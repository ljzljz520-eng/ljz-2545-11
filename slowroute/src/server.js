import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApiError, unauthorized } from './errors.js';
import { createMemoryStore } from './memory-store.js';
import { createServices } from './services.js';
import { makeIndexHandler, pumpOnce, startWorker } from './worker.js';
import { ROLES } from './config.js';

export async function createApp({ autostartWorker = true, port: listenPort = 0, store: injectedStore } = {}) {
  const store = injectedStore || createMemoryStore();
  const services = createServices(store);
  const handler = makeIndexHandler(store.repo);
  const worker = autostartWorker ? startWorker(store.repo, handler) : null;

  // 演示种子用户；生产环境由会话中间件提供 req.user
  const author = services.createUser('作者-小林', ROLES.AUTHOR);
  const reviewer = services.createUser('审核员-老周', ROLES.REVIEWER);
  const users = new Map([[author.id, author], [reviewer.id, reviewer]]);

  const idempotency = new Map(); // 整包提交幂等（离线重送）

  const authenticate = async (req) => {
    const token = req.headers['x-user-id'];
    if (!token) return null;
    return users.get(token) || (await store.repo.userGet(token)) || null;
  };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 2_000_000) throw new ApiError(413, 'body_too_large', '请求体过大');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ApiError(400, 'bad_json', 'JSON 解析失败'); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        const user = await authenticate(req);
        const seg = p.split('/').filter(Boolean);
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const need = (asReviewer = false) => {
          if (!user) throw unauthorized();
          if (asReviewer && user.role !== ROLES.REVIEWER) throw new ApiError(403, 'forbidden', '仅审核员可操作');
          return user;
        };

        if (req.method === 'GET' && p === '/api/session')
          return send(res, 200, { users: [author, reviewer], me: user || null });

        if (req.method === 'POST' && p === '/api/photos') return send(res, 201, services.initPhoto(need(), body));
        if (req.method === 'POST' && /^\/api\/photos\/[^/]+\/complete$/.test(p))
          return send(res, 200, services.completePhoto(need(), decodeURIComponent(seg[2])));

        if (p === '/api/routes') {
          if (req.method === 'POST') {
            const me = need();
            const idem = req.headers['idempotency-key'];
            if (idem && idempotency.has(me.id + ':' + idem))
              return send(res, 200, idempotency.get(me.id + ':' + idem).body);
            const out = await services.createDraft(me, body);
            if (idem) idempotency.set(me.id + ':' + idem, { body: out, at: Date.now() });
            return send(res, 201, out);
          }
          if (req.method === 'GET') {
            const me = need();
            const mine = await services.listMyRoutes(me);
            return send(res, 200, me.role === ROLES.REVIEWER
              ? { mine, inReview: await services.listInReview(me) } : { mine });
          }
        }

        const routeId = seg[2] && seg[2].startsWith('route_') ? decodeURIComponent(seg[2]) : null;
        if (routeId) {
          const rId = routeId;
          if (req.method === 'GET' && seg.length === 3) return send(res, 200, await services.viewRoute(user, rId));
          if (req.method === 'PUT' && seg.length === 3)
            return send(res, 200, await services.replaceWhole(need(), rId, body, req.headers['x-expected-geometry-rev']));
          if (req.method === 'PATCH' && seg[3] === 'segment-batch')
            return send(res, 200, await services.segmentBatch(need(), rId, body));
          if (req.method === 'PATCH' && seg[3] === 'story')
            return send(res, 200, await services.updateStory(need(), rId, body));
          if (req.method === 'POST' && seg[3] === 'submit')
            return send(res, 200, await services.submitForReview(need(), rId));
          if (req.method === 'POST' && seg[3] === 'withdraw')
            return send(res, 200, await services.withdraw(need(), rId, body.reason));
          if (req.method === 'POST' && seg[3] === 'publish')
            return send(res, 200, await services.publish(need(), rId));
          if (req.method === 'POST' && seg[3] === 'feature')
            return send(res, 201, await services.feature(need(true), rId, body.reason));
        }

        const mNote = p.match(/^\/api\/versions\/([^/]+)\/points\/([^/]+)\/note$/);
        if (mNote && req.method === 'PUT') {
          const me = need();
          const ver = await store.repo.versionGet(decodeURIComponent(mNote[1]));
          if (!ver) throw new ApiError(404, 'version_not_found', '版本不存在');
          return send(res, 200, await services.updateNote(me, ver.routeId, decodeURIComponent(mNote[2]), body.note, req.headers['x-expected-note-rev']));
        }
        const versionId = seg[2] && seg[2].startsWith('ver_') ? decodeURIComponent(seg[2]) : null;
        if (versionId && req.method === 'GET' && seg.length === 3)
          return send(res, 200, await services.viewVersion(user, versionId));
        if (versionId && req.method === 'POST' && seg[3] === 'review') {
          const me = need(true);
          return send(res, 200, await services.review(me, versionId, body.action, body.reason, body.expectedFingerprint));
        }

        if (req.method === 'GET' && p === '/api/featured')
          return send(res, 200, { cards: services.listFeatured().filter((c) => c.active) });
        if (req.method === 'GET' && p === '/api/search')
          return send(res, 200, { results: await services.searchPublished(url.searchParams.get('q')) });

        if (req.method === 'POST' && p === '/api/admin/pump') {
          need(true);
          const n = await pumpOnce(store.repo, body.failTimes ? makeFlakyHandler(handler, body.failTimes) : handler);
          return send(res, 200, { processed: n, outbox: await store.repo.outboxList() });
        }

        return send(res, 404, { error: 'not_found', message: '未知 API 路径' });
      }
      return await serveStatic(p, res);
    } catch (e) {
      if (e instanceof ApiError)
        return send(res, e.status, { error: e.code, message: e.message, details: e.details });
      send(res, 500, { error: 'internal', message: String((e && e.message) || e) });
    }
  });

  // 让每一条任务的前 failTimes 次执行都失败（用于验收退避重试）
  function makeFlakyHandler(base, failTimes) {
    return async (task) => {
      if (task.attempts <= failTimes) throw new Error('search backend temporarily unavailable');
      return base(task);
    };
  }

  await new Promise((r) => server.listen(listenPort, r));
  return {
    port: server.address().port,
    server, services, store, repo: store.repo,
    users: { author, reviewer, byId: (id) => users.get(id) },
    pump: () => pumpOnce(store.repo, handler),
    // 让所有待重试任务立即到期（验收退避时用，生产由指数退避自然到期）
    async expireBackoff() {
      for (const t of await store.repo.outboxList()) {
        if (t.status === 'pending') await store.repo.outboxUpdate({ ...t, runAfter: new Date(0).toISOString() });
      }
    },
    flakyPump: (failTimes) => pumpOnce(store.repo, makeFlakyHandler(handler, failTimes)),
    stop: async () => { if (worker) await worker.stop(); if (store.repo.pool) await store.repo.pool.end(); await new Promise((r) => server.close(r)); }
  };
}

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
async function serveStatic(urlPath, res) {
  const rel = (urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')).split('?')[0];
  if (rel.includes('..')) { res.writeHead(400); return res.end('bad path'); }
  try {
    const file = path.join(STATIC_DIR, rel);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404'); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const port = Number(process.env.PORT || 3000);
    let store;
    if (process.env.DATABASE_URL) {
      const { createPgStore } = await import('./pg-store.js');
      store = await createPgStore(process.env.DATABASE_URL);
      console.log('using PostgreSQL store');
    }
    await createApp({ port, store });
    console.log(`slowroute on http://localhost:${port}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
