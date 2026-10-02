import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QqGateway } from '../src/gateway.js';
import { readConfig } from '../src/config.js';
import { makePublicWebSocket } from '../src/gateway-network.js';
import { fixtureGateway } from './gateway-helpers.js';
import { harness, config, qqPayload, subscriptionParams } from './helpers.js';

async function setup(t, options = {}) {
  const f = await harness({ ...options, overrides: { qqTransport: 'gateway', ...options.overrides } });
  const g = fixtureGateway(f); f.app.attachGateway(g.gateway); t.after(f.close);
  await f.subscribe(); await g.gateway.start(); g.hello(); g.ready(); return { f, ...g };
}
const message = (f, seq = 1, overrides = {}) => ({ ...qqPayload(f.now(), overrides), s: seq });

test('Gateway closes the authenticated MCP loop, rejects other senders and disables Webhook input', async t => {
  const { f, gateway, sockets, reports } = await setup(t);
  assert.equal(gateway.status().connected, true);
  await gateway.connect(); assert.equal(sockets.length, 1); // Repeated starts cannot open a second live receiver.
  assert.deepEqual(sockets[0].sent[0], { op: 2, d: { token: 'QQBot fixture-qq-token', intents: 1 << 25, shard: [0, 1] } });
  assert.equal((await f.postQq()).status, 404);
  sockets[0].push(message(f));
  sockets[0].push(message(f, 2, { author: { user_openid: 'untrusted-other-owner' }, id: 'other-message' }));
  sockets[0].push(message(f, 3, { id: 'rich-message', attachments: [{}] }));
  sockets[0].push({ ...message(f, 4), t: 'GROUP_AT_MESSAGE_CREATE' });
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
  assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 4);
  await f.app.bridge.tick(); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.reply()).body.result.structuredContent.status, 'pending');
  const arbitrary = await f.postMcp('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'fixture-message-1', text: '4', recipient: 'other-owner' } });
  assert.equal(arbitrary.status, 400);
  await f.app.bridge.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].url, 'https://api.bot.qq.com/v2/users/fixture_qq_owner/messages');
  assert.deepEqual(f.sends[0].body, { msg_type: 0, content: '4', msg_id: 'fixture-message-1', msg_seq: 1 });
  const output = JSON.stringify(reports);
  for (const value of [f.config.qqSecret, f.config.ownerOpenid, 'fixture-qq-token', 'fixture-session-private', '2 + 2']) assert.equal(output.includes(value), false);
  assert.equal((await fetch(f.origin + '/readyz')).status, 200);
});

test('queue failure rolls back the message and seq together; RESUME retries the uncommitted event', async t => {
  const { f, gateway, sockets, hello } = await setup(t, { overrides: { queueLimit: 1 } });
  sockets[0].push(message(f));
  const second = { ...message(f, 2, { id: 'second-message' }), id: 'second-source-event' };
  sockets[0].push(second);
  assert.equal(sockets[0].terminated, true);
  assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 1);
  assert.equal(f.app.bridge.store.message('second-message'), undefined);
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM rates WHERE kind=?', 'inbound').n, 1);
  await f.app.bridge.tick();
  await gateway.connect(); hello();
  assert.deepEqual(sockets[1].sent[0], { op: 6, d: { token: 'QQBot fixture-qq-token', session_id: 'fixture-session-private', seq: 1 } });
  sockets[1].push(second);
  sockets[1].push({ op: 0, t: 'RESUMED', s: 3, d: '' });
  assert.equal(f.app.bridge.store.message('second-message').id, 'second-message');
  assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 3);
  assert.equal(gateway.status().connected, true);
  await f.app.bridge.tick(); assert.equal(f.deliveries.length, 2);
});

