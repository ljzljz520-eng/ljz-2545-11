import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/memory-store.js';
import { createServices } from '../src/services.js';
import { makeIndexHandler, pumpOnce } from '../src/worker.js';
import { ROLES } from '../src/config.js';

let store, svc, author, reviewer, indexHandler;

const coords = (extra = []) => [
  [121.4700, 31.2300],
  [121.4800, 31.2320],
  [121.4900, 31.2300],
  [121.5000, 31.2320],
  ...extra
];
const ids = ['v0', 'v1', 'v2', 'v3'];

function draftBody(over = {}) {
  return {
    title: over.title ?? '苏州河慢行走廊',
    story: over.story ?? '沿河三个歇脚点，傍晚很舒服。',
    geometry: over.geometry ?? { type: 'LineString', coordinates: coords(over.extraCoords || []), vertexIds: over.vertexIds || ids },
    restPoints: over.restPoints ?? [
      { id: 'p0', name: '河边长椅', note: '有遮阳棚', coord: [121.475, 31.2308], photoIds: [] },
      { id: 'p1', name: '二号桥洞', note: '雨天可避', coord: [121.495, 31.2308], photoIds: [] }
    ],
    photoIds: over.photoIds ?? []
  };
}

async function makeRoute(author, body = draftBody()) {
  const d = svc.createDraft(author, body);
  return d;
}
async function fullApprove(author, reviewer, routeId, reason = '几何清晰、故事完整、路口安全') {
  await svc.submitForReview(author, routeId);
  const route = await svc.viewRoute(author, routeId);
  const v = route.draft;
  const r = await svc.review(reviewer, v.id, 'approve', reason, v.fingerprint);
  await svc.publish(author, routeId);
  await pumpOnce(store.repo, indexHandler);
  return { route: await svc.viewRoute(author, routeId), review: r.review };
}

beforeEach(() => {
  store = createMemoryStore();
  svc = createServices(store);
  author = svc.createUser('小林', ROLES.AUTHOR);
  reviewer = svc.createUser('老周', ROLES.REVIEWER);
  indexHandler = makeIndexHandler(store.repo);
});

// 1. 同时编辑同一路段：后到者冲突；不同路段可合并
test('验收1: 同时编辑同一路段触发 same_segment_conflict，不同路段可合并', async () => {
  const { route, version } = await makeRoute(author);
  const baseTags = version.edgeEtags;
  // 服务端先应用一次（模拟 A 的编辑先到）
  await svc.segmentBatch(author, route.id, {
    clientOpId: 'op-A', baseGeometryRev: 1, baseTags,
    ops: [{ type: 'move', vertexId: 'v1', coord: [121.4805, 31.2325] }]
  });
  // B 仍基于 rev1 且也动 v1 所在边 -> 冲突
  await assert.rejects(
    svc.segmentBatch(author, route.id, {
      clientOpId: 'op-B', baseGeometryRev: 1, baseTags,
      ops: [{ type: 'move', vertexId: 'v1', coord: [121.4802, 31.2318] }]
    }),
    (e) => e.code === 'same_segment_conflict'
  );
  // B rebase 后改后段 v3，可合并
  const fresh = (await svc.viewRoute(author, route.id)).draft;
  const ok = await svc.segmentBatch(author, route.id, {
    clientOpId: 'op-B2', baseGeometryRev: fresh.geometryRev, baseTags: fresh.edgeEtags,
    ops: [{ type: 'move', vertexId: 'v3', coord: [121.5002, 31.2322] }]
  });
  assert.equal(ok.geometryRev, 3);
});

