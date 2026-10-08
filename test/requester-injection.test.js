import { createApp } from '../src/server.js';
import { config, subscriptionParams, qqPayload } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceSender, makePublicRequester } from '../src/network.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';

const proxyEnv = { HTTPS_PROXY: 'http://synthetic-proxy.invalid:3128' };
const never = () => assert.fail('No network is permitted in this test');
const adapter = () => ({ send: never });
const status = send => send.callbackTransportStatus();

test('canonical callback injection and legacy aliases share a strict code-only contract', () => {
  for (const name of ['managedAdapter', 'managedCallbackAdapter']) {
    const send = makePublicRequester({ proxyEnv, [name]: adapter(), lookup: never, request: never });
    assert.deepEqual(status(send), { ready: false, mode: 'blocked', reason: 'proxy_policy_unverified', proxy_configured: true,
      destination_binding: 'unverified', network_checked: false });
    assert.deepEqual(send.callbackPreflight(), status(send));
  }
  const transport = async () => assert.fail('No callback is attempted');
  for (const name of ['callbackTransport', 'callbackSend']) {
    const send = makePublicRequester({ proxyEnv, [name]: transport });
    assert.equal(status(send)?.ready ?? false, false);
  }
  const one = adapter();
  assert.equal(status(makePublicRequester({ proxyEnv, managedAdapter: one, managedCallbackAdapter: one })).reason, 'proxy_policy_unverified');
  transport.preflight = () => ({ ready: true, mode: 'managed', reason: 'none', proxy_configured: true,
    destination_binding: 'delegated_unverified', network_checked: false });
  assert.equal(status(makePublicRequester({ proxyEnv, callbackTransport: transport })).reason, 'transport_unverified');
  for (const options of [null, [], { managedAdpater: one }, { callbackSender: transport },
    { managedAdapter: { verified: true } }, { managedAdapter: { send: never, verified: true } },
    { managedAdapter: one, managedCallbackAdapter: adapter() }, { callbackTransport: transport, callbackSend: never },
    { managedAdapter: one, callbackTransport: transport }, { callbackTransport: {} },
    Object.create({ managedAdapter: one }), Object.defineProperty({}, 'proxyEnv', { value: proxyEnv }),
    { managedAdapter: Object.defineProperty({}, 'send', { value: never }) }, { get managedAdapter() { assert.fail('Do not evaluate getters'); } }]) {
    assert.throws(() => makePublicRequester(options), TypeError);
  }
});

test('formal sender factory is offline, default blocked, and does not interpret environment modules or flags', () => {
  const env = { ...proxyEnv, MANAGED_CALLBACK_ADAPTER: '/synthetic/must-not-import.js', CALLBACK_VERIFIED: 'true' };
  const send = createServiceSender({ proxyEnv: env });
  assert.equal(status(send).ready, false); assert.equal(status(send).reason, 'proxy_policy_unverified');
  assert.equal(status(send).network_checked, false);
  let calls = 0;
  const injected = createServiceSender({ proxyEnv: env, requesterFactory(options) {
    calls++; assert.equal(options.proxyEnv, env);
    return makePublicRequester({ ...options, managedAdapter: adapter(), lookup: never, request: never });
  } });
  assert.equal(calls, 1); assert.equal(status(injected).ready, false);
  assert.equal(status(injected).mode, 'blocked'); assert.equal(status(injected).reason, 'proxy_policy_unverified');
  for (const options of [{ managedAdapter: adapter() }, { requesterFactory: 'module.js' },
    { requesterFactory: () => ({ send: never }) }, { proxyEnv: env, send: never }]) {
    assert.throws(() => createServiceSender(options), TypeError);
  }
});

test('service-created sender carries synthetic challenge and queued event through the same explicit callback fixture without a listener', async () => {
  const kinds = []; let factories = 0, lookups = 0;
  const now = Date.now(), settings = config();
  const send = createServiceSender({ proxyEnv, requesterFactory(options) {
    factories++;
    const callbackTransport = async (target, request) => {
      assert.equal(target, subscriptionParams().delivery.url); assert.deepEqual(request.hosts, ['receiver.example.com']);
      await request.beforeConnect(); const body = JSON.parse(request.body.toString());
      kinds.push(body.type === 'verification' ? 'challenge' : 'event');
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body.type === 'verification' ? { challenge: body.challenge } : {})) };
    };
    callbackTransport.preflight = () => preflightCallbackTransport({ proxyEnv: {} });
    return makePublicRequester({ ...options, lookup: () => { lookups++; assert.fail('Fixture must not resolve DNS'); },
      request: never, providerSend: never, callbackTransport });
  } });
  const app = createApp(settings, { send, worker: false, clock: () => now });
  try {
    assert.equal(app.bridge.send, send);
    await app.bridge.rpc('events/subscribe', subscriptionParams(), { id: settings.principal, validUntil: now + 60000 });
    app.bridge.acceptQq(qqPayload(now), 'synthetic-code-injection');
    await app.bridge.tick();
    assert.deepEqual(kinds, ['challenge', 'event']); assert.equal(factories, 1); assert.equal(lookups, 0);
    assert.equal(status(send).network_checked, false);
  } finally { await app.close(); }
});
