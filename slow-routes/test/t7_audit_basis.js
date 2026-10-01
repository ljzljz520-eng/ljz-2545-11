'use strict';
// 验收补充：任何被精选/发布版本都有完整审核依据；changes_requested 流程；
//           多次发布后旧版状态、快照不可变
const h = require('./helpers');

(async () => {
  const { app, request, worker } = await h.boot();
  const { T, auth, idem, assert, gid, line, drain, createPublishedRoute } = h;
  const { getPool } = require('../src/db/pool');

  console.log('# 场景7 完整审核依据链 + 改版重发 + 请求修改流程');

  // v1 被要求修改
  let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title: '滨江慢走线', story: '沿着江边走到灯塔的故事' });
  const rid = r.body.id;
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '滨江慢走线', story: '沿着江边走到灯塔的故事', geometry: line(4) });
  assert('初稿保存', r.status === 200);
  let sub = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem(gid('k')))
    .send({ reason: '请审核', photo_ids: [] });
  const rw1 = sub.body.review_id;
  r = await request(app).post('/api/reviews/' + rw1 + '/decision').set(auth(T.reviewer))
    .send({ decision: 'changes_requested', comment: '危险路口段请绕开，故事再补一段' });
  assert('请求修改返回 200', r.status === 200);
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  assert('路线进入 changes_requested', r.body.status === 'changes_requested');
  // 此时没有发布物
  const noPub = await getPool().query('SELECT count(*)::int AS n FROM publications WHERE route_id=$1', [rid]);
  assert('请求修改不产生发布', noPub.rows[0].n === 0);

  // 作者修改后重新投稿 => 新审核单，旧单仍可查且状态为 changes_requested
  const mine = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const c2 = mine.body.working_geom.coordinates[2];
  const segs = mine.body.segments.map((sg) => ({ uid: sg.uid, version: sg.version }));
  await request(app).patch('/api/routes/' + rid + '/text').set(auth(T.author))
    .send({ story: '沿着江边走到灯塔的故事，新增：在第二个路口走地下通道，安全。' });
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 2, to: [Number((c2[0] + 0.003).toFixed(6)), Number((c2[1] + 0.003).toFixed(6))], expected_seg_versions: segs });
  assert('改道成功', r.status === 200);
  sub = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem(gid('k')))
    .send({ reason: '已绕开危险路口并补充故事', photo_ids: [] });
  assert('修改后重新投稿成功', sub.status === 202, { s: sub.status, e: sub.body.error });
  const rw2 = sub.body.review_id;
  assert('新审核单与旧单不同', rw2 !== rw1);
  r = await request(app).post('/api/reviews/' + rw2 + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: '修改到位，通过' });
  assert('新版通过', r.status === 200);
  await drain(worker);

  // 发布记录必须能一路追溯到 approved 审核、冻结版本
  const pub1 = await getPool().query(
    `SELECT p.id, p.revision_id, p.approved_review_id, rv.geom_fingerprint, rv.text_fingerprint,
            r.decision, r.superseded_at, r.comment
       FROM publications p
       JOIN route_revisions rv ON rv.id=p.revision_id
       JOIN reviews r ON r.id=p.approved_review_id
      WHERE p.route_id=$1 AND p.withdrawn_at IS NULL`, [rid]);
  assert('发布版有完整审核依据（指纹+通过决议+意见）',
    pub1.rowCount === 1 && pub1.rows[0].decision === 'approved' && !pub1.rows[0].superseded_at
    && !!pub1.rows[0].comment && !!pub1.rows[0].geom_fingerprint);
  const pubId1 = pub1.rows[0].id;
  const frozenGeom = pub1.rows[0].geom_fingerprint;

  // 作者再出 v2 并发布：旧发布被标记 superseded（保留可访问快照）
  const mine2 = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const segs2 = mine2.body.segments.map((sg) => ({ uid: sg.uid, version: sg.version }));
  const c1 = mine2.body.working_geom.coordinates[1];
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 1, to: [Number((c1[0] + 0.002).toFixed(6)), Number((c1[1]).toFixed(6))], expected_seg_versions: segs2 });
  await request(app).patch('/api/routes/' + rid + '/text').set(auth(T.author))
    .send({ title: '滨江慢走线', story: '沿着江边走到灯塔的故事，v2 延长到轮渡码头。' });
  sub = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem(gid('k')))
    .send({ reason: 'v2 延长线', photo_ids: [] });
  await request(app).post('/api/reviews/' + sub.body.review_id + '/decision').set(auth(T.reviewer))
    .send({ decision: 'approved', comment: 'v2 通过' });
  await drain(worker);

  const pubs = await getPool().query(
    `SELECT id, withdrawn_at IS NOT NULL AS is_old, revision_version FROM publications
      WHERE route_id=$1 ORDER BY revision_version`, [rid]);
  assert('存在两个发布快照', pubs.rows.length === 2, pubs.rows);
  assert('旧版被标记为被取代但记录保留', pubs.rows[0].is_old === true && pubs.rows[1].is_old === false);

  // 旧版公开链接仍可读，且内容指纹未变（不可变快照）
  r = await request(app).get('/api/public/publications/' + pubId1);
  assert('旧版链接仍可访问并带状态说明', r.status === 200 && !!r.body.status_note);
  const oldGf = (await getPool().query('SELECT geom_fingerprint FROM route_revisions WHERE id=(SELECT revision_id FROM publications WHERE id=$1)', [pubId1])).rows[0].geom_fingerprint;
  assert('旧版快照几何指纹不可变', oldGf === frozenGeom);

  // 任何被精选版本都有依据：旧版（已被取代）不能精选；当前版可以
  r = await request(app).post('/api/featured').set(auth(T.admin)).send({ publication_id: pubId1, blurb: '旧版推荐' });
  assert('被取代的旧版不能精选 => 409', r.status === 409);
  const pubId2 = pubs.rows[1].id;
  r = await request(app).post('/api/featured').set(auth(T.admin)).send({ publication_id: pubId2, blurb: '新版值得走' });
  assert('当前发布版可精选', r.status === 201, { s: r.status, e: r.body.error });

  // 审核历史完整（作者可见每次决议及失效原因）
  r = await request(app).get('/api/routes/' + rid + '/reviews').set(auth(T.author));
  assert('审核历史包含两次以上记录', r.body.length >= 2);
  assert('历史含 changes_requested 与 approved',
    r.body.some((x) => x.decision === 'changes_requested') && r.body.some((x) => x.decision === 'approved'));

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
