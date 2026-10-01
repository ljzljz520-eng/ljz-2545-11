'use strict';
// 验收：同时编辑同路段、路段插删后提示点重新定位；整路线乐观锁 vs 分段合并
const h = require('./helpers');

(async () => {
  const { app, request } = await h.boot();
  const { T, auth, assert, line } = h;

  console.log('# 场景2 并发编辑：整路线乐观锁 vs 分段合并 + 歇脚点依赖');
  let r = await request(app).post('/api/routes').set(auth(T.author)).send({ title: '苏州河', story: '沿河的故事内容' });
  const rid = r.body.id;
  const geom = line(5); // 4 segments
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '苏州河', story: '沿河的故事内容', geometry: geom });
  assert('初始保存', r.status === 200);
  const v1 = r.body.route_version;

  // 在中间段放一个歇脚点
  r = await request(app).post('/api/routes/' + rid + '/stops').set(auth(T.author))
    .send({ name: '渡口', note: '长椅', coordinates: geom.coordinates[2] });
  const stopId = r.body.stops[0].id;
  assert('歇脚点 ok', r.body.stops[0].status === 'ok');

  // A 作者持有旧 route_version 做整路线保存；B 已先改动 => A 必须 409
  const geomB = line(5, 121.46);
  geomB.coordinates.forEach((c) => { c[0] = Number((c[0] + 0.001).toFixed(6)); });
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '苏州河', story: 'B 改了故事内容', geometry: geom, expected_version: v1 });
  assert('B 先保存成功', r.status === 200, { err: r.body.error });

  const geomA = JSON.parse(JSON.stringify(geom));
  geomA.coordinates[0] = [121.452, 31.2202];
  r = await request(app).put('/api/routes/' + rid).set(auth(T.author))
    .send({ title: '苏州河', story: '沿河的故事内容', geometry: geomA, expected_version: v1 });
  assert('A 用旧版本整路线保存 => 409', r.status === 409 && /route_version/.test(r.body.error), { s: r.status, e: r.body.error });

  // 重新拉取当前路线（模拟合并）
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const cur = r.body;
  const segUids = cur.segments.map((s) => s.uid);
  const segVers = cur.segments.map((s) => ({ uid: s.uid, version: s.version }));

  // 分段合并：两位作者同时编辑*不同*段，都应成功（细粒度）
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 1, to: [geom.coordinates[1][0], 31.2235], expected_seg_versions: segVers });
  assert('分段改顶点1成功（动 seg0,seg1）', r.status === 200, { err: r.body.error });

  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const segVers2 = r.body.segments.map((s) => ({ uid: s.uid, version: s.version }));
  // 第二位作者只动尾段（seg3），其版本号未变 => 成功合并
  const lastV = geom.coordinates.length - 1;
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: lastV, to: [geom.coordinates[lastV][0], 31.218], expected_seg_versions: segVers2 });
  assert('同一作者另一客户端改不同段：分段合并成功', r.status === 200, { s: r.status, e: r.body.error });

  // 同时编辑*同一路段*：旧 seg_version => 409
  r = await request(app).post('/api/routes/' + rid + '/segments/move').set(auth(T.author))
    .send({ vertex_seq: 1, to: [geom.coordinates[1][0], 31.224], expected_seg_versions: segVers });
  assert('并发改同段且版本过期 => 409', r.status === 409, { s: r.status, e: r.body.error });

  // 路段插删导致歇脚点需要重新定位
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const now2 = r.body;
  // 删除歇脚点所在段附近的顶点（顶点2 会合并 seg1+seg2）
  const versions = now2.segments.map((s) => ({ uid: s.uid, version: s.version }));
  const stop = now2.stops.find((s) => s.id === stopId);
  assert('歇脚点仍在', !!stop);
  const anchoredUid = stop.anchor.uid;
  const anchoredSegIdx = now2.segments.findIndex((s) => s.uid === anchoredUid);
  const vertexToDelete = anchoredSegIdx === now2.segments.length - 1 ? anchoredSegIdx : anchoredSegIdx + 1;
  r = await request(app).post('/api/routes/' + rid + '/segments/delete').set(auth(T.author))
    .send({ vertex_seq: vertexToDelete, expected_seg_versions: versions });
  assert('删除顶点被接受', r.status === 200, { s: r.status, e: r.body.error });
  const conflict = r.body.conflict;
  assert('服务端返回歇脚点重定位冲突提示', !!conflict && conflict.type === 'stop_relocation_required', conflict);

  // 重定位未完成前，不能提交审核
  r = await request(app).post('/api/routes/' + rid + '/submit').set(auth(T.author)).send({ reason: 'x', photo_ids: [] });
  assert('有待重定位点时禁止提交', r.status === 409 && /重新定位/.test(r.body.error), { s: r.status, e: r.body.error });

  // 作者重新定位后解除
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const badStop = r.body.stops.find((s) => s.status === 'needs_relocation');
  assert('存在 needs_relocation 的点', !!badStop);
  const curGeom = r.body.working_geom.coordinates;
  const near = curGeom[Math.min(1, curGeom.length - 2)];
  r = await request(app).post('/api/routes/' + rid + '/stops/' + badStop.id + '/relocate').set(auth(T.author))
    .send({ coordinates: near });
  assert('重定位成功', r.status === 200 && r.body.stops.every((s) => s.status === 'ok'), { s: r.status, e: r.body.error });

  // 插入顶点：前半段保留 uid，锚点不迁移
  r = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const before = r.body;
  const vv = before.segments.map((s) => ({ uid: s.uid, version: s.version }));
  const c0 = before.working_geom.coordinates[0], c1 = before.working_geom.coordinates[1];
  const mid = [Number(((c0[0] + c1[0]) / 2).toFixed(6)), Number(((c0[1] + c1[1]) / 2).toFixed(6))];
  r = await request(app).post('/api/routes/' + rid + '/segments/insert').set(auth(T.author))
    .send({ segment_uid: before.segments[0].uid, at: mid, expected_seg_versions: vv });
  assert('段插入成功', r.status === 200, { s: r.status, e: r.body.error });
  const keptUid = r.body.segments.some((s) => s.uid === before.segments[0].uid);
  assert('分裂后前半段保留旧 uid', keptUid);


  // 先把此前编辑遗留的待重定位点处理干净，回到全 ok 基线
  let pre = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  for (const bs of pre.body.stops.filter((x) => x.status === 'needs_relocation')) {
    const g = pre.body.working_geom.coordinates;
    const near = g[Math.min(1, g.length - 2)];
    await request(app).post('/api/routes/' + rid + '/stops/' + bs.id + '/relocate').set(auth(T.author)).send({ coordinates: near });
  }

  // 几何不变、只整线保存（改标题）=> 路段 uid 与歇脚点状态保持
  let rr = await request(app).get('/api/routes/' + rid).set(auth(T.author));
  const savedUids = rr.body.segments.map((x) => x.uid);
  rr = await request(app).put('/api/routes/' + rid).set(auth(T.author)).send({
    title: '苏州河（新标题）',
    story: rr.body.story || '沿河的故事内容',
    geometry: rr.body.working_geom
  });
  assert('几何不变的整线保存成功', rr.status === 200, { e: rr.body.error });
  assert('路段 uid 全部保留', rr.body.segments.length === savedUids.length &&
    rr.body.segments.every((x, i) => x.uid === savedUids[i]));
  assert('歇脚点未被误判为重定位', rr.body.stops.every((x) => x.status === 'ok'), rr.body.stops.map(s=>({n:s.name,st:s.status})));
  assert('无重定位冲突提示', rr.body.conflict === null);

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
