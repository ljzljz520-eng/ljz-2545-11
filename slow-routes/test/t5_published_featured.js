'use strict';
// 验收：精选卡引用发布快照；撤回后旧链接保留状态说明但不泄漏未公开草稿；
//       任何被精选版本都有完整审核依据；后台发布与搜索索引更新可重试
const h = require('./helpers');

(async () => {
  const { app, request, worker } = await h.boot();
  const { T, auth, idem, assert, gid, line, drain, createPublishedRoute } = h;
  const { getPool } = require('../src/db/pool');

  console.log('# 场景5 发布快照 / 撤回旧链接 / 精选审核依据 / 搜索索引');

  const pub = await createPublishedRoute(request, app, {});
  const left = await drain(worker);
  assert('发布+索引任务全部完成', left.length === 0, left);

  const head = await getPool().query('SELECT id FROM publications WHERE route_id=$1 AND withdrawn_at IS NULL', [pub.rid]);
  assert('存在未撤回发布快照', head.rowCount === 1);
  const pubId = head.rows[0].id;

  // 搜索索引可见
  let r = await request(app).get('/api/public/search?q=' + encodeURIComponent('苏州河'));
  assert('发布后搜索命中', r.body.some((x) => x.publication_id === pubId), { n: r.body.length });

  // 精选卡引用发布快照
  r = await request(app).post('/api/featured').set(auth(T.admin))
    .send({ publication_id: pubId, blurb: '傍晚沿河最舒服的一段' });
  assert('精选创建成功', r.status === 201, { s: r.status, e: r.body.error });
  const cardId = r.body.id;

  // 精选必须带完整审核依据
  const basis = await getPool().query(
    `SELECT p.approved_review_id, rv.decision, rv.superseded_at
       FROM featured_cards f JOIN publications p ON p.id=f.publication_id
       JOIN reviews rv ON rv.id=p.approved_review_id
      WHERE f.id=$1`, [cardId]);
  assert('精选版本有 approved 且未失效的审核依据',
    basis.rowCount === 1 && basis.rows[0].decision === 'approved' && !basis.rows[0].superseded_at);

  // 非管理员不能精选；草稿 id 不能精选
  r = await request(app).post('/api/featured').set(auth(T.author)).send({ publication_id: pubId, blurb: 'x' });
  assert('作者不能精选', r.status === 403);
  const draft = await request(app).post('/api/routes').set(auth(T.author2)).send({ title: '草稿不会被精选', story: '秘密改道的新故事' });
  r = await request(app).post('/api/featured').set(auth(T.admin)).send({ publication_id: draft.body.id, blurb: '尝试推荐草稿' });
  assert('用非发布 id 精选 => 404', r.status === 404);

  // 公开精选卡看到的是快照（含几何/歇脚点）
  r = await request(app).get('/api/public/featured');
  const card = r.body.find((x) => x.card_id === cardId);
  assert('公开精选返回发布快照', card && card.snapshot.publication_id === pubId && card.snapshot.geometry.type === 'LineString');
  assert('未撤回时无状态说明', card.withdrawn === false);

  // 旧链接可访问
  r = await request(app).get('/api/public/publications/' + pubId);
  assert('公开链接可读快照', r.status === 200 && r.body.title === '苏州河慢行道');
  assert('公开视图含审核依据', !!r.body.audit_basis && !!r.body.audit_basis.review_id);

  // 作者撤回
  r = await request(app).post('/api/routes/' + pub.rid + '/withdraw').set(auth(T.author)).send({ note: '施工改道，暂不推荐' });
  assert('撤回成功', r.status === 200 && r.body.status === 'withdrawn', r.body);
  await drain(worker);

  // 旧链接仍在：状态说明 + 旧快照
  r = await request(app).get('/api/public/publications/' + pubId);
  assert('撤回后旧链接仍 200', r.status === 200);
  assert('带撤回状态说明', r.body.withdrawn === true && /施工改道/.test(r.body.status_note), r.body.status_note);
  assert('内容仍是发布快照（几何保留）', r.body.geometry.type === 'LineString');

  // 不泄漏未公开草稿：公开端无法看到工作副本/新草稿
  const secret = await request(app).put('/api/routes/' + pub.rid).set(auth(T.author))
    .send({ title: '苏州河慢行道（私密改道版）', story: '作者正在画的新秘密支线内容', geometry: line(4, 121.5) });
  assert('撤回后作者可继续编辑草稿', secret.status === 200, { e: secret.body.error });
  r = await request(app).get('/api/public/publications/' + pubId);
  assert('旧链接不泄漏新草稿标题', r.body.title === '苏州河慢行道');
  assert('旧链接不泄漏新草稿故事', !/秘密支线/.test(r.body.story));
  // 匿名无权访问工作路线
  r = await request(app).get('/api/routes/' + pub.rid);
  assert('未公开草稿匿名访问 401', r.status === 401);
  r = await request(app).get('/api/routes/' + pub.rid).set(auth(T.author2));
  assert('他人不能读到草稿', r.status === 404);

  // 精选卡仍列旧快照但标记撤回
  r = await request(app).get('/api/public/featured');
  const card2 = r.body.find((x) => x.card_id === cardId);
  assert('撤回后精选卡保留并标记 withdrawn', card2 && card2.withdrawn === true && /施工改道/.test(card2.withdrawn_note));
  assert('精选卡快照仍未被草稿覆盖', card2.snapshot.title === '苏州河慢行道');

  // 搜索不再命中（unindex 任务）
  r = await request(app).get('/api/public/search?q=' + encodeURIComponent('苏州河'));
  assert('撤回后搜索不命中', !r.body.some((x) => x.publication_id === pubId));

  // 已撤回版本不能再次精选
  r = await request(app).post('/api/featured').set(auth(T.admin))
    .send({ publication_id: pubId, blurb: '想复活' });
  assert('撤回快照禁止精选 => 409', r.status === 409);

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
