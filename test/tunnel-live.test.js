import { cleanupPrivateFixture, beforeFixtureCleanup, privateMkdirSync, privateMkdtempSync, fixtureChmodSync, fixtureSymlinkSync, assertPrivateFixture } from '../packages/dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { Bridge } from '../src/bridge.js';
import { readQqCredentials, saveQqCredentials } from '../src/credential-store.js';
import { servicePreflight, serviceSnapshot, startPersistentService, startLockedPersistentService } from '../src/service-runtime.js';
import { acquireModeLock } from '../src/bridge-mode.js';
import { fixtureGateway } from './gateway-helpers.js';
import { mcpRequest, subscriptionParams, qqPayload } from './helpers.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';
import { makePublicRequester } from '../src/network.js';

const serviceKey = Buffer.alloc(32, 21).toString('base64url');
const storageKey = Buffer.alloc(32, 22).toString('base64url');
function fixture(t) {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'qq-live-synthetic-'));
  fixtureChmodSync(directory, 0o700); cleanupPrivateFixture(t, directory);
  const key = path.join(directory, 'service-key'), storage = path.join(directory, 'storage-key');
  fs.writeFileSync(key, serviceKey, { mode: 0o600 }); fs.writeFileSync(storage, storageKey, { mode: 0o600 });
  saveQqCredentials({ appId: 'fixture-app', appSecret: 'synthetic-qq-secret', ownerOpenid: 'fixture_qq_owner', ownerEvidence: 'official-qr-response' },
    { directory, expectedAppId: 'fixture-app', profile: 'tencent-sdk' });
  const env = { AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_OPERATION: 'live',
    TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:dot-bridge', TUNNEL_SERVICE_KEY_FILE: key, QQ_TRANSPORT: 'gateway',
    QQ_API_PROFILE: 'tencent-sdk', QQ_APP_ID: 'fixture-app', QQ_CREDENTIALS_FILE: path.join(directory, 'credentials.json'),
    STORAGE_KEY_FILE: storage, DATABASE_PATH: path.join(directory, 'bridge.sqlite'), BRIDGE_LOCK_DIRECTORY: directory,
    MCP_CALLBACK_ALLOWED_HOSTS: 'receiver.example.com', SUBSCRIPTION_TTL_SECONDS: '60' };
  return { directory, key, storage, env, config: () => readConfig(env) };
}