test('Gateway checkpoints and dedupe survive a restart, while session contents stay encrypted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-qq-gateway-test-')), dbPath = path.join(dir, 'bridge.sqlite');
  let first, second;
  t.after(async () => {
    await second?.close(); await first?.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('dot-qq-gateway-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  first = await harness({ dbPath, overrides: { qqTransport: 'gateway' } });
  const a = fixtureGateway(first); first.app.attachGateway(a.gateway);
  await first.subscribe(); await a.gateway.start(); a.hello(); a.ready(); a.sockets[0].push(message(first));
  await first.close(); first = undefined;
  assert.equal(fs.readFileSync(dbPath).includes(Buffer.from('fixture-session-private')), false);
  second = await harness({ dbPath, overrides: { qqTransport: 'gateway' } });
  const b = fixtureGateway(second); second.app.attachGateway(b.gateway);
  await b.gateway.start(); b.hello(); assert.equal(b.sockets[0].sent[0].op, 6); assert.equal(b.sockets[0].sent[0].d.seq, 1);
  b.sockets[0].push(message(second)); // Already committed sequence is ignored.
  b.sockets[0].push(message(second, 2)); // Same message under a new sequence also deduplicates.
  assert.equal(second.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
  assert.equal(second.app.bridge.store.gatewaySession().lastSeq, 2);
  await second.app.bridge.tick(); assert.equal(second.deliveries.length, 1);
});

test('same-database Gateway lease permits one receiver and rejects a stale process checkpoint', async t => {
  const { f, gateway: first, sockets } = await setup(t);
  const second = fixtureGateway(f);
  try {
    await second.gateway.start(); assert.equal(second.gateway.status().phase, 'waiting_lease'); assert.equal(second.sockets.length, 0);
    const token = first.token; await first.stop();
    await second.gateway.connect(); second.hello();
    assert.equal(second.sockets.length, 1); assert.equal(second.sockets[0].sent[0].op, 6);
    assert.throws(() => f.app.bridge.store.recordGatewayCheckpoint({ sessionId: 'stale-session', lastSeq: 900, leaseToken: token }, f.now()), /lease lost/);
    assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 0); assert.equal(sockets[0].terminated, true);
  } finally { await second.gateway.stop(); }
});

test('absent owner/auth rejects Gateway before I/O and absent subscription waits without token requests', async t => {
  assert.throws(() => readConfig({ QQ_TRANSPORT: 'gateway' }), /explicit AppID/);
  assert.throws(() => readConfig({ QQ_TRANSPORT: 'arbitrary' }), /Invalid QQ_TRANSPORT/);
  assert.throws(() => readConfig({ QQ_GATEWAY_ALLOWED_HOSTS: '*.qq.com' }), /exact DNS/);
  assert.throws(() => new QqGateway({ config: config({ qqTransport: 'gateway', ownerOpenid: '' }) }), /explicit owner binding/);
  const f = await harness({ overrides: { qqTransport: 'gateway' } }); const g = fixtureGateway(f); f.app.attachGateway(g.gateway); t.after(f.close);
  await g.gateway.start(); assert.equal(g.gateway.status().phase, 'waiting_subscription'); assert.equal(f.requests.length, 0);
  assert.equal((await fetch(f.origin + '/readyz')).status, 503);
  await f.subscribe(); await g.gateway.connect(); assert.equal(g.sockets.length, 1);
});

test('subscription revocation during discovery prevents the socket and after connection prevents acceptance', async t => {
  let f, revoke = false;
  f = await harness({ overrides: { qqTransport: 'gateway' }, sendOverride: async url => {
    if (revoke && url.endsWith('/gateway/bot')) f.app.bridge.store.unsubscribe(f.app.bridge.store.activeSubscription(f.now()).id);
  } });
  const g = fixtureGateway(f); f.app.attachGateway(g.gateway); t.after(f.close);
  await f.subscribe(); revoke = true; await g.gateway.start();
  assert.equal(g.sockets.length, 0); assert.equal(g.gateway.status().connected, false);
  revoke = false; await f.subscribe(); await g.gateway.connect(); g.hello(); g.ready();
  f.app.bridge.store.unsubscribe(f.app.bridge.store.activeSubscription(f.now()).id);
  g.sockets[0].push(message(f)); assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 0);
  assert.equal(f.app.bridge.store.message('fixture-message-1'), undefined); assert.equal(g.sockets[0].terminated, true);
});

test('heartbeat reports the committed seq, detects missing ACK and retains resumable state', async t => {
  const { f, gateway, sockets, intervals, hello } = await setup(t);
  sockets[0].push(message(f));
  const heartbeat = [...intervals].find(timer => timer.ms === 1000);
  heartbeat.fn(); assert.deepEqual(sockets[0].sent.at(-1), { op: 1, d: 1 });
  sockets[0].push({ op: 11 }); heartbeat.fn(); assert.equal(sockets[0].terminated, false);
  heartbeat.fn(); assert.equal(sockets[0].terminated, true); assert.equal(gateway.status().phase, 'heartbeat_timeout');
  await gateway.connect(); hello(); assert.equal(sockets[1].sent[0].d.seq, 1);
});

