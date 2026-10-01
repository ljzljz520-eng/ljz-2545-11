'use strict';
const { Pool } = require('pg');
const config = require('../config');

let pool;
function getPool() {
  if (pool) return pool;
  if (config.DATABASE_URL) {
    pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  } else {
    pool = new Pool({
      host: '127.0.0.1',
      port: config.EMBEDDED.port,
      user: config.EMBEDDED.user,
      password: config.EMBEDDED.password,
      database: 'slowroutes',
      max: 10
    });
  }
  pool.on('error', (e) => console.error('[pg] idle client error', e));
  return pool;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, tx };
