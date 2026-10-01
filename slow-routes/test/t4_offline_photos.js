'use strict';
// 验收：离线重送幂等；照片未上传完不能提交
const h = require('./helpers');

(async () => {
  const { app, request } = await h.boot();
  const { T, auth, idem, assert, line } = h;

  console.log('# 场景4 离线重送去重 + 照片两步上传完整性');

  // 同一幂等键 + 同一请求体重送两次 => 只建一条路线
  const body0 = { title: '离线提交线', story: '弱网环境反复点提交的故事' };
  const r1 = await request(app).post('/api/routes').set(auth(T.author)).set(idem('offline-key-1')).send(body0);
  const r2 = await request(app).post('/api/routes').set(auth(T.author)).set(idem('offline-key-1')).send(body0);
  assert('重送返回相同结果', r1.body.id === r2.body.id);
  assert('第二次带 Replay 标记', r2.headers['idempotent-replay'] === 'true');
  const { getPool } = require('../src/db/pool');
  const cnt = await getPool().query("SELECT count(*)::int AS n FROM routes WHERE title='离线提交线'");
  assert('数据库只创建一条', cnt.rows[0].n === 1, cnt.rows[0]);

  // 同键不同体 => 拒绝（防止串请求）
  const r3 = await request(app).post('/api/routes').set(auth(T.author)).set(idem('offline-key-1'))
    .send({ title: '完全不同的内容', story: 'x' });
  assert('同键不同体拒绝', r3.status === 422);

  // submit 幂等：审核中再点提交不产生第二张审核单
  let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title: '照片线', story: '沿途风景故事' });
  const rid = r.body.id;
  await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '照片线', story: '沿途风景故事', geometry: line(4) });
  const s1 = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem('submit-key-1'))
    .send({ reason: '初投', photo_ids: [] });
  const s2 = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem('submit-key-1'))
    .send({ reason: '初投', photo_ids: [] });
  assert('submit 重放返回同一 review', s1.body.review_id === s2.body.review_id);
  const rws = await getPool().query('SELECT count(*)::int AS n FROM reviews WHERE route_id=$1', [rid]);
  assert('只有一张审核单', rws.rows[0].n === 1, rws.rows[0]);

  // 照片：类型/大小服务端校验
  const fake = await request(app).post('/api/photos').set(auth(T.author)).set('X-Photo-Content-Type', 'application/x-msdownload').send(Buffer.from('xx'));
  assert('非法图片类型拒绝', fake.status === 422);
  const big = Buffer.alloc(6 * 1024 * 1024, 255);
  const bigr = await request(app).post('/api/photos').set(auth(T.author)).set('X-Photo-Content-Type', 'image/png').send(big);
  assert('超大照片拒绝', bigr.status === 422);

  // 引用不存在的照片 => 提交被拒绝（照片未上传完/丢失）
  const { stopEmbedded } = require('../src/db/embedded');
  // 先撤回当前审核，回草稿，再试
  await request(app).post('/api/routes/' + rid + '/withdraw').set(auth(T.author)).send({ note: '撤' });
  const miss = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem('submit-key-2'))
    .send({ reason: '带图', photo_ids: ['ph_does_not_exist'] });
  assert('引用未上传/不存在照片拒绝提交', miss.status === 422, miss.body);

  // 正常上传完照片再提交 => 成功
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
  const up = await request(app).post('/api/photos').set(auth(T.author)).set('X-Photo-Content-Type', 'image/png').send(png);
  assert('照片上传成功', up.status === 201 && up.body.status === 'ready');
  const ok = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).set(idem('submit-key-3'))
    .send({ reason: '带图重投', photo_ids: [up.body.id] });
  assert('照片齐了提交成功', ok.status === 202, { s: ok.status, e: ok.body.error });

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
