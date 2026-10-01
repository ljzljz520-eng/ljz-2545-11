import { LIMITS as L, TASK } from './config.js';

// 后台副作用索引器（真实部署替换为 PG FTS / ES）。通过 repo 访问数据，
// 内存库与 PG 库共用同一套重试语义。
export function makeIndexHandler(repo) {
  return async function handle(task) {
    const { routeId, versionId } = task.payload || {};
    const v = await repo.versionGet(versionId);
    if (task.task === TASK.SEARCH_INDEX) {
      if (!v || v.status !== 'published')
        throw Object.assign(new Error('version not published yet'), { retryable: true });
      await repo.searchUpsert({
        routeId, versionId, title: v.title,
        snippet: v.story.slice(0, 120),
        points: (v.restPoints || []).map((p) => p.name).join(' ')
      });
      return 'indexed';
    }
    if (task.task === TASK.UNPUBLISH_INDEX) {
      await repo.searchDelete(routeId);
      return 'unindexed';
    }
    if (task.task === TASK.PUBLISH_INDEX) {
      if (!v || v.status !== 'published')
        throw Object.assign(new Error('publish mark missing'), { retryable: true });
      await repo.versionMarkMaterialized(versionId);
      return 'materialized';
    }
    throw new Error('unknown task ' + task.task);
  };
}

// 单轮：claim → 执行 → done / 退避重试 / 超限 dead。可被测试精确驱动。
export async function pumpOnce(repo, handler) {
  let processed = 0;
  const tasks = await repo.outboxClaimDue();
  for (const task of tasks) {
    task.attempts += 1;
    await repo.outboxUpdate({ ...task, status: 'running' });
    try {
      const result = await handler(task);
      await repo.outboxUpdate({ ...task, status: 'done', result, finishedAt: new Date().toISOString() });
      processed += 1;
    } catch (e) {
      const dead = task.attempts >= L.MAX_REVIEW_ATTEMPTS || e.retryable === false;
      await repo.outboxUpdate({
        ...task,
        status: dead ? 'dead' : 'pending',
        lastError: String(e.message || e),
        runAfter: dead ? null : new Date(Date.now() + Math.min(200 * 2 ** (task.attempts - 1), 5000)).toISOString()
      });
    }
  }
  return processed;
}

export function startWorker(repo, handler, intervalMs = L.WORKER_POLL_MS) {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try { await pumpOnce(repo, handler); } catch { /* 单轮异常不杀进程 */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const p = tick();
  return { stop: async () => { stopped = true; await p; } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPgStore } = await import('./pg-store.js').catch(() => ({}));
  if (!createPgStore || !process.env.DATABASE_URL) {
    console.error('独立 worker 需要 DATABASE_URL（演示时 worker 已内嵌在 API 进程）');
    process.exit(1);
  }
  const store = await createPgStore(process.env.DATABASE_URL);
  startWorker(store.repo, makeIndexHandler(store.repo));
  console.log('worker polling postgres');
}
