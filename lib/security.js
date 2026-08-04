const crypto = require('crypto');

function normalizeToken(token) {
  return typeof token === 'string' ? token.trim() : '';
}

function tokensMatch(candidate, expected) {
  const candidateBuffer = Buffer.from(normalizeToken(candidate));
  const expectedBuffer = Buffer.from(normalizeToken(expected));

  if (candidateBuffer.length !== expectedBuffer.length || expectedBuffer.length === 0) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function getBearerToken(request) {
  const authorization = request.get('authorization') || '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return '';
  return normalizeToken(authorization.slice(7));
}

function createAuthMiddleware(configuredToken) {
  const token = normalizeToken(configuredToken);

  return {
    enabled: Boolean(token),
    middleware(request, response, next) {
      if (!token) return next();

      const candidate = getBearerToken(request) || request.get('x-cloudvault-token');
      if (!tokensMatch(candidate, token)) {
        return response.status(401).json({ error: 'Authentication required' });
      }

      next();
    }
  };
}

function getClientAddress(request) {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const clients = new Map();

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of clients) {
      if (entry.windowStartedAt <= cutoff) clients.delete(key);
    }
  }, windowMs);
  cleanup.unref?.();

  return (request, response, next) => {
    const now = Date.now();
    const key = getClientAddress(request);
    let entry = clients.get(key);

    if (!entry || now - entry.windowStartedAt >= windowMs) {
      entry = { windowStartedAt: now, count: 0 };
      clients.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    response.set('RateLimit-Limit', String(max));
    response.set('RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.windowStartedAt + windowMs - now) / 1000);
      response.set('Retry-After', String(Math.max(1, retryAfter)));
      return response.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    next();
  };
}

function createConnectionLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const clients = new Map();

  return (address) => {
    const now = Date.now();
    const previous = clients.get(address) || [];
    const recent = previous.filter(timestamp => now - timestamp < windowMs);
    recent.push(now);
    clients.set(address, recent);
    return recent.length <= max;
  };
}

module.exports = {
  createAuthMiddleware,
  createConnectionLimiter,
  createRateLimiter,
  getBearerToken,
  normalizeToken,
  tokensMatch
};