// 2. 离线重送：相同 clientOpId 幂等
test('验收2: 离线重送相同 clientOpId 只生效一次', async () => {
  const { route, version } = await makeRoute(author);
  const batch = {
    clientOpId: 'offline-1', baseGeometryRev: 1, baseTags: version.edgeEtags,
    ops: [{ type: 'insert', after: 'v0', vertexId: 'v9', coord: [121.475, 31.2315] }],
    // 插入把 v0>v1 边拆开，p0 失去依附：随同一操作给出重新落点
    resolutions: { p0: { coord: [121.472, 31.2305] } }
  };
  const first = await svc.segmentBatch(author, route.id, batch);
  const again = await svc.segmentBatch(author, route.id, batch); // 网络重发
  assert.equal(first.geometryRev, again.geometryRev);
  const v = (await svc.viewRoute(author, route.id)).draft;
  assert.equal(v.geometry.vertexIds.length, 5); // 没有重复插入
});

// 3. 审核与撤回竞争：先裁决则撤回失败，反之亦然
test('验收3: 审核与撤回竞争——审核先落则撤回被拒', async () => {
  const { route } = await makeRoute(author);
  await svc.submitForReview(author, route.id);
  let v = (await svc.viewRoute(author, route.id)).draft;
  await svc.review(reviewer, v.id, 'approve', '没问题', v.fingerprint);
  // 作者此刻撤回（状态已 approved，不是 in_review）
  await assert.rejects(svc.withdraw(author, route.id, '不投了'), (e) => (e.code+' '+e.message).includes("仅审核中或已发布"));
  v = (await svc.viewRoute(author, route.id)).draft;
  assert.equal(v.status, 'approved');
});

test('验收3b: 撤回先落则审核失败 not_in_review', async () => {
  const { route } = await makeRoute(author);
  await svc.submitForReview(author, route.id);
  let v = (await svc.viewRoute(author, route.id)).draft;
  await svc.withdraw(author, route.id, '想再改改');
  await assert.rejects(
    svc.review(reviewer, v.id, 'approve', '通过', v.fingerprint),
    (e) => (e.code+' '+e.message).includes('不在审核中')
  );
});

// 4. 折线自交：服务端拒绝
test('验收4: 蝴蝶结自交折线在创建时即被服务端拒绝', () => {
  const body = draftBody({
    geometry: { type: 'LineString', coordinates: [[121.0, 31.0], [121.02, 31.02], [121.02, 31.0], [121.0, 31.02]], vertexIds: ['b0', 'b1', 'b2', 'b3'] }
  });
  assert.throws(() => svc.createDraft(author, body), /自相交/);
});

// 5. 照片未上传完：提交审核被拒
test('验收5: 存在 uploading 照片时不能提交', async () => {
  const photo = svc.initPhoto(author, { filename: 'a.jpg', bytes: 1000 });
  const { route } = await makeRoute(author, draftBody({ photoIds: [photo.id] }));
  await assert.rejects(svc.submitForReview(author, route.id), (e) => (e.code+' '+e.message).includes("photos_not_ready"));
  svc.completePhoto(author, photo.id);
  const v = await svc.submitForReview(author, route.id);
  assert.equal(v.status, 'in_review');
});

// 6. 后台发布与搜索索引：失败可重试，最终成功
test('验收6: 索引器前两次失败后自动重试成功', async () => {
  let flakyCalls = 0;
  const flaky = async (task) => {
    if (task.task === 'search_index') {
      flakyCalls += 1;
      if (flakyCalls <= 2) throw new Error('search backend temporarily unavailable');
    }
    return indexHandler(task);
  };

  const { route } = await makeRoute(author);
  await svc.submitForReview(author, route.id);
  const v = (await svc.viewRoute(author, route.id)).draft;
  await svc.review(reviewer, v.id, 'approve', 'ok', v.fingerprint);
  await svc.publish(author, route.id);

  const expireBackoff = async () => (await store.repo.outboxList())
    .forEach((t) => { t.runAfter = new Date(0).toISOString(); });

  await pumpOnce(store.repo, flaky); // 第一次失败
  let st = (await store.repo.outboxList()).find((t) => t.task === 'search_index');
  assert.equal(st.status, 'pending');
  assert.equal(st.attempts, 1);
  assert.match(st.lastError, /unavailable/);

  await expireBackoff();
  await pumpOnce(store.repo, flaky); // 第二次失败
  st = (await store.repo.outboxList()).find((t) => t.task === 'search_index');
  assert.equal(st.attempts, 2);
  assert.equal(st.status, 'pending');

  await expireBackoff();
  await pumpOnce(store.repo, flaky); // 第三次成功
  st = (await store.repo.outboxList()).find((t) => t.task === 'search_index');
  assert.equal(st.status, 'done');
  assert.equal(flakyCalls, 3);

  const res = await svc.searchPublished('苏州河');
  assert.equal(res.length, 1);
});

