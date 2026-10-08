import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { makePublicRequester } from '../src/network.js';
import { config, mcpHeaders, mcpRequest, qqPayload, subscriptionParams } from './helpers.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';
import { verifyWebhook } from '../src/signatures.js';

async function appFixture(t, send) {
  let now = Date.parse('2026-10-03T12:00:00Z');
  const app = createApp(config(), { send, clock: () => now, worker: false });
  const address = await app.listen(0); t.after(() => app.close());
  const post = async (method, params = {}) => {
    const request = mcpRequest(method, params);
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: mcpHeaders(request), body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  };
  return { app, post, now, advance: ms => { now += ms; } };
}

test('real app subscription challenge and event queue select the injected shared callback interface', async t => {
  const calls = [], controller = new AbortController();
  const transport = async (raw, options) => {
    await options.beforeConnect(); calls.push({ raw, options });
    const body = JSON.parse(options.body);
    return { status: body.type === 'verification' ? 200 : 202, headers: {}, body: Buffer.from(body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '{}') };
  };
  transport.preflight = () => preflightCallbackTransport({ proxyEnv: {} });
  const send = makePublicRequester({ proxyEnv: { HTTPS_PROXY: 'http://synthetic-proxy.invalid:3128' }, callbackTransport: transport,
    lookup: () => assert.fail('legacy DNS path must not run'), request: () => assert.fail('legacy request must not run'),
    providerSend: () => assert.fail('provider path must not run') });
  const f = await appFixture(t, send);
  const subscribed = await f.post('events/subscribe', subscriptionParams()); assert.equal(subscribed.status, 200);
  f.app.bridge.acceptQq(qqPayload(f.now), 'synthetic-replay'); await f.app.bridge.tick();
  assert.equal(calls.length, 2); assert.equal(JSON.parse(calls[0].options.body).type, 'verification');
  assert.equal(JSON.parse(calls[1].options.body).name, 'qq.message.created');
  for (const call of calls) {
    assert.equal(call.raw, subscriptionParams().delivery.url); assert.deepEqual(call.options.hosts, ['receiver.example.com']);
    assert.equal(typeof call.options.beforeConnect, 'function'); assert.equal(typeof call.options.headers['webhook-signature'], 'string');
  }
  await send(subscriptionParams().delivery.url, { purpose: 'callback', hosts: ['receiver.example.com'], body: Buffer.from('{}'), signal: controller.signal });
  assert.equal(calls.at(-1).options.signal, controller.signal);
  const setup = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: {} })).body.result.structuredContent;
  assert.equal(setup.callback_transport.network_checked, false); assert.equal(setup.callback_transport.ready, true);
});

test('default managed callback without supported adapter fails before DNS/request and surfaces fixed setup/error state', async t => {
  let dns = 0, requests = 0, provider = 0;
  const send = makePublicRequester({ proxyEnv: { HTTPS_PROXY: 'http://synthetic-user:synthetic-private@proxy.invalid:3128' },
    lookup: () => { dns++; assert.fail('DNS forbidden'); }, request: () => { requests++; assert.fail('request forbidden'); }, providerSend: () => { provider++; assert.fail('provider forbidden'); } });
  const f = await appFixture(t, send);
  const setup = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: { callback_url: 'https://receiver.example.com/private-path?private-query=1' } })).body.result.structuredContent;
  assert.deepEqual(setup.callback_transport, { ready: false, mode: 'blocked', reason: 'proxy_policy_unverified', proxy_configured: true, destination_binding: 'unverified', network_checked: false });
  assert.equal(setup.configuration_ready, false); assert.equal(setup.events_discoverable, true);
  const denied = await f.post('events/subscribe', subscriptionParams()); assert.equal(denied.body.error.code, -32015);
  assert.equal(denied.body.error.data.reason, 'proxy_policy_unverified');
  await assert.rejects(send(subscriptionParams().delivery.url, { purpose: 'callback', hosts: ['receiver.example.com'], body: Buffer.from('{}') }), error => error.code === -32015 && error.data.reason === 'proxy_policy_unverified');
  assert.deepEqual([dns, requests, provider], [0, 0, 0]); assert.equal(f.app.bridge.ready(), false);
  for (const value of ['synthetic-user', 'synthetic-private', 'proxy.invalid', 'private-path', 'private-query', subscriptionParams().delivery.secret]) {
    assert.equal(JSON.stringify({ setup, denied }).includes(value), false);
  }
});

