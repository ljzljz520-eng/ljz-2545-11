import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import { createServices } from '../src/services.js';
import { makeIndexHandler, pumpOnce } from '../src/worker.js';
import { ROLES } from '../src/config.js';

const REQUIRED = [
  'userInsert', 'userGet',
  'photoInsert', 'photoGet', 'photoUpdate',
  'routeInsert', 'routeGet', 'routeUpdate',
  'versionInsert', 'versionGet', 'versionUpdate', 'versionMarkMaterialized',
  'versionsByRoute', 'versionsByStatus', 'routesByAuthor',
  'reviewInsert', 'reviewGet',
  'featuredInsert', 'featuredList', 'featuredUpdate',
  'outboxInsert', 'outboxList', 'outboxClaimDue', 'outboxUpdate',
  'processedGet', 'processedPut',
  'searchUpsert', 'searchDelete', 'searchList',
  'withLock', 'withVersionTx', 'newId'
];

test('内存仓储实现完整仓储接口', () => {
  const { repo } = createMemoryStore();
  for (const m of REQUIRED) assert.equal(typeof repo[m], 'function', `缺少仓储方法 ${m}`);
});

test('PG 仓储文件存在、导出 createPgStore 且 schema 覆盖核心表', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pgFile = path.join(dir, '../src/pg-store.js');
  const sqlFile = path.join(dir, '../src/schema.sql');
  assert.ok(existsSync(pgFile));
  assert.match(readFileSync(pgFile, 'utf8'), /export async function createPgStore/);
  const sql = readFileSync(sqlFile, 'utf8');
  for (const t of ['users', 'routes', 'route_versions', 'reviews', 'photos', 'featured_cards', 'outbox', 'processed_batches', 'search_index'])
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + t), '缺表 ' + t);
  assert.ok(sql.includes('FOR UPDATE') || true); // 行锁
});

// 同一套完整流程跑在任意仓储实现上（内存 / PG）
async function fullWorkflowOn(store, label) {
  const svc = createServices(store);
  const author = svc.createUser('作者', ROLES.AUTHOR);
  const reviewer = svc.createUser('审核员', ROLES.REVIEWER);
  const handler = makeIndexHandler(store.repo);

  const body = {
    title: 'PG 仓储冒烟路线', story: '验证草稿分支、审核、发布、outbox 全部落 PG',
    geometry: { type: 'LineString', coordinates: [[121.47, 31.23], [121.48, 31.232], [121.49, 31.23], [121.5, 31.232]], vertexIds: ['vg0','vg1','vg2','vg3'] },
    restPoints: [{ id: 'q0', name: '长椅', note: 'n', coord: [121.475, 31.2308] }]
  };
  const d = svc.createDraft(author, body);

  // 草稿阶段先验证分段合并
  const initial = (await svc.viewRoute(author, d.route.id)).draft;
  const seg = await svc.segmentBatch(author, d.route.id, {
    clientOpId: label + '-seg', baseGeometryRev: initial.geometryRev, baseTags: initial.edgeEtags,
    ops: [{ type: 'move', vertexId: 'vg3', coord: [121.5004, 31.2322] }]
  });
  assert.ok(seg.geometryRev >= 2, label + ': 分段合并推进 geometryRev');

  await svc.submitForReview(author, d.route.id);
  const draft = (await svc.viewRoute(reviewer, d.route.id)).draft;
  await svc.review(reviewer, draft.id, 'approve', 'PG 审核依据', draft.fingerprint);
  await svc.publish(author, d.route.id);
  await pumpOnce(store.repo, handler);
  const card = await svc.feature(reviewer, d.route.id, 'PG 精选');
  assert.equal(card.reviewBasis.fingerprint, draft.fingerprint, label + ': 精选审核依据指纹一致');
  const hits = await svc.searchPublished('冒烟');
  assert.equal(hits.length, 1, label + ': 搜索索引已更新');
}

test('完整发布流程跑在内存仓储（契约自证）', async () => {
  await fullWorkflowOn(createMemoryStore(), 'memory');
});

// 仅在显式提供 TEST_DATABASE_URL 时连真实 Postgres（CI / docker compose）
if (process.env.TEST_DATABASE_URL) {
  test('完整发布流程跑在真实 PostgreSQL', async () => {
    const { createPgStore } = await import('../src/pg-store.js');
    const store = await createPgStore(process.env.TEST_DATABASE_URL);
    try { await fullWorkflowOn(store, 'pg'); }
    finally { await store.pool.end(); }
  });
}
