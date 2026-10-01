'use strict';
const { tx } = require('../db/pool');
const { getPool } = require('../db/pool');
const {
  ValidationError, ConflictError, NotFoundError,
  validateLineString, validateTextFields,
  fingerprintGeometry, fingerprintText,
  haversine, projectPoint, evaluateStopsAfterGeometry
} = require('./geo');
const L = require('../config').LIMITS;
const { uid, routeShape, loadRouteLocked, listSegments, listStops, writeSegments, writeStops, audit } = require('./store');

// 对"审核中/被请求修改"路线的编辑：旧审核立刻作废（作者改危险路口不能沿用旧同意）
async function invalidatePendingReviews(client, route, reason) {
  const r = await client.query(
    `UPDATE reviews SET superseded_at = now(), superseded_reason = $2::text
       WHERE route_id = $1 AND decision = 'pending' AND superseded_at IS NULL`,
    [route.id, reason]
  );
  if (r.rowCount > 0) {
    await client.query('UPDATE routes SET active_review_id = NULL WHERE id = $1', [route.id]);
    await audit(client, null, route.id, 'review.superseded', { reason, count: r.rowCount });
  }
  return r.rowCount;
}

// 任何草稿编辑后调用：回退到 draft / changes_requested，并递增整路线版本
async function afterDraftEdit(client, route, { geomChanged, textChanged, reason }) {
  let superseded = 0;
  if (route.status === 'in_review') {
    superseded = await invalidatePendingReviews(client, route, reason || 'author edited draft while review was open');
    await client.query(
      `UPDATE routes SET status = 'changes_requested', active_review_id = NULL, updated_at = now() WHERE id = $1`,
      [route.id]
    );
  } else {
    await client.query('UPDATE routes SET updated_at = now() WHERE id = $1', [route.id]);
  }
  const ver = await client.query(
    'UPDATE routes SET route_version = route_version + 1 WHERE id = $1 RETURNING route_version',
    [route.id]
  );
  return { superseded, route_version: Number(ver.rows[0].route_version) };
}

async function createRoute(user, body) {
  const coords = (body.geometry && body.geometry.coordinates) || [];
  const title = body.title || '未命名慢行线';
  if (coords.length > 0) {
    validateLineString(body.geometry);
  }
  if (body.story && String(body.story).length > L.STORY_MAX) throw new ValidationError('story too long');
  const id = uid('rt');
  const gf = coords.length ? fingerprintGeometry(body.geometry) : null;
  const tf = fingerprintText({ title, story: body.story || '' });
  const geom = coords.length ? body.geometry : { type: 'LineString', coordinates: [] };
  return tx(async (client) => {
    await client.query(
      `INSERT INTO routes (id, author_id, title, status, working_geom, story,
                           geom_fingerprint, text_fingerprint)
       VALUES ($1,$2,$3,'draft',$4::jsonb,$5,$6,$7)`,
      [id, user.id, title, JSON.stringify(geom), body.story || '', gf, tf]
    );
    const coords2 = geom.coordinates;
    if (coords2.length >= 2) {
      const uids = coords2.slice(0, -1).map(() => uid('seg'));
      await writeSegments(client, id, uids, coords2, uids.map(() => 1));
    }
    await audit(client, user.id, id, 'route.create', { hasGeometry: coords.length > 0 });
    return getRouteForUser0(client, id, user);
  });
}

async function getRouteForUser(client, routeId, user) {
  const r = await client.query('SELECT * FROM routes WHERE id = $1', [routeId]);
  if (r.rowCount === 0) throw new NotFoundError('route not found');
  const route = r.rows[0];
  if (user.role === 'author' && route.author_id !== user.id) throw new NotFoundError('route not found');
  const segments = await listSegments(client, routeId);
  const stops = await listStops(client, routeId);
  const photos = (await client.query(
    'SELECT id, filename, bytes, status, created_at FROM photos WHERE route_id=$1 ORDER BY created_at', [routeId]
  )).rows;
  const out = routeShape(route);
  out.segments = segments;
  out.stops = stops;
  out.photos = photos;
  out.can_edit = user.role !== 'author' || route.author_id === user.id;
  return out;
}
async function getRouteForUser0(client, routeId, user) { return getRouteForUser(client, routeId, user); }

async function getRoute(user, routeId) {
  return tx(async (client) => getRouteForUser(client, routeId, user));
}