test('callback exceptions never expose arbitrary reason, cause, URL, header or message fields', async t => {
  const privateText = 'synthetic-never-log-callback-data';
  const transport = async () => { throw Object.assign(new Error(privateText), { code: privateText, data: { reason: privateText }, cause: { token: privateText } }); };
  transport.preflight = () => preflightCallbackTransport({ proxyEnv: {} });
  const send = makePublicRequester({ proxyEnv: {}, callbackTransport: transport }); const f = await appFixture(t, send);
  const denied = await f.post('events/subscribe', subscriptionParams());
  assert.equal(denied.body.error.code, -32015); assert.equal(denied.body.error.data.reason, 'connection_failed');
  assert.equal(JSON.stringify(denied).includes(privateText), false);
  assert.equal(Object.hasOwn(denied.body.error.data.callback_transport, 'token'), false);
  transport.preflight = () => ({ ...preflightCallbackTransport({ proxyEnv: {} }), token: privateText });
  const malformed = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: {} })).body.result.structuredContent;
  assert.equal(malformed.callback_transport.reason, 'transport_unverified'); assert.equal(JSON.stringify(malformed).includes(privateText), false);
});

test('bare custom send reports unverified transport and cannot imply callback readiness', async t => {
  const f = await appFixture(t, () => assert.fail('unverified send must not run'));
  const setup = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: {} })).body.result.structuredContent;
  assert.deepEqual(setup.callback_transport, { ready: false, mode: 'blocked', reason: 'transport_unverified', proxy_configured: null, destination_binding: 'unverified', network_checked: false });
  assert.equal((await f.post('events/subscribe', subscriptionParams())).body.error.code, -32015);
});

test('managed adapter injections cannot unblock app subscription or send before DNS and network', async t => {
  for (const name of ['managedAdapter', 'managedCallbackAdapter']) {
    const calls = { dns: 0, requests: 0, provider: 0, adapter: 0, gates: 0 };
    const forbidden = key => () => { calls[key]++; assert.fail(`${key} must not run`); };
    const send = makePublicRequester({ proxyEnv: { HTTPS_PROXY: 'http://synthetic-proxy.invalid:3128' },
      lookup: forbidden('dns'), request: forbidden('requests'), providerSend: forbidden('provider'),
      [name]: { send: forbidden('adapter') } });
    const f = await appFixture(t, send);
    const setup = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: {} })).body.result.structuredContent;
    assert.deepEqual(setup.callback_transport, { ready: false, mode: 'blocked', reason: 'proxy_policy_unverified',
      proxy_configured: true, destination_binding: 'unverified', network_checked: false });
    assert.equal(setup.configuration_ready, false); assert.equal(f.app.bridge.ready(), false);
    const denied = await f.post('events/subscribe', subscriptionParams());
    assert.equal(denied.body.error.code, -32015); assert.equal(denied.body.error.data.reason, 'proxy_policy_unverified');
    assert.equal(f.app.bridge.store.activeSubscription(f.now), undefined);
    await assert.rejects(send(subscriptionParams().delivery.url, { purpose: 'callback', hosts: ['receiver.example.com'],
      body: Buffer.from('{}'), beforeConnect: forbidden('gates') }),
      error => error.code === -32015 && error.data.reason === 'proxy_policy_unverified');
    assert.deepEqual(calls, { dns: 0, requests: 0, provider: 0, adapter: 0, gates: 0 });
  }
});

