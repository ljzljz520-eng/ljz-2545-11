'use strict';
const crypto = require('crypto');

const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

function routeShape(row) {
  return {
    id: row.id,
    author_id: row.author_id,
    title: row.title,
    status: row.status,
    working_geom: row.working_geom,
    story: row.story,
    draft_version: row.draft_version,
    route_version: Number(row.route_version),
    geom_fingerprint: row.geom_fingerprint,
    text_fingerprint: row.text_fingerprint,
    active_review_id: row.active_review_id,
    published_revision_id: row.published_revision_id,
    withdrawn_note: row.withdrawn_note,
    updated_at: row.updated_at
  };
}

async function loadRouteLocked(client, id) {
  const r = await client.query('SELECT * FROM routes WHERE id = $1 FOR UPDATE', [id]);
  if (r.rowCount === 0) return null;
  return r.rows[0];
}

async function listSegments(client, routeId) {
  const r = await client.query(
    'SELECT seq, uid, start_pt, end_pt, seg_version FROM route_segments WHERE route_id=$1 ORDER BY seq',
    [routeId]
  );
  return r.rows.map((x) => ({
    seq: x.seq, uid: x.uid,
    start: x.start_pt, end: x.end_pt,
    version: Number(x.seg_version)
  }));
}

async function listStops(client, routeId) {
  const r = await client.query(
    'SELECT id, seq, name, note, anchor, coordinates, status FROM route_stops WHERE route_id=$1 ORDER BY seq',
    [routeId]
  );
  return r.rows.map((x) => ({
    id: x.id, seq: x.seq, name: x.name, note: x.note,
    anchor: x.anchor, coordinates: x.coordinates, status: x.status
  }));
}

async function writeSegments(client, routeId, uids, coords, versions) {
  await client.query('DELETE FROM route_segments WHERE route_id=$1', [routeId]);
  for (let i = 0; i < uids.length; i++) {
    await client.query(
      `INSERT INTO route_segments (route_id, seq, uid, start_pt, end_pt, seg_version)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [routeId, i, uids[i], JSON.stringify(coords[i]), JSON.stringify(coords[i + 1]), versions[i]]
    );
  }
}

async function writeStops(client, routeId, stops) {
  for (const s of stops) {
    await client.query(
      `INSERT INTO route_stops (id, route_id, seq, name, note, anchor, coordinates, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (route_id, seq) DO UPDATE SET
         name=EXCLUDED.name, note=EXCLUDED.note, anchor=EXCLUDED.anchor,
         coordinates=EXCLUDED.coordinates, status=EXCLUDED.status`,
      [s.id, routeId, s.seq, s.name, s.note, JSON.stringify(s.anchor), JSON.stringify(s.coordinates), s.status]
    );
  }
}

async function audit(client, actorId, routeId, action, detail) {
  await client.query(
    'INSERT INTO audit_log (actor_id, route_id, action, detail) VALUES ($1,$2,$3,$4::jsonb)',
    [actorId, routeId, action, JSON.stringify(detail || {})]
  );
}

module.exports = { uid, routeShape, loadRouteLocked, listSegments, listStops, writeSegments, writeStops, audit };
