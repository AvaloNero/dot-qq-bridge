import http from 'node:http';
import { TextDecoder } from 'node:util';
import { Bridge } from './bridge.js';
import { BridgeError, equal, object, rpcResult } from './common.js';
import { createAuthenticator } from './auth.js';
import { makePublicRequester } from './network.js';
import { qqChallenge, qqVerify } from './signatures.js';
import { assertApprovedTunnelLive } from './tunnel-service-operation.js';

const VERSION = '2026-07-28';
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('Expected application/json', { status: 415 });
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError('Compressed bodies are unsupported', { status: 415 });
  if (Number(req.headers['content-length']) > 32768) throw new BridgeError('Request too large', { status: 413 });
  let timer;
  const read = (async () => {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32768) throw new BridgeError('Request too large', { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new BridgeError('Body timeout', { status: 408 })); req.destroy(); }, 10000); });
  try { return await Promise.race([read, timeout]); } finally { clearTimeout(timer); }
}
function parse(body) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new BridgeError('Invalid JSON or UTF-8', { code: -32700 }); }
}
function decodedName(value) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('=?base64?')) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) return undefined;
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return undefined; }
}
export function validateMcp(request, headers) {
  object(request, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (Object.hasOwn(request, 'id') && !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id))))) {
    throw new BridgeError('Invalid JSON-RPC request', { code: -32600 });
  }
  const params = request.params ?? {}, meta = params._meta;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !meta || typeof meta !== 'object' || Array.isArray(meta) ||
      typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string' || !meta['io.modelcontextprotocol/clientCapabilities'] ||
      typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object' || Array.isArray(meta['io.modelcontextprotocol/clientCapabilities'])) {
    throw new BridgeError('Required per-request MCP metadata is missing');
  }
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== request.method ||
      (['tools/call', 'resources/read', 'prompts/get'].includes(request.method) && decodedName(headers['mcp-name']) !== (params.name ?? params.uri))) {
    throw new BridgeError('MCP header/body mismatch or required header missing', { code: -32020 });
  }
  if (version !== VERSION) throw new BridgeError('Unsupported MCP protocol version', { code: -32022, data: { supported: [VERSION] } });
  const accept = headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) throw new BridgeError('Accept must include application/json and text/event-stream', { status: 406 });
  return params;
}

