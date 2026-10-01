'use strict';
const { tx, getPool } = require('../db/pool');
const { ValidationError, ConflictError, NotFoundError, fingerprintGeometry, fingerprintText } = require('./geo');
const L = require('../config').LIMITS;
const { uid, loadRouteLocked, listStops, audit } = require('./store');
const { attachPhotos } = require('./photos');

// 提交审核：冻结一个不可变版本；服务端校验几何/文字/歇脚点/照片完整性
async function submitForReview(user, routeId, body) {
  const reason = String(body.reason || '');
  if (reason.length > L.REASON_MAX) throw new ValidationError('投稿说明过长');
  const photoIds = body.photo_ids || [];

  return tx(async (client) => {
    const route = await loadRouteLocked(client, routeId);
    if (!route || (route.author_id !== user.id && user.role !== 'admin')) throw new NotFoundError('route not found');
    if (route.status === 'in_review' && route.active_review_id) {
      const live = await client.query(
        `SELECT 1 FROM reviews WHERE id=$1 AND decision='pending' AND superseded_at IS NULL`,
        [route.active_review_id]);
      if (live.rowCount > 0) throw new ConflictError('该路线已有进行中的审核，请等待结果或撤回编辑', { status: route.status });
    }
    // published：只有作者已在草稿上做出新改动（新几何/文字版本）时才允许投下一版；
    // 内容没变的重复投稿直接拒绝。
    if (route.status === 'published') {
      const head = await client.query(
        `SELECT rv.geom_fingerprint AS gf, rv.text_fingerprint AS tf
           FROM publications p JOIN route_revisions rv ON rv.id = p.revision_id
          WHERE p.id = $1`, [route.published_revision_id]);
      if (head.rowCount > 0 &&
          head.rows[0].gf === route.geom_fingerprint &&
          head.rows[0].tf === route.text_fingerprint) {
        throw new ConflictError('当前版本已发布且草稿无改动；请修改后再投稿新版本', { status: 'published' });
      }
    }

    // 1) 几何服务端复核（不能靠客户端）
    if (!route.working_geom || !Array.isArray(route.working_geom.coordinates) ||
        route.working_geom.coordinates.length < L.MIN_POINTS) {
      throw new ValidationError('路线几何不完整，无法提交');
    }
    // 2) 文字
    if (!route.title || route.title.trim().length < L.TITLE_MIN) throw new ValidationError('标题不完整');
    if (String(route.story || '').trim().length < 5) throw new ValidationError('请先填写路线故事');

    // 3) 歇脚点：几何改动后必须全部重新定位完
    const stops = await listStops(client, routeId);
    const pending = stops.filter((s) => s.status === 'needs_relocation');
    if (pending.length) {
      throw new ConflictError('还有歇脚点在路段插删后未重新定位，不能提交', {
        stop_ids: pending.map((s) => s.id)
      });
    }

    // 4) 照片：必须已经上传完成（两步上传；不能只凭客户端 manifest）
    await attachPhotos(client, user, routeId, photoIds);
    const photoRows = (await client.query(
      'SELECT id, status FROM photos WHERE route_id=$1', [routeId]
    )).rows;
    const bad = photoRows.filter((p) => p.status !== 'ready');
    if (bad.length) throw new ConflictError('照片未上传完成，不能提交', { photos: bad });

    // 5) 冻结不可变版本快照
    const nextVer = Number(route.draft_version) + (route.status === 'draft' ? 0 : 1);
    const version = Number(
      (await client.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM route_revisions WHERE route_id=$1', [routeId])).rows[0].v
    );
    const gf = fingerprintGeometry(route.working_geom);
    const tf = fingerprintText({ title: route.title, story: route.story || '' });
    const revisionId = uid('rv');
    await client.query(
      `INSERT INTO route_revisions
        (id, route_id, version, kind, geometry, story, title, stop_snapshots, reason, created_by,
         geom_fingerprint, text_fingerprint)
       VALUES ($1,$2,$3,'submit',$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
      [revisionId, routeId, version, JSON.stringify(route.working_geom), route.story || '',
       route.title, JSON.stringify(stops.map((s) => ({ id: s.id, name: s.name, note: s.note, coordinates: s.coordinates }))),
       reason, user.id, gf, tf]
    );
    const reviewId = uid('rw');
    await client.query(
      `INSERT INTO reviews (id, route_id, revision_id, reviewer_id, decision, comment,
                            bound_geom_fingerprint, bound_text_fingerprint)
       VALUES ($1,$2,$3,(SELECT id FROM users WHERE role='reviewer' ORDER BY random() LIMIT 1),
               'pending', NULL, $4, $5)`,
      [reviewId, routeId, revisionId, gf, tf]
    );
    await client.query(
      `UPDATE routes SET status=$2, active_review_id=$3, draft_version=$4,
                         geom_fingerprint=$5, text_fingerprint=$6, updated_at=now()
         WHERE id=$1`,
      [routeId, 'in_review', reviewId, version, gf, tf]
    );
    await audit(client, user.id, routeId, 'route.submit', { revision: revisionId, review: reviewId, reason });
    return { route_id: routeId, revision_id: revisionId, version, review_id: reviewId, status: 'in_review' };
  });
}

async function listReviewsForAuthor(client, routeId) {
  return (await client.query(
    `SELECT r.id, r.decision, r.comment, r.bound_geom_fingerprint, r.bound_text_fingerprint,
            r.decided_at, r.superseded_at, r.superseded_reason, r.revision_id, rv.version,
            r.reviewer_id
       FROM reviews r JOIN route_revisions rv ON rv.id = r.revision_id
      WHERE r.route_id=$1 ORDER BY r.created_at DESC`, [routeId])).rows;
}

module.exports = { submitForReview, listReviewsForAuthor };
