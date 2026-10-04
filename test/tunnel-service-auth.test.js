import { privateMkdtempSync, privateMkdirSync, fixtureChmodSync, fixtureSymlinkSync } from '../packages/dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createAuthenticator } from '../src/auth.js';
import { readServiceKey } from '../src/tunnel-service-auth.js';
import { createApp } from '../src/server.js';
import { mcpRequest } from './helpers.js';
const key = Buffer.alloc(32, 19).toString('base64url'); // public fixture only
function fixture(t) {
  const dir = privateMkdtempSync(path.join(os.tmpdir(), 'qq-tunnel-auth-test-')); fixtureChmodSync(dir, 0o700);
  const file = path.join(dir, 'key'); fs.writeFileSync(file, key, { mode: 0o600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_KEY_FILE: file,
    TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:dot-bridge', QQ_TRANSPORT: 'disabled', STORAGE_KEY: Buffer.alloc(32, 20).toString('base64') };
  return { dir, file, env, config: { ...readConfig(env), dbPath: ':memory:' } };
}
function req(headers = {}, rawHeaders) {
  const h = { 'x-dot-bridge-service-key': key, ...headers };
  return { headers: h, rawHeaders: rawHeaders ?? Object.entries(h).flat(), socket: { remoteAddress: '127.0.0.1' } };
}
test('tunnel mode is explicit, local-only, separate from provider/OAuth and readiness cannot activate traffic', t => {
  const f = fixture(t); assert.equal(f.config.principal, 'tunnel-owner:dot-bridge'); assert.equal(f.config.tunnelServiceReadinessOnly, true);
  for (const change of [{ BRIDGE_MODE: 'sites' }, { HOST: '0.0.0.0' }, { HOST: 'localhost' }, { PUBLIC_ORIGIN: 'https://example.com' },
    { TUNNEL_SERVICE_OWNER_ID: 'someone@example.com' }, { TUNNEL_SERVICE_KEY_FILE: 'relative' }, { MCP_OWNER_SUBJECT: 'other' },
    { OAUTH_ISSUER: 'https://issuer.example' }, { DEV_BEARER_TOKEN: 'secret' }, { QQ_TRANSPORT: 'gateway' }, { QQ_TRANSPORT: 'webhook' },
    { QQ_OWNER_OPENID: 'guessed' }, { QQ_BOT_SECRET: 'anything' }, { MCP_CALLBACK_ALLOWED_HOSTS: 'callback.example' }, { TUNNEL_SERVICE_READINESS_ONLY: 'false' }]) {
    assert.throws(() => readConfig({ ...f.env, ...change }));
  }
  assert.equal(readConfig({}).authMode, 'deny');
});
test('strict key reader rejects symlinks, hardlinks, permissions and malformed token without exposing it', t => {
  const f = fixture(t); assert.equal(readServiceKey(f.file), key);
  fixtureChmodSync(f.file, 0o644); assert.throws(() => readServiceKey(f.file), /unavailable or unsafe/); fixtureChmodSync(f.file, 0o600);
  fixtureChmodSync(f.dir, 0o755); assert.throws(() => readServiceKey(f.file)); fixtureChmodSync(f.dir, 0o700);
  const link = path.join(f.dir, 'link'); fixtureSymlinkSync(f.file, link); assert.throws(() => readServiceKey(link));
  const sub = path.join(f.dir, 'sub'); privateMkdirSync(sub, { mode: 0o700 }); fixtureSymlinkSync(f.dir, path.join(sub, 'linked')); assert.throws(() => readServiceKey(path.join(sub, 'linked', 'key')));
  const hard = path.join(f.dir, 'hard'); fs.linkSync(f.file, hard); assert.throws(() => readServiceKey(f.file)); fs.unlinkSync(hard);
  for (const value of [key + '\n', 'sk-sensitive-fixture', 'a'.repeat(43), 'x'.repeat(10000)]) {
    fs.writeFileSync(f.file, value); assert.throws(() => readServiceKey(f.file), error => !error.message.includes(value));
  }
});
test('service authenticator only returns pinned local owner; no network, spoofed identities, duplicates, arrays or remote peers', async t => {
  const f = fixture(t); const auth = createAuthenticator(f.config, () => assert.fail('network forbidden'), () => 1000);
  assert.deepEqual(await auth(req()), { id: 'tunnel-owner:dot-bridge', validUntil: 1000 + f.config.subscriptionTtlMs });
  for (const h of [{ authorization: 'Bearer anything' }, { 'oai-sites-user-id': 'other' }, { 'x-openai-user-id': 'other' },
    { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { cookie: 'identity=other' },
    { 'x-dot-bridge-owner': 'other' }, { 'x-dot-bridge-user': 'other' }, { 'x-dot-bridge-identity': 'other' }, { 'oai-user-id': 'other' }, { 'x-dot-bridge-service-key': 'wrong' }, { 'x-dot-bridge-service-key': [key] },
    { 'x-dot-bridge-service-key': key + ',' + key }, { 'x-dot-bridge-service-key': undefined }]) await assert.rejects(auth(req(h)), e => e.status === 401);
  await assert.rejects(auth(req({}, ['X-Dot-Bridge-Service-Key', key, 'x-dot-bridge-service-key', key])));
  await assert.rejects(auth({ ...req(), rawHeaders: undefined }));
  await assert.rejects(auth({ ...req(), socket: { remoteAddress: '10.0.0.1' } }));
});
async function post(origin, method, params = {}, extra = {}) {
  const body = mcpRequest(method, params);
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-method': method, 'mcp-protocol-version': '2026-07-28', ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
    'x-dot-bridge-service-key': key, ...extra }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
test('actual HTTP readiness provides discovery only, rejects writes and raw duplicate header, no bot/event traffic', async t => {
  const f = fixture(t); const app = createApp(f.config, { worker: false, send: () => assert.fail('network forbidden') });
  t.after(() => app.close()); const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  const discover = await post(origin, 'server/discover'); assert.equal(discover.status, 200);
  assert.deepEqual((await post(origin, 'events/list')).body.result.events, []);
  assert.deepEqual((await post(origin, 'tools/list')).body.result.tools.map(x => x.name), ['check_bridge_setup']);
  assert.equal((await post(origin, 'tools/call', { name: 'check_bridge_setup', arguments: {} })).status, 200);
  for (const [method, params] of [['events/subscribe', {}], ['events/unsubscribe', {}], ['tools/call', { name: 'reply_to_qq', arguments: {} }]]) assert.equal((await post(origin, method, params)).status, 403);
  assert.equal((await post(origin, 'ping', {}, { 'x-dot-bridge-service-key': 'wrong' })).status, 401);
  assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).status, 404);
  assert.equal((await fetch(`${origin}/readyz`)).status, 503);
  assert.equal((await fetch(`${origin}/qq/webhook`, { method: 'POST' })).status, 404);
  assert.equal(await app.bridge.tick(), false); assert.equal(app.bridge.acceptQq({}), 'ignored');
  const status = await new Promise((resolve, reject) => { const r = http.request(`${origin}/mcp`, { method: 'POST', headers: {
    'x-dot-bridge-service-key': [key, key], 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end('{}'); });
  assert.equal(status, 401);
});
test('listen override cannot expose service mode beyond loopback', async t => {
  const f = fixture(t); const app = createApp(f.config, { worker: false }); t.after(() => app.close());
  await assert.rejects(app.listen(0, '0.0.0.0'), /loopback/);
});

test('direct readiness app construction rejects persistent storage before touching files', t => {
  const f = fixture(t), dbPath = path.join(f.dir, 'must-not-exist.sqlite');
  assert.throws(() => createApp({ ...f.config, dbPath }), /ephemeral/);
  assert.equal(fs.existsSync(dbPath), false);
});
