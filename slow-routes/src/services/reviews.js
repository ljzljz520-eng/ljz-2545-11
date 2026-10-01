'use strict';
const { tx, getPool } = require('../db/pool');
const { ConflictError, NotFoundError, ValidationError } = require('./geo');
const L = require('../config').LIMITS;
const { uid, loadRouteLocked, audit } = require('./store');
const { enqueue } = require('./jobs');

async function pendingList(user) {
  const r = await getPool().query(
    `SELECT r.id AS review_id, r.route_id, rv.title, rv.version, r.created_at, u.display_name AS author_name
       FROM reviews r
       JOIN route_revisions rv ON rv.id = r.revision_id
       JOIN routes rt ON rt.id = r.route_id
       JOIN users u ON u.id = rt.author_id
      WHERE r.decision='pending' AND r.superseded_at IS NULL
        AND rt.status='in_review' AND rt.active_review_id = r.id
      ORDER BY r.created_at`);
  return r.rows;
}

// 审核员看到的必须是提交时刻冻结的快照（确定路线几何及文字版）
async function getReview(user, reviewId) {
  const r = await getPool().query(
    `SELECT r.*, rv.geometry, rv.title AS rev_title, rv.story AS rev_story,
            rv.stop_snapshots, rv.version, rv.reason, rv.geom_fingerprint, rv.text_fingerprint,
            rt.status AS route_status, rt.active_review_id, rt.author_id
       FROM reviews r
       JOIN route_revisions rv ON rv.id = r.revision_id
       JOIN routes rt ON rt.id = r.route_id
      WHERE r.id = $1`, [reviewId]);
  if (r.rowCount === 0) throw new NotFoundError('审核单不存在');
  const row = r.rows[0];
  return {
    review_id: row.id,
    route_id: row.route_id,
    author_id: row.author_id,
    route_status: row.route_status,
    still_active: row.active_review_id === row.id && row.superseded_at === null && row.decision === 'pending',
    superseded_at: row.superseded_at,
    superseded_reason: row.superseded_reason,
    revision: {
      id: row.revision_id, version: row.version, title: row.rev_title, story: row.rev_story,
      geometry: row.geometry, stops: row.stop_snapshots, reason: row.reason,
      geom_fingerprint: row.geom_fingerprint, text_fingerprint: row.text_fingerprint
    },
    decision: row.decision, comment: row.comment, decided_at: row.decided_at
  };
}

async function decide(user, reviewId, body) {
  const decision = body.decision;
  if (!['approved', 'rejected', 'changes_requested'].includes(decision)) {
    throw new ValidationError('decision 非法');
  }
  const comment = String(body.comment || '');
  if (comment.length > L.COMMENT_MAX) throw new ValidationError('审核意见过长');
  if (decision === 'rejected' && comment.length < 2) throw new ValidationError('驳回必须填写理由');

  return tx(async (client) => {
    const r = await client.query(
      `SELECT r.*, rt.status AS route_status, rt.active_review_id,
              rv.geom_fingerprint AS rv_gf, rv.text_fingerprint AS rv_tf,
              rt.geom_fingerprint AS rt_gf, rt.text_fingerprint AS rt_tf
         FROM reviews r
         JOIN route_revisions rv ON rv.id = r.revision_id
         JOIN routes rt ON rt.id = r.route_id
        WHERE r.id = $1 FOR UPDATE OF r`, [reviewId]);
    if (r.rowCount === 0) throw new NotFoundError('审核单不存在');
    const rev = r.rows[0];

    const locked = await client.query('SELECT * FROM routes WHERE id=$1 FOR UPDATE', [rev.route_id]);
    const route = locked.rows[0];

    if (rev.decision !== 'pending') throw new ConflictError('该审核已决议', { decision: rev.decision });
    if (rev.superseded_at || route.active_review_id !== reviewId || route.status !== 'in_review') {
      throw new ConflictError('审核对象已不是当前待审版本：作者已改动或撤回，旧审核不能沿用', {
        superseded: !!rev.superseded_at,
        route_status: route.status
      });
    }
    // 关键：绑定指纹必须同时匹配几何与文字
    if (rev.bound_geom_fingerprint !== route.geom_fingerprint ||
        rev.bound_text_fingerprint !== route.text_fingerprint ||
        rev.rv_gf !== route.geom_fingerprint || rev.rv_tf !== route.text_fingerprint) {
      // 数据层兜底：标记失效
      await client.query(`UPDATE reviews SET superseded_at=now(), superseded_reason='fingerprint mismatch at decision' WHERE id=$1`, [reviewId]);
      await client.query(`UPDATE routes SET active_review_id=NULL WHERE id=$1`, [rev.route_id]);
      throw new ConflictError('几何或文字已与送审版本不一致，必须针对新版本重新审核（不能沿用旧同意）');
    }

    await client.query(
      `UPDATE reviews SET decision=$2, comment=$3, decided_at=now() WHERE id=$1`,
      [reviewId, decision, comment]);

    let jobId = null;
    if (decision === 'approved') {
      // 后台发布任务（可重试）：落地不可变发布快照 + 搜索索引更新
      jobId = await enqueueInTx(client, 'publish', {
        route_id: route.id, revision_id: rev.revision_id, review_id: reviewId, actor: user.id
      });
      await client.query(`UPDATE routes SET status='published', updated_at=now() WHERE id=$1`, [route.id]);
    } else if (decision === 'changes_requested') {
      const crId = uid('rv');
      const version = Number((await client.query(
        'SELECT COALESCE(MAX(version),0)+1 AS v FROM route_revisions WHERE route_id=$1', [route.id])).rows[0].v);
      await client.query(
        `INSERT INTO route_revisions (id, route_id, version, kind, geometry, story, title, stop_snapshots, reason, created_by, geom_fingerprint, text_fingerprint)
         VALUES ($1,$2,$3,'request_changes',$4::jsonb,$5,$6,'[]',$7,$8,$9,$10)`,
        [crId, route.id, version, JSON.stringify(route.working_geom), route.story, route.title,
         comment, user.id, route.geom_fingerprint, route.text_fingerprint]);
      await client.query(`UPDATE routes SET status='changes_requested', active_review_id=NULL, updated_at=now() WHERE id=$1`, [route.id]);
    } else {
      await client.query(`UPDATE routes SET status='draft', active_review_id=NULL, updated_at=now() WHERE id=$1`, [route.id]);
    }
    await audit(client, user.id, route.id, 'review.decide', { review: reviewId, decision, comment, job: jobId });
    return { review_id: reviewId, decision, job_id: jobId };
  });
}

async function enqueueInTx(client, type, payload) {
  const id = 'job_' + require('crypto').randomBytes(8).toString('hex');
  await client.query(
    `INSERT INTO jobs (id, type, payload, status) VALUES ($1,$2,$3::jsonb,'pending')`,
    [id, type, JSON.stringify(payload)]
  );
  return id;
}

module.exports = { pendingList, getReview, decide };
