import { createServiceSender, makePublicRequester } from '../src/network.js';
import { callbackTransportStatus } from '../src/callback-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { servicePreflight, startPersistentService } from '../src/service-runtime.js';
const env = { BRIDGE_MODE: 'tunnel', BRIDGE_LOCK_DIRECTORY: '/tmp/fixture-lock-not-created', QQ_APP_ID: 'fixture', QQ_BOT_SECRET: 'fake-secret', QQ_OWNER_OPENID: 'fixture-owner', MCP_OWNER_SUBJECT: 'fixture-sub',
  STORAGE_KEY: Buffer.alloc(32, 1).toString('base64'), PUBLIC_ORIGIN: 'https://fixture.example', OAUTH_ISSUER: 'https://issuer.example',
  OAUTH_JWKS_URL: 'https://issuer.example/jwks', OAUTH_AUDIENCE: 'https://fixture.example/mcp', DATABASE_PATH: '/tmp/fixture-not-created.sqlite',
  AUTH_MODE: 'oauth', QQ_TRANSPORT: 'gateway' };
test('formal service preflight is secret-free and rejects missing auth, memory storage or invalid key', () => {
  assert.equal(servicePreflight(env).ready_to_start, true);
  for (const change of [{ AUTH_MODE: 'dev' }, { DATABASE_PATH: ':memory:' }, { STORAGE_KEY: 'fake-secret' }, { QQ_OWNER_OPENID: '' }]) {
    const result = servicePreflight({ ...env, ...change }); assert.equal(result.ready_to_start, false); assert.ok(!JSON.stringify(result).includes('fake-secret'));
  }
});
test('persistent runtime stays alive awaiting current-dot subscription, logs changes/heartbeat and shuts down once', async () => {
  let active = false, connected = false, tick, stopped = 0, now = 0; const output = [];
  const app = { bridge: { ready: () => true, store: { activeSubscription: () => active } }, attachGateway() {}, async listen() {}, async close() { stopped++; } };
  const gateway = { status: () => ({ connected, rawSecret: 'never' }), async start() {} };
  const runtime = await startPersistentService({}, { appFactory: () => app, gatewayFactory: () => gateway,
    report: v => output.push(v), clock: () => now, repeat: f => { tick = f; return 1; }, cancel() {} });
  assert.equal(runtime.snapshot().stage, 'waiting_dot_subscription'); assert.equal(stopped, 0);
  const before = output.length; tick(); assert.equal(output.length, before);
  active = true; tick(); assert.equal(output.at(-1).stage, 'waiting_gateway');
  connected = true; tick(); assert.equal(output.at(-1).stage, 'gateway_connected');
  assert.equal(output.at(-1).current_dot_roundtrip_verified, false);
  active = false; tick(); assert.equal(output.at(-1).ready_for_owner_message, false);
  now = 60001; tick(); assert.equal(output.at(-1).stage, 'waiting_dot_subscription');
  await runtime.close(); await runtime.close(); assert.equal(stopped, 1); assert.ok(!JSON.stringify(output).includes('never'));
});
test('startup errors never expose raw configuration or exception values', async () => {
  const output = []; const app = { bridge: {}, attachGateway() {}, async listen() { throw new Error('never-secret'); }, async close() {} };
  await assert.rejects(startPersistentService({}, { appFactory: () => app, gatewayFactory: () => ({}), report: v => output.push(v) }), /startup failed/);
  assert.ok(!JSON.stringify(output).includes('never-secret'));
});

test('termination during asynchronous startup cleans up and never starts status interval', async () => {
  const ac = new AbortController(); let release, closed = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const app = { bridge: {}, attachGateway() {}, async listen() {}, async close() { closed++; release(); } };
  const service = startPersistentService({}, { appFactory: () => app, gatewayFactory: () => ({ async start() { await pending; } }),
    signal: ac.signal, repeat() { assert.fail('interval after stop'); } });
  await Promise.resolve(); ac.abort(); await assert.rejects(service, /startup failed/); assert.equal(closed, 1);
});

test('constructor failure is sanitized even for library callers', async () => {
  await assert.rejects(startPersistentService({}, { appFactory() { throw new Error('never-secret'); } }), error => error.message === 'Persistent service startup failed');
});

test('formal sender factory is constructed once and shared by service preflight and runtime', async () => {
  let factoryCalls = 0, captured;
  const managedAdapter = { send: () => assert.fail('No network is permitted') };
  const settings = { ...env, HTTPS_PROXY: 'http://synthetic-proxy.invalid:3128' };
  const send = createServiceSender({ proxyEnv: settings, requesterFactory(options) {
    factoryCalls++; return makePublicRequester({ ...options, managedAdapter,
      lookup: () => assert.fail('No DNS is permitted'), request: () => assert.fail('No network is permitted') });
  } });
  const before = servicePreflight(settings, { send });
  assert.deepEqual(before.callback_transport, { ready: false, mode: 'blocked', reason: 'proxy_policy_unverified',
    proxy_configured: true, destination_binding: 'unverified', network_checked: false });
  const service = await startPersistentService({}, { send, appFactory(_config, options) {
    captured = options.send;
    return { bridge: { ready: () => false, callbackTransport: () => callbackTransportStatus(options.send),
      store: { activeSubscription: () => null } }, attachGateway() {}, async listen() {}, async close() {} };
  }, gatewayFactory: () => ({ status: () => ({ connected: false }), async start() {} }), repeat: () => 1, cancel() {} });
  try {
    assert.equal(factoryCalls, 1); assert.equal(captured, send);
    assert.deepEqual(service.snapshot().callback_transport, before.callback_transport);
    managedAdapter.send = () => assert.fail('Mutated adapter must not run');
    assert.equal(servicePreflight(settings, { send }).callback_transport.reason, 'adapter_invalid');
    assert.deepEqual(service.snapshot().callback_transport, servicePreflight(settings, { send }).callback_transport);
    assert.equal(service.snapshot().callback_transport.network_checked, false);
  } finally { await service.close(); }
});
