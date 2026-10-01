import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const snake = {
  routeId: 'route_id', authorId: 'author_id', parentVersionId: 'parent_version_id',
  photoIds: 'photo_ids', edgeTags: 'edge_tags', geometryRev: 'geometry_rev',
  storyRev: 'story_rev', noteRev: 'note_rev', submittedAt: 'submitted_at',
  decidedAt: 'decided_at', publishedAt: 'published_at', withdrawnAt: 'withdrawn_at',
  withdrawReason: 'withdraw_reason', rejectReason: 'reject_reason', reviewId: 'review_id',
  supersededById: 'superseded_by_id', draftVersionId: 'draft_version_id',
  currentPublishedId: 'current_published_id', createdAt: 'created_at', updatedAt: 'updated_at',
  reviewerId: 'reviewer_id', readyAt: 'ready_at', deactivatedReason: 'deactivated_reason',
  deactivatedAt: 'deactivated_at', reviewBasis: 'review_basis', dedupeKey: 'dedupe_key',
  lastError: 'last_error', runAfter: 'run_after', finishedAt: 'finished_at',
  batchKey: 'batch_key', versionId: 'version_id'
};

function camelize(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[ck] = v;
  }
  return out;
}
const jsonCols = (t) => {
  const map = {
    route_versions: ['geometry', 'rest_points', 'photo_ids', 'edge_tags'],
    reviews: ['snapshot'], featured_cards: ['snapshot', 'review_basis'],
    outbox: ['payload']
  };
  return map[t] || [];
};
function hydrate(table, row) {
  const o = camelize(row);
  for (const c of jsonCols(table)) {
    const ck = c.replace(/_([a-z])/g, (_, x) => x.toUpperCase());
    if (o[ck] !== undefined && typeof o[ck] === 'string') o[ck] = JSON.parse(o[ck]);
  }
  return o;
}

