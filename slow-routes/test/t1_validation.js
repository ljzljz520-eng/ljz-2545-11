'use strict';
// 验收：提交坐标有界且限制复杂度；折线自交服务端拦截
const h = require('./helpers');

(async () => {
  const { app, request, worker } = await h.boot();
  const { T, auth, assert, line, drain } = h;

  console.log('# 场景1 服务端 GeoJSON 校验（不能靠客户端）');
  let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title: '测试线', story: 's' });
  const rid = r.body.id;

  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: { type: 'Point', coordinates: [1, 2] } });
  assert('非 LineString 拒绝', r.status === 422, r.body.error);

  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } });
  assert('坐标越界拒绝', r.status === 422, r.body);

  const many = line(501);
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: many });
  assert('超过 500 点复杂度上限拒绝', r.status === 422, r.body.error);

  const dup = line(3);
  dup.coordinates[2] = dup.coordinates[1].concat();
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: dup });
  assert('重复顶点拒绝', r.status === 422, r.body.error);

  const cross = { type: 'LineString', coordinates: [[121.45, 31.22], [121.49, 31.226], [121.49, 31.22], [121.45, 31.226]] };
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: cross });
  assert('折线自交拒绝', r.status === 422 && /self-intersecting/.test(r.body.error), r.body);

  const ok1 = line(6);
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '测试线', story: '故事内容', geometry: ok1 });
  assert('合法折线通过', r.status === 200, r.body.error);

  // 标题/故事长度
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: 'x', story: '故事内容', geometry: ok1 });
  assert('标题过短拒绝', r.status === 422);

  // 无鉴权不能写
  r = await request(app).put('/api/routes/' + rid).send({ title: '测试线', story: '故事内容', geometry: ok1 });
  assert('无 token 拒绝', r.status === 401);

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
