import path from 'node:path';
import { validHostname } from './network.js';

function number(env, key, fallback, min, max) {
  const value = env[key] ? Number(env[key]) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
export function readConfig(env = process.env) {
  const mode = env.AUTH_MODE || 'deny';
  if (!['deny', 'dev', 'oauth'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  const config = {
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 3000, 1, 65535),
    dbPath: path.resolve(env.DATABASE_PATH || 'data/bridge.sqlite'), storageKey: env.STORAGE_KEY || '',
    authMode: mode, devToken: env.DEV_BEARER_TOKEN || '', principal: env.MCP_OWNER_SUBJECT || '',
    qqAppId: env.QQ_APP_ID || '', qqSecret: env.QQ_BOT_SECRET || '', ownerOpenid: env.QQ_OWNER_OPENID || '',
    qqApiProfile: env.QQ_API_PROFILE || 'documented',
    qqTransport: env.QQ_TRANSPORT || 'webhook',
    gatewayHosts: (env.QQ_GATEWAY_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    publicOrigin: env.PUBLIC_ORIGIN || '', oauthIssuer: env.OAUTH_ISSUER || '', oauthJwksUrl: env.OAUTH_JWKS_URL || '',
    oauthAudience: env.OAUTH_AUDIENCE || '', oauthScope: env.OAUTH_REQUIRED_SCOPE || 'qq:bridge',
    callbackHosts: (env.MCP_CALLBACK_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    signatureSkewSeconds: 300, replyTtlMs: number(env, 'REPLY_TTL_SECONDS', 240, 10, 300) * 1000,
    subscriptionTtlMs: number(env, 'SUBSCRIPTION_TTL_SECONDS', 86400, 60, 604800) * 1000,
    queueLimit: number(env, 'QUEUE_LIMIT', 100, 1, 10000), inboundPerMinute: number(env, 'INBOUND_PER_MINUTE', 10, 1, 20),
    repliesPerMinute: number(env, 'REPLIES_PER_MINUTE', 10, 1, 20), maxAttempts: number(env, 'MAX_DELIVERY_ATTEMPTS', 5, 1, 10),
    retryBaseMs: 1000, workerIntervalMs: 500, leaseMs: 60000, textRetentionMs: 7 * 86400000
  };
  if (mode === 'dev' && (!['127.0.0.1', '::1'].includes(config.host) || config.publicOrigin || config.devToken.length < 32 || !config.principal)) {
    throw new Error('Dev auth requires loopback, no PUBLIC_ORIGIN, a synthetic token of at least 32 characters, and a principal');
  }
  if (mode === 'oauth') {
    for (const [key, raw] of Object.entries({ PUBLIC_ORIGIN: config.publicOrigin, OAUTH_ISSUER: config.oauthIssuer, OAUTH_JWKS_URL: config.oauthJwksUrl, OAUTH_AUDIENCE: config.oauthAudience })) {
      let url;
      try { url = new URL(raw); } catch { throw new Error(`Invalid ${key}`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`Invalid ${key}`);
    }
    if (new URL(config.publicOrigin).origin !== config.publicOrigin || config.oauthAudience !== `${config.publicOrigin}/mcp` || !config.principal) {
      throw new Error('OAuth requires one owner subject and OAUTH_AUDIENCE equal to PUBLIC_ORIGIN/mcp');
    }
  }
  if (config.ownerOpenid && !/^[a-zA-Z0-9_-]{1,128}$/.test(config.ownerOpenid)) throw new Error('Invalid QQ_OWNER_OPENID');
  if (!['documented', 'tencent-sdk', 'tencent-sandbox'].includes(config.qqApiProfile)) throw new Error('Invalid QQ_API_PROFILE');
  if (!['webhook', 'gateway'].includes(config.qqTransport)) throw new Error('Invalid QQ_TRANSPORT');
  if (config.gatewayHosts.some(host => !validHostname(host))) throw new Error('QQ_GATEWAY_ALLOWED_HOSTS requires exact DNS hostnames');
  if (!config.gatewayHosts.length) config.gatewayHosts = [config.qqApiProfile === 'tencent-sandbox' ? 'sandbox.api.sgroup.qq.com' :
    config.qqApiProfile === 'tencent-sdk' ? 'api.sgroup.qq.com' : 'api.bot.qq.com'];
  if (config.qqTransport === 'gateway' && (mode === 'deny' || !config.qqAppId || !config.qqSecret || !config.ownerOpenid || !config.principal)) {
    throw new Error('QQ Gateway requires explicit AppID, secret, one owner openid and an authenticated MCP principal before network access');
  }
  if (config.callbackHosts.some(host => !validHostname(host))) throw new Error('MCP_CALLBACK_ALLOWED_HOSTS requires exact DNS hostnames without URLs, wildcards or IP addresses');
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(config.oauthScope)) throw new Error('Invalid OAUTH_REQUIRED_SCOPE');
  return Object.freeze(config);
}
