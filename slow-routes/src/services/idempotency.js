'use strict';
const crypto = require('crypto');
const { tx } = require('../db/pool');

// Offline re-send protection: same Idempotency-Key + same body => first response is replayed.
// Handler must return { status, body }.
module.exports = function idempotent(req) {
  return async (handler) => {
    const key = req.headers['idempotency-key'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const requestHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    if (!key) {
      const out = await handler(null);
      return { status: out.status, body: out.body };
    }
    return tx(async (client) => {
      const found = await client.query(
        'SELECT status_code, response FROM idempotency WHERE key=$1 FOR UPDATE', [key]);
      if (found.rowCount > 0) {
        const row = found.rows[0];
        if (row.response.request_hash !== requestHash) {
          const e = new Error('the same Idempotency-Key was reused with a different request body');
          e.status = 422; throw e;
        }
        return { __replayed: true, status: row.status_code, body: row.response.body };
      }
      const out = await handler(client);
      await client.query(
        `INSERT INTO idempotency (key, author_id, method_path, request_hash, status_code, response)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [key, req.user ? req.user.id : 'anon', req.method + ' ' + req.path, requestHash,
         out.status, JSON.stringify({ body: out.body, request_hash: requestHash })]
      );
      return { status: out.status, body: out.body };
    });
  };
};
