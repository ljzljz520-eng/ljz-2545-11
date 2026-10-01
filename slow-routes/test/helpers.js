'use strict';
// 共享测试引导：启动内嵌 PG + 迁移 + Express app + worker drain
const path = require('path');
process.chdir(path.join(__dirname, '..'));

let app, request;
async function boot() {
  // fresh cluster for deterministic tests
  require('fs').rmSync(require('path').join(__dirname, '..', 'data', 'db'), { recursive: true, force: true });
  await require('../src/db/embedded').startEmbedded();
  await require('../src/db/migrate').migrate();
  const srv = require('../src/server');
  app = srv.createApp();
  request = require('supertest');
  return { app, request, worker: srv.worker };
}
async function shutdown() {
  await require('../src/db/embedded').stopEmbedded();
}

const T = {
  author: 'token-author', author2: 'token-author2',
  reviewer: 'token-reviewer', admin: 'token-admin'
};
function auth(token) { return { Authorization: 'Bearer ' + token }; }
function idem(key) { return { 'Idempotency-Key': key }; }

let n = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS', name); }
  else { console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); process.exitCode = 1; }
}
function gid(prefix) { n += 1; return prefix + '-' + n; }

async function drain(worker) {
  const left = await worker.drain(100);
  if (left.length) console.log('  (unfinished jobs)', JSON.stringify(left));
  return left;
}

// 画一条合法折线：n 个点，大致东西走向，微抖动
function line(n, startLng = 121.45, lat = 31.22) {
  const coords = [];
  for (let i = 0; i < n; i++) {
    coords.push([Number((startLng + i * 0.004).toFixed(6)), Number((lat + (i % 2) * 0.0008).toFixed(6))]);
  }
  return { type: 'LineString', coordinates: coords };
}

async function createPublishedRoute(request, app, { title = '苏州河慢行道', story = '沿河黄昏的故事，有桥有水', withStop = true, photo = true } = {}) {
  let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title, story });
  const rid = r.body.id;
  const geom = line(5);
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title, story, geometry: geom });
  if (withStop) {
    await request(app).post('/api/routes/' + rid + '/stops').set(auth(T.author))
      .send({ name: '四号渡口', note: '长椅与树荫', coordinates: geom.coordinates[2].concat() });
  }
  let photoId = null;
  if (photo) {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const up = await request(app).post('/api/photos').set(auth(T.author))
      .set('X-Photo-Content-Type', 'image/png').send(png);
    photoId = up.body.id;
  }
  const sub = await request(app).post('/api/routes/' + rid + '/submit')
    .set(auth(T.author)).set(idem(gid('k')))
    .send({ reason: '第一次投稿', photo_ids: photoId ? [photoId] : [] });
  const reviewId = sub.body.review_id;
  const dec = await request(app).post('/api/reviews/' + reviewId + '/decision')
    .set(auth(T.reviewer)).send({ decision: 'approved', comment: '路线清楚，歇脚点合理' });
  return { rid, reviewId, publishJob: dec.body.job_id, geom };
}

module.exports = { boot, shutdown, app: () => app, request: () => request, T, auth, idem, assert, gid, drain, line, createPublishedRoute };
