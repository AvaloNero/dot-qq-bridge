import { createPublicKey, verify } from 'node:crypto';
import { BridgeError, equal } from './common.js';

const unauthorized = () => new BridgeError('Authentication required or rejected', { status: 401, code: -32012 });
export function createAuthenticator(config, send, clock = Date.now) {
  let cachedKeys = [], cacheUntil = 0, refreshAt = 0, pending;
  async function keys(force) {
    const now = clock();
    if ((!force && cacheUntil > now) || (force && refreshAt > now && cachedKeys.length)) return cachedKeys;
    if (!pending) pending = (async () => {
      const url = new URL(config.oauthJwksUrl);
      const response = await send(url.href, { method: 'GET', hosts: [url.hostname] });
      if (response.status !== 200) throw unauthorized();
      let data;
      try { data = JSON.parse(response.body.toString('utf8')); } catch { throw unauthorized(); }
      if (!Array.isArray(data.keys) || data.keys.length > 50) throw unauthorized();
      cachedKeys = data.keys.filter(key => key.kty === 'RSA' && typeof key.kid === 'string' &&
        (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') &&
        (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) && !key.d);
      cacheUntil = now + 300000;
      refreshAt = now + 30000;
      return cachedKeys;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return async function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 16384 || !config.principal) throw unauthorized();
    const token = header.slice(7), now = clock();
    if (config.authMode === 'dev') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !equal(token, config.devToken)) throw unauthorized();
      return { id: config.principal, validUntil: now + config.subscriptionTtlMs };
    }
    if (config.authMode !== 'oauth') throw unauthorized();
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw unauthorized();
      const headerJwt = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (headerJwt.alg !== 'RS256' || typeof headerJwt.kid !== 'string' || headerJwt.crit || headerJwt.jku || headerJwt.x5u || headerJwt.b64 !== undefined) throw unauthorized();
      let matches = (await keys(false)).filter(key => key.kid === headerJwt.kid);
      if (!matches.length) matches = (await keys(true)).filter(key => key.kid === headerJwt.kid);
      if (matches.length !== 1) throw unauthorized();
      const key = createPublicKey({ key: matches[0], format: 'jwk' });
      if (key.asymmetricKeyDetails.modulusLength < 2048 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw unauthorized();
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== config.oauthIssuer || claims.sub !== config.principal || !audience.includes(config.oauthAudience) ||
          !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
          (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now)) ||
          (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat * 1000 > now + 30000)) ||
          typeof claims.scope !== 'string' || !claims.scope.split(' ').includes(config.oauthScope)) throw unauthorized();
      return { id: claims.sub, validUntil: claims.exp * 1000 };
    } catch { throw unauthorized(); }
  };
}