test('invalid sessions clear persistence and re-identify; rate close waits and account close stops', async t => {
  const { f, gateway, sockets, hello, ready, timeouts } = await setup(t);
  sockets[0].push({ op: 9, d: false }); assert.equal(f.app.bridge.store.gatewaySession(), null);
  await gateway.connect(); hello(); assert.equal(sockets[1].sent[0].op, 2); ready();
  sockets[1].emit('close', 4008); assert.ok([...timeouts].some(timer => timer.ms === 60000));
  await gateway.connect(); hello(); assert.equal(sockets[2].sent[0].op, 6);
  sockets[2].emit('close', 4914); assert.equal(gateway.status().phase, 'blocked_account_or_protocol');
  assert.equal(gateway.status().connected, false); assert.equal(timeouts.size, 0);
  const requests = f.requests.length; await gateway.connect(); assert.equal(f.requests.length, requests);
});

test('connection quota zero skips IDENTIFY; malformed frames never advance the durable checkpoint', async t => {
  const f = await harness({ overrides: { qqTransport: 'gateway' } }); const g = fixtureGateway(f); f.app.attachGateway(g.gateway); t.after(f.close);
  await f.subscribe(); const original = f.app.bridge.qq.gatewayInfo;
  f.app.bridge.qq.gatewayInfo = async options => ({ ...(await original(options)), remaining: 0, resetAfter: 120000 });
  await g.gateway.start(); assert.equal(g.sockets.length, 0); assert.equal(g.gateway.status().phase, 'quota_exhausted');
  assert.ok([...g.timeouts].some(timer => timer.ms === 120000));
  f.app.bridge.qq.gatewayInfo = original; await g.gateway.connect(); g.hello(); g.ready();
  g.sockets[0].emit('message', Buffer.from([0xff]), false); assert.equal(g.sockets[0].terminated, true);
  assert.equal(f.app.bridge.store.gatewaySession().lastSeq, 0);
});

test('optional missing Gateway event ID derives a transport-bound ID and replay is still deduplicated', async t => {
  const { f, sockets } = await setup(t);
  const incoming = message(f); delete incoming.id; sockets[0].push(incoming); sockets[0].push(incoming);
  assert.ok(f.app.bridge.store.message('fixture-message-1').source_event_id.startsWith('gw_'));
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM jobs').n, 1);
});

test('Gateway WSS connector pins public DNS answers, checks TLS and refuses redirects and compression', async () => {
  let constructed;
  class FakeWebSocket { constructor(url, options) { constructed = { url, options }; } }
  const answers = [{ address: '8.8.8.8', family: 4 }]; let authorized = false;
  const connect = makePublicWebSocket({ lookup: async () => answers, WebSocketClass: FakeWebSocket });
  await connect('wss://api.bot.qq.com/websocket/', { hosts: ['api.bot.qq.com'], beforeConnect: () => { authorized = true; } });
  assert.equal(authorized, true); assert.equal(constructed.options.rejectUnauthorized, true);
  assert.equal(constructed.options.servername, 'api.bot.qq.com'); assert.equal(constructed.options.followRedirects, false);
  assert.equal(constructed.options.perMessageDeflate, false); assert.equal(constructed.options.maxPayload, 32768);
  constructed.options.lookup('api.bot.qq.com', { all: true }, (error, pinned) => { assert.equal(error, null); assert.equal(pinned, answers); });
  constructed.options.lookup('api.bot.qq.com', {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4); });
});

test('Gateway connector refuses non-WSS, unexpected hosts, private DNS and revocation after DNS', async () => {
  let dns = 0, connects = 0;
  const connect = makePublicWebSocket({ lookup: async () => { dns++; return [{ address: '127.0.0.1', family: 4 }]; },
    WebSocketClass: class { constructor() { connects++; } } });
  for (const raw of ['https://api.bot.qq.com/x', 'ws://api.bot.qq.com/x', 'wss://evil.example.com/x', 'wss://127.0.0.1/x',
    'wss://api.bot.qq.com:8443/x', 'wss://user:secret@api.bot.qq.com/x', 'wss://api.bot.qq.com/x#secret']) {
    await assert.rejects(connect(raw, { hosts: ['api.bot.qq.com'] }));
  }
  assert.equal(dns, 0); await assert.rejects(connect('wss://api.bot.qq.com/x', { hosts: ['api.bot.qq.com'] })); assert.equal(connects, 0);
  const vetted = makePublicWebSocket({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], WebSocketClass: class { constructor() { connects++; } } });
  await assert.rejects(vetted('wss://api.bot.qq.com/x', { hosts: ['api.bot.qq.com'], beforeConnect: () => { throw new Error('revoked'); } }));
  assert.equal(connects, 0);
});
