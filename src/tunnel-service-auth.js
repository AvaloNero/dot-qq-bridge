// Private single-owner deployment authentication. This does not attest a ChatGPT
// user or a provider identity. Every Tunnel Use holder has this owner's authority.
import path from 'node:path';
import { BridgeError, equal } from './common.js';
import { readPrivateFile } from './private-files.js';

export const SERVICE_HEADER = 'x-dot-bridge-service-key';
export const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
const reject = () => new BridgeError('Authentication required or rejected', { status: 401, code: -32012 });
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
export function validateTunnelServiceConfig(config) {
  if (config.bridgeMode !== 'tunnel' || !['127.0.0.1', '::1'].includes(config.host) || config.publicOrigin ||
      config.principal !== 'tunnel-owner:dot-bridge' ||
      !Number.isSafeInteger(config.subscriptionTtlMs) || config.subscriptionTtlMs < 60000 || config.subscriptionTtlMs > 604800000 ||
      !path.isAbsolute(config.tunnelServiceKeyFile ?? '') ||
      path.normalize(config.tunnelServiceKeyFile) !== config.tunnelServiceKeyFile) {
    throw new Error('Tunnel service auth requires private loopback, a dedicated key file, and a fixed local owner ID');
  }
}
export function readServiceKey(file) {
  // Descriptor-relative traversal prevents intermediate or final symlink swaps.
  // Unsupported operating systems fail closed rather than skip ownership checks.
  try {
    const key = readPrivateFile(file, { exactBytes: 43 }).toString('utf8');
    if (!keyPattern.test(key) || Buffer.from(key, 'base64url').length !== 32 || Buffer.from(key, 'base64url').toString('base64url') !== key) throw new Error();
    return key;
  } catch { throw new Error('Tunnel service credential file is unavailable or unsafe'); }
}
function unsafeHeader(name) {
  return /^(?:authorization|proxy-authorization|cookie|forwarded|remote-user)$/.test(name) ||
    /^(?:x-forwarded-|x-auth|x-user|x-owner|x-principal|x-remote-|x-openai-|openai-|oai-|x-oai-|x-mcp-owner|x-dot-(?:bridge-)?(?:owner|user|principal|identity))/.test(name);
}
export function createTunnelServiceAuthenticator(config, clock = Date.now) {
  validateTunnelServiceConfig(config);
  const credential = readServiceKey(config.tunnelServiceKeyFile);
  return async req => {
    if (!loopback(req.socket?.remoteAddress) || !Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2) throw reject();
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]?.toLowerCase();
      if (typeof name !== 'string' || unsafeHeader(name)) throw reject();
      if (name === SERVICE_HEADER) count++;
    }
    for (const name of Object.keys(req.headers ?? {})) if (unsafeHeader(name.toLowerCase())) throw reject();
    const token = req.headers?.[SERVICE_HEADER];
    if (count !== 1 || typeof token !== 'string' || !keyPattern.test(token) || !equal(token, credential)) throw reject();
    return { id: config.principal, validUntil: clock() + config.subscriptionTtlMs };
  };
}