// 7. 任何被精选版本都有完整审核依据
test('验收7: 精选引用发布快照且带审核依据；无依据不可精选', async () => {
  const { route } = await makeRoute(author);
  const { review } = await fullApprove(author, reviewer, route.id);
  const card = await svc.feature(reviewer, route.id, '适合亲子');
  assert.equal(card.active, true);
  assert.equal(card.reviewBasis.reviewId, review.id);
  assert.equal(card.reviewBasis.fingerprint, review.fingerprint);
  assert.equal(card.snapshot.title, '苏州河慢行走廊');

  // 未发布路线不能精选
  const other = await makeRoute(author, draftBody({ title: '未发布小道' }));
  await assert.rejects(svc.feature(reviewer, other.route.id, '想精选'), (e) => (e.code+' '+e.message).includes("只能精选已发布"));
});

// 8. 坐标有界 + 复杂度，纯服务端
test('验收8: 越界坐标与超复杂折线由服务端拒绝', () => {
  assert.throws(() => svc.createDraft(author, draftBody({
    geometry: { type: 'LineString', coordinates: [[121, 31], [999, 31]] }
  })), /超出允许范围/);
  const huge = Array.from({ length: 501 }, (_, i) => [121 + i * 0.0006, 31 + (i % 3) * 0.004]);
  assert.throws(() => svc.createDraft(author, draftBody({ geometry: { type: 'LineString', coordinates: huge } })), /最多 500/);
});

// 9. 审核中改危险路口：旧同意/旧审核不沿用，产生新草稿分支，旧链接保留状态说明
test('验收9: 审核中改稿使旧版本撤回留痕，需重新审核', async () => {
  const { route } = await makeRoute(author);
  await svc.submitForReview(author, route.id);
  const inReview = (await svc.viewRoute(author, route.id)).draft;
  // 审核员通过旧版（作者即将改的版本）——但作者同时改稿
  const newBody = draftBody({
    geometry: { type: 'LineString', coordinates: coords(), vertexIds: ids } // 先构造
  });
  // 移动危险路口 v1
  newBody.geometry = {
    type: 'LineString',
    coordinates: [[121.47, 31.23], [121.4812, 31.2330], [121.49, 31.23], [121.5, 31.232]],
    vertexIds: ['vw0','vw1','vw2','vw3']
  };
  const out = await svc.replaceWhole(author, route.id, { ...newBody, restPoints: [] }, inReview.geometryRev);
  assert.ok(out.superseded, '应产生新版本并标记旧版');
  const oldId = inReview.id;
  // 旧链接：作者视角可见 withdrawn 状态说明；审核员裁决旧版会失败
  await assert.rejects(svc.review(reviewer, oldId, 'approve', '旧同意', inReview.fingerprint), (e) => (e.code+' '+e.message).includes("不在审核中"));
  const err = await svc.viewVersion(author, oldId).catch((e) => e);
  assert.equal(err.status, 410);
  assert.match(err.message, /自动关闭/);
  // 新版必须重新走审核
  const draft = (await svc.viewRoute(author, route.id)).draft;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.parentVersionId, oldId);
  await svc.submitForReview(author, route.id);
  const v2 = (await svc.viewRoute(author, route.id)).draft;
  const res = await svc.review(reviewer, v2.id, 'approve', '新路口确认安全', v2.fingerprint);
  assert.equal(res.version.status, 'approved');
});

