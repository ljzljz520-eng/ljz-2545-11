'use strict';
const { tx } = require('../db/pool');
const { ValidationError, ConflictError, NotFoundError, projectPoint, haversine } = require('./geo');
const L = require('../config').LIMITS;
const { uid, loadRouteLocked, listSegments, listStops, audit } = require('./store');
const { getRouteForUser, afterDraftEdit } = require('./routes');

function owned(route, user) {
  if (!route) throw new NotFoundError('route not found');
  if (route.author_id !== user.id && user.role !== 'admin') throw new NotFoundError('route not found');
}

function snapToGeometry(coords, point) {
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const pr = projectPoint(point, coords[i], coords[i + 1]);
    if (!best || pr.dist < best.dist) best = Object.assign({ segIdx: i }, pr);
  }
  if (best === null) throw new ValidationError('路线还没有几何，无法添加歇脚点');
  const a = coords[best.segIdx], b = coords[best.segIdx + 1];
  const coordinates = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
  return { segIdx: best.segIdx, t: best.t, coordinates, distToLine: best.dist };
}

async function addStop(user, routeId, body) {
  const name = String(body.name || '').trim();
  if (name.length < 1) throw new ValidationError('歇脚点名称必填');
  if (name.length > L.STOP_NAME_MAX) throw new ValidationError('歇脚点名称过长');
  const note = String(body.note || '');
  if (note.length > L.STOP_NOTE_MAX) throw new ValidationError('备注过长');
  const coords = body.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) throw new ValidationError('coordinates 须为 [lng,lat]');
  if (coords.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new ValidationError('坐标非法');
  if (coords[0] < L.LNG_MIN || coords[0] > L.LNG_MAX || coords[1] < L.LAT_MIN || coords[1] > L.LAT_MAX) {
    throw new ValidationError('歇脚点坐标越界');
  }

  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    owned(route, user);
    const geomCoords = route.working_geom.coordinates;
    if (geomCoords.length < 2) throw new ValidationError('请先画好路线再添加歇脚点');
    const segs = await listSegments(client, routeId);
    const stops = await listStops(client, routeId);
    if (stops.length >= L.MAX_STOPS) throw new ValidationError('歇脚点数量超过上限');

    const snap = snapToGeometry(geomCoords, coords);
    if (snap.distToLine > 200) throw new ValidationError('歇脚点离路线太远（>200m），请放在路线附近', { meters: snap.distToLine });
    const id = uid('st');
    const anchor = { kind: 'segment', uid: segs[snap.segIdx].uid, t: snap.t };
    await client.query(
      `INSERT INTO route_stops (id, route_id, seq, name, note, anchor, coordinates, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'ok')`,
      [id, routeId, stops.length, name, note, JSON.stringify(anchor), JSON.stringify(snap.coordinates)]
    );
    await audit(client, user.id, routeId, 'stop.add', { id, segment: anchor.uid });
    return getRouteForUser(client, routeId, user);
  });
}

// 作者显式确认新位置 => 解除 needs_relocation
async function relocateStop(user, routeId, stopId, body) {
  const coords = body.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) throw new ValidationError('coordinates 须为 [lng,lat]');
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    owned(route, user);
    const r = await client.query('SELECT * FROM route_stops WHERE id=$1 AND route_id=$2 FOR UPDATE', [stopId, routeId]);
    if (r.rowCount === 0) throw new NotFoundError('歇脚点不存在');
    const stop = r.rows[0];
    const geomCoords = route.working_geom.coordinates;
    const segs = await listSegments(client, routeId);
    const snap = snapToGeometry(geomCoords, coords);
    if (snap.distToLine > 200) throw new ValidationError('新位置离路线太远', { meters: snap.distToLine });
    const anchor = { kind: 'segment', uid: segs[snap.segIdx].uid, t: snap.t };
    await client.query(
      `UPDATE route_stops SET anchor=$3::jsonb, coordinates=$4::jsonb, status='ok' WHERE id=$1 AND route_id=$2`,
      [stopId, routeId, JSON.stringify(anchor), JSON.stringify(snap.coordinates)]
    );
    await audit(client, user.id, routeId, 'stop.relocate', { id: stopId });
    return getRouteForUser(client, routeId, user);
  });
}

async function updateStopNote(user, routeId, stopId, body) {
  const note = String(body.note || '');
  const name = body.name === undefined ? undefined : String(body.name).trim();
  if (note.length > L.STOP_NOTE_MAX) throw new ValidationError('备注过长');
  if (name !== undefined && (name.length < 1 || name.length > L.STOP_NAME_MAX)) throw new ValidationError('名称非法');
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    owned(route, user);
    const r = await client.query('SELECT id FROM route_stops WHERE id=$1 AND route_id=$2 FOR UPDATE', [stopId, routeId]);
    if (r.rowCount === 0) throw new NotFoundError('歇脚点不存在');
    if (name !== undefined) {
      await client.query('UPDATE route_stops SET name=$3 WHERE id=$1 AND route_id=$2', [stopId, routeId, name]);
    }
    await client.query('UPDATE route_stops SET note=$3 WHERE id=$1 AND route_id=$2', [stopId, routeId, note]);
    // 改备注不改变几何；不影响审核绑定的几何维度，文字指纹不含备注
    await audit(client, user.id, routeId, 'stop.note', { id: stopId });
    return getRouteForUser(client, routeId, user);
  });
}

async function deleteStop(user, routeId, stopId) {
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    owned(route, user);
    const r = await client.query('DELETE FROM route_stops WHERE id=$1 AND route_id=$2', [stopId, routeId]);
    if (r.rowCount === 0) throw new NotFoundError('歇脚点不存在');
    // 重排 seq
    const rows = (await client.query('SELECT id FROM route_stops WHERE route_id=$1 ORDER BY seq', [routeId])).rows;
    for (let i = 0; i < rows.length; i++) await client.query('UPDATE route_stops SET seq=$2 WHERE id=$1', [rows[i].id, i]);
    await audit(client, user.id, routeId, 'stop.delete', { id: stopId });
    return getRouteForUser(client, routeId, user);
  });
}

// 只改文字（标题/故事）——文字维度指纹变化也会使绑定旧文字版的审核失效
async function saveText(user, routeId, body) {
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    owned(route, user);
    const title = String(body.title || route.title);
    const story = body.story === undefined ? route.story : String(body.story);
    if (title.trim().length < L.TITLE_MIN || title.length > L.TITLE_MAX) throw new ValidationError('标题长度非法');
    if (String(story || '').length > L.STORY_MAX) throw new ValidationError('故事过长');
    const { fingerprintText } = require('./geo');
    const tf = fingerprintText({ title, story: story || '' });
    const textChanged = route.text_fingerprint !== tf;
    await client.query('UPDATE routes SET title=$2, story=$3, text_fingerprint=$4 WHERE id=$1',
      [routeId, title, story || '', tf]);
    if (textChanged) {
      const r = await afterDraftEdit(client, await loadRouteLocked(client, routeId), { textChanged, reason: 'text edited' });
      await audit(client, user.id, routeId, 'route.save_text', { supersededReviews: r.superseded });
    }
    return getRouteForUser(client, routeId, user);
  });
}

module.exports = { addStop, relocateStop, updateStopNote, deleteStop, saveText };
