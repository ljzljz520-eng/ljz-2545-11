'use strict';
const { tx } = require('../db/pool');
const {
  ValidationError, ConflictError, NotFoundError,
  validateLineString, fingerprintGeometry,
  evaluateStopsAfterGeometry, projectPoint
} = require('./geo');
const L = require('../config').LIMITS;
const { uid, loadRouteLocked, listSegments, listStops, writeSegments, audit } = require('./store');
const { getRouteForUser, afterDraftEdit } = require('./routes');

function expectRouteOwned(route, user) {
  if (!route) throw new NotFoundError('route not found');
  if (route.author_id !== user.id && user.role !== 'admin') throw new NotFoundError('route not found');
}

// 分段乐观锁：客户端必须给出所触碰段的当前 seg_version；并发改同段 => 409
function checkTouchedSegVersions(segs, expected) {
  const conflicts = [];
  for (const e of expected || []) {
    const seg = segs.find((s) => s.uid === e.uid);
    if (!seg) { conflicts.push({ uid: e.uid, reason: 'segment missing (deleted by concurrent edit)' }); continue; }
    if (Number(seg.version) !== Number(e.version)) {
      conflicts.push({ uid: e.uid, your_version: e.version, current_version: seg.version });
    }
  }
  if (conflicts.length) {
    throw new ConflictError('同一路段存在并发修改，分段合并冲突；请拉取最新路段后重试或改用整路线保存', {
      strategy: 'segment-level merge rejected for touched segments',
      conflicts
    });
  }
}

async function recompute(client, route, user, oldStops, oldCoords, oldUids, uids, coords, versions, reason) {
  // 服务端完整复核新折线（边界/复杂度/自交/长度）
  const checked = validateLineString({ type: 'LineString', coordinates: coords });
  const gf = fingerprintGeometry(checked.geometry);
  const geomChanged = route.geom_fingerprint !== gf;

  await writeSegments(client, route.id, uids, coords, versions);

  let relocated = [];
  if (geomChanged) {
    const newStops = evaluateStopsAfterGeometry(oldStops, oldCoords, oldUids, coords, uids);
    relocated = newStops.filter((s) => s.status === 'needs_relocation');
    await client.query('DELETE FROM route_stops WHERE route_id=$1', [route.id]);
    newStops.forEach((s, i) => { s.seq = i; });
    for (const s of newStops) {
      await client.query(
        `INSERT INTO route_stops (id, route_id, seq, name, note, anchor, coordinates, status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [s.id, route.id, s.seq, s.name, s.note, JSON.stringify(s.anchor), JSON.stringify(s.coordinates), s.status]
      );
    }
  }
  await client.query('UPDATE routes SET working_geom=$2::jsonb, geom_fingerprint=$3 WHERE id=$1',
    [route.id, JSON.stringify(checked.geometry), gf]);
  const edited = await afterDraftEdit(client, await loadRouteLocked(client, route.id), { geomChanged, reason });
  await audit(client, user.id, route.id, 'segment.' + reason, { relocated: relocated.length, supersededReviews: edited.superseded });
  return relocated;
}

// 在段 segUid 上插入一个顶点（段分裂；两侧段 uid 处理见下）
async function insertVertex(user, routeId, body) {
  const segUid = body.segment_uid;
  const q = body.at;
  const expected = body.expected_seg_versions || [];
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    expectRouteOwned(route, user);
    const segs = await listSegments(client, routeId);
    checkTouchedSegVersions(segs, expected);
    const idx = segs.findIndex((s) => s.uid === segUid);
    if (idx === -1) throw new ConflictError('目标路段已不存在（可能已被并发插入/删除）', { segment_uid: segUid });
    const coords = route.working_geom.coordinates.slice();
    coords.splice(idx + 1, 0, [Number(q[0]), Number(q[1])]);

    // uid 规则：保留原 uid 给前半段（锚点无需迁移），后半段新 uid
    const uids = segs.map((s) => s.uid);
    const versions = segs.map((s) => Number(s.version));
    uids.splice(idx + 1, 0, uid('seg'));
    versions[idx] += 1;                          // 前半段几何变了
    versions.splice(idx + 1, 0, 1);              // 新段

    const oldStops = await listStops(client, routeId);
    const relocated = await recompute(client, route, user, oldStops, route.working_geom.coordinates,
      segs.map((s) => s.uid), uids, coords, versions, 'insert');

    const out = await getRouteForUser(client, routeId, user);
    out.conflict = relocated.length ? {
      type: 'stop_relocation_required',
      message: '插入顶点后，部分歇脚点几何漂移，需要重新定位',
      stop_ids: relocated.map((s) => s.id)
    } : null;
    return out;
  });
}

// 删除顶点 vertex_seq（前后两段合并）
async function deleteVertex(user, routeId, body) {
  const vseq = Number(body.vertex_seq);
  const expected = body.expected_seg_versions || [];
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    expectRouteOwned(route, user);
    const segs = await listSegments(client, routeId);
    checkTouchedSegVersions(segs, expected);
    const coords = route.working_geom.coordinates;
    if (vseq < 1 || vseq > coords.length - 2) {
      throw new ValidationError('只能删除内部顶点（删除端点请用整路线保存）', { vertex_seq: vseq });
    }
    const newCoords = coords.slice();
    newCoords.splice(vseq, 1);
    // 合并段 seg[vseq-1](A-V) 与 seg[vseq](V-B) 为一段 (A-B)：保留前者 uid + bump
    const uids = segs.map((s) => s.uid);
    const versions = segs.map((s) => Number(s.version));
    versions[vseq - 1] += 1;
    uids.splice(vseq, 1);
    versions.splice(vseq, 1);

    const oldStops = await listStops(client, routeId);
    const relocated = await recompute(client, route, user, oldStops, coords,
      segs.map((s) => s.uid), uids, newCoords, versions, 'delete');

    const out = await getRouteForUser(client, routeId, user);
    out.conflict = relocated.length ? {
      type: 'stop_relocation_required',
      message: '删除顶点合并路段后，锚定在被删路段上的歇脚点必须重新定位',
      stop_ids: relocated.map((s) => s.id)
    } : null;
    return out;
  });
}

// 移动顶点（触碰相邻两段；细粒度锁两段 => 并发改别的段仍可合并）
async function moveVertex(user, routeId, body) {
  const vseq = Number(body.vertex_seq);
  const q = body.to;
  const expected = body.expected_seg_versions || [];
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    expectRouteOwned(route, user);
    const segs = await listSegments(client, routeId);
    checkTouchedSegVersions(segs, expected);
    const coords = route.working_geom.coordinates.slice();
    if (vseq < 0 || vseq >= coords.length) throw new ValidationError('vertex_seq 越界');
    coords[vseq] = [Number(q[0]), Number(q[1])];

    const uids = segs.map((s) => s.uid);
    const versions = segs.map((s) => Number(s.version));
    if (vseq > 0) versions[vseq - 1] += 1;
    if (vseq < segs.length) versions[vseq] += 1;

    const oldStops = await listStops(client, routeId);
    const relocated = await recompute(client, route, user, oldStops, route.working_geom.coordinates,
      uids.slice(), uids, coords, versions, 'move');

    const out = await getRouteForUser(client, routeId, user);
    out.conflict = relocated.length ? {
      type: 'stop_relocation_required',
      message: '移动顶点后有歇脚点漂移超限，需要重新定位',
      stop_ids: relocated.map((s) => s.id)
    } : null;
    return out;
  });
}

module.exports = { insertVertex, deleteVertex, moveVertex };
