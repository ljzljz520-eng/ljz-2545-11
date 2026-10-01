'use strict';
// 开发/测试：自动下载并启动一个内嵌 PostgreSQL（无需系统安装）。
// 生产：设置 DATABASE_URL 指向外部 PG，此模块不启用。
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;
const config = require('../config');

let pg;

async function startEmbedded() {
  const e = config.EMBEDDED;
  fs.mkdirSync(path.dirname(e.clusterDir), { recursive: true });
  pg = new EmbeddedPostgres({
    version: e.version,
    clusterDir: e.clusterDir,
    port: e.port,
    user: e.user,
    password: e.password,
    databaseDir: e.clusterDir
  });
  await pg.initialise();
  await pg.start();

  const { Client } = require('pg');
  // 建业务数据库（忽略已存在）
  const admin = new Client({ host: '127.0.0.1', port: e.port, user: e.user, password: e.password, database: 'postgres' });
  await admin.connect();
  await admin.query(`DO $$ BEGIN CREATE ROLE ${e.user} LOGIN PASSWORD '${e.password}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`).catch(() => {});
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='slowroutes'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE slowroutes OWNER node');
  await admin.end();
  return pg;
}

async function stopEmbedded() {
  if (pg) { await pg.stop(); pg = null; }
}

module.exports = { startEmbedded, stopEmbedded };
