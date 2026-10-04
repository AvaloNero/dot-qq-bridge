import path from 'node:path';
import { OWNER } from './common.js';
const fail = () => { throw new Error('Bridge aggregator configuration is invalid or mixed with provider settings'); };
function keyPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0') || value === '/') fail();
  return value;
}
function port(value, fallback) {
  const text = value ?? String(fallback);
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 65535) fail();
  return Number(text);
}
export function readConfig(env = process.env) {
  const operation = env.TUNNEL_SERVICE_OPERATION ?? 'readiness';
  const rawChannels = env.TUNNEL_LIVE_CHANNELS ?? '';
  const liveChannels = rawChannels ? rawChannels.split(',') : [];
  if (!['readiness','live'].includes(operation) || (env.TUNNEL_SERVICE_READINESS_ONLY && (operation !== 'readiness' || env.TUNNEL_SERVICE_READINESS_ONLY !== 'true'))) fail();
  if (env.AUTH_MODE !== 'tunnel-service' || env.BRIDGE_MODE !== 'tunnel' ||
      (env.TUNNEL_SERVICE_OWNER_ID && env.TUNNEL_SERVICE_OWNER_ID !== OWNER) ||
      (env.TUNNEL_SERVICE_READINESS_ONLY && env.TUNNEL_SERVICE_READINESS_ONLY !== 'true')) fail();
  const accepted = new Set(['QQ_MCP_PORT', 'QQ_SERVICE_KEY_FILE', 'LARK_MCP_PORT', 'LARK_SERVICE_KEY_FILE',
    'TUNNEL_SERVICE_KEY_FILE', 'TUNNEL_SERVICE_OWNER_ID', 'TUNNEL_SERVICE_READINESS_ONLY', 'TUNNEL_SERVICE_OPERATION', 'TUNNEL_LIVE_CHANNELS']);
  for (const [name, value] of Object.entries(env)) {
    if (value && !accepted.has(name) && (/^(QQ_|LARK_|OAUTH_|MCP_|TUNNEL_SERVICE_)/.test(name) ||
        ['PUBLIC_ORIGIN', 'DEV_BEARER_TOKEN', 'DATABASE_PATH', 'STORAGE_KEY', 'ALLOWED_ORIGINS'].includes(name))) fail();
  }
  return validateConfig({ operation, liveChannels, host: env.HOST ?? '127.0.0.1', port: port(env.PORT, 8789), owner: OWNER,
    ingressKeyFile: keyPath(env.TUNNEL_SERVICE_KEY_FILE), qqKeyFile: keyPath(env.QQ_SERVICE_KEY_FILE),
    larkKeyFile: keyPath(env.LARK_SERVICE_KEY_FILE), qqPort: port(env.QQ_MCP_PORT, 8787), larkPort: port(env.LARK_MCP_PORT, 8788) });
}
export function validateConfig(value) {
  const required = ['host', 'port', 'owner', 'ingressKeyFile', 'qqKeyFile', 'larkKeyFile', 'qqPort', 'larkPort'];
  const fields = [...required,'operation','liveChannels'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
  const operation = value.operation ?? 'readiness', liveChannels = value.liveChannels ?? [];
  if (!['readiness','live'].includes(operation) || !Array.isArray(liveChannels) || liveChannels.some(x=>!['qq','lark'].includes(x)) ||
      new Set(liveChannels).size !== liveChannels.length || (operation === 'readiness' ? liveChannels.length !== 0 : liveChannels.length === 0)) fail();
  if (!['127.0.0.1', '::1'].includes(value.host) || value.owner !== OWNER ||
      [value.port, value.qqPort, value.larkPort].some(p => !Number.isInteger(p) || p < 1 || p > 65535) ||
      new Set([value.port, value.qqPort, value.larkPort]).size !== 3) fail();
  const files = [value.ingressKeyFile, value.qqKeyFile, value.larkKeyFile].map(keyPath);
  if (new Set(files).size !== 3) fail();
  return Object.freeze({ ...value, operation, liveChannels:Object.freeze([...liveChannels].sort()) });
}
