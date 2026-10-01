'use strict';
const { getPool } = require('../db/pool');
const { NotFoundError } = require('./geo');

// 公开搜索：只命中当前 head 发布快照；撤回后不命中
async function search(q) {
  const term = String(q || '').trim();
  if (!term) {
    const r = await getPool().query(
      `SELECT s.route_id, s.publication_id, s.title, p.published_at
         FROM search_index s JOIN publications p ON p.id = s.publication_id
        WHERE p.withdrawn_at IS NULL
        ORDER BY p.published_at DESC LIMIT 50`);
    return r.rows;
  }
  const r = await getPool().query(
    `SELECT s.route_id, s.publication_id, s.title,
            ts_rank(s.tsv, plainto_tsquery('simple', $1)) AS rank,
            p.published_at
       FROM search_index s
       JOIN publications p ON p.id = s.publication_id
      WHERE p.withdrawn_at IS NULL
        AND (s.tsv @@ plainto_tsquery('simple', $1) OR s.title ILIKE '%' || $1 || '%')
      ORDER BY rank DESC, p.published_at DESC LIMIT 50`, [term]);
  return r.rows;
}

// 旧链接：按发布快照 id 访问。撤回后仍可读快照 + 状态说明；不存在或草稿 => 404，不泄漏
async function getPublicPublication(publicationId) {
  const r = await getPool().query(
    `SELECT p.id, p.route_id, p.revision_version, p.title, p.story, p.geometry,
            p.stop_snapshots, p.published_at, p.withdrawn_at, p.withdrawn_note,
            p.approved_review_id, r.decided_at, r.comment AS review_comment,
            u.display_name AS reviewer_name
       FROM publications p
       JOIN reviews r ON r.id = p.approved_review_id
       JOIN users u ON u.id = r.reviewer_id
      WHERE p.id = $1`, [publicationId]);
  if (r.rowCount === 0) throw new NotFoundError('链接对应的发布版本不存在（可能从未发布）');
  const x = r.rows[0];
  return {
    publication_id: x.id,
    route_id: x.route_id,
    revision_version: x.revision_version,
    title: x.title,
    story: x.story,
    geometry: x.geometry,
    stops: x.stop_snapshots,
    published_at: x.published_at,
    withdrawn: !!x.withdrawn_at,
    status_note: x.withdrawn_at
      ? '该路线已由作者撤回（' + (x.withdrawn_note || '') + '）。你看到的是撤回前的发布快照；作者的新草稿不公开。'
      : null,
    withdrawn_at: x.withdrawn_at,
    // 完整审核依据（公开卡也可溯源）
    audit_basis: {
      review_id: x.approved_review_id,
      decided_at: x.decided_at,
      reviewer: x.reviewer_name,
      comment: x.review_comment
    }
  };
}

module.exports = { search, getPublicPublication };
