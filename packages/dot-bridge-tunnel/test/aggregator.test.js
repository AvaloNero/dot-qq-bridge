import { privateMkdtempSync, fixtureChmodSync, fixtureSymlinkSync } from '../../dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, validateConfig } from '../src/config.js';
import { createAuthenticator, readServiceKey } from '../src/auth.js';
import { createApp, checkHeaders } from '../src/server.js';
import { retainValidationHeaders } from '../src/transport-headers.js';
import { validateMcp } from '../src/protocol.js';
import { VERSION, OWNER, SERVICE_HEADER, metadata } from '../src/common.js';
const KEYS = { ingress: Buffer.alloc(32, 41).toString('base64url'), qq: Buffer.alloc(32, 42).toString('base64url'), lark: Buffer.alloc(32, 43).toString('base64url') }; // public synthetic fixtures, not real credentials
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir = privateMkdtempSync(path.join(os.tmpdir(), 'dot-aggregate-test-')); fixtureChmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {};
  for (const [role, key] of Object.entries(KEYS)) { files[role] = path.join(dir, role); fs.writeFileSync(files[role], key, { mode: 0o600 }); }
  const env = { AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_OWNER_ID: OWNER,
    TUNNEL_SERVICE_KEY_FILE: files.ingress, QQ_SERVICE_KEY_FILE: files.qq, LARK_SERVICE_KEY_FILE: files.lark };
  return { dir, files, env, config: readConfig(env) };
}
function request(method = 'ping', params = {}, id = 1) { return { jsonrpc: '2.0', id, method, params: { ...params, _meta: metadata() } }; }
function headers(body) { return { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  [SERVICE_HEADER]: KEYS.ingress, 'mcp-method': body.method, 'mcp-protocol-version': VERSION,
  ...(body.method === 'tools/call' ? { 'mcp-name': body.params.name } : {}) }; }
function raw(port, body, custom = {}, url = '/mcp', method = 'POST') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false,
      headers: Array.isArray(custom) ? custom : { ...(typeof body === 'object' && !Buffer.isBuffer(body) ? headers(body) : {}), ...custom } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, value, text, headers: res.headers });
      });
    }); req.on('error', reject); req.end(buffer);
  });
}
const post = (port, method, params = {}, extra = {}) => raw(port, request(method, params), extra);
const qqSetup = () => ({ configuration_ready: false, events_discoverable: false,
  missing_settings: ['QQ_APP_ID', 'QQ_BOT_SECRET', 'QQ_OWNER_OPENID', 'MCP_CALLBACK_ALLOWED_HOSTS'],
  callback_hostname: null, callback_policy: 'not_provided', qq_api_profile: 'documented', network_checked: false,
  next_step: 'untrusted upstream text with synthetic-private-canary' });
