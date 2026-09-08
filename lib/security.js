const crypto = require('crypto');

const AUTH_COOKIE_NAME = 'cloudvault_token';

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

function getCookieToken(request) {
  const cookieHeader = request.headers?.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== AUTH_COOKIE_NAME) continue;

    try {
      return normalizeToken(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch (error) {
      return '';
    }
  }
  return '';
}

function appendAuthCookie(response, request, token, maxAge = null) {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (request.secure || request.headers?.['x-forwarded-proto'] === 'https') {
    attributes.push('Secure');
  }
  if (maxAge !== null) attributes.push(`Max-Age=${maxAge}`);
  const cookie = attributes.join('; ');
  if (typeof response.append === 'function') response.append('Set-Cookie', cookie);
  else response.set?.('Set-Cookie', cookie);
}

function clearAuthCookie(response, request) {
  appendAuthCookie(response, request, '', 0);
}

function createAuthMiddleware(configuredToken) {
  const token = normalizeToken(configuredToken);

  return {
    enabled: Boolean(token),
    middleware(request, response, next) {
      if (!token) return next();

      const bearerToken = getBearerToken(request);
      const headerToken = request.get('x-cloudvault-token');
      const cookieToken = getCookieToken(request);
      const queryToken = normalizeToken(request.query?.token);
      const candidate = bearerToken || headerToken || cookieToken || queryToken;
      if (!tokensMatch(candidate, token)) {
        return response.status(401).json({ error: 'Authentication required' });
      }

      if (bearerToken || headerToken || queryToken) appendAuthCookie(response, request, token);

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

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [address, timestamps] of clients) {
      const recent = timestamps.filter(timestamp => timestamp > cutoff);
      if (recent.length === 0) clients.delete(address);
      else clients.set(address, recent);
    }
  }, windowMs);
  cleanup.unref?.();

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
  clearAuthCookie,
  getCookieToken,
  getBearerToken,
  normalizeToken,
  tokensMatch
};
