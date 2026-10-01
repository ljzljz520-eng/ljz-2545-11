'use strict';
const { getPool } = require('../db/pool');
const { AuthError } = require('./geo');

async function authenticate(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new AuthError('missing bearer token');
  const r = await getPool().query('SELECT id, display_name, role FROM users WHERE token = $1', [token]);
  if (r.rowCount === 0) throw new AuthError('invalid token');
  return r.rows[0];
}

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      req.user = await authenticate(req);
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'forbidden: requires ' + roles.join(' or ') });
      }
      next();
    } catch (e) {
      res.status(e.status || 401).json({ error: e.message });
    }
  };
}

const anyUser = requireRole('author', 'reviewer', 'admin');

module.exports = { authenticate, requireRole, anyUser };
