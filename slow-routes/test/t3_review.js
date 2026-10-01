'use strict';
// 验收：审核必须针对确定路线几何及文字版；作者审核中改危险路口不能沿用旧同意；审核与撤回竞争
const h = require('./helpers');

(async () => {
  const { app, request } = await h.boot();
  const { T, auth, idem, assert, gid, line, drain } = h;

  console.log('# 场景3 审核绑定几何+文字版本，编辑即作废旧审核');

  async function freshRoute(opts = {}) {
    let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title: '危险路口测试线', story: '经过学校门口的路线故事' });
    const rid = r.body.id;
    r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
      .send({ title: '危险路口测试线', story: '经过学校门口的路线故事', geometry: line(5) });
    if (opts.stop) {
      await request(app).post('/api/routes/' + rid + '/stops').set(auth(T.author))
        .send({ name: '校门口', note: '红绿灯', coordinates: line(5).coordinates[2] });
    }
    const sub = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem(gid('k')))
      .send({ reason: '投稿', photo_ids: [] });
    return { rid, reviewId: sub.body.review_id };
  }

  // ---- 3a 审核员看到的是冻结快照，不是可被偷换的工作副本 ----
  let { rid, reviewId } = await freshRoute();
  let r = await request(app).get('/api/reviews/' + reviewId).set(auth(T.reviewer));
  assert('审核单仍有效', r.body.still_active === true);
  const snapshotVersion = r.body.revision.version;
  const snapGeom = JSON.stringify(r.body.revision.geometry);

  // 作者审核中移动"危险路口"顶点（segments move => 几何指纹变化，审核作废）
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const segs = r.body.segments.map((s) => ({ uid: s.uid, version: s.version }));
  const c3 = r.body.working_geom.coordinates[3];
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 3, to: [Number((c3[0] + 0.002).toFixed(6)), Number((c3[1] + 0.001).toFixed(6))], expected_seg_versions: segs });
  assert('审核中作者可编辑（改危险路口）', r.status === 200, { e: r.body.error });

  r = await request(app).get('/api/reviews/' + reviewId).set(auth(T.reviewer));
  assert('旧审核单已标记失效', r.body.still_active === false && !!r.body.superseded_at);
  assert('冻结快照几何未被偷换', JSON.stringify(r.body.revision.geometry) === snapGeom);

  // 审核员仍尝试对旧单"同意" => 必须拒绝，不能沿用旧同意
  r = await request(app).post('/api/reviews/' + reviewId + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '同意' });
  assert('对失效旧单 approve => 409', r.status === 409 && /不是当前待审版本|重新审核/.test(r.body.error), { s: r.status, e: r.body.error });

  // 待审列表里不再出现该路线
  r = await request(app).get('/api/reviews').set(auth(T.reviewer));
  assert('待审列表不含已失效单', !r.body.some((x) => x.review_id === reviewId));

  // ---- 3b 文字改了同样失效（文字版绑定）----
  ({ rid, reviewId } = await freshRoute());
  r = await request(app).patch('/api/routes/' + rid + '/text').set(auth(T.author))
    .send({ title: '危险路口测试线（改道版）', story: '经过学校门口的路线故事，新增避让天桥描述' });
  assert('审核中改文字成功', r.status === 200, { s: r.status, e: r.body.error });
  r = await request(app).post('/api/reviews/' + reviewId + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '同意旧版' });
  assert('文字变更后旧同意不可用 => 409', r.status === 409);

  // ---- 3c 重新投稿后对新版本审核：通过 ----
  ({ rid, reviewId } = await freshRoute());
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const segs2 = r.body.segments.map((s) => ({ uid: s.uid, version: s.version }));
  const c2 = r.body.working_geom.coordinates[2];
  await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 2, to: [Number(c2[0].toFixed(6)), Number((c2[1] + 0.002).toFixed(6))], expected_seg_versions: segs2 });
  const sub2 = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem(gid('k')))
    .send({ reason: '已绕开危险路口，请复审', photo_ids: [] });
  assert('新版本重新投稿', sub2.status === 202, { s: sub2.status, e: sub2.body.error });
  r = await request(app).post('/api/reviews/' + sub2.body.review_id + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '改道口合理，通过' });
  assert('新版本审核通过并入发布任务', r.status === 200 && !!r.body.job_id, { s: r.status, e: r.body.error });

  // ---- 3d 审核与撤回竞争：approve 前一刻撤回 ----
  ({ rid, reviewId } = await freshRoute());
  // 撤回（审核中）优先
  r = await request(app).post('/api/routes/' + rid + '/withdraw').set(auth(T.author))
    .send({ note: '我要再改改' });
  assert('审核中撤回成功，回到草稿', r.status === 200 && r.body.status === 'draft', r.body);
  r = await request(app).post('/api/reviews/' + reviewId + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '同意（迟到）' });
  assert('撤回后审核员的同意被拒 => 409', r.status === 409, { s: r.status });
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  assert('路线未被发布', r.body.status === 'draft');

  // ---- 3e 竞争另一面：approve 先提交，随后撤回 => 撤回走已发布分支 ----
  ({ rid, reviewId } = await freshRoute());
  r = await request(app).post('/api/reviews/' + reviewId + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '同意' });
  assert('先 approve 成功', r.status === 200);
  await drain(h.worker);
  r = await request(app).post('/api/routes/' + rid + '/withdraw').set(auth(T.author))
    .send({ note: '发布后改变主意' });
  assert('已发布版本撤回 => withdrawn', r.status === 200 && r.body.status === 'withdrawn', { s: r.status, e: r.body.error });

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
