'use strict';
const { tx, getPool } = require('../db/pool');
const { ConflictError, NotFoundError } = require('./geo');
const { uid, loadRouteLocked, audit } = require('./store');

// ---- 后台任务实际执行：幂等 + 失败抛错让 worker 重试 ----
async function runPublish(payload) {
  return tx(async (client) => {
    // 幂等：同一 revision 已发布过则直接复用（不管是否已被新版取代/撤回）
    const exist = await client.query(
      `SELECT id FROM publications WHERE revision_id=$1`, [payload.revision_id]);
    if (exist.rowCount > 0) {
      // 确保索引任务结果存在（后台发布与搜索索引更新可分别重试）
      const pubId = exist.rows[0].id;
      await ensureIndex(client, payload.route_id, pubId);
      return { publication_id: pubId, idempotent: true };
    }

    const rev = await client.query(
      `SELECT rv.*, r.decision AS review_decision, r.superseded_at AS review_superseded
         FROM route_revisions rv JOIN reviews r ON r.id = $2
        WHERE rv.id = $1 FOR UPDATE`,
      [payload.revision_id, payload.review_id]);
    if (rev.rowCount === 0) throw new Error('revision/review missing for publish job');
    const snapshot = rev.rows[0];
    if (snapshot.review_decision !== 'approved' || snapshot.review_superseded) {
      throw new Error('refuse to publish: review is not an intact approval (no complete audit basis)');
    }
    const pubId = uid('pb');
    await client.query(
      `INSERT INTO publications
        (id, route_id, revision_id, revision_version, geometry, title, story, stop_snapshots,
         approved_review_id, published_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)`,
      [pubId, snapshot.route_id, snapshot.id, snapshot.version,
       JSON.stringify(snapshot.geometry), snapshot.title, snapshot.story || '',
       JSON.stringify(snapshot.stop_snapshots || []), payload.review_id, payload.actor]);
    await client.query('UPDATE routes SET published_revision_id=$2, updated_at=now() WHERE id=$1',
      [snapshot.route_id, pubId]);
    // 新发布落地 => 旧发布快照仍在但不再是 head（撤回语义由 withdrawn_at 单独处理）
    await client.query(
      `UPDATE publications SET withdrawn_at = COALESCE(withdrawn_at, now()),
                               withdrawn_note = COALESCE(withdrawn_note, 'superseded by a new approved version')
        WHERE route_id=$1 AND id <> $2`, [snapshot.route_id, pubId]);
    await ensureIndex(client, snapshot.route_id, pubId);
    await audit(client, payload.actor, snapshot.route_id, 'publish.done', { publication: pubId, revision: snapshot.id });
    return { publication_id: pubId };
  });
}

async function ensureIndex(client, routeId, publicationId) {
  const pub = (await client.query('SELECT title FROM publications WHERE id=$1', [publicationId])).rows[0];
  // 简单中文友好索引：标题 + 故事分词（空格/标点）。to_tsvector('simple') 可重试写入。
  await client.query(
    `INSERT INTO search_index (route_id, publication_id, title, tsv, indexed_at)
     VALUES ($1,$2,$3, to_tsvector('simple', COALESCE($3,'')), now())
     ON CONFLICT (route_id) DO UPDATE SET publication_id=EXCLUDED.publication_id,
       title=EXCLUDED.title, tsv=EXCLUDED.tsv, indexed_at=now()`,
    [routeId, publicationId, pub.title]
  );
}

async function runIndex(payload) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const pub = await client.query(
      `SELECT id, route_id, title, story, withdrawn_at FROM publications WHERE id=$1 FOR UPDATE`,
      [payload.publication_id]);
    if (pub.rowCount === 0) throw new Error('publication missing for index job');
    if (pub.rows[0].withdrawn_at) {
      await client.query('DELETE FROM search_index WHERE route_id=$1', [pub.rows[0].route_id]);
    } else {
      await ensureIndex(client, pub.rows[0].route_id, pub.rows[0].id);
    }
    await client.query('COMMIT');
    return { indexed: payload.publication_id };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function runUnindex(payload) {
  await getPool().query('DELETE FROM search_index WHERE route_id=$1', [payload.route_id]);
  return { unindexed: payload.route_id };
}