test('live requires explicit opt-in and complete file-bound scope; config/preflight never create storage', t => {
  const f = fixture(t); const config = f.config();
  assert.equal(config.tunnelServiceReadinessOnly, false); assert.equal(servicePreflight(f.env).ready_to_start, true);
  assert.equal(fs.existsSync(f.env.DATABASE_PATH), false);
  for (const change of [{ TUNNEL_SERVICE_OPERATION: '' }, { TUNNEL_SERVICE_OPERATION: 'other' }, { TUNNEL_SERVICE_READINESS_ONLY: 'true' },
    { QQ_CREDENTIALS_FILE: '' }, { QQ_APP_ID: 'different' }, { QQ_API_PROFILE: 'documented' }, { QQ_TRANSPORT: 'webhook' },
    { QQ_BOT_SECRET: 'never-secret' }, { QQ_OWNER_OPENID: 'guessed' }, { STORAGE_KEY: 'never-secret' }, { STORAGE_KEY_FILE: f.key },
    { DATABASE_PATH: ':memory:' }, { DATABASE_PATH: 'relative.sqlite' }, { BRIDGE_LOCK_DIRECTORY: '' }, { TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:other' },
    { MCP_OWNER_SUBJECT: 'other' }, { SITES_BINDING_ID: 'other' }, { OAUTH_REQUIRED_SCOPE: 'other' }, { PUBLIC_ORIGIN: 'https://public.example' }]) {
    assert.throws(() => readConfig({ ...f.env, ...change }), e => !e.message.includes('never-secret'));
    assert.equal(servicePreflight({ ...f.env, ...change }).ready_to_start, false);
  }
  assert.equal(fs.existsSync(f.env.DATABASE_PATH), false);
});
test('credential loader rejects guessed evidence, scope changes, unsafe file links/permissions and wrong ownership', t => {
  const f = fixture(t), file = f.env.QQ_CREDENTIALS_FILE, original = fs.readFileSync(file);
  assert.equal(readQqCredentials(file, { expectedAppId: 'fixture-app', profile: 'tencent-sdk' }).ownerOpenid, 'fixture_qq_owner');
  for (const change of [{ owner_evidence: 'first-message' }, { owner_evidence: undefined }, { owner_openid: '' }, { app_id: 'other' }, { extra: 'unknown' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...change })); assert.throws(f.config);
  }
  fs.writeFileSync(file, original); fixtureChmodSync(file, 0o640); assert.throws(f.config); fixtureChmodSync(file, 0o600);
  fs.linkSync(file, path.join(f.directory, 'hard')); assert.throws(f.config); fs.unlinkSync(path.join(f.directory, 'hard'));
  fixtureSymlinkSync(file, path.join(f.directory, 'link')); assert.throws(() => readConfig({ ...f.env, QQ_CREDENTIALS_FILE: path.join(f.directory, 'link') }));
  if (typeof process.getuid === 'function' && process.getuid() === 0) { fs.chownSync(file, 65534, 65534); assert.throws(f.config); fs.chownSync(file, 0, 0); }
  fixtureChmodSync(f.directory, 0o755); assert.throws(f.config); fixtureChmodSync(f.directory, 0o700);
  assert.throws(() => saveQqCredentials({ appId: 'fixture-app', appSecret: 'synthetic-secret', ownerOpenid: 'guessed' },
    { directory: path.join(f.directory, 'not-created'), expectedAppId: 'fixture-app', profile: 'tencent-sdk' }));
  assert.equal(fs.existsSync(path.join(f.directory, 'not-created')), false);
});
test('raw app and Bridge construction cannot bypass readiness/live safeguards or create a database', t => {
  const f = fixture(t), config = f.config();
  assert.throws(() => createApp(config), /explicit approval/); assert.throws(() => new Bridge(config), /explicit approval/);
  for (const change of [{ tunnelServiceOperation: undefined }, { tunnelServiceReadinessOnly: true }, { ownerOpenid: 'guessed' },
    { qqSecret: 'guessed' }, { storageKey: Buffer.alloc(32, 23).toString('base64') }, { qqCredentialsFile: '' },
    { dbPath: ':memory:' }, { sitesPlatformToken: 'mixed' }, { host: '0.0.0.0' }, { subscriptionTtlMs: Infinity }]) {
    assert.throws(() => createApp({ ...config, ...change }, { approvedLive: true })); assert.throws(() => new Bridge({ ...config, ...change }, { approvedLive: true }));
  }
  assert.equal(fs.existsSync(f.env.DATABASE_PATH), false);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = f.env.DATABASE_PATH + suffix; fixtureSymlinkSync(f.key, target); assert.throws(f.config); fs.unlinkSync(target);
  }
  fs.linkSync(f.key, f.env.DATABASE_PATH); assert.throws(f.config); fs.unlinkSync(f.env.DATABASE_PATH);
});
test('unapproved library runtime rejects before credential reads, lock, listener or store side effects', async t => {
  const f = fixture(t), config = f.config(); fs.unlinkSync(f.key); fs.unlinkSync(f.storage); fs.unlinkSync(f.env.QQ_CREDENTIALS_FILE);
  assert.throws(() => createApp(config), /explicit approval/); assert.throws(() => new Bridge(config), /explicit approval/);
  await assert.rejects(startPersistentService(config, { appFactory: () => assert.fail('app must not start') }), /explicit approval/);
  await assert.rejects(startLockedPersistentService(config, { lockFactory: () => assert.fail('lock must not open') }), /explicit approval/);
  assert.equal(fs.existsSync(f.env.DATABASE_PATH), false);
});

