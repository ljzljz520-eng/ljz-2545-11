'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const geo = require('./services/geo');
const { anyUser, requireRole, authenticate } = require('./services/auth');
const idempotent = require('./services/idempotency');

const routesSvc = require('./services/routes');
const segmentsSvc = require('./services/segments');
const stopsSvc = require('./services/stops');
const photosSvc = require('./services/photos');
const submissions = require('./services/submissions');
const reviewsSvc = require('./services/reviews');
const publishing = require('./services/publishing');
const featuredSvc = require('./services/featured');
const publicSvc = require('./services/public');
const worker = require('./services/worker');

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createApp() {
  const app = express();
  app.use((req, res, next) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        try { req.body = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {}; }
        catch { return res.status(400).json({ error: 'invalid JSON' }); }
      }
      next();
    });
  });

  // ---- static frontend & uploaded photos ----
  app.use('/', express.static(path.join(__dirname, '..', 'public')));
  app.use('/uploads', express.static(photosSvc.UPLOAD_DIR));

  // 健康检查
  app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // 我的路线
  app.get('/api/my/routes', anyUser, asyncH(async (req, res) => {
    res.json(await routesSvc.listMine(req.user));
  }));
  app.post('/api/routes', anyUser, asyncH(async (req, res) => {
    const out = await idempotent(req)(async () => ({ status: 201, body: await routesSvc.createRoute(req.user, req.body || {}) }));
    if (out.__replayed) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  }));
  app.get('/api/routes/:id', anyUser, asyncH(async (req, res) => {
    res.json(await routesSvc.getRoute(req.user, req.params.id));
  }));

  // 整路线保存（全量乐观锁）
  app.put('/api/routes/:id', anyUser, asyncH(async (req, res) => {
    const out = await idempotent(req)(async () => ({ status: 200, body: await routesSvc.saveFullRoute(req.user, req.params.id, req.body || {}) }));
    if (out.__replayed) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  }));
  // 只改文字
  app.patch('/api/routes/:id/text', anyUser, asyncH(async (req, res) => {
    res.json(await stopsSvc.saveText(req.user, req.params.id, req.body || {}));
  }));

  // 分段编辑（细粒度乐观合并）
  app.post('/api/routes/:id/segments/insert', anyUser, asyncH(async (req, res) => {
    res.json(await segmentsSvc.insertVertex(req.user, req.params.id, req.body || {}));
  }));
  app.post('/api/routes/:id/segments/delete', anyUser, asyncH(async (req, res) => {
    res.json(await segmentsSvc.deleteVertex(req.user, req.params.id, req.body || {}));
  }));
  app.post('/api/routes/:id/segments/move', anyUser, asyncH(async (req, res) => {
    res.json(await segmentsSvc.moveVertex(req.user, req.params.id, req.body || {}));
  }));

  // 歇脚点
  app.post('/api/routes/:id/stops', anyUser, asyncH(async (req, res) => {
    res.json(await stopsSvc.addStop(req.user, req.params.id, req.body || {}));
  }));
  app.post('/api/routes/:id/stops/:stopId/relocate', anyUser, asyncH(async (req, res) => {
    res.json(await stopsSvc.relocateStop(req.user, req.params.id, req.params.stopId, req.body || {}));
  }));
  app.patch('/api/routes/:id/stops/:stopId', anyUser, asyncH(async (req, res) => {
    res.json(await stopsSvc.updateStopNote(req.user, req.params.id, req.params.stopId, req.body || {}));
  }));
  app.delete('/api/routes/:id/stops/:stopId', anyUser, asyncH(async (req, res) => {
    res.json(await stopsSvc.deleteStop(req.user, req.params.id, req.params.stopId));
  }));

  // 照片：二进制直传（服务端强制校验类型/大小），避免"提交时照片还没传完"
  app.post('/api/photos', anyUser, asyncH(async (req, res) => {
    const ct = (req.headers['x-photo-content-type'] || '').split(';')[0].trim();
    const out = await photosSvc.uploadPhoto(req.user, { contentType: ct, buffer: req.rawBody });
    res.status(201).json(out);
  }));

  // 提交审核 / 撤回
  app.post('/api/routes/:id/submit', anyUser, asyncH(async (req, res) => {
    const out = await idempotent(req)(async () => ({ status: 202, body: await submissions.submitForReview(req.user, req.params.id, req.body || {}) }));
    if (out.__replayed) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  }));
  app.post('/api/routes/:id/withdraw', anyUser, asyncH(async (req, res) => {
    const out = await idempotent(req)(async () => ({ status: 200, body: await publishing.withdraw(req.user, req.params.id, req.body || {}) }));
    if (out.__replayed) res.set('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  }));

  // 审核端
  app.get('/api/reviews', requireRole('reviewer', 'admin'), asyncH(async (req, res) => {
    res.json(await reviewsSvc.pendingList(req.user));
  }));
  app.get('/api/reviews/:id', requireRole('reviewer', 'admin'), asyncH(async (req, res) => {
    res.json(await reviewsSvc.getReview(req.user, req.params.id));
  }));
  app.post('/api/reviews/:id/decision', requireRole('reviewer', 'admin'), asyncH(async (req, res) => {
    res.json(await reviewsSvc.decide(req.user, req.params.id, req.body || {}));
  }));

  // 精选
  app.post('/api/featured', requireRole('admin'), asyncH(async (req, res) => {
    res.status(201).json(await featuredSvc.createFeatured(req.user, req.body || {}));
  }));
  app.delete('/api/featured/:id', requireRole('admin'), asyncH(async (req, res) => {
    res.json(await featuredSvc.removeFeatured(req.user, req.params.id));
  }));

  // 公开
  app.get('/api/public/featured', asyncH(async (req, res) => {
    res.json(await featuredSvc.publicFeatured());
  }));
  app.get('/api/public/search', asyncH(async (req, res) => {
    res.json(await publicSvc.search(req.query.q));
  }));
  app.get('/api/public/publications/:id', asyncH(async (req, res) => {
    res.json(await publicSvc.getPublicPublication(req.params.id));
  }));

  // 作者看自己路线的审核历史（含被作废说明）
  app.get('/api/routes/:id/reviews', anyUser, asyncH(async (req, res) => {
    await routesSvc.getRoute(req.user, req.params.id); // 鉴权：仅作者本人/管理员
    const { getPool } = require('./db/pool');
    const r = await getPool().query(
      `SELECT r.id, r.decision, r.comment, r.decided_at, r.superseded_at, r.superseded_reason,
              rv.version
         FROM reviews r JOIN route_revisions rv ON rv.id=r.revision_id
        WHERE r.route_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  }));

  // 错误处理
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: err.message, details: err.details || undefined });
  });

  return app;
}

async function main() {
  const { startEmbedded } = require('./db/embedded');
  const { migrate } = require('./db/migrate');
  if (config.EMBEDDED.enabled) await startEmbedded();
  await migrate();
  const app = createApp();
  const server = app.listen(config.PORT, () => console.log('[server] listening on ' + config.PORT));
  worker.start();

  const shutdown = async () => {
    server.close();
    await worker.stop();
    const { stopEmbedded } = require('./db/embedded');
    if (config.EMBEDDED.enabled) await stopEmbedded();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, main, worker };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
