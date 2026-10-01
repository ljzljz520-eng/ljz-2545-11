'use strict';
const { getPool } = require('../db/pool');
const crypto = require('crypto');

async function enqueue(type, payload) {
  const id = 'job_' + crypto.randomBytes(8).toString('hex');
  await getPool().query(
    `INSERT INTO jobs (id, type, payload, status) VALUES ($1,$2,$3::jsonb,'pending')`,
    [id, type, JSON.stringify(payload)]
  );
  return id;
}

module.exports = { enqueue };