test('real app uses shared direct-pinned transport for signed challenge and queued event, preserving retry and 410 semantics', async t => {
  const calls = []; let dns = 0, eventStatus = 429;
  let f;
  const send = makePublicRequester({ proxyEnv: {},
    lookup: async host => { dns++; assert.equal(host, 'receiver.example.com'); return [{ address: '8.8.8.8', family: 4 }]; },
    providerSend: () => assert.fail('provider forbidden'),
    request: (target, options, receive) => {
      assert.equal(target.hostname, 'receiver.example.com'); assert.equal(options.agent, false);
      assert.equal(options.servername, target.hostname); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.autoSelectFamily, false); assert.equal(options.family, 4);
      assert.equal(options.headers.host, target.hostname); assert.equal(options.headers['proxy-authorization'], undefined);
      options.lookup(target.hostname, { all: true }, (error, answers) => {
        assert.equal(error, null); assert.deepEqual(answers, [{ address: '8.8.8.8', family: 4 }]);
      });
      const req = new EventEmitter();
      req.destroy = () => { if (!req.closed) { req.closed = true; queueMicrotask(() => req.emit('close')); } };
      req.end = payload => queueMicrotask(() => {
        assert.equal(verifyWebhook(subscriptionParams().delivery.secret, options.headers, payload, f.now), true);
        const body = JSON.parse(payload); calls.push(body);
        const res = new EventEmitter(); res.statusCode = body.type === 'verification' ? 200 : eventStatus;
        res.headers = { 'content-type': 'application/json' }; res.rawHeaders = Object.entries(res.headers).flat(); res.complete = false;
        res.destroy = () => { if (!res.closed) { res.closed = true; queueMicrotask(() => res.emit('close')); } };
        receive(res); if (res.closed) return;
        res.emit('data', Buffer.from(body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '{}'));
        res.complete = true; res.emit('end'); res.destroy(); req.destroy();
      });
      return req;
    } });
  f = await appFixture(t, send);
  assert.equal((await f.post('events/subscribe', subscriptionParams())).status, 200);
  const longText = '\u4e2d'.repeat(2000); f.app.bridge.acceptQq(qqPayload(f.now, { content: longText }), 'synthetic-direct');
  await f.app.bridge.tick(); assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state, 'pending');
  f.advance(1001); eventStatus = 202; await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state, 'delivered');
  assert.equal(calls.length, 3); assert.deepEqual(calls[1], calls[2]); assert.equal(calls[1].data.text, longText); assert.equal(dns, 3);
  const setup = (await f.post('tools/call', { name: 'check_bridge_setup', arguments: {} })).body.result.structuredContent;
  assert.deepEqual(setup.callback_transport, { ready: true, mode: 'direct', reason: 'none', proxy_configured: false, destination_binding: 'direct_pinned', network_checked: false });
  const next = qqPayload(f.now + 1001, { id: 'second-message', content: 'second synthetic message' }); next.id = 'second-source-event';
  f.app.bridge.acceptQq(next, 'synthetic-direct-next'); eventStatus = 410; await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.activeSubscription(f.now + 1001), undefined);
  assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE message_id='second-message'").state, 'dead');
});
test('subscription commit rechecks callback transport and allowlist after asynchronous verification', async t => {
  for (const change of ['transport', 'policy']) {
    let blocked = false, f;
    const transport = async (_raw, options) => {
      await options.beforeConnect(); const body = JSON.parse(options.body);
      if (change === 'transport') blocked = true; else f.app.bridge.config.callbackHosts = ['other.example.com'];
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
    };
    transport.preflight = () => preflightCallbackTransport({ proxyEnv: blocked ? { HTTPS_PROXY: 'http://proxy.invalid:3128' } : {} });
    f = await appFixture(t, makePublicRequester({ proxyEnv: {}, callbackTransport: transport }));
    const result = await f.post('events/subscribe', subscriptionParams());
    assert.equal(result.body.error.code, -32015);
    assert.equal(result.body.error.data.reason, change === 'transport' ? 'proxy_policy_unverified' : 'host_not_allowed');
    assert.equal(f.app.bridge.store.activeSubscription(f.now), undefined);
  }
});
