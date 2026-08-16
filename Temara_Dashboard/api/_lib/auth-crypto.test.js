/**
 * Safety-net tests for auth-crypto.js (Node assert only).
 * Run: node api/_lib/auth-crypto.test.js
 *
 * Actual API notes (do not treat as product bugs unless listed at the end):
 * - checkLoginRateLimit(req) — not (ip, role); returns { blocked, retryAfterSec }
 *   not { allowed, remaining }.
 * - Cookie parsing is parseCookies(req), not exported as parseCookieHeader.
 */
const assert = require('assert');
const {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  checkLoginRateLimit,
  getTokenFromRequest,
  requireBearerSession,
} = require('./auth-crypto');

function mockReq(overrides = {}) {
  return {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
    headers: { ...(overrides.headers || {}) },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testVerifyPassword() {
  const hash = hashPassword('correct-horse');
  assert.strictEqual(verifyPassword('correct-horse', hash), true);
  assert.strictEqual(verifyPassword('wrong-password', hash), false);
  assert.strictEqual(verifyPassword('correct-horse', 'not-a-hash'), false);
  assert.strictEqual(verifyPassword('correct-horse', 'bcrypt$abc$def'), false);
  assert.strictEqual(verifyPassword('', hash), false);
  assert.strictEqual(verifyPassword(null, hash), false);
}

async function testVerifyJwt() {
  const secret = 'test-jwt-secret';
  const token = signJwt({ role: 'doctor', sub: 'u1' }, secret, 3600);
  const payload = verifyJwt(token, secret);
  assert.ok(payload);
  assert.strictEqual(payload.role, 'doctor');
  assert.strictEqual(payload.sub, 'u1');
  assert.ok(payload.exp);

  const expired = signJwt({ role: 'doctor' }, secret, -30);
  assert.strictEqual(verifyJwt(expired, secret), null);

  const tampered = `${token.slice(0, -2)}aa`;
  assert.strictEqual(verifyJwt(tampered, secret), null);

  assert.strictEqual(verifyJwt('not-a-jwt', secret), null);
  assert.strictEqual(verifyJwt('a.b', secret), null);
  assert.strictEqual(verifyJwt('', secret), null);
  assert.strictEqual(verifyJwt(token, ''), null);
}

async function testCheckLoginRateLimit() {
  const originalFetch = global.fetch;
  const req = mockReq({ headers: { 'x-forwarded-for': '203.0.113.10' } });

  try {
  await withEnv(
    {
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    },
    async () => {
      let incr = 0;
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/incr/')) {
          incr += 1;
          return { ok: true, json: async () => ({ result: incr }) };
        }
        if (href.includes('/expire/')) {
          return { ok: true, json: async () => ({ result: 1 }) };
        }
        if (href.includes('/ttl/')) {
          return { ok: true, json: async () => ({ result: 840 }) };
        }
        throw new Error(`unexpected fetch ${href}`);
      };

      const first = await checkLoginRateLimit(req);
      assert.strictEqual(first.blocked, false);

      let fifth;
      for (let i = 2; i <= 5; i += 1) {
        fifth = await checkLoginRateLimit(req);
      }
      assert.strictEqual(fifth.blocked, false);

      const sixth = await checkLoginRateLimit(req);
      assert.strictEqual(sixth.blocked, true);
      assert.ok(sixth.retryAfterSec > 0);

      incr = 0;
      const afterWindow = await checkLoginRateLimit(req);
      assert.strictEqual(afterWindow.blocked, false);
    }
  );

  await withEnv(
    { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined },
    async () => {
      const open = await checkLoginRateLimit(req);
      assert.strictEqual(open.blocked, false);
      assert.strictEqual(open.bypassed, true);
    }
  );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testParseCookieHeader() {
  const valid = getTokenFromRequest(
    mockReq({
      headers: {
        cookie: 'dentaflow_session=abc%20123; other=z',
      },
    })
  );
  assert.strictEqual(valid, 'abc 123');

  const empty = getTokenFromRequest(mockReq({ headers: { cookie: '' } }));
  assert.strictEqual(empty, null);

  const malformed = getTokenFromRequest(
    mockReq({ headers: { cookie: 'no-equals; ; =value; dentaflow_session=ok' } })
  );
  assert.strictEqual(malformed, 'ok');
}

async function testRequireBearerSession() {
  const secret = 'unit-test-jwt-secret';
  const token = signJwt({ role: 'doctor' }, secret, 3600);

  await withEnv({ JWT_SECRET: secret }, async () => {
    const reqOk = mockReq({ headers: { cookie: `dentaflow_session=${encodeURIComponent(token)}` } });
    const resOk = mockRes();
    const payload = requireBearerSession(reqOk, resOk, { allowedRoles: ['doctor', 'assistant'] });
    assert.ok(payload);
    assert.strictEqual(payload.role, 'doctor');
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(resOk.body, null);

    const reqBad = mockReq({ headers: { cookie: 'dentaflow_session=not-a-valid-jwt' } });
    const resBad = mockRes();
    const denied = requireBearerSession(reqBad, resBad);
    assert.strictEqual(denied, null);
    assert.strictEqual(resBad.statusCode, 401);
    // Observed: 401 does not call clearAuthCookie / Set-Cookie (see notes).

    const reqMissing = mockReq({ headers: {} });
    const resMissing = mockRes();
    const missing = requireBearerSession(reqMissing, resMissing);
    assert.strictEqual(missing, null);
    assert.strictEqual(resMissing.statusCode, 401);

    const reqRole = mockReq({
      headers: { cookie: `dentaflow_session=${encodeURIComponent(token)}` },
    });
    const resRole = mockRes();
    const forbidden = requireBearerSession(reqRole, resRole, { allowedRoles: ['assistant'] });
    assert.strictEqual(forbidden, null);
    assert.strictEqual(resRole.statusCode, 403);
  });
}

async function runAllTests() {
  await testVerifyPassword();
  await testVerifyJwt();
  await testCheckLoginRateLimit();
  await testParseCookieHeader();
  await testRequireBearerSession();
  console.log('All tests passed');
}

runAllTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
