import https from 'node:https';
import { BridgeError } from './common.js';

// Only trusted platform call sites opt in. Never use this for MCP callbacks,
// OAuth discovery/JWKS, operator-provided URLs, or arbitrary external targets.
export const PROVIDER_HOSTS = Object.freeze(['api.bot.qq.com', 'api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com', 'bots.qq.com']);
const failure = (reason = 'connection_refused') => new BridgeError('Provider connection failed', { code: -32015, data: { reason }, retryable: true });
export function providerUrl(raw, hosts) {
  let url; try { url = new URL(raw); } catch { throw new BridgeError('Invalid provider destination'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !PROVIDER_HOSTS.includes(url.hostname) || !Array.isArray(hosts) || !hosts.includes(url.hostname)) throw new BridgeError('Provider destination is not approved');
  return url;
}
export function configuredProviderProxy(env = process.env) {
  // Same precedence as Node. Do not log URLs: an existing proxy may contain auth.
  const raw = env.https_proxy || env.HTTPS_PROXY;
  if (!raw) return null;
  if (typeof raw !== 'string' || /[\r\n]/.test(raw)) throw new BridgeError('Invalid provider proxy configuration');
  let parsed; try { parsed = new URL(raw); } catch { throw new BridgeError('Invalid provider proxy configuration'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hash || !parsed.hostname) throw new BridgeError('Invalid provider proxy configuration');
  return parsed.href;
}
export function proxyBypassed(host, env = process.env) {
  const raw = env.no_proxy || env.NO_PROXY || '';
  return raw.split(',').some(entry => {
    let rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    if (rule.includes(':')) { const parts = rule.split(':'); if (parts.length !== 2) return false; if (parts[1] !== '443') return false; rule = parts[0]; }
    if (rule.startsWith('*.')) rule = rule.slice(1);
    if (rule.startsWith('.')) return host.endsWith(rule) || host === rule.slice(1);
    return host === rule;
  });
}
export function createProviderProxyAgent({ env = process.env, allowedHost = host => PROVIDER_HOSTS.includes(host), ca } = {}) {
  const proxy = configuredProviderProxy(env);
  if (!proxy) return null;
  class RestrictedAgent extends https.Agent {
    addRequest(req, options) {
      const host = options.hostname ?? options.host;
      if (proxyBypassed(host, env) || !allowedHost(host) || (options.port && Number(options.port) !== 443) || options.rejectUnauthorized === false || options.socketPath ||
          (options.servername && options.servername !== host)) {
        throw new BridgeError('Provider socket destination is not approved');
      }
      // The proxy resolves ONLY these trusted provider names. TLS validates the
      // original name. Matching NO_PROXY fails closed; no direct fallback or global mutation.
      return super.addRequest(req, { ...options, servername: host, rejectUnauthorized: true });
    }
  }
  try { return new RestrictedAgent({ proxyEnv: { HTTPS_PROXY: proxy }, keepAlive: false, rejectUnauthorized: true, ...(ca ? { ca } : {}) }); }
  catch { throw failure('proxy_configuration'); }
}
export function makeProviderRequester({ env = process.env, request = https.request, timeoutMs = 10000, maxBytes = 262144, agentFactory = createProviderProxyAgent } = {}) {
  return async (raw, { method = 'POST', headers = {}, body = Buffer.alloc(0), hosts, beforeConnect = () => {} }) => {
    const url = providerUrl(raw, hosts);
    if (!['GET', 'HEAD', 'POST'].includes(method) || !Buffer.isBuffer(body) || body.length > maxBytes ||
        Object.keys(headers).some(key => ['host', 'proxy-authorization', 'connection', 'transfer-encoding'].includes(key.toLowerCase()))) throw new BridgeError('Invalid provider request');
    let agent;
    try { agent = agentFactory({ env }); } catch { throw failure('proxy_configuration'); }
    if (!agent) throw failure('proxy_unavailable');
    try {
      beforeConnect();
      return await new Promise((resolve, reject) => {
        let timer, req;
        const finish = (error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); };
        try { req = request(url, { method, headers: { ...headers, 'Content-Length': body.length }, agent, servername: url.hostname, rejectUnauthorized: true }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); finish(failure('redirect_rejected')); return; }
          const chunks = []; let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(failure('response_too_large')); else chunks.push(chunk); });
          res.on('error', () => finish(failure('response_failed')));
          res.on('aborted', () => finish(failure('response_failed')));
          res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }); } catch { finish(failure()); return; }
        timer = setTimeout(() => req.destroy(failure('timeout')), timeoutMs);
        req.on('error', error => finish(error instanceof BridgeError ? error : failure(error.code?.startsWith('ERR_TLS') || error.code?.includes('CERT') ? 'tls_error' : 'connection_refused')));
        req.end(body);
      });
    } finally { agent.destroy(); }
  };
}