// 10. 撤回后旧链接保留状态说明，且不泄漏未公开草稿；精选卡失活
test('验收10: 发布版撤回 -> 精选卡失活、搜索移除、旧链接 410 有说明、草稿不泄漏', async () => {
  const { route } = await makeRoute(author);
  await fullApprove(author, reviewer, route.id);
  await svc.feature(reviewer, route.id, '首页推荐');
  await svc.withdraw(author, route.id, '施工封闭，暂时撤下');

  const pubId = route.draftVersionId;
  const err = await svc.viewVersion(null, pubId).catch((e) => e);
  assert.equal(err.status, 410);
  assert.equal(err.details.status, 'withdrawn');
  assert.ok(!err.details.story && !err.details.geometry, '撤回链接不得携带未公开内容');
  assert.match(err.details.stateNote, /施工封闭/);

  const cards = svc.listFeatured().filter((c) => c.active);
  assert.equal(cards.length, 0);
  const card = svc.listFeatured()[0];
  assert.match(card.deactivatedReason, /施工封闭/); // 保留状态说明，不删除
  assert.equal((await svc.searchPublished('')).length, 0);

  // 匿名访问只看到 404，确认未公开草稿不泄漏
  await assert.rejects(svc.viewRoute(null, route.id), (e) => (e.code+' '+e.message).includes("不存在"));
});

// 11. 路段插删后歇脚点重新定位：自动重定位提示 + 悬空点必须解决
test('验收11: 插删路段触发 repositioned 提示与 detached 冲突解决', async () => {
  const { route, version } = await makeRoute(author);
  // 在 v0-v1 之间插入一个顶点：p0 所在边被替换 -> detached
  const first = await svc.segmentBatch(author, route.id, {
    clientOpId: 'edge-cut', baseGeometryRev: 1, baseTags: version.edgeEtags,
    ops: [{ type: 'insert', after: 'v0', vertexId: 'vx', coord: [121.475, 31.2308] }]
  }).catch((e) => e);
  // p0 锚在 v0>v1，插点后该边消失 -> 应报 point_needs_relocate，带 repositioned/detached 信息
  assert.equal(first.status, 409);
  assert.equal(first.code, 'point_needs_relocate');
  assert.ok(first.details.detached.includes('p0'));

  // 作者解决：p0 重新落点，p1 若受影响自动重定位
  const cur = (await svc.viewRoute(author, route.id)).draft;
  const resolved = await svc.segmentBatch(author, route.id, {
    clientOpId: 'edge-cut', baseGeometryRev: 1, baseTags: version.edgeEtags,
    ops: [{ type: 'insert', after: 'v0', vertexId: 'vx', coord: [121.475, 31.2308] }],
    resolutions: {
      p0: { coord: [121.474, 31.2306] },
      ...(first.details.detached.includes('p1') ? { p1: { drop: true } } : {})
    }
  });
  assert.ok(resolved.geometryRev >= 2);
});

// 12. 指纹不匹配：审核员拿着旧页面提交裁决 -> fingerprint_mismatch
test('验收12: 送审指纹与当前不一致时拒绝裁决', async () => {
  const { route } = await makeRoute(author);
  await svc.submitForReview(author, route.id);
  await assert.rejects(
    svc.review(reviewer, (await svc.viewRoute(reviewer, route.id)).draft.id, 'approve', 'x', 'sha256:deadbeef'),
    (e) => e.code === 'fingerprint_mismatch'
  );
});

// 附：整路线乐观锁——rev 不匹配拒绝覆盖
test('附: 整路线替换带 geometryRev 乐观锁', async () => {
  const { route, version } = await makeRoute(author);
  await svc.segmentBatch(author, route.id, {
    clientOpId: 'm', baseGeometryRev: 1, baseTags: version.edgeEtags,
    ops: [{ type: 'move', vertexId: 'v2', coord: [121.4902, 31.2298] }]
  });
  await assert.rejects(
    svc.replaceWhole(author, route.id, draftBody(), 1),
    (e) => e.code === 'geometry_rev_stale'
  );
});
