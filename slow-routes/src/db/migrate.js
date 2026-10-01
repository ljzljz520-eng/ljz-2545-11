'use strict';
const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await getPool().query(sql);

  // seed users with fixed dev tokens (HMAC-less bearer tokens; demo only)
  const seeded = await getPool().query('SELECT count(*)::int AS n FROM users');
  if (seeded.rows[0].n === 0) {
    await getPool().query(
      `INSERT INTO users (id, display_name, role, token) VALUES
        ('u_author', '小林（作者）', 'author', 'token-author'),
        ('u_author2', '阿周（作者）', 'author', 'token-author2'),
        ('u_reviewer', '老陈（审核员）', 'reviewer', 'token-reviewer'),
        ('u_admin', '站长（管理员）', 'admin', 'token-admin')`
    );
  }
  console.log('[db] migrated; users seeded');
}

module.exports = { migrate };

if (require.main === module) {
  (async () => {
    try {
      const { startEmbedded, stopEmbedded } = require('./embedded');
      const config = require('../config');
      if (config.EMBEDDED.enabled) await startEmbedded();
      await migrate();
      if (config.EMBEDDED.enabled) await stopEmbedded();
      process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  })();
}
