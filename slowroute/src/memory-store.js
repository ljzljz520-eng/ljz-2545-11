import { randomUUID } from 'node:crypto';

// 内存仓储：零外部依赖即可运行与验收。
// 事务语义与 PG 实现对齐——per-key 互斥 + 版本行串行裁决，
// 同一版本上的“审核 / 撤回”竞争一定排队分出先后。
export function createMemoryStore() {
  const tables = {
    users: new Map(),
    routes: new Map(),
    versions: new Map(),
    reviews: new Map(),
    photos: new Map(),
    featured: new Map(),
    outbox: new Map(),
    processedBatches: new Map(),
    searchIndex: new Map()
  };
  const locks = new Map();
  const newId = (prefix) => prefix + '_' + randomUUID().slice(0, 12);

  const repo = {
    kind: 'memory',
    newId,
    userInsert: (u) => (tables.users.set(u.id, u), u),
    userGet: (id) => tables.users.get(id) || null,
    photoInsert: (p) => (tables.photos.set(p.id, p), p),
    photoGet: (id) => tables.photos.get(id) || null,
    photoUpdate: (p) => (tables.photos.set(p.id, p), p),
    routeInsert: (r) => (tables.routes.set(r.id, r), r),
    routeGet: (id) => tables.routes.get(id) || null,
    routeUpdate: (r) => (tables.routes.set(r.id, r), r),
    versionInsert: (v) => (tables.versions.set(v.id, v), v),
    versionGet: (id) => tables.versions.get(id) || null,
    versionUpdate: (v) => (tables.versions.set(v.id, v), v),
    reviewInsert: (r) => (tables.reviews.set(r.id, r), r),
    reviewGet: (id) => tables.reviews.get(id) || null,
    featuredInsert: (f) => (tables.featured.set(f.id, f), f),
    featuredList: () => [...tables.featured.values()],
    featuredUpdate: (f) => (tables.featured.set(f.id, f), f),
    outboxInsert: (row, { dedupeKey } = {}) => {
      if (dedupeKey)
        for (const t of tables.outbox.values())
          if (t.dedupeKey === dedupeKey && t.status !== 'dead') return t;
      tables.outbox.set(row.id, row);
      return row;
    },
    outboxList: () => [...tables.outbox.values()],
    outboxClaimDue: () => {
      const now = Date.now();
      return [...tables.outbox.values()]
        .filter((t) => t.status === 'pending' && (!t.runAfter || now >= new Date(t.runAfter).getTime()))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    outboxUpdate: (row) => (tables.outbox.set(row.id, row), row),
    versionMarkMaterialized: (id) => {
      const v = tables.versions.get(id);
      if (v) { v.indexState = 'published-materialized'; tables.versions.set(id, v); }
    },
    versionsByRoute: (routeId) => [...tables.versions.values()].filter((v) => v.routeId === routeId),
    versionsByStatus: (status) => [...tables.versions.values()].filter((v) => v.status === status),
    routesByAuthor: (authorId) => [...tables.routes.values()].filter((r) => r.authorId === authorId),
    processedGet: (key) => tables.processedBatches.get(key) || null,
    processedPut: (key, row) => (tables.processedBatches.set(key, row), row),
    searchUpsert: (row) => (tables.searchIndex.set(row.routeId, row), row),
    searchDelete: (routeId) => tables.searchIndex.delete(routeId),
    searchList: () => [...tables.searchIndex.values()],

    // key 级互斥（对齐 PG 的 advisory lock）
    async withLock(key, fn) {
      while (locks.get(key)) await locks.get(key);
      let release;
      const gate = new Promise((r) => (release = r));
      locks.set(key, gate);
      try { return await fn(); } finally { locks.delete(key); release(); }
    },

    // 版本行事务：与 PG BEGIN ... SELECT ... FOR UPDATE 语义一致
    async withVersionTx(versionId, fn) {
      return repo.withLock('version:' + versionId, async () => {
        const v = tables.versions.get(versionId);
        const ctx = {
          state: v,
          save(next) { ctx.state = next; tables.versions.set(versionId, next); },
          enqueue(task, payload, opts) {
            const id = newId('task');
            return repo.outboxInsert({
              id, task, payload: JSON.parse(JSON.stringify(payload)),
              status: 'pending', attempts: 0, lastError: null,
              dedupeKey: opts?.dedupeKey || null,
              runAfter: null, createdAt: new Date().toISOString()
            }, opts);
          }
        };
        return fn(ctx);
      });
    }
  };

  return { repo, newId, tables, withLock: repo.withLock, withVersionTx: repo.withVersionTx };
}
