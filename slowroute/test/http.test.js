import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app, base, authorId, reviewerId;

async function call(method, path, { userId, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const body = () => ({
  title: '苏州河慢行走廊', story: '沿河歇脚，傍晚很舒服。',
  geometry: { type: 'LineString', coordinates: [[121.47, 31.23], [121.48, 31.232], [121.49, 31.23], [121.5, 31.232]], vertexIds: ['v0', 'v1', 'v2', 'v3'] },
  restPoints: [{ id: 'p0', name: '河边长椅', note: '有棚子', coord: [121.475, 31.2308] }]
});

beforeEach(async () => {
  app = await createApp({ autostartWorker: false });
  base = `http://127.0.0.1:${app.port}`;
  authorId = app.users.author.id;
  reviewerId = app.users.reviewer.id;
});
afterEach(async () => { if (app) { await app.stop(); app = null; } });

test('未认证写操作 401', async () => {
  const r = await call('POST', '/api/routes', { body: body() });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'unauthorized');
});

test('坏 JSON / 非 LineString / 越界坐标都返回机器可读错误码', async () => {
  const res = await fetch(base + '/api/routes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': authorId }, body: '{bad'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_json');

  let r = await call('POST', '/api/routes', { userId: authorId, body: { ...body(), geometry: { type: 'Point', coordinates: [121, 31] } } });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'not_linestring');

  r = await call('POST', '/api/routes', { userId: authorId, body: { ...body(), geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } } });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'coord_out_of_bounds');
  assert.ok(r.json.details.bounds, '错误体应带边界说明');
});

test('Idempotency-Key 重放返回同一草稿（离线重送整包）', async () => {
  const h = { 'Idempotency-Key': 'web-1' };
  const r1 = await call('POST', '/api/routes', { userId: authorId, body: body(), headers: h });
  const r2 = await call('POST', '/api/routes', { userId: authorId, body: body(), headers: h });
  assert.equal(r1.status, 201);
  assert.equal(r2.json.version.id, r1.json.version.id);
});

test('完整发布流：提交->审核必须带正确指纹->发布->公开搜索', async () => {
  const r = await call('POST', '/api/routes', { userId: authorId, body: body() });
  const routeId = r.json.route.id;
  const versionId = r.json.version.id;
  let x = await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  assert.equal(x.json.status, 'in_review');

  // 错误指纹审核 -> 409
  x = await call('POST', `/api/versions/${versionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: 'ok', expectedFingerprint: 'sha256:wrong' }
  });
  assert.equal(x.status, 409); assert.equal(x.json.error, 'fingerprint_mismatch');

  const fp = (await call('GET', `/api/routes/${routeId}`, { userId: reviewerId })).json.draft.fingerprint;
  x = await call('POST', `/api/versions/${versionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: '几何与文字核对无误', expectedFingerprint: fp }
  });
  assert.equal(x.json.version.status, 'approved');

  x = await call('POST', `/api/routes/${routeId}/publish`, { userId: authorId, body: {} });
  assert.equal(x.json.version.status, 'published');
  await app.pump();
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('苏州河'));
  assert.equal(s.json.results.length, 1);
});

test('照片未上传完不能送审（服务端闸门）', async () => {
  let r = await call('POST', '/api/photos', { userId: authorId, body: { filename: 'a.jpg', bytes: 1234 } });
  const photoId = r.json.id;
  r = await call('POST', '/api/routes', { userId: authorId, body: { ...body(), photoIds: [photoId] } });
  const routeId = r.json.route.id;
  r = await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'photos_not_ready');
  assert.deepEqual(r.json.details.missing, [photoId]);
  await call('POST', `/api/photos/${photoId}/complete`, { userId: authorId, body: {} });
  r = await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  assert.equal(r.status, 200);
});

