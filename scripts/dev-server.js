#!/usr/bin/env node
/**
 * Local development server for DentaFlow OS (Temara_Dashboard).
 *
 * The production app is deployed on Vercel: static assets in Temara_Dashboard/
 * plus serverless functions in Temara_Dashboard/api/*.js. This server emulates
 * that runtime locally without needing a Vercel account:
 *   - serves the static frontend, and
 *   - dispatches /api/* requests to the real serverless handlers with a
 *     Vercel-compatible (req, res) shim, applying vercel.json rewrites.
 *
 * External integrations (n8n, Redis, Baserow, Twilio, Cal.com) are remote and
 * require production secrets, so those proxy endpoints will return their
 * "not configured" responses locally. Authentication (JWT + scrypt) runs fully
 * locally using the dev credentials in Temara_Dashboard/.env.local.
 *
 * Uses Node.js built-ins only — no third-party dependencies.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'Temara_Dashboard');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Minimal .env parser — loads KEY=VALUE lines into process.env (existing values win). */
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

// Load dev env (real process env always takes precedence).
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

/** Load vercel.json rewrites, including `/book/:slug` and `/book/:path*` params. */
function compileRewrite(source, destination) {
  const names = [];
  const regexSource = source
    .split(/(:[A-Za-z_][A-Za-z0-9_]*\*?)/)
    .map((part) => {
      const token = part.match(/^:([A-Za-z_][A-Za-z0-9_]*)(\*)?$/);
      if (token) {
        names.push(token[1]);
        return token[2] ? '(.*)' : '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return {
    regex: new RegExp(`^${regexSource}$`),
    names,
    destination,
  };
}

function loadRewrites() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (cfg.rewrites || [])
      .filter((r) => r && typeof r.source === 'string' && typeof r.destination === 'string')
      .map((r) => compileRewrite(r.source, r.destination));
  } catch {
    return [];
  }
}

const REWRITES = loadRewrites();

function applyRewrite(pathname, incomingSearch) {
  for (const rule of REWRITES) {
    const match = pathname.match(rule.regex);
    if (!match) continue;

    let dest = rule.destination;
    const captured = {};
    rule.names.forEach((name, index) => {
      const value = decodeURIComponent(match[index + 1] || '');
      captured[name] = value;
      dest = dest.split(`:${name}`).join(encodeURIComponent(value));
    });

    const destUrl = new URL(dest, 'http://localhost');
    const searchParams = new URLSearchParams(destUrl.search);
    for (const [key, value] of incomingSearch) searchParams.set(key, value);
    for (const [key, value] of Object.entries(captured)) {
      if (!searchParams.has(key)) searchParams.set(key, value);
    }

    return { pathname: destUrl.pathname, searchParams };
  }
  return { pathname, searchParams: incomingSearch };
}

function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (data) => {
    if (data === undefined || data === null) {
      res.end();
    } else if (Buffer.isBuffer(data) || typeof data === 'string') {
      res.end(data);
    } else if (typeof data === 'object') {
      res.json(data);
    } else {
      res.end(String(data));
    }
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) return; // 5MB cap for dev
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function parseBody(req, rawBuffer) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const text = rawBuffer.toString('utf8');
  if (!text) return undefined;
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

function isSafeApiFile(candidate) {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(path.resolve(API_DIR))) return false;
  const relFromApi = path.relative(API_DIR, resolved);
  if (relFromApi.split(path.sep).some((part) => part.startsWith('_'))) return false;
  return fs.existsSync(resolved);
}

function resolveApiHandlerPath(pathname) {
  // pathname like /api/auth or /api/public/clinic/temara
  const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (!rel || rel.includes('..')) return null;

  const exact = path.join(API_DIR, `${rel}.js`);
  if (isSafeApiFile(exact)) return path.resolve(exact);

  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const dynamicParts = parts.slice(0, i).concat('[slug]');
    const dynamicCandidate = path.join(API_DIR, ...dynamicParts) + '.js';
    if (isSafeApiFile(dynamicCandidate)) return path.resolve(dynamicCandidate);
  }

  return null;
}

async function handleApi(req, res, pathname, searchParams) {
  const handlerPath = resolveApiHandlerPath(pathname);
  if (!handlerPath) {
    res.status(404).json({ ok: false, error: 'Not Found', path: pathname });
    return;
  }

  // Vercel-style request augmentation.
  const search = searchParams.toString();
  req.url = pathname + (search ? `?${search}` : '');
  req.query = Object.fromEntries(searchParams);

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const raw = await readBody(req);
    req.body = parseBody(req, raw);
  }

  let handler;
  try {
    handler = require(handlerPath);
    if (handler && handler.default) handler = handler.default;
  } catch (err) {
    console.error(`[api] failed to load ${handlerPath}:`, err);
    res.status(500).json({ ok: false, error: 'Handler load error', details: String(err && err.message) });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[api] handler threw for ${pathname}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Internal Server Error', details: String(err && err.message) });
    }
  }
}

async function handleStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const resolved = path.resolve(path.join(ROOT, pathname));
  if (!resolved.startsWith(path.resolve(ROOT))) {
    res.status(403).send('Forbidden');
    return;
  }

  let filePath = resolved;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    res.status(404).send('Not Found');
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(data);
  } catch {
    res.status(404).send('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  decorateResponse(res);
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });

  try {
    const rewritten = applyRewrite(urlObj.pathname, urlObj.searchParams);
    if (rewritten.pathname.startsWith('/api/')) {
      await handleApi(req, res, rewritten.pathname, rewritten.searchParams);
    } else {
      await handleStatic(req, res, rewritten.pathname);
    }
  } catch (err) {
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DentaFlow OS dev server running at http://${HOST}:${PORT}`);
  console.log(`Serving static frontend from: ${ROOT}`);
  console.log(`Serverless API from:          ${API_DIR}`);
  const hasAuth = Boolean(process.env.JWT_SECRET);
  console.log(`Auth configured (JWT_SECRET): ${hasAuth ? 'yes' : 'NO — run scripts/setup-dev-env.sh'}`);
});
