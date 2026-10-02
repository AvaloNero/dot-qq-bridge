import { sign } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { qqKey, verifyWebhook } from '../src/signatures.js';
import { EVENT_NAME } from '../src/bridge.js';

// Deliberately public, synthetic fixture values. These are never real account credentials.
export const FIXTURE_TOKEN = 'synthetic-local-token-for-tests-only-0000000000';
export const FIXTURE_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
export function config(overrides = {}) {
  return { ...readConfig({ AUTH_MODE: 'dev', DEV_BEARER_TOKEN: FIXTURE_TOKEN, MCP_OWNER_SUBJECT: 'fixture-owner',
    QQ_APP_ID: 'fixture-app', QQ_BOT_SECRET: 'fixture-qq-bot-secret', QQ_OWNER_OPENID: 'fixture_qq_owner',
    STORAGE_KEY: Buffer.alloc(32, 8).toString('base64'), MCP_CALLBACK_ALLOWED_HOSTS: 'receiver.example.com' }),
    dbPath: ':memory:', ...overrides };
}
export function mcpRequest(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'offline-fixture', version: '1.0.0' } } } };
}
export function mcpHeaders(request) {
  return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${FIXTURE_TOKEN}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': request.method,
    ...(request.method === 'tools/call' ? { 'Mcp-Name': request.params.name } : {}) };
}
export function subscriptionParams(overrides = {}) {
  return { name: EVENT_NAME, arguments: { conversation: 'owner' }, cursor: null,
    delivery: { mode: 'webhook', url: 'https://receiver.example.com/current-dot', secret: FIXTURE_SECRET }, ...overrides };
}
export function qqPayload(now, overrides = {}) {
  return { id: 'fixture-event-1', op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'fixture-message-1',
    author: { user_openid: 'fixture_qq_owner', bot: false }, message_type: 0,
    content: '2 + 2 是多少？', timestamp: new Date(now).toISOString(), ...overrides } };
}
export function qqHeaders(configValue, body, now) {
  const ts = String(Math.floor(now / 1000));
  return { 'Content-Type': 'application/json', 'X-Bot-Appid': configValue.qqAppId,
    'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': sign(null, Buffer.concat([Buffer.from(ts), body]), qqKey(configValue.qqSecret)).toString('hex') };
}
export async function harness({ overrides = {}, sendOverride, dbPath, worker = false } = {}) {
  let now = Date.parse('2026-10-02T12:00:00Z');
  const settings = config({ ...overrides, ...(dbPath ? { dbPath } : {}) });
  const deliveries = [], sends = [], requests = [];
  let signingSecret = FIXTURE_SECRET;
  async function send(url, options) {
    options.beforeConnect?.();
    requests.push({ url, options });
    if (sendOverride) {
      const overridden = await sendOverride(url, options, { now, deliveries, sends });
      if (overridden !== undefined) return overridden;
    }
    if (['https://api.bot.qq.com/gateway/bot', 'https://api.sgroup.qq.com/gateway/bot', 'https://sandbox.api.sgroup.qq.com/gateway/bot'].includes(url)) {
      return { status: 200, body: Buffer.from(JSON.stringify({ url: `wss://${new URL(url).hostname}/websocket/`, shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 86400000, max_concurrency: 1 } })) };
    }
    const body = JSON.parse(options.body.toString('utf8'));
    if (url.startsWith('https://receiver.example.com/')) {
      if (!verifyWebhook(signingSecret, Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])), options.body, now)) throw new Error('Fixture receiver rejected signature');
      if (body.type === 'verification') return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
      deliveries.push(body);
      return { status: 202, body: Buffer.from('{}') };
    }
    if (['https://api.bot.qq.com/app/getAppAccessToken', 'https://bots.qq.com/app/getAppAccessToken'].includes(url)) return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'fixture-qq-token', expires_in: 7200 })) };
    if (['https://api.bot.qq.com', 'https://api.sgroup.qq.com', 'https://sandbox.api.sgroup.qq.com'].some(origin => url.startsWith(`${origin}/v2/users/`))) {
      sends.push({ url, body, headers: options.headers });
      return { status: 200, body: Buffer.from(JSON.stringify({ id: 'fixture-outbound-1' })) };
    }
    throw new Error('Unexpected fixture outbound request');
  }
  const app = createApp(settings, { clock: () => now, send, worker });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  async function postMcp(method, params = {}, { headers = {}, request, token } = {}) {
    const rpc = request ?? mcpRequest(method, params);
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...mcpHeaders(rpc), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(rpc) });
    const body = response.status === 202 ? null : await response.json();
    return { status: response.status, body, headers: response.headers };
  }
  async function postQq(payload = qqPayload(now), { headers = {}, rawBody, signedAt = now } = {}) {
    const body = rawBody ?? Buffer.from(JSON.stringify(payload));
    const response = await fetch(`${origin}/qq/webhook`, { method: 'POST', headers: { ...qqHeaders(settings, body, signedAt), ...headers }, body });
    return { status: response.status, body: await response.json() };
  }
  return { app, config: settings, origin, postMcp, postQq, deliveries, sends, requests,
    now: () => now, advance: ms => { now += ms; }, setSecret: value => { signingSecret = value; },
    subscribe: params => postMcp('events/subscribe', params ?? subscriptionParams()),
    reply: (message_id = 'fixture-message-1', text = '4') => postMcp('tools/call', { name: 'reply_to_qq', arguments: { message_id, text } }),
    close: () => app.close() };
}
