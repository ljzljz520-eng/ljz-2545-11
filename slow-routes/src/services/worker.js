'use strict';
const { getPool } = require('../db/pool');
const config = require('../config');
const publishing = require('./publishing');

// handlers resolved dynamically so tests (or ops) can inject failures
function handlerFor(type) {
  return publishing[type === 'publish' ? 'runPublish' : type === 'index' ? 'runIndex' : 'runUnindex'];
}

let stopped = false;
let ticking = null;

// 认领一个到期任务：原子地 pending -> running
async function claim(client) {
  const r = await client.query(
    `UPDATE jobs SET status='running', attempts=attempts+1,
                     run_after=now() + interval '120 seconds'
       WHERE id = (
         SELECT id FROM jobs
          WHERE status='pending' AND run_after <= now()
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
      RETURNING *`);
  return r.rowCount ? r.rows[0] : null;
}

async function finishSuccess(client, job, result) {
  await client.query(
    `UPDATE jobs SET status='done', result=$2::jsonb, finished_at=now(), run_after=now() WHERE id=$1`,
    [job.id, JSON.stringify(result || {})]);
}

async function markRetryOrDead(client, job, err) {
  const attempts = Number(job.attempts);
  if (attempts >= Number(job.max_attempts)) {
    await client.query(
      `UPDATE jobs SET status='dead', last_error=$2, finished_at=now() WHERE id=$1`,
      [job.id, String(err && err.stack || err)]);
    console.error('[worker] job dead', job.id, job.type, err && err.message);
    return;
  }
  const delayMs = config.JOB.BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
  await client.query(
    `UPDATE jobs SET status='pending', last_error=$2,
                     run_after=now() + ($3::numeric / 1000.0) * interval '1 second'
       WHERE id=$1`,
    [job.id, String(err && err.message || err), Math.round(delayMs)]);
  console.warn('[worker] retry', job.id, job.type, 'attempt', attempts, 'in', delayMs, 'ms');
}

async function tick() {
  if (stopped) return;
  // 认领（独立事务，attempts 与租约必须在执行前持久化）
  let job = null;
  {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      job = await claim(client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[worker] claim error', e);
    } finally {
      client.release();
    }
  }
  if (!job) return;

  // 执行在事务外；handler（发布/索引）自身有事务保证
  const handler = handlerFor(job.type);
  try {
    const result = await handler(job.payload);
    await withClient((c) => finishSuccess(c, job, result));
  } catch (err) {
    await withClient((c) => markRetryOrDead(c, job, err));
  }
}

async function withClient(fn) {
  const client = await getPool().connect();
  try { await client.query('BEGIN'); await fn(client); await client.query('COMMIT'); }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

function start() {
  stopped = false;
  const loop = async () => {
    while (!stopped) {
      await tick();
      await new Promise((r) => setTimeout(r, config.JOB.POLL_MS));
    }
  };
  ticking = loop();
  return ticking;
}
async function stop() { stopped = true; if (ticking) await ticking.catch(() => {}); }

// 测试辅助：同步把所有任务跑到 done/dead（退避/租约在测试中立即到期）
async function drain(maxRounds = 200) {
  for (let i = 0; i < maxRounds; i++) {
    const due = await getPool().query(
      `SELECT count(*)::int AS n FROM jobs
        WHERE (status='pending' AND run_after <= now())
           OR (status='running' AND run_after <= now())`);
    if (due.rows[0].n === 0) {
      // 退避中的 pending 任务：为测试把 run_after 提前
      const waiting = await getPool().query(
        "UPDATE jobs SET run_after=now() WHERE status='pending' AND run_after > now() RETURNING id");
      // 卡在 running（租约到期，疑似上次执行崩溃）：重置为 pending 让其重试
      const stalled = await getPool().query(
        `UPDATE jobs SET status='pending', run_after=now()
          WHERE status='running' AND run_after <= now() RETURNING id`);
      if (waiting.rowCount === 0 && stalled.rowCount === 0) break;
    }
    await tick();
  }
  const left = await getPool().query("SELECT id,type,status,attempts,last_error FROM jobs WHERE status <> 'done'");
  return left.rows;
}

module.exports = { start, stop, drain, tick };