// ---- 撤回：旧链接保留状态说明，不泄漏未公开草稿 ----
async function withdraw(user, routeId, body) {
  const note = String(body.note || '作者撤回了这条路线');
  const { LIMITS: LM } = require('../config');
  if (note.length > LM.REASON_MAX) throw new (require('./geo').ValidationError)('撤回理由过长');
  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    if (!route || (route.author_id !== user.id && user.role !== 'admin')) throw new NotFoundError('route not found');
    if (route.status === 'in_review') {
      // 审核与撤回竞争：撤回优先 => 进行中审核作废，回到草稿
      await client.query(
        `UPDATE reviews SET superseded_at=now(), superseded_reason='withdrawn by author during review'
          WHERE id=$1 AND decision='pending'`, [route.active_review_id]);
      await client.query(
        `UPDATE routes SET status='draft', active_review_id=NULL, updated_at=now() WHERE id=$1`, [routeId]);
      const rvId = uid('rv');
      const version = Number((await client.query(
        'SELECT COALESCE(MAX(version),0)+1 AS v FROM route_revisions WHERE route_id=$1', [routeId])).rows[0].v);
      await client.query(
        `INSERT INTO route_revisions (id, route_id, version, kind, geometry, story, title, stop_snapshots, reason, created_by, geom_fingerprint, text_fingerprint)
         VALUES ($1,$2,$3,'withdraw',$4::jsonb,$5,$6,'[]',$7,$8,$9,$10)`,
        [rvId, routeId, version, JSON.stringify(route.working_geom), route.story, route.title,
         note, user.id, route.geom_fingerprint, route.text_fingerprint]);
      await audit(client, user.id, routeId, 'route.withdraw_from_review', { note });
      return { route_id: routeId, status: 'draft', publication: null };
    }
    if (route.status !== 'published' || !route.published_revision_id) {
      throw new ConflictError('当前没有可撤回的已发布版本', { status: route.status });
    }
    const pubId = route.published_revision_id;
    await client.query(
      `UPDATE publications SET withdrawn_at=now(), withdrawn_note=$2 WHERE id=$1`, [pubId, note]);
    await client.query(
      `UPDATE routes SET status='withdrawn', withdrawn_note=$2, updated_at=now() WHERE id=$1`,
      [routeId, note]);
    // 搜索索引移除（可重试任务）
    const jid = 'job_' + require('crypto').randomBytes(8).toString('hex');
    await client.query(
      `INSERT INTO jobs (id, type, payload) VALUES ($1,'unindex',$2::jsonb)`,
      [jid, JSON.stringify({ route_id: routeId })]);
    await client.query('DELETE FROM search_index WHERE route_id=$1', [routeId]);
    const rvId = uid('rv');
    const version = Number((await client.query(
      'SELECT COALESCE(MAX(version),0)+1 AS v FROM route_revisions WHERE route_id=$1', [routeId])).rows[0].v);
    await client.query(
      `INSERT INTO route_revisions (id, route_id, version, kind, geometry, story, title, stop_snapshots, reason, created_by, geom_fingerprint, text_fingerprint)
       VALUES ($1,$2,$3,'withdraw',$4::jsonb,$5,$6,'[]',$7,$8,$9,$10)`,
      [rvId, routeId, version, JSON.stringify(route.working_geom), route.story, route.title,
       note, user.id, route.geom_fingerprint, route.text_fingerprint]);
    await audit(client, user.id, routeId, 'route.withdraw', { publication: pubId, note, job: jid });
    return { route_id: routeId, status: 'withdrawn', publication_id: pubId };
  });
}

module.exports = { runPublish, runIndex, runUnindex, withdraw };
