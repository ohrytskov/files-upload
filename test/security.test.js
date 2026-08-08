const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAuthMiddleware,
  createRateLimiter,
  tokensMatch
} = require('../lib/security');

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('token comparison and bearer authentication work', () => {
  assert.equal(tokensMatch('secret', 'secret'), true);
  assert.equal(tokensMatch('secret', 'different'), false);

  const auth = createAuthMiddleware('secret');
  const request = {
    get(name) {
      return name === 'authorization' ? 'Bearer secret' : '';
    }
  };
  const response = responseDouble();
  let called = false;
  auth.middleware(request, response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(response.statusCode, 200);
});
test('invalid authentication is rejected', () => {
  const auth = createAuthMiddleware('secret');
  const response = responseDouble();
  auth.middleware({ get: () => 'Bearer wrong' }, response, () => {});
  assert.equal(response.statusCode, 401);
});

test('rate limiter rejects requests over its configured limit', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const request = { ip: 'test-client' };
  const first = responseDouble();
  const second = responseDouble();
  let nextCount = 0;

  limiter(request, first, () => { nextCount += 1; });
  limiter(request, second, () => { nextCount += 1; });

  assert.equal(nextCount, 1);
  assert.equal(second.statusCode, 429);
});