test('审核中改危险路口：旧链接 410 带状态说明，不含几何/故事，需重新审核', async () => {
  let r = await call('POST', '/api/routes', { userId: authorId, body: body() });
  const routeId = r.json.route.id; const oldVersionId = r.json.version.id;
  await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  const changed = body();
  changed.geometry = {
    type: 'LineString',
    coordinates: [[121.47, 31.23], [121.4812, 31.233], [121.49, 31.23], [121.5, 31.232]],
    vertexIds: ['vnw0','vnw1','vnw2','vnw3']
  };
  r = await call('PUT', `/api/routes/${routeId}`, {
    userId: authorId, body: { ...changed, restPoints: [] }, headers: { 'x-expected-geometry-rev': '1' }
  });
  assert.equal(r.status, 200); assert.ok(r.json.superseded);

  // 匿名访问旧版本 -> 410，仅状态说明
  const g = await call('GET', `/api/versions/${oldVersionId}`);
  assert.equal(g.status, 410);
  assert.equal(g.json.error, 'version_withdrawn');
  assert.ok(g.json.details.stateNote.includes('自动关闭'));
  assert.equal(g.json.details.geometry, undefined);
  assert.equal(g.json.details.story, undefined);
  assert.equal(g.json.details.supersededById, undefined, '匿名不得看到后继草稿 id');

  // 审核员裁决旧版失败
  const rev = await call('POST', `/api/versions/${oldVersionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: '旧同意', expectedFingerprint: 'whatever' }
  });
  assert.equal(rev.status, 409);
  assert.equal(rev.json.error, 'not_in_review');
});

test('撤回与审核竞争：先撤回则审核 409；精选卡失活保留说明；搜索移除', async () => {
  const r = await call('POST', '/api/routes', { userId: authorId, body: body() });
  const routeId = r.json.route.id; const versionId = r.json.version.id;
  await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  const fp = (await call('GET', `/api/routes/${routeId}`, { userId: reviewerId })).json.draft.fingerprint;
  await call('POST', `/api/versions/${versionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: '通过', expectedFingerprint: fp }
  });
  await call('POST', `/api/routes/${routeId}/publish`, { userId: authorId, body: {} });
  await call('POST', `/api/routes/${routeId}/feature`, { userId: reviewerId, body: { reason: '亲子友好' } });
  await app.pump();
  assert.equal((await call('GET', '/api/featured')).json.cards.length, 1);

  const w = await call('POST', `/api/routes/${routeId}/withdraw`, { userId: authorId, body: { reason: '施工封闭' } });
  assert.equal(w.json.version.status, 'withdrawn');
  await app.pump();
  assert.equal((await call('GET', '/api/featured')).json.cards.length, 0);
  assert.equal((await call('GET', '/api/search?q=苏州河')).json.results.length, 0);

  // 匿名访问路线整体 -> 404，未公开草稿不泄漏
  const anon = await call('GET', `/api/routes/${routeId}`);
  assert.equal(anon.status, 404);
});

test('精选卡内容是发布快照：之后新草稿不会出现在卡片里', async () => {
  const r = await call('POST', '/api/routes', { userId: authorId, body: body() });
  const routeId = r.json.route.id; const versionId = r.json.version.id;
  await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  const fp = (await call('GET', `/api/routes/${routeId}`, { userId: reviewerId })).json.draft.fingerprint;
  await call('POST', `/api/versions/${versionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: '通过', expectedFingerprint: fp }
  });
  await call('POST', `/api/routes/${routeId}/publish`, { userId: authorId, body: {} });
  await call('POST', `/api/routes/${routeId}/feature`, { userId: reviewerId, body: { reason: '推荐' } });
  await app.pump();
  const card = (await call('GET', '/api/featured')).json.cards[0];
  assert.equal(card.snapshot.title, '苏州河慢行走廊');
  assert.equal(card.reviewBasis.fingerprint, fp);
  assert.ok(card.reviewBasis.reason);
});

test('后台 pump 可被运维驱动并暴露重试状态', async () => {
  const r = await call('POST', '/api/routes', { userId: authorId, body: body() });
  const routeId = r.json.route.id; const versionId = r.json.version.id;
  await call('POST', `/api/routes/${routeId}/submit`, { userId: authorId, body: {} });
  const fp = r.json.version.fingerprint;
  await call('POST', `/api/versions/${versionId}/review`, {
    userId: reviewerId, body: { action: 'approve', reason: '通过', expectedFingerprint: fp }
  });
  await call('POST', `/api/routes/${routeId}/publish`, { userId: authorId, body: {} });
  // 第一次 pump：每条任务的第 1 次执行失败，任务回到 pending 带退避
  let pump = await call('POST', '/api/admin/pump', { userId: reviewerId, body: { failTimes: 1 } });
  assert.equal(pump.status, 200);
  let st = pump.json.outbox.find((t) => t.task === 'search_index');
  assert.equal(st.status, 'pending');
  assert.equal(st.attempts, 1);
  // 让退避到期后再 pump 一次：attempts=2 > failTimes，成功
  await app.expireBackoff();
  pump = await call('POST', '/api/admin/pump', { userId: reviewerId, body: { failTimes: 1 } });
  st = pump.json.outbox.find((t) => t.task === 'search_index');
  assert.equal(st.status, 'done');
  assert.equal(st.attempts, 2);
  const s = await call('GET', '/api/search?q=苏州河');
  assert.equal(s.json.results.length, 1);
});