async function listMine(user) {
  const r = await getPool().query(
    `SELECT id, title, status, route_version, draft_version, published_revision_id, updated_at
       FROM routes WHERE author_id=$1 ORDER BY updated_at DESC`, [user.id]);
  return r.rows;
}

// ===== 整路线保存：全量乐观锁（route_version / If-Match 语义）=====
async function saveFullRoute(user, routeId, body) {
  const expected = body.expected_version ? Number(body.expected_version) : null;
  const { geometry } = validateLineString(body.geometry);
  validateTextFields({ title: body.title, story: body.story });
  const gf = fingerprintGeometry(geometry);
  const tf = fingerprintText({ title: body.title, story: body.story || '' });

  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    if (!route) throw new NotFoundError('route not found');
    if (route.author_id !== user.id && user.role !== 'admin') throw new NotFoundError('route not found');
    if (expected !== null && Number(route.route_version) !== expected) {
      throw new ConflictError('route_version 不匹配：路线已被他人改动，请刷新后合并', {
        your_version: expected, current_version: Number(route.route_version),
        strategy: 'full-route optimistic lock rejected; fetch latest and merge'
      });
    }
    const oldCoords = route.working_geom.coordinates;
    const oldSegs = await listSegments(client, routeId);
    const oldUids = oldSegs.map((s) => s.uid);
    const oldStops = await listStops(client, routeId);
    const geomChanged = route.geom_fingerprint !== gf;
    const textChanged = route.text_fingerprint !== tf;

    const newCoords = geometry.coordinates;
    let relocated = [];

    if (geomChanged) {
      // 全量保存：几何变了 => 分段整体重建（需要细粒度合并应走 segments/* 接口）。
      // 保留仍可按坐标对应的旧段 uid，尽量让锚点存活；对应不上的段给新 uid。
      const oldKey = (s) => s.start[0].toFixed(7) + ',' + s.start[1].toFixed(7) + '>' +
                                 s.end[0].toFixed(7) + ',' + s.end[1].toFixed(7);
      const oldByKey = new Map(oldSegs.map((s) => [oldKey(s), s]));
      const newUids = [];
      const newVersions = [];
      for (let i = 0; i < newCoords.length - 1; i++) {
        const key = newCoords[i][0].toFixed(7) + ',' + newCoords[i][1].toFixed(7) + '>' +
                    newCoords[i + 1][0].toFixed(7) + ',' + newCoords[i + 1][1].toFixed(7);
        const kept = oldByKey.get(key);
        if (kept) { newUids.push(kept.uid); newVersions.push(Number(kept.version) + 1); }
        else { newUids.push(uid('seg')); newVersions.push(1); }
      }
      await writeSegments(client, routeId, newUids, newCoords, newVersions);

      const newStops = evaluateStopsAfterGeometry(oldStops, oldCoords, oldUids, newCoords, newUids);
      relocated = newStops.filter((s) => s.status === 'needs_relocation');
      await client.query('DELETE FROM route_stops WHERE route_id=$1', [routeId]);
      newStops.forEach((s, i) => { s.seq = i; });
      for (const s of newStops) {
        await client.query(
          `INSERT INTO route_stops (id, route_id, seq, name, note, anchor, coordinates, status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
          [s.id, routeId, s.seq, s.name, s.note, JSON.stringify(s.anchor), JSON.stringify(s.coordinates), s.status]
        );
      }
    }

    await client.query(
      `UPDATE routes SET working_geom=$2::jsonb, title=$3, story=$4,
                         geom_fingerprint=$5, text_fingerprint=$6
         WHERE id=$1`,
      [routeId, JSON.stringify(geometry), body.title, body.story || '', gf, tf]
    );
    const edited = await afterDraftEdit(client, await loadRouteLocked(client, routeId), {
      geomChanged, textChanged,
      reason: 'full-route save by author'
    });
    await audit(client, user.id, routeId, 'route.save_full', {
      geomChanged, textChanged, relocated: relocated.length, supersededReviews: edited.superseded
    });
    const out = await getRouteForUser(client, routeId, user);
    out.conflict = relocated.length ? {
      type: 'stop_relocation_required',
      message: '路段插删后有歇脚点需要重新定位',
      stop_ids: relocated.map((s) => s.id)
    } : null;
    return out;
  });
}

module.exports = { createRoute, getRoute, listMine, saveFullRoute, loadRouteLocked, getRouteForUser, afterDraftEdit };
