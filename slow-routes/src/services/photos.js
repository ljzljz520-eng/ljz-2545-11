'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tx, getPool } = require('../db/pool');
const { ValidationError } = require('./geo');
const L = require('../config').LIMITS;
const { audit } = require('./store');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'
};

// 上传采用两步：1) POST /photos 直传二进制（服务端校验类型/大小）；2) 提交路线时只允许引用 ready 照片
async function uploadPhoto(user, { contentType, buffer }) {
  const ext = ALLOWED[contentType];
  if (!ext) throw new ValidationError('只支持 jpeg/png/webp', { contentType });
  if (buffer.length > L.PHOTO_MAX_BYTES) throw new ValidationError('照片超过 ' + (L.PHOTO_MAX_BYTES / 1024 / 1024) + 'MB');
  const id = 'ph_' + crypto.randomBytes(10).toString('hex');
  const filename = id + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  await getPool().query(
    `INSERT INTO photos (id, author_id, filename, bytes, status) VALUES ($1,$2,$3,$4,'ready')`,
    [id, user.id, filename, buffer.length]
  );
  return { id, filename, bytes: buffer.length, status: 'ready' };
}

// 提交时把照片挂到路线（必须都是本人、ready、存在）
async function attachPhotos(client, user, routeId, photoIds) {
  const ids = Array.isArray(photoIds) ? photoIds : [];
  if (ids.length === 0) return [];
  const r = await client.query(
    `SELECT id, status, author_id, route_id FROM photos
       WHERE id = ANY($1::text[]) FOR UPDATE`, [ids]);
  if (r.rowCount !== ids.length) {
    const found = new Set(r.rows.map((x) => x.id));
    throw new ValidationError('部分照片不存在或尚未上传完成', { missing: ids.filter((x) => !found.has(x)) });
  }
  for (const p of r.rows) {
    if (p.author_id !== user.id && user.role !== 'admin') throw new ValidationError('不能引用他人照片', { id: p.id });
    if (p.status !== 'ready') throw new ValidationError('照片未上传完成，不能提交', { id: p.id, status: p.status });
    if (p.route_id && p.route_id !== routeId) throw new ValidationError('照片已被其他路线占用', { id: p.id });
  }
  await client.query('UPDATE photos SET route_id=$2 WHERE id = ANY($1::text[])', [ids, routeId]);
  return ids;
}

module.exports = { uploadPhoto, attachPhotos, UPLOAD_DIR };