async function liveHarness(t, { callback = true, worker = false } = {}) {
  const f = fixture(t); if (!callback) f.env.MCP_CALLBACK_ALLOWED_HOSTS = '';
  let now = Date.parse('2026-10-03T12:00:00Z'); const requests = [], events = [], replies = [];
  const send = async (url, options) => {
    options.beforeConnect?.(); requests.push(url);
    if (url.endsWith('/gateway/bot')) return { status: 200, body: Buffer.from(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket/', shards: 1, session_start_limit: { total: 10, remaining: 10, reset_after: 1000, max_concurrency: 1 } })) };
    const body = JSON.parse(options.body);
    if (url.startsWith('https://receiver.example.com/')) {
      if (body.type === 'verification') return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
      events.push(body); return { status: 202, body: Buffer.from('{}') };
    }
    if (url.endsWith('/app/getAppAccessToken')) return { status: 200, body: Buffer.from('{"access_token":"synthetic-token","expires_in":7200}') };
    if (url.includes('/v2/users/')) { replies.push({ url, body }); return { status: 200, body: Buffer.from('{"id":"synthetic-outbound"}') }; }
    assert.fail('unexpected synthetic route');
  };
  send.callbackPreflight = () => preflightCallbackTransport({ proxyEnv: {} });
  const config = { ...f.config(), workerIntervalMs: 5 }, app = createApp(config, { clock: () => now, send, worker, approvedLive: true });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`; let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } }; beforeFixtureCleanup(t, close);
  const post = async (method, params = {}, headers = {}) => {
    const body = mcpRequest(method, params);
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), 'x-dot-bridge-service-key': serviceKey, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, config, app, origin, now: () => now, advance: ms => { now += ms; }, close, post, requests, events, replies };
}
test('live catalog and authenticated Events are fixed; no gateway request until allowlist and valid subscription', async t => {
  const f = await liveHarness(t, { callback: false });
  const gw = fixtureGateway(f); f.app.attachGateway(gw.gateway); await gw.gateway.start();
  assert.equal(gw.gateway.status().phase, 'waiting_subscription'); assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.post('tools/list')).body.result.tools.map(x => x.name), ['get_qq_message', 'reply_to_qq', 'check_bridge_setup']);
  assert.equal((await f.post('events/list')).body.result.events[0].name, 'qq.message.created');
  const rejected = await f.post('events/subscribe', subscriptionParams()); assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.data.callback_hostname, 'receiver.example.com'); assert.equal(f.requests.length, 0);
  assert.equal((await f.post('ping', {}, { authorization: 'Bearer fake' })).status, 401);
  assert.equal((await fetch(`${f.origin}/qq/webhook`, { method: 'POST' })).status, 404);
});
test('synthetic live gateway and encrypted durable queue complete one reply, reject caller recipients, expire and restart safely', async t => {
  const f = await liveHarness(t); const gw = fixtureGateway(f); f.app.attachGateway(gw.gateway); await gw.gateway.start();
  assert.equal(f.requests.length, 0);
  const sub = await f.post('events/subscribe', subscriptionParams({ ttlMs: 999999999 })); assert.equal(sub.status, 200);
  assert.equal(Date.parse(sub.body.result.refreshBefore), f.now() + 60000);
  await gw.gateway.connect(); gw.hello(); gw.ready(); assert.equal(gw.gateway.status().connected, true);
  const incoming = { ...qqPayload(f.now()), s: 1 }; gw.sockets[0].push(incoming); gw.sockets[0].push(incoming);
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
  assert.equal(await f.app.bridge.tick(), true); assert.equal(f.events.length, 1);
  const args = { message_id: 'fixture-message-1', text: 'synthetic answer' };
  assert.equal((await f.post('tools/call', { name: 'reply_to_qq', arguments: { ...args, recipient: 'other' } })).status, 400);
  assert.equal((await f.post('tools/call', { name: 'reply_to_qq', arguments: args })).status, 200);
  assert.equal((await f.post('tools/call', { name: 'reply_to_qq', arguments: args })).status, 200);
  await f.app.bridge.tick(); assert.equal(f.replies.length, 1); assert.ok(f.replies[0].url.includes('/fixture_qq_owner/'));
  const raw = f.app.bridge.store.get('SELECT text FROM messages').text; assert.ok(!raw.includes('2 + 2'));
  f.advance(60001); gw.gateway.heartbeat(); assert.equal(gw.gateway.status().connected, false);
  assert.equal((await f.post('tools/call', { name: 'reply_to_qq', arguments: args })).status, 400);
  await f.close(); assert.equal(gw.intervals.size, 0); assert.equal(gw.timeouts.size, 0);
  assertPrivateFixture(assert, f.env.DATABASE_PATH, 0o600);
  const restarted = createApp(f.config, { send: () => assert.fail('network forbidden'), worker: false, approvedLive: true });
  assert.equal(restarted.bridge.store.replyStatus('fixture-message-1').status, 'sent'); await restarted.close();
  fs.writeFileSync(f.storage, Buffer.alloc(32, 24).toString('base64url'));
  assert.throws(() => createApp(readConfig(f.env), { worker: false, approvedLive: true }));
});
test('live enables normal queue worker and direct startup flags never silently activate readiness', async t => {
  const f = await liveHarness(t, { worker: true });
  await f.post('events/subscribe', subscriptionParams()); f.app.bridge.acceptQq(qqPayload(f.now()), 'synthetic-replay');
  const deadline = Date.now() + 1000;
  while (!f.events.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.events.length, 1);
  const attempted = spawnSync(process.execPath, ['scripts/run-tunnel-readiness.js'], { env: f.env, encoding: 'utf8' });
  assert.equal(attempted.status, 1); assert.equal(attempted.stdout, '');
  const plan = spawnSync(process.execPath, ['scripts/qq-service.js'], { env: f.env, encoding: 'utf8' });
  assert.equal(plan.status, 0); assert.equal(JSON.parse(plan.stdout).started, false);
});
test('mode lock rejects ancestor links, hardlinked replacement, and a second mode consumer', t => {
  const f = fixture(t); const release = acquireModeLock(f.directory, 'qq', 'fixture-app', 'tunnel');
  assert.throws(() => acquireModeLock(f.directory, 'qq', 'fixture-app', 'sites'));
  release(); const link = path.join(f.directory, 'link'); fixtureSymlinkSync(f.directory, link);
  assert.throws(() => acquireModeLock(link, 'qq', 'fixture-app', 'tunnel'));
  const releaseAgain = acquireModeLock(f.directory, 'qq', 'fixture-app', 'tunnel');
  const lock = fs.readdirSync(f.directory).find(name => name.endsWith('.lock'));
  fs.linkSync(path.join(f.directory, lock), path.join(f.directory, 'linked-lock')); assert.throws(releaseAgain);
  fs.unlinkSync(path.join(f.directory, 'linked-lock')); releaseAgain();
});
test('live close is idempotent, refuses reopening and closes a racing listen before returning', async t => {
  const f = fixture(t); const app = createApp(f.config(), { send: () => assert.fail('network forbidden'), worker: false, approvedLive: true });
  const listening = app.listen(0); const closed = app.close();
  assert.equal(app.close(), closed); await assert.rejects(listening, /cancelled/); await closed;
  assert.equal(app.server.listening, false); await assert.rejects(app.listen(0), /closed/);
  const second = createApp(f.config(), { send: () => assert.fail('network forbidden'), worker: false, approvedLive: true });
  await second.listen(0); await assert.rejects(second.listen(0), /started/); await second.close();
  assert.equal(second.server.listening, false);
});
test('restart with removed callback hostname cannot reuse durable subscription or contact QQ', async t => {
  const f = await liveHarness(t); await f.post('events/subscribe', subscriptionParams());
  f.app.bridge.acceptQq(qqPayload(f.now()), 'fixture-replay'); await f.app.bridge.tick();
  await f.post('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'fixture-message-1', text: 'queued before policy change' } });
  await f.close();
  for (const hosts of ['', 'other.example.com']) {
    const config = readConfig({ ...f.env, MCP_CALLBACK_ALLOWED_HOSTS: hosts });
    const app = createApp(config, { clock: f.now, send: () => assert.fail('network forbidden'), worker: false, approvedLive: true });
    const gw = fixtureGateway({ app, now: f.now }); app.attachGateway(gw.gateway); await gw.gateway.start();
    assert.equal(gw.gateway.status().phase, 'waiting_subscription'); assert.equal(gw.calls.length, 0);
    assert.equal(app.bridge.store.activeSubscription(f.now()), undefined);
    assert.throws(() => app.bridge.store.queueReply('fixture-message-1', 'blocked', config.principal, f.now()));
    await app.bridge.tick();
    assert.notEqual(app.bridge.store.replyStatus('fixture-message-1').status, 'sent');
    await app.close();
  }
});
test('live durable fields stay encrypted in SQLite and WAL, reopen correctly, and reject key mismatch and tamper', async t => {
  const f = await liveHarness(t);
  const messageText = 'synthetic-message-canary-7acbb928', replyText = 'synthetic-reply-canary-5288f834';
  const url = 'https://receiver.example.com/callback-canary-cd8761ae?opaque=5631452';
  const secret = `whsec_${Buffer.alloc(32, 27).toString('base64')}`;
  const subscribed = await f.post('events/subscribe', subscriptionParams({ delivery: { mode: 'webhook', url, secret } }));
  assert.equal(subscribed.status, 200); const subId = subscribed.body.result.id;
  f.app.bridge.acceptQq(qqPayload(f.now(), { content: messageText }), 'synthetic-encryption-event');
  await f.app.bridge.tick();
  await f.post('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'fixture-message-1', text: replyText } });
  const scan = () => {
    for (const suffix of ['', '-wal']) {
      const file = f.env.DATABASE_PATH + suffix; if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      for (const canary of [messageText, replyText, url, secret]) assert.equal(bytes.includes(Buffer.from(canary)), false);
    }
  };
  scan(); await f.close(); scan();
  const app = createApp(readConfig(f.env), { clock: f.now, approvedLive: true, worker: false, send: () => assert.fail('network forbidden') });
  const store = app.bridge.store;
  assert.equal(store.message('fixture-message-1').text, messageText); assert.equal(store.replyText('fixture-message-1'), replyText);
  assert.equal(store.subscription(subId).url, url); assert.equal(store.subscription(subId).secret, secret);
  for (const [table, column, idColumn, id, read] of [
    ['messages', 'text', 'id', 'fixture-message-1', () => store.message('fixture-message-1')],
    ['replies', 'text', 'message_id', 'fixture-message-1', () => store.replyText('fixture-message-1')],
    ['subscriptions', 'callback', 'id', subId, () => store.subscription(subId)]
  ]) {
    const original = store.get(`SELECT ${column} AS encrypted FROM ${table} WHERE ${idColumn}=?`, id).encrypted;
    const bytes = Buffer.from(original, 'base64'); bytes[bytes.length - 1] ^= 1;
    store.run(`UPDATE ${table} SET ${column}=? WHERE ${idColumn}=?`, bytes.toString('base64'), id);
    assert.throws(read); store.run(`UPDATE ${table} SET ${column}=? WHERE ${idColumn}=?`, original, id);
  }
  await app.close(); scan();
  fs.writeFileSync(f.storage, Buffer.alloc(32, 28).toString('base64url'));
  assert.throws(() => createApp(readConfig(f.env), { approvedLive: true, worker: false }));
});
test('live restart with a persisted subscription cannot activate provider while managed callback adapter is unavailable', async t => {
  const f = await liveHarness(t); assert.equal((await f.post('events/subscribe', subscriptionParams())).status, 200); await f.close();
  const proxyEnv = { HTTPS_PROXY: 'http://synthetic-private@managed.invalid:3128' };
  const send = makePublicRequester({ proxyEnv, lookup: () => assert.fail('DNS forbidden'), request: () => assert.fail('request forbidden'),
    providerSend: () => assert.fail('provider forbidden') });
  const app = createApp(f.config, { clock: f.now, send, approvedLive: true, worker: false });
  const gw = fixtureGateway({ app, now: f.now }); app.attachGateway(gw.gateway); await app.listen(0); beforeFixtureCleanup(t, () => app.close());
  await gw.gateway.start();
  assert.equal(gw.gateway.status().phase, 'waiting_subscription'); assert.equal(gw.calls.length, 0);
  const snapshot = serviceSnapshot(app, gw.gateway, f.now);
  assert.equal(snapshot.authenticated_subscription_active, true); assert.equal(snapshot.ready_for_owner_message, false);
  assert.equal(snapshot.stage, 'pending_callback_transport'); assert.equal(snapshot.callback_transport.reason, 'proxy_policy_unverified');
  const status = servicePreflight({ ...f.env, ...proxyEnv }); assert.equal(status.ready_to_start, true);
  assert.equal(status.callback_transport.reason, 'proxy_policy_unverified');
  assert.equal(JSON.stringify({ snapshot, status }).includes('synthetic-private'), false);
});


test('live startup prepares the private mode-lock directory before configuration is read',t=>{
 const f=fixture(t),locks=path.join(f.directory,'mode-locks'),env={...f.env,BRIDGE_LOCK_DIRECTORY:locks};
 assert.throws(()=>readConfig(env));assert.equal(fs.existsSync(locks),false);assert.equal(fs.existsSync(f.env.DATABASE_PATH),false);
 privateMkdirSync(locks,{mode:0o700});const config=readConfig(env);assert.equal(config.bridgeLockDirectory,locks);
 const release=acquireModeLock(locks,'qq','fixture-app','tunnel');release();assert.equal(fs.existsSync(f.env.DATABASE_PATH),false);
});
