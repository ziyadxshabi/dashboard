/**
 * Filesystem route for POST /api/auth/logout (Vercel maps this path
 * without a rewrite). Delegates to the unified auth handler.
 */
'use strict';

const handleAuth = require('../auth');

module.exports = async function handler(req, res) {
  req.url = '/api/auth/logout';
  return handleAuth(req, res);
};