export async function createPgStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  const sql = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  await pool.query(sql);
  const newId = (prefix) => prefix + '_' + randomUUID().slice(0, 12);

  // 事务上下文：同一连接内的 repo 调用复用 txClient
  let txClient = null;
  const client = () => txClient || pool;
  const q = (text, params) => client().query(text, params);

  const insert = async (table, obj, returning = '*') => {
    const cols = Object.keys(obj);
    const dbCols = cols.map((c) => snake[c] || c);
    const vals = cols.map((c) => {
      const v = obj[c];
      return ['geometry', 'restPoints', 'photoIds', 'edgeTags', 'snapshot', 'reviewBasis', 'payload'].includes(c) && v !== undefined
        ? JSON.stringify(v) : v;
    });
    const text = `INSERT INTO ${table} (${dbCols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING ${returning}`;
    const { rows } = await q(text, vals);
    return hydrate(table, rows[0]);
  };
  const update = async (table, idCol, obj, id) => {
    const cols = Object.keys(obj).filter((c) => c !== idCol);
    const sets = [];
    const vals = [];
    cols.forEach((c, i) => {
      const isJson = ['geometry', 'restPoints', 'photoIds', 'edgeTags', 'snapshot', 'reviewBasis', 'payload'].includes(c);
      sets.push(`${snake[c] || c}=$${i + 1}`);
      vals.push(isJson ? JSON.stringify(obj[c]) : obj[c]);
    });
    if (!sets.length) return obj;
    vals.push(id);
    const { rows } = await q(`UPDATE ${table} SET ${sets.join(',')} WHERE ${snake[idCol] || idCol}=$${vals.length} RETURNING *`, vals);
    return hydrate(table, rows[0]);
  };
  const getOne = async (table, idCol, id) => {
    const { rows } = await q(`SELECT * FROM ${table} WHERE ${snake[idCol] || idCol}=$1`, [id]);
    return rows[0] ? hydrate(table, rows[0]) : null;
  };

  const repo = {
    kind: 'pg', pool, newId,
    userInsert: (u) => insert('users', u),
    userGet: (id) => getOne('users', 'id', id),
    photoInsert: (p) => insert('photos', p),
    photoGet: (id) => getOne('photos', 'id', id),
    photoUpdate: (p) => update('photos', 'id', p, p.id),
    routeInsert: (r) => insert('routes', r),
    routeGet: (id) => getOne('routes', 'id', id),
    routeUpdate: (r) => update('routes', 'id', r, r.id),
    versionInsert: (v) => insert('route_versions', v),
    versionGet: (id) => getOne('route_versions', 'id', id),
    versionUpdate: (v) => update('route_versions', 'id', { ...v, updatedAt: new Date().toISOString() }, v.id),
    versionMarkMaterialized: async (id) => { await q(`UPDATE route_versions SET index_state='published-materialized' WHERE id=$1`, [id]); },
    reviewInsert: (r) => insert('reviews', r),
    reviewGet: (id) => getOne('reviews', 'id', id),
    featuredInsert: (f) => insert('featured_cards', f),
    featuredList: async () => (await q('SELECT * FROM featured_cards ORDER BY created_at')).rows.map((r) => hydrate('featured_cards', r)),
    featuredUpdate: (f) => update('featured_cards', 'id', f, f.id),
    versionsByRoute: async (rid) => (await q('SELECT * FROM route_versions WHERE route_id=$1 ORDER BY created_at', [rid])).rows.map((r) => hydrate('route_versions', r)),
    versionsByStatus: async (st) => (await q('SELECT * FROM route_versions WHERE status=$1', [st])).rows.map((r) => hydrate('route_versions', r)),
    routesByAuthor: async (aid) => (await q('SELECT * FROM routes WHERE author_id=$1', [aid])).rows.map(camelize),
    searchList: async () => (await q('SELECT route_id AS "routeId", version_id AS "versionId", title, snippet, points FROM search_index')).rows,
    async searchUpsert(row) {
      await q(`INSERT INTO search_index(route_id,version_id,title,snippet,points,tsv)
              VALUES($1,$2,$3,$4,$5,to_tsvector('simple',coalesce($3,'')||' '||coalesce($4,'')||' '||coalesce($5,'')))
              ON CONFLICT (route_id) DO UPDATE SET
                version_id=EXCLUDED.version_id,title=EXCLUDED.title,snippet=EXCLUDED.snippet,
                points=EXCLUDED.points,tsv=EXCLUDED.tsv`,
        [row.routeId, row.versionId, row.title, row.snippet || '', row.points || '']);
      return row;
    },
    searchDelete: async (rid) => { await q('DELETE FROM search_index WHERE route_id=$1', [rid]); },
    processedGet: async (key) => {
      const { rows } = await q('SELECT response FROM processed_batches WHERE batch_key=$1', [key]);
      return rows[0] ? hydrate('processed_batches', rows[0]) : null;
    },
    processedPut: async (key, row) => {
      await q(`INSERT INTO processed_batches(batch_key,response,at) VALUES($1,$2,now())
              ON CONFLICT (batch_key) DO UPDATE SET response=EXCLUDED.response, at=now()`,
        [key, JSON.stringify(row.response)]);
      return row;
    },
    async outboxInsert(row) {
      try {
        return await insert('outbox', row);
      } catch (e) {
        if (e.code === '23505' && row.dedupeKey) { // 唯一去重键冲突 => 复用已有任务
          const { rows } = await q('SELECT * FROM outbox WHERE dedupe_key=$1', [row.dedupeKey]);
          return hydrate('outbox', rows[0]);
        }
        throw e;
      }
    },
    outboxList: async () => (await q('SELECT * FROM outbox ORDER BY created_at')).rows.map((r) => hydrate('outbox', r)),
    async outboxClaimDue() {
      const { rows } = await q(`SELECT * FROM outbox WHERE status='pending' AND run_after<=now()
                               ORDER BY created_at LIMIT 50`);
      return rows.map((r) => hydrate('outbox', r));
    },
    outboxUpdate: async (row) => update('outbox', 'id', {
      status: row.status, attempts: row.attempts, lastError: row.lastError ?? null,
      result: row.result ?? null, runAfter: row.runAfter ? new Date(row.runAfter) : new Date(),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : null
    }, row.id),

    // 会话级 advisory lock 对齐内存版的 per-key 互斥（分段编辑串行化）
    async withLock(key, fn) {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        const prev = txClient; txClient = c;
        try { return await fn(); } finally { txClient = prev; }
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
        c.release();
      }
    },

    // 版本行事务：SELECT ... FOR UPDATE 让审核与撤回竞争排队裁决
    async withVersionTx(versionId, fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['version:' + versionId]);
        const { rows } = await c.query('SELECT * FROM route_versions WHERE id=$1 FOR UPDATE', [versionId]);
        const state = rows[0] ? hydrate('route_versions', rows[0]) : null;
        const prev = txClient; txClient = c;
        const ctx = {
          state,
          save: async (v) => {
            const { rows: r2 } = await c.query(`UPDATE route_versions SET
              status=$2,title=$3,story=$4,geometry=$5,rest_points=$6,photo_ids=$7,edge_tags=$8,
              fingerprint=$9,geometry_rev=$10,story_rev=$11,note_rev=$12,submitted_at=$13,
              decided_at=$14,published_at=$15,withdrawn_at=$16,withdraw_reason=$17,reject_reason=$18,
              review_id=$19,superseded_by_id=$20,index_state=$21,updated_at=now() WHERE id=$1 RETURNING *`,
              [v.id, v.status, v.title, v.story, JSON.stringify(v.geometry), JSON.stringify(v.restPoints),
               JSON.stringify(v.photoIds), JSON.stringify(v.edgeTags), v.fingerprint, v.geometryRev,
               v.storyRev, v.noteRev, v.submittedAt ? new Date(v.submittedAt) : null,
               v.decidedAt ? new Date(v.decidedAt) : null, v.publishedAt ? new Date(v.publishedAt) : null,
               v.withdrawnAt ? new Date(v.withdrawnAt) : null, v.withdrawReason || null,
               v.rejectReason || null, v.reviewId || null, v.supersededById || null, v.indexState || null]);
            ctx.state = hydrate('route_versions', r2[0]);
          },
          enqueue: async (task, payload, opts) => repo.outboxInsert({
            id: newId('task'), task, payload, status: 'pending', attempts: 0,
            lastError: null, dedupeKey: opts?.dedupeKey || null,
            runAfter: new Date().toISOString(), createdAt: new Date().toISOString()
          })
        };
        try {
          const out = await fn(ctx);
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally { txClient = prev; }
      } finally { c.release(); }
    }
  };

  return { repo, newId, pool };
}
