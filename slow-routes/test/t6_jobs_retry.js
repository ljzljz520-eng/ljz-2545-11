'use strict';
// 验收：后台发布与搜索索引更新可重试（瞬时故障后指数退避，最终成功；彻底失败进 dead）
const h = require('./helpers');

(async () => {
  const { app, request, worker } = await h.boot();
  const { T, auth, idem, assert, gid, line, drain, createPublishedRoute } = h;
  const { getPool } = require('../src/db/pool');

  console.log('# 场景6 后台任务重试：发布与索引更新');

  // 1) 正常：approve 产生 publish 任务，drain 后 done 且幂等重跑无副作用
  const pub = await createPublishedRoute(request, app, {});
  let left = await drain(worker);
  assert('任务全部 done', left.length === 0);
  const j = await getPool().query("SELECT id, attempts, status, result FROM jobs WHERE type='publish'");
  assert('发布任务成功', j.rows[0].status === 'done' && j.rows[0].attempts >= 1, j.rows[0]);
  const pubsAfter1 = await getPool().query('SELECT count(*)::int AS n FROM publications WHERE route_id=$1', [pub.rid]);
  // 手动再执行同一 publish payload（模拟消息重复投递）
  const publishing = require('../src/services/publishing');
  const revId = (await getPool().query('SELECT revision_id FROM publications WHERE id=$1', [j.rows[0].result.publication_id])).rows[0].revision_id;
  const again = await publishing.runPublish({ route_id: pub.rid, revision_id: revId, review_id: pub.reviewId, actor: 'u_reviewer' });
  assert('重复投递幂等', again.idempotent === true, again);
  const pubsAfter2 = await getPool().query('SELECT count(*)::int AS n FROM publications WHERE route_id=$1', [pub.rid]);
  assert('没有产生重复发布', pubsAfter1.rows[0].n === pubsAfter2.rows[0].n);

  // 2) 瞬时故障注入：让 runIndex 头两次抛错，worker 退避重试后成功
  const original = publishing.runIndex;
  let flaky = 2;
  publishing.runIndex = async (payload) => {
    if (flaky > 0) { flaky -= 1; throw new Error('search cluster flapping'); }
    return original(payload);
  };
  const pubId = (await getPool().query('SELECT id FROM publications WHERE route_id=$1 LIMIT 1', [pub.rid])).rows[0].id;
  await getPool().query(`INSERT INTO jobs (id, type, payload, status) VALUES ('job_flaky','index',$1::jsonb,'pending')`,
    [JSON.stringify({ publication_id: pubId })]);
  left = await drain(worker, 200);
  const flakyJob = (await getPool().query('SELECT status, attempts, last_error FROM jobs WHERE id=$1', ['job_flaky'])).rows[0];
  assert('索引任务重试后成功', flakyJob.status === 'done', flakyJob);
  assert('发生了重试（attempts>=3）', flakyJob.attempts >= 3, flakyJob);
  publishing.runIndex = original;

  // 3) 永久失败：超过最大次数进入 dead，且不阻塞其他任务
  publishing.runIndex = async () => { throw new Error('index permanently broken'); };
  await getPool().query(
    `INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES ('job_dead','index',$1::jsonb,'pending',3)`,
    [JSON.stringify({ publication_id: pubId })]);
  // 一条正常的 unindex 任务也在队列中，确保 dead 任务不挡道
  await getPool().query(
    `INSERT INTO jobs (id, type, payload, status) VALUES ('job_other','unindex',$1::jsonb,'pending')`,
    [JSON.stringify({ route_id: 'nonexistent-route' })]);
  left = await drain(worker, 300);
  const dead = (await getPool().query('SELECT status, attempts FROM jobs WHERE id=$1', ['job_dead'])).rows[0];
  const other = (await getPool().query('SELECT status FROM jobs WHERE id=$1', ['job_other'])).rows[0];
  assert('超过次数 => dead', dead.status === 'dead' && dead.attempts === 3, dead);
  assert('dead 不阻塞其他任务', other.status === 'done', other);
  assert('last_error 保留排障信息', (await getPool().query('SELECT last_error FROM jobs WHERE id=$1', ['job_dead'])).rows[0].last_error.includes('permanently broken'));
  publishing.runIndex = original;

  // 4) 审核依据缺失时 publish 任务拒绝执行（防止无依据发布落地）
  const bad = await getPool().query(
    `INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES ('job_bad','publish',$1::jsonb,'pending',2)
     RETURNING id`,
    [JSON.stringify({ route_id: 'rt_x', revision_id: 'rv_missing', review_id: 'rw_missing', actor: 'u_admin' })]);
  left = await drain(worker, 300);
  const badJob = (await getPool().query('SELECT status, attempts FROM jobs WHERE id=$1', ['job_bad'])).rows[0];
  assert('无审核依据的发布任务最终 dead，不会落地', badJob.status === 'dead', badJob);
  const ghost = await getPool().query('SELECT count(*)::int AS n FROM publications WHERE revision_id=$1', ['rv_missing']);
  assert('没有产生发布记录', ghost.rows[0].n === 0);

  await h.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