export function createApp(config, { clock = Date.now, send, worker = true, approvedLive = false } = {}) {
  assertApprovedTunnelLive(config, approvedLive);
  send ??= makePublicRequester();
  const authenticate = createAuthenticator(config, send, clock), bridge = new Bridge(config, { clock, send, approvedLive });
  let interval, lastTick = Promise.resolve(), stopping = false, lastPrune = 0, gateway, listenPromise, closePromise;
  const ready = () => bridge.ready() && !!bridge.store.activeSubscription(clock()) &&
    (config.qqTransport === 'webhook' || gateway?.status().connected === true);
  const server = http.createServer(async (req, res) => {
    let rpcId, isMcp = false;
    try {
      const url = new URL(req.url, 'http://bridge.invalid');
      const hostname = new URL(`http://${req.headers.host}`).hostname;
      const hosts = ['127.0.0.1', 'localhost', '[::1]', config.host];
      if (config.publicOrigin) hosts.push(new URL(config.publicOrigin).hostname);
      if (!hosts.includes(hostname)) throw new BridgeError('Invalid Host', { status: 403 });
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok', bridge_ready: ready() });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const available = ready();
        return json(res, available ? 200 : 503, { ready: available });
      }
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        if (config.authMode !== 'oauth') return json(res, 404, { error: 'OAuth is not configured' });
        return json(res, 200, { resource: config.oauthAudience, authorization_servers: [config.oauthIssuer],
          scopes_supported: [config.oauthScope], bearer_methods_supported: ['header'] });
      }
      if (url.pathname === '/mcp') {
        isMcp = true;
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' }, { Allow: 'POST' });
        if (req.headers.origin !== undefined && !config.allowedOrigins.includes(req.headers.origin)) throw new BridgeError('Invalid Origin', { status: 403, code: -32012 });
        const principal = await authenticate(req);
        const request = parse(await readBody(req));
        rpcId = request && !Array.isArray(request) ? request.id : undefined;
        const params = validateMcp(request, req.headers);
        bridge.store.tx(() => bridge.store.rate('mcp', 120, clock()));
        if (!Object.hasOwn(request, 'id')) {
          if (request.method !== 'notifications/cancelled') throw new BridgeError('Unsupported notification');
          res.writeHead(202); res.end(); return;
        }
        const result = await bridge.rpc(request.method, params, principal);
        return json(res, 200, rpcResult(request.id, result));
      }
      if (url.pathname === '/qq/webhook') {
        if (config.qqTransport !== 'webhook') return json(res, 404, { error: 'Webhook transport is disabled' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' }, { Allow: 'POST' });
        if (!config.qqAppId || !config.qqSecret) throw new BridgeError('QQ callback is not configured', { status: 503 });
        if (req.headers['x-bot-appid'] !== undefined && !equal(req.headers['x-bot-appid'], config.qqAppId)) throw new BridgeError('Wrong QQ AppID', { status: 401 });
        const body = await readBody(req), payload = parse(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BridgeError('Invalid QQ payload');
        if (payload.op === 13) {
          if (!equal(req.headers['x-bot-appid'] ?? '', config.qqAppId)) throw new BridgeError('Wrong QQ AppID', { status: 401 });
          object(payload, ['op', 'd', 's', 't', 'id'], ['op', 'd']);
          object(payload.d, ['plain_token', 'event_ts'], ['plain_token', 'event_ts']);
          if (typeof payload.d.plain_token !== 'string' || !/^[a-zA-Z0-9]{1,128}$/.test(payload.d.plain_token) ||
              typeof payload.d.event_ts !== 'string' || !/^\d{10}$/.test(payload.d.event_ts) ||
              Math.abs(clock() / 1000 - Number(payload.d.event_ts)) > config.signatureSkewSeconds) throw new BridgeError('Invalid callback challenge');
          bridge.store.tx(() => bridge.store.rate('qq_verification', 10, clock()));
          return json(res, 200, { plain_token: payload.d.plain_token, signature: qqChallenge(config.qqSecret, payload.d.plain_token, payload.d.event_ts) });
        }
        const replayId = qqVerify(config.qqSecret, req.headers, body, clock(), config.signatureSkewSeconds);
        bridge.acceptQq(payload, replayId);
        return json(res, 200, { op: 12, d: 0 });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const safe = error instanceof BridgeError ? error : new BridgeError('Internal bridge error', { status: 500, code: -32603 });
      const extra = safe.status === 401 && isMcp && config.authMode !== 'tunnel-service' ? { 'WWW-Authenticate': config.authMode === 'oauth' ?
        `Bearer resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="${config.oauthScope}"` : 'Bearer' } : {};
      if (!res.headersSent && !res.destroyed) json(res, safe.status, isMcp ? { jsonrpc: '2.0', id: rpcId ?? null,
        error: { code: safe.code, message: safe.message, ...(safe.data ? { data: safe.data } : {}) } } : { error: safe.message }, extra);
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.timeout = 30000;
  server.keepAliveTimeout = 5000; server.maxConnections = 64;
  function runWorker() {
    if (stopping || bridge.running) return;
    lastTick = bridge.tick().then(() => {
      if (clock() - lastPrune > 3600000) { bridge.store.prune(clock()); lastPrune = clock(); }
    }).catch(() => { process.stderr.write('Worker failure; inspect durable queue using the operator runbook.\n'); });
  }
  return { server, bridge,
    attachGateway(adapter) { if (gateway || stopping || config.tunnelServiceReadinessOnly) throw new Error('Gateway attachment refused'); gateway = adapter; },
    async listen(port = config.port, host = config.host) {
      if (stopping || listenPromise) throw new Error('Listener is already started or closed');
      if (config.authMode === 'tunnel-service' && !['127.0.0.1', '::1'].includes(host)) throw new Error('Tunnel service listener must remain loopback-only');
      listenPromise = new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
      await listenPromise;
      if (stopping) throw new Error('Listener startup cancelled');
      if (worker && !config.tunnelServiceReadinessOnly) { interval = setInterval(runWorker, config.workerIntervalMs); interval.unref(); }
      return server.address();
    },
    close() {
      if (closePromise) return closePromise;
      stopping = true; clearInterval(interval);
      closePromise = (async () => {
        await gateway?.stop();
        await listenPromise?.catch(() => {});
        await new Promise(resolve => server.close(resolve));
        await lastTick; bridge.store.close();
      })();
      return closePromise;
    }
  };
}
