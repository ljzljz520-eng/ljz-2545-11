'use strict';
const { tx, getPool } = require('../db/pool');
const { NotFoundError, ValidationError, ConflictError } = require('./geo');
const L = require('../config').LIMITS;
const { uid, audit } = require('./store');

// 精选：只能引用发布快照；且该发布版必须带"完整审核依据"（未失效的 approved 审核）
async function createFeatured(user, body) {
  const publicationId = String(body.publication_id || '');
  const blurb = String(body.blurb || '').trim();
  if (!publicationId) throw new ValidationError('publication_id 必填');
  if (blurb.length < 2 || blurb.length > L.BLURB_MAX) throw new ValidationError('推荐语 2-' + L.BLURB_MAX + ' 字');

  return tx(async (client) => {
    const pub = await client.query(
      `SELECT p.*, r.decision, r.superseded_at, rt.status AS route_status
         FROM publications p
         JOIN reviews r ON r.id = p.approved_review_id
         JOIN routes rt ON rt.id = p.route_id
        WHERE p.id = $1 FOR UPDATE`, [publicationId]);
    if (pub.rowCount === 0) throw new NotFoundError('发布版本不存在');
    const p = pub.rows[0];
    if (p.withdrawn_at) throw new ConflictError('该发布版已撤回，不能精选', { withdrawn_note: p.withdrawn_note });
    if (p.decision !== 'approved' || p.superseded_at) {
      throw new ConflictError('该发布版缺少有效的审核依据，不能精选');
    }
    const dup = await client.query(
      'SELECT 1 FROM featured_cards WHERE publication_id=$1 AND removed_at IS NULL', [publicationId]);
    if (dup.rowCount > 0) throw new ConflictError('该发布版已在精选中');

    const id = uid('fc');
    await client.query(
      'INSERT INTO featured_cards (id, publication_id, blurb, created_by) VALUES ($1,$2,$3,$4)',
      [id, publicationId, blurb, user.id]);
    await audit(client, user.id, p.route_id, 'featured.create', { card: id, publication: publicationId });
    return { id, publication_id: publicationId, blurb };
  });
}

async function removeFeatured(user, cardId) {
  return tx(async (client) => {
    const r = await client.query('SELECT * FROM featured_cards WHERE id=$1 FOR UPDATE', [cardId]);
    if (r.rowCount === 0) throw new NotFoundError('精选卡不存在');
    await client.query('UPDATE featured_cards SET removed_at=now() WHERE id=$1', [cardId]);
    await audit(client, user.id, null, 'featured.remove', { card: cardId });
    return { id: cardId, removed: true };
  });
}

// 公开精选：始终是发布快照（含已撤回卡的状态说明），绝不出现草稿
async function publicFeatured() {
  const r = await getPool().query(
    `SELECT f.id AS card_id, f.blurb, f.created_at,
            p.id AS publication_id, p.title, p.story, p.geometry, p.stop_snapshots,
            p.published_at, p.withdrawn_at, p.withdrawn_note, p.route_id,
            p.revision_version, p.approved_review_id
       FROM featured_cards f
       JOIN publications p ON p.id = f.publication_id
      WHERE f.removed_at IS NULL
      ORDER BY f.created_at DESC`);
  return r.rows.map((x) => ({
    card_id: x.card_id,
    blurb: x.blurb,
    published_at: x.published_at,
    withdrawn: !!x.withdrawn_at,
    withdrawn_note: x.withdrawn_note || null,
    // 快照引用：链接永远指向这个发布版本
    snapshot: {
      publication_id: x.publication_id,
      route_id: x.route_id,
      revision_version: x.revision_version,
      title: x.title,
      story: x.story,
      geometry: x.geometry,
      stops: x.stop_snapshots,
      approved_review_id: x.approved_review_id
    }
  }));
}

module.exports = { createFeatured, removeFeatured, publicFeatured };