async function mock(t, role) {
  const state = { seen: [], transform: value => value, response: undefined };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); state.seen.push({ body, headers: req.headers });
    assert.equal(req.url, '/mcp'); assert.equal(req.headers[SERVICE_HEADER], KEYS[role]);
    assert.equal(req.headers.authorization, undefined); assert.equal(body.id, 'readiness');
    assert.deepEqual(body.params._meta, metadata()); validateMcp(body, req.headers);
    if (state.response) return state.response(req, res, body);
    let result;
    if (body.method === 'server/discover') result = { supportedVersions: [VERSION], capabilities: { tools: {}, events: {} } };
    else if (body.method === 'tools/list') result = { tools: role === 'qq' ? [{ name: 'check_bridge_setup' }] : [] };
    else if (body.method === 'events/list') result = { events: [] };
    else if (body.method === 'tools/call') { assert.equal(role, 'qq'); assert.deepEqual(body.params.arguments, {}); result = { isError: false, structuredContent: qqSetup(), content: [{ type: 'text', text: 'synthetic-private-canary' }] }; }
    else assert.fail('Unexpected upstream operation');
    const value = state.transform({ jsonrpc: '2.0', id: body.id, result: { ...result, resultType: 'complete', _meta: { identity: 'synthetic-private-canary' } } }, body);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { ...state, get port() { return server.address().port; }, state, server };
}
async function running(t) {
  const f = fixture(t), qq = await mock(t, 'qq'), lark = await mock(t, 'lark');
  const app = createApp({ ...f.config, qqPort: qq.port, larkPort: lark.port }); t.after(() => app.close());
  const address = await app.listen(0); return { ...f, qq, lark, app, port: address.port };
}
function authReq(extra = {}, rawHeaders) {
  const h = { [SERVICE_HEADER]: KEYS.ingress, ...extra };
  return { headers: h, rawHeaders: rawHeaders ?? Object.entries(h).flat(), socket: { remoteAddress: '127.0.0.1' } };
}
test('configuration requires explicit readiness and independent fixed loopback routes', t => {
  const f = fixture(t); assert.equal(f.config.owner, OWNER); assert.equal(f.config.host, '127.0.0.1');
  for (const change of [{ AUTH_MODE: '' }, { BRIDGE_MODE: 'sites' }, { HOST: 'localhost' }, { HOST: '0.0.0.0' },
    { TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:another' }, { TUNNEL_SERVICE_READINESS_ONLY: 'false' }, { PORT: '0' }, { QQ_MCP_PORT: '65536' },
    { QQ_MCP_PORT: '8789' }, { QQ_MCP_PORT: 'http://127.0.0.1' }, { LARK_MCP_PORT: '08788' }, { QQ_SERVICE_KEY_FILE: f.files.ingress },
    { LARK_SERVICE_KEY_FILE: './key' }, { TUNNEL_SERVICE_KEY_FILE: f.dir + '/../key' }]) assert.throws(() => readConfig({ ...f.env, ...change }));
  for (const name of ['QQ_APP_ID', 'QQ_BOT_SECRET', 'QQ_OWNER_OPENID', 'LARK_APP_SECRET', 'LARK_CREDENTIALS_FILE', 'MCP_OWNER_SUBJECT',
    'MCP_CALLBACK_ALLOWED_HOSTS', 'MCP_ALLOWED_ORIGINS', 'OAUTH_ISSUER', 'DEV_BEARER_TOKEN', 'PUBLIC_ORIGIN', 'STORAGE_KEY', 'DATABASE_PATH']) {
    assert.throws(() => readConfig({ ...f.env, [name]: 'synthetic-canary' }));
  }
  assert.throws(() => validateConfig({ ...f.config, qqOrigin: 'https://example.invalid' }));
  assert.equal(readConfig({ ...f.env, HTTP_PROXY: 'http://proxy.invalid', HTTPS_PROXY: 'http://proxy.invalid' }).qqPort, 8787);
});
test('key reader rejects symlinks, hardlinks, directories, modes, oversized and malformed files', t => {
  const f = fixture(t); assert.equal(readServiceKey(f.files.ingress), KEYS.ingress);
  fixtureChmodSync(f.files.ingress, 0o640); assert.throws(() => readServiceKey(f.files.ingress)); fixtureChmodSync(f.files.ingress, 0o600);
  fixtureChmodSync(f.dir, 0o750); assert.throws(() => readServiceKey(f.files.ingress)); fixtureChmodSync(f.dir, 0o700);
  const alias = path.join(f.dir, 'alias'); fixtureSymlinkSync(f.files.ingress, alias); assert.throws(() => readServiceKey(alias)); fs.unlinkSync(alias);
  fixtureSymlinkSync(f.dir, alias); assert.throws(() => readServiceKey(path.join(alias, 'ingress'))); fs.unlinkSync(alias);
  fs.linkSync(f.files.ingress, alias); assert.throws(() => readServiceKey(f.files.ingress)); fs.unlinkSync(alias);
  assert.throws(() => readServiceKey(f.dir));
  for (const value of [KEYS.ingress + '\n', 'a'.repeat(43), 'x'.repeat(50000), 'synthetic-invalid-value', '']) {
    fs.writeFileSync(f.files.ingress, value); assert.throws(() => readServiceKey(f.files.ingress), e => e.message === 'Tunnel service credential file is unavailable or unsafe');
  }
  fs.writeFileSync(f.files.lark, KEYS.lark + '\n'); assert.equal(readServiceKey(f.files.lark, true), KEYS.lark);
  fs.writeFileSync(f.files.lark, KEYS.lark + '\r\n'); assert.throws(() => readServiceKey(f.files.lark, true));
});
test('different paths with identical credential content are rejected', t => {
  const f = fixture(t); fs.writeFileSync(f.files.lark, KEYS.qq); assert.throws(() => createApp(f.config), /independent/);
});
test('service authentication pins owner independently of identity/bearer claims and rejects invalid keys', () => {
  const auth = createAuthenticator(KEYS.ingress); assert.deepEqual(auth(authReq()), { id: OWNER });
  for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'X-Forwarded-Authorization', 'Remote-User', 'X-Forwarded-User', 'X-Forwarded-Client-Cert', 'X-Auth-User',
    'X-User-Id', 'X-Owner', 'X-Principal', 'X-Remote-User', 'X-OpenAI-User', 'X-OAI-Owner', 'OAI-Sites-User-Id', 'OpenAI-User',
    'X-MCP-Owner', 'X-Dot-Owner', 'X-Dot-Bridge-Owner', 'X-Dot-Bridge-Identity']) {
    assert.deepEqual(auth(authReq({ [name.toLowerCase()]: 'spoof' })), { id: OWNER });
  }
  for (const key of ['wrong', undefined, [KEYS.ingress], KEYS.qq, 'a'.repeat(43)]) assert.throws(() => auth(authReq({ [SERVICE_HEADER]: key })));
  assert.throws(() => auth(authReq({}, ['X-Dot-Bridge-Service-Key', KEYS.ingress, 'x-dot-bridge-service-key', KEYS.ingress])));
  assert.throws(() => auth({ ...authReq(), rawHeaders: undefined }));
  assert.throws(() => auth({ ...authReq(), socket: { remoteAddress: '192.0.2.1' } }));
});
test('catalog is local, minimal and read-only; ping and notifications cause no upstream request', async t => {
  const f = await running(t);
  const discovery = await post(f.port, 'server/discover'); assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.value.result.supportedVersions, [VERSION]);
  assert.deepEqual((await post(f.port, 'tools/list')).value.result.tools.map(t => t.name), ['check_bridge_setup', 'check_lark_readiness']);
  assert.deepEqual((await post(f.port, 'events/list')).value.result.events, []);
  assert.equal((await post(f.port, 'ping')).status, 200);
  const notification = request('notifications/cancelled', { requestId: 1 }); delete notification.id;
  assert.equal((await raw(f.port, notification)).status, 202);
  assert.equal(f.qq.state.seen.length + f.lark.state.seen.length, 0);
});
test('QQ and Lark use separate credentials and redact all upstream free text/metadata', async t => {
  const f = await running(t);
  const body = request('tools/call', { name: 'check_bridge_setup', arguments: {} }, 'client-id-private');
  body.params._meta['untrusted-owner'] = 'synthetic-private-canary';
  const qq = await raw(f.port, body, { 'x-extra-untrusted': 'synthetic-private-canary' });
  assert.equal(qq.status, 200); assert.equal(qq.value.id, 'client-id-private'); assert.equal(qq.value.result.structuredContent.configuration_ready, false);
  assert.equal(qq.text.includes('synthetic-private-canary'), false);
  assert.deepEqual(f.qq.state.seen.map(c => c.body.method), ['server/discover', 'tools/list', 'events/list', 'tools/call']);
  assert.equal(f.qq.state.seen.some(c => Object.hasOwn(c.headers, 'x-extra-untrusted')), false);
  const lark = await post(f.port, 'tools/call', { name: 'check_lark_readiness', arguments: {} }); assert.equal(lark.status, 200);
  assert.deepEqual(lark.value.result.structuredContent, { authenticated_mcp_reachable: true, readiness_catalog_only: true,
    provider_network_checked: false, ready_for_delivery: false, end_to_end_verified: false });
  assert.equal(lark.text.includes('synthetic-private-canary'), false);
  assert.deepEqual(f.lark.state.seen.map(c => c.body.method), ['server/discover', 'tools/list', 'events/list']);
  for (const response of [qq, lark]) for (const key of Object.values(KEYS)) assert.equal(response.text.includes(key), false);
});
test('writes, messages, callbacks, subscriptions, arbitrary params and URLs are rejected before upstream', async t => {
  const f = await running(t);
  for (const method of ['events/subscribe', 'events/unsubscribe', 'resources/read', 'initialize', 'unknown']) assert.equal((await post(f.port, method)).status, 403);
  for (const name of ['reply_to_qq', 'get_qq_message', 'reply_to_lark', 'get_lark_message', 'http://127.0.0.1']) assert.equal((await post(f.port, 'tools/call', { name, arguments: {} })).status, 403);
  for (const argumentsValue of [{ callback_url: 'https://example.invalid/?secret' }, { url: 'http://127.0.0.1' }, { command: 'id' }, { headers: {} }, [], null]) {
    assert.equal((await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: argumentsValue })).status, 400);
  }
  for (const method of ['tools/list', 'events/list']) assert.equal((await post(f.port, method, { cursor: 'next' })).status, 400);
  assert.equal((await post(f.port, 'server/discover', { endpoint: 'x' })).status, 400);
  assert.equal(f.qq.state.seen.length + f.lark.state.seen.length, 0);
});
test('original strict MCP metadata/header/version/Accept contract is preserved', async t => {
  const f = await running(t);
  assert.equal((await post(f.port, 'ping', {}, { 'mcp-method': 'tools/list' })).value.error.code, -32020);
  assert.equal((await post(f.port, 'ping', {}, { 'mcp-protocol-version': '2025-11-25' })).value.error.code, -32020);
  const old = request('ping'); old.params._meta['io.modelcontextprotocol/protocolVersion'] = '2025-11-25';
  const rejected = await raw(f.port, old, { 'mcp-protocol-version': '2025-11-25' }); assert.equal(rejected.value.error.code, -32022); assert.deepEqual(rejected.value.error.data.supported, [VERSION]);
  for (const name of ['io.modelcontextprotocol/protocolVersion', 'io.modelcontextprotocol/clientCapabilities']) {
    const body = request('ping'); delete body.params._meta[name]; assert.equal((await raw(f.port, body)).status, 400);
  }
  for (const accept of ['application/json', 'text/event-stream', '*/*']) assert.equal((await post(f.port, 'ping', {}, { accept })).status, 406);
  assert.equal((await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} }, { 'mcp-name': 'wrong' })).value.error.code, -32020);
  const encoded = '=?base64?' + Buffer.from('check_bridge_setup').toString('base64') + '?=';
  assert.equal((await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} }, { 'mcp-name': encoded })).status, 200);
  for (const body of [[], { ...request(), id: null }, { ...request(), jsonrpc: '1.0' }, { ...request(), unexpected: true }, { ...request(), params: [] }]) assert.equal((await raw(f.port, body, headers(request()))).status, 400);
});
test('HTTP rejects wrong key, duplicate protocol/auth, invalid host/origin/path/method and encodings', async t => {
  const f = await running(t);
  assert.equal((await post(f.port, 'ping', {}, { [SERVICE_HEADER]: KEYS.qq })).status, 401);
  for (const host of ['evil.invalid', `127.0.0.1:${f.port + 1}`, '127.0.0.1@evil.invalid', '2130706433']) assert.equal((await post(f.port, 'ping', {}, { host })).status, 403);
  assert.equal((await post(f.port, 'ping', {}, { origin: 'http://localhost' })).status, 403);
  assert.equal((await post(f.port, 'ping', {}, { authorization: 'Bearer fixture' })).status, 200);
  for (const url of ['/mcp?key=fixture', '/mcp/', '//mcp', '/qq/webhook', '/.well-known/oauth-protected-resource/mcp']) assert.equal((await raw(f.port, request(), {}, url)).status, 404);
  assert.equal((await raw(f.port, '', {}, '/mcp', 'GET')).status, 405);
  assert.equal((await post(f.port, 'ping', {}, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await post(f.port, 'ping', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await raw(f.port, Buffer.from([0xff]), headers(request()))).value.error.code, -32700);
  assert.equal((await raw(f.port, '{', headers(request()))).value.error.code, -32700);
  for (const header of [SERVICE_HEADER, 'Mcp-Method', 'Host', 'Accept']) {
    const h = ['Host', `127.0.0.1:${f.port}`, ...Object.entries(headers(request())).flat(), header, header === SERVICE_HEADER ? KEYS.ingress : 'ping'];
    const response = await raw(f.port, request(), h); assert.ok([400, 401].includes(response.status));
  }
});
test('request size and request-ID bounds are enforced', async t => {
  const f = await running(t), body = request('ping', { filler: 'x'.repeat(33000) });
  assert.equal((await raw(f.port, body, { 'content-length': Buffer.byteLength(JSON.stringify(body)) })).status, 413);
  assert.equal((await raw(f.port, request('ping', {}, 'x'.repeat(257)))).status, 400);
  const result = await post(f.port, 'ping'); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
});
test('upstream discovery/catalog growth and unsafe readiness claims fail closed', async t => {
  const f = await running(t);
  const cases = [
    (v,b) => { if (b.method === 'server/discover') v.result.supportedVersions = ['2025-11-25']; },
    (v,b) => { if (b.method === 'server/discover') v.result.capabilities.resources = {}; },
    (v,b) => { if (b.method === 'tools/list') v.result.tools.push({ name: 'reply_to_qq' }); },
    (v,b) => { if (b.method === 'events/list') v.result.events.push({ name: 'message' }); },
    ...["more", "", false, 0].map(cursor => (v,b) => { if (b.method === 'tools/list') v.result.nextCursor = cursor; }),
    (v,b) => { if (b.method === 'tools/call') v.result.structuredContent.configuration_ready = true; },
    (v,b) => { if (b.method === 'tools/call') v.result.structuredContent.events_discoverable = true; },
    (v,b) => { if (b.method === 'tools/call') v.result.structuredContent.callback_hostname = 'synthetic-private-canary'; },
    (v,b) => { if (b.method === 'tools/call') v.result.structuredContent.missing_settings.push('synthetic-private-canary'); },
    (v,b) => { if (b.method === 'tools/call') v.result.structuredContent.qq_api_profile = 'synthetic-private-canary'; },
    (v,b) => { if (b.method === 'tools/call') v.result.isError = true; },
    v => { v.id = 'wrong'; }, v => { v.error = { message: 'synthetic-private-canary' }; }, v => { delete v.result.resultType; }
  ];
  for (const mutate of cases) {
    f.qq.state.transform = (v,b) => { mutate(v,b); return v; };
    const result = await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} });
    assert.equal(result.status, 502); assert.equal(result.value.error.code, -32030); assert.equal(result.text.includes('synthetic-private-canary'), false);
  }
  f.lark.state.transform = (v,b) => { if (b.method === 'tools/list') v.result.tools.push({ name: 'reply_to_lark' }); return v; };
  assert.equal((await post(f.port, 'tools/call', { name: 'check_lark_readiness', arguments: {} })).status, 502);
});
test('upstream HTTP errors, redirects, malformed UTF8/JSON, compression and response bounds are sanitized', async t => {
  const f = await running(t);
  const replies = [
    res => { res.writeHead(401); res.end('synthetic-private-canary'); },
    res => { res.writeHead(302, { location: 'http://example.invalid/synthetic-private-canary' }); res.end(); },
    res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('synthetic-private-canary'); },
    res => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('synthetic-private-canary'); },
    res => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 50000 }); res.end('x'.repeat(50000)); },
    res => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('x'.repeat(20000)); res.end('x'.repeat(20000)); },
    res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{'); },
    res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(Buffer.from([0xff])); },
    res => res.destroy()
  ];
  for (const reply of replies) {
    f.qq.state.response = (_req,res) => reply(res);
    const result = await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} });
    assert.equal(result.status, 502); assert.equal(result.text.includes('synthetic-private-canary'), false);
  }
});
test('upstream timeout is bounded and sanitized', async t => {
  const f = await running(t); f.qq.state.response = () => {};
  const start = Date.now(), result = await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} });
  assert.equal(result.status, 502); assert.ok(Date.now() - start < 5000);
});
test('closing aborts upstream requests and sockets; close is idempotent; no listener override', async t => {
  const f = await running(t); await assert.rejects(f.app.listen(0, '0.0.0.0'));
  f.qq.state.response = () => {};
  const pending = post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} }).catch(() => null);
  while (!f.qq.state.seen.length) await new Promise(resolve => setTimeout(resolve, 10));
  const start = Date.now(); await f.app.close(); await f.app.close(); await pending;
  assert.ok(Date.now() - start < 1000); assert.equal(f.app.server.listening, false);
  await assert.rejects(f.app.listen(0));
});
test('per-process authenticated rate limit is bounded', async t => {
  const f = await running(t);
  for (let i = 0; i < 120; i++) assert.equal((await post(f.port, 'ping')).status, 200);
  assert.equal((await post(f.port, 'ping')).status, 429);
});
test('CLI signal shutdown exits cleanly and never prints credential values or file paths', async t => {
  const f = fixture(t), hold = http.createServer(); hold.listen(0, '127.0.0.1'); await new Promise(resolve => hold.once('listening', resolve));
  const port = hold.address().port; await new Promise(resolve => hold.close(resolve));
  const child = spawn(process.execPath, ['src/main.js'], { cwd: root, env: { PATH: process.env.PATH, ...f.env, PORT: String(port), ...(process.platform === 'win32' ? { DOT_BRIDGE_SUPERVISED: '1' } : {}) }, stdio: [process.platform === 'win32' ? 'pipe' : 'ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < (process.platform === 'win32' ? 500 : 100) && !output.includes('started') && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(output.includes('started'));
  if (process.platform === 'win32') child.stdin.end('stop\n'); else child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  for (const value of [...Object.values(KEYS), f.dir]) assert.equal(output.includes(value), false);
});

test('unauthenticated health endpoints expose fixed constants only and never probe upstream', async t => {
  const f = await running(t);
  const health = await raw(f.port, '', {}, '/healthz', 'GET');
  assert.equal(health.status, 200); assert.deepEqual(health.value, { status: 'ok', readiness_only: true, real_message_forwarding: false });
  const ready = await raw(f.port, '', {}, '/readyz', 'GET');
  assert.equal(ready.status, 503); assert.deepEqual(ready.value, { ready: false, ready_for_delivery: false, end_to_end_verified: false });
  assert.equal(f.qq.state.seen.length + f.lark.state.seen.length, 0);
});

test('upstream requests do not inherit proxy environment or the global HTTP agent', async t => {
  const f = await running(t), originalAgent = http.globalAgent;
  const original = Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(original)) process.env[name] = 'http://127.0.0.1:1';
  const forbiddenAgent = new http.Agent(); forbiddenAgent.createConnection = () => { assert.fail('Global agent must not be used'); };
  http.globalAgent = forbiddenAgent;
  try { assert.equal((await post(f.port, 'tools/call', { name: 'check_bridge_setup', arguments: {} })).status, 200); }
  finally { http.globalAgent = originalAgent; forbiddenAgent.destroy(); for (const [name,value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
test('concurrency is capped before a ninth request reaches upstream', async t => {
  const f = await running(t); f.qq.state.response = () => {};
  const pending = Array.from({length:8}, () => post(f.port, 'tools/call', {name:'check_bridge_setup',arguments:{}}).catch(() => null));
  while (f.qq.state.seen.length < 8) await new Promise(resolve => setTimeout(resolve,10));
  assert.equal((await post(f.port, 'ping')).status, 429); assert.equal(f.qq.state.seen.length, 8);
  await f.app.close(); await Promise.all(pending);
});

test('slow incomplete incoming body is closed within the body deadline without upstream work', async t => {
  const f = await running(t), start = Date.now();
  await new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1',port:f.port,path:'/mcp',method:'POST',agent:false,headers:headers(request()) }, res => { res.resume(); res.on('end',resolve); });
    const guard = setTimeout(() => { req.destroy(); reject(Error('Body deadline not enforced')); }, 7000);
    req.on('error', () => { clearTimeout(guard); resolve(); });
    req.on('close', () => { clearTimeout(guard); resolve(); });
    req.write('{');
  });
  assert.ok(Date.now() - start < 6500); assert.equal(f.qq.state.seen.length + f.lark.state.seen.length, 0);
});

const claimHeaders = Object.fromEntries(['authorization','proxy-authorization','cookie','forwarded','x-forwarded-for','x-forwarded-host',
  'x-forwarded-proto','x-forwarded-user','x-forwarded-client-cert','x-forwarded-authorization','x-auth-user','x-user-id','x-owner',
  'x-principal','remote-user','x-openai-user-id','x-oai-owner','oai-sites-user-id','openai-user','x-dot-bridge-owner',
  'x-dot-bridge-identity','x-mcp-owner','x-unrecognized-context'].map(name=>[name,'synthetic-private-canary']));
test('combined caller claims cannot establish authority without the real peer and unique consistent key', () => {
  const auth=createAuthenticator(KEYS.ingress);
  assert.deepEqual(auth(authReq(claimHeaders)),{id:OWNER});
  for(const wrong of [KEYS.qq,'invalid',undefined])assert.throws(()=>auth(authReq({...claimHeaders,[SERVICE_HEADER]:wrong})),e=>e.status===401);
  const missing=authReq(claimHeaders);delete missing.headers[SERVICE_HEADER];missing.rawHeaders=Object.entries(claimHeaders).flat();assert.throws(()=>auth(missing),e=>e.status===401);
  assert.throws(()=>auth({...authReq(claimHeaders),socket:{remoteAddress:'192.0.2.99'}}),e=>e.status===401);
  for(const pair of [[KEYS.ingress,KEYS.qq],[KEYS.qq,KEYS.ingress],[KEYS.qq,KEYS.qq],['invalid',KEYS.ingress]]) {
    const r=authReq({...claimHeaders,[SERVICE_HEADER]:pair[1]});r.rawHeaders=['X-Dot-Bridge-Service-Key',pair[0],...Object.entries(claimHeaders).flat()];assert.throws(()=>auth(r),e=>e.status===401);
  }
  const duplicate=authReq(claimHeaders,['X-Dot-Bridge-Service-Key',KEYS.ingress,'x-dot-bridge-service-key',KEYS.ingress,...Object.entries(claimHeaders).flat()]);
  assert.throws(()=>auth(duplicate),e=>e.status===401);
  const parsedDuplicate=authReq(claimHeaders);parsedDuplicate.headers['X-Dot-Bridge-Service-Key']=KEYS.ingress;assert.throws(()=>auth(parsedDuplicate),e=>e.status===401);
  const parsedMissing=authReq(claimHeaders);delete parsedMissing.headers[SERVICE_HEADER];assert.throws(()=>auth(parsedMissing),e=>e.status===401);
  const rawMissing=authReq(claimHeaders);rawMissing.rawHeaders=Object.entries(claimHeaders).flat();assert.throws(()=>auth(rawMissing),e=>e.status===401);
});
test('all non-authoritative claims are discarded and cannot change HTTP/MCP policy, RPC scope or upstream', async t => {
  const f=await running(t);
  const result=await post(f.port,'tools/call',{name:'check_bridge_setup',arguments:{}},claimHeaders);
  assert.equal(result.status,200);assert.equal(result.text.includes('synthetic-private-canary'),false);
  assert.equal(f.qq.state.seen.length,4);assert.equal(f.lark.state.seen.length,0);
  for(const call of f.qq.state.seen){assert.equal(call.headers.host,`127.0.0.1:${f.qq.port}`);for(const name of Object.keys(claimHeaders))assert.equal(call.headers[name],undefined);}
  assert.equal((await post(f.port,'ping',{}, {...claimHeaders,host:'evil.invalid'})).status,403);
  assert.equal((await post(f.port,'ping',{}, {...claimHeaders,origin:'https://evil.invalid'})).status,403);
  assert.equal((await post(f.port,'ping',{}, {...claimHeaders,[SERVICE_HEADER]:KEYS.qq})).status,401);
  const noKey=headers(request());delete noKey[SERVICE_HEADER];assert.equal((await raw(f.port,JSON.stringify(request()),{...noKey,...claimHeaders})).status,401);
  assert.equal((await post(f.port,'ping',{}, {...claimHeaders,'mcp-method':'tools/list'})).value.error.code,-32020);
  assert.equal((await post(f.port,'events/subscribe',{},claimHeaders)).status,403);
  assert.equal((await post(f.port,'tools/call',{name:'reply_to_qq',arguments:{}},claimHeaders)).status,403);
  const duplicate=['Host',`127.0.0.1:${f.port}`,...Object.entries(headers(request())).flat(),...Object.entries(claimHeaders).flat(),'X-Dot-Bridge-Service-Key',KEYS.ingress];
  assert.equal((await raw(f.port,request(),duplicate)).status,401);
  for(const name of ['Host','MCP-Method','MCP-Protocol-Version','Origin','MCP-Session-Id']){
    const h=['Host',`127.0.0.1:${f.port}`,...Object.entries(headers(request())).flat(),...Object.entries(claimHeaders).flat()];
    if(['Origin','MCP-Session-Id'].includes(name))h.push(name,'fixture');h.push(name,'fixture');
    assert.equal((await raw(f.port,request(),h)).value.error.code,-32020);
  }
});
test('post-auth positive normalizer retains only HTTP/MCP fields and never changes actual socket/destination', () => {
  const socket={remoteAddress:'127.0.0.1'}, retained={host:'127.0.0.1:8789','content-type':'application/json','content-length':'2',
    'content-encoding':'identity',accept:'application/json, text/event-stream','mcp-method':'ping','mcp-protocol-version':VERSION,'mcp-session-id':'fixture-session'};
  const r=authReq({...claimHeaders,...retained});r.socket=socket;r.url='/mcp';r.method='POST';
  assert.deepEqual(createAuthenticator(KEYS.ingress)(r),{id:OWNER});checkHeaders(r,8789);retainValidationHeaders(r);
  assert.deepEqual({...r.headers},retained);assert.deepEqual(r.rawHeaders,Object.entries(retained).flat());assert.equal(r.socket,socket);assert.equal(r.url,'/mcp');assert.equal(r.method,'POST');
  assert.equal(r.headers[SERVICE_HEADER],undefined);assert.equal(JSON.stringify(r).includes('synthetic-private-canary'),false);
  const before=JSON.stringify(r);retainValidationHeaders(r);assert.equal(JSON.stringify(r),before);
});
test('original raw Host/Origin and critical mirrors are checked before any filtering', () => {
  const base=()=>({headers:{host:'127.0.0.1:8789','mcp-method':'ping'},rawHeaders:['Host','127.0.0.1:8789','Mcp-Method','ping']});
  assert.doesNotThrow(()=>checkHeaders(base(),8789));
  for(const name of ['host','origin','mcp-method','mcp-name','mcp-protocol-version','mcp-session-id','content-type','content-length','content-encoding','transfer-encoding','accept']) {
    const rawOnly=base();rawOnly.rawHeaders.push(name,'unexpected');assert.throws(()=>checkHeaders(rawOnly,8789));
    const parsedOnly=base();parsedOnly.headers[name]='unexpected';assert.throws(()=>checkHeaders(parsedOnly,8789));
    const duplicate=base();if(!['host','mcp-method'].includes(name)){duplicate.rawHeaders.push(name,'fixture');duplicate.headers[name]='fixture';}duplicate.rawHeaders.push(name,'fixture');assert.throws(()=>checkHeaders(duplicate,8789));
  }
  const origin=base();origin.headers.origin='https://evil.invalid';origin.rawHeaders.push('Origin',origin.headers.origin);assert.throws(()=>checkHeaders(origin,8789),e=>e.status===403);
  for(const raw of [undefined,['odd'],[null,'value']])assert.throws(()=>checkHeaders({...base(),rawHeaders:raw},8789));
});
