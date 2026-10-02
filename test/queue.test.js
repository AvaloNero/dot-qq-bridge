import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, qqPayload, config, subscriptionParams, FIXTURE_SECRET } from './helpers.js';
import { Store } from '../src/store.js';
import { BridgeError } from '../src/common.js';

function temp(t, beforeCleanup = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-qq-bridge-test-'));
  t.after(async () => {
    await beforeCleanup();
    const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('dot-qq-bridge-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return path.join(dir, 'bridge.sqlite');
}
function nextMessage(f, n) {
  const payload = qqPayload(f.now(), { id: `fixture-message-${n}` }); payload.id = `fixture-event-${n}`; return payload;
}
async function delivered(f) { await f.subscribe(); await f.postQq(); await f.app.bridge.tick(); }

test('simulated HTTP protocol closes the full loop with one durable reply to the verified route', async t => {
  const f = await harness(); t.after(f.close);
  await delivered(f);
  const event = f.deliveries[0]; assert.equal(event.name, 'qq.message.created'); assert.equal(event.data.message_id, 'fixture-message-1');
  assert.equal((await f.reply()).body.result.structuredContent.status, 'pending');
  assert.equal((await f.reply()).body.result.structuredContent.status, 'pending');
  await f.app.bridge.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].url, 'https://api.bot.qq.com/v2/users/fixture_qq_owner/messages');
  assert.deepEqual(f.sends[0].body, { msg_type: 0, content: '4', msg_id: 'fixture-message-1', msg_seq: 1 });
  assert.equal(f.sends[0].headers.Authorization, 'QQBot fixture-qq-token');
  assert.equal((await f.reply()).body.result.structuredContent.status, 'sent');
});
test('reply cannot choose a recipient, forge a message, send before event delivery or overwrite an answer', async t => {
  const f = await harness(); t.after(f.close); await f.subscribe(); await f.postQq();
  assert.equal((await f.reply()).body.error.code, -32012);
  await f.app.bridge.tick();
  const arbitrary = await f.postMcp('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'fixture-message-1', text: 'x', recipient: 'stranger' } });
  assert.equal(arbitrary.status, 400);
  assert.equal((await f.reply('forged-message')).body.error.code, -32012);
  assert.equal((await f.reply('fixture-message-1', ' ')).status, 400);
  assert.equal((await f.reply('fixture-message-1', 'x'.repeat(2001))).status, 400);
  assert.equal((await f.reply()).status, 200);
  assert.equal((await f.reply('fixture-message-1', 'different')).status, 400);
  assert.equal(f.sends.length, 0);
});
test('concurrent duplicate signed callbacks and concurrent reply calls create exactly one event and one reply', async t => {
  const f = await harness(); t.after(f.close); await f.subscribe();
  const received = await Promise.all(Array.from({ length: 8 }, () => f.postQq()));
  assert.ok(received.every(result => result.status === 200));
  await f.app.bridge.tick(); assert.equal(f.deliveries.length, 1);
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.reply()));
  assert.ok(replies.every(result => result.status === 200));
  await Promise.all([f.app.bridge.tick(), f.app.bridge.tick()]); assert.equal(f.sends.length, 1);
});
test('subscription, accepted events, de-duplication and queued replies survive database/process restart', async t => {
  let f;
  const dbPath = temp(t, async () => { if (f) await f.close(); });
  f = await harness({ dbPath });
  await f.subscribe(); await f.postQq(); await f.close();
  // A separate process confirms durable, committed state rather than shared JS memory.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare(\"SELECT count(*) AS n FROM jobs WHERE state='pending'\").get(); console.log(row.n); db.close();", dbPath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), '1');
  f = await harness({ dbPath });
  assert.equal((await f.postQq()).status, 200); await f.app.bridge.tick(); assert.equal(f.deliveries.length, 1);
  await f.reply(); await f.close();
  f = await harness({ dbPath });
  await f.app.bridge.tick(); assert.equal(f.sends.length, 1);
  assert.equal((await f.reply()).body.result.structuredContent.status, 'sent');
  const contents = fs.readFileSync(dbPath);
  assert.equal(contents.includes(Buffer.from(FIXTURE_SECRET)), false);
  assert.equal(contents.includes(Buffer.from('2 + 2 是多少？')), false);
});
test('existing database rejects different owner, AppID, principal or storage key', t => {
  const dbPath = temp(t), initial = config({ dbPath }), store = new Store(initial); store.close();
  for (const changed of [{ ownerOpenid: 'someone_else' }, { principal: 'another-principal' }, { qqAppId: 'different-app' }, { storageKey: Buffer.alloc(32, 9).toString('base64') }]) {
    assert.throws(() => new Store({ ...initial, ...changed }));
  }
});
test('transient MCP callback failures retry identical event bytes and ID with fresh signing timestamps', async t => {
  let events = 0;
  const f = await harness({ sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId && ++events === 1) return { status: 503, body: Buffer.from('{}') };
  } }); t.after(f.close);
  await delivered(f); assert.equal(f.deliveries.length, 0);
  const first = f.requests.at(-1); f.advance(1100); await f.app.bridge.tick();
  const second = f.requests.at(-1); assert.equal(f.deliveries.length, 1);
  assert.deepEqual(first.options.body, second.options.body);
  assert.equal(first.options.headers['webhook-id'], second.options.headers['webhook-id']);
  assert.notEqual(first.options.headers['webhook-timestamp'], second.options.headers['webhook-timestamp']);
});
test('callback timeout is retried, but retries have a strict attempt bound', async t => {
  const f = await harness({ overrides: { maxAttempts: 2 }, sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) throw new BridgeError('Destination timeout', { retryable: true, data: { reason: 'timeout' } });
  } }); t.after(f.close);
  await delivered(f); f.advance(1100); await f.app.bridge.tick();
  const job = f.app.bridge.store.get("SELECT state,attempts FROM jobs WHERE kind='event'");
  assert.equal(job.state, 'dead'); assert.equal(job.attempts, 2);
  f.advance(10000); await f.app.bridge.tick(); assert.equal(f.requests.length, 3);
});
for (const status of [410, 413, 302]) test(`MCP callback ${status} is terminal; redirects are not followed`, async t => {
  const f = await harness({ sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) return { status, body: Buffer.from('{}') };
  } }); t.after(f.close);
  await delivered(f); assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state, 'dead');
  if (status === 410) assert.equal(f.app.bridge.store.activeSubscription(f.now()), undefined);
  f.advance(10000); await f.app.bridge.tick(); assert.equal(f.requests.length, 2);
});
test('expired subscription and revoked owner cancel queued work and block reply tools', async t => {
  const f = await harness(); t.after(f.close);
  await f.subscribe(subscriptionParams({ ttlMs: 1000 })); await f.postQq(); f.advance(1001); await f.app.bridge.tick();
  assert.equal(f.deliveries.length, 0); assert.equal((await f.reply()).body.error.code, -32012);
  const g = await harness(); t.after(g.close); await delivered(g); await g.reply(); g.config.ownerOpenid = '';
  await g.app.bridge.tick(); assert.equal(g.sends.length, 0);
  assert.equal(g.app.bridge.store.replyStatus('fixture-message-1').status, 'cancelled');
});
test('passive reply deadline is enforced both when queueing and immediately before sending', async t => {
  const f = await harness(); t.after(f.close); await delivered(f); f.advance(240001);
  assert.equal((await f.reply()).status, 400); assert.equal(f.sends.length, 0);
  const g = await harness(); t.after(g.close); await delivered(g); await g.reply(); g.advance(240001); await g.app.bridge.tick();
  assert.equal(g.sends.length, 0); assert.equal(g.app.bridge.store.replyStatus('fixture-message-1').status, 'expired');
});
test('unsubscribing cancels pending events and replies; a different dot can subscribe afterward', async t => {
  const f = await harness(); t.after(f.close); await delivered(f); await f.reply();
  const params = subscriptionParams(); delete params.delivery.secret; delete params.cursor;
  await f.postMcp('events/unsubscribe', params); await f.app.bridge.tick(); assert.equal(f.sends.length, 0);
  assert.equal((await f.reply()).body.error.code, -32012);
  assert.equal((await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, url: 'https://receiver.example.com/another-dot' } }))).status, 200);
  assert.equal((await f.reply()).body.error.code, -32012);
});
test('persistent inbound rate limit and queue capacity roll back rejected messages', async t => {
  const f = await harness({ overrides: { inboundPerMinute: 1 } }); t.after(f.close); await f.subscribe(); await f.postQq();
  assert.equal((await f.postQq(nextMessage(f, 2))).status, 429);
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
  f.advance(60001); assert.equal((await f.postQq(nextMessage(f, 2))).status, 200);
  const g = await harness({ overrides: { queueLimit: 1 } }); t.after(g.close); await g.subscribe(); await g.postQq();
  assert.equal((await g.postQq(nextMessage(g, 2))).status, 503);
  await g.app.bridge.tick(); assert.equal((await g.postQq(nextMessage(g, 2))).status, 200);
});
test('QQ send rate limit waits without consuming remote delivery attempts', async t => {
  const f = await harness({ overrides: { repliesPerMinute: 1 } }); t.after(f.close); await delivered(f); await f.reply(); await f.app.bridge.tick();
  await f.postQq(nextMessage(f, 2)); await f.app.bridge.tick(); await f.reply('fixture-message-2'); await f.app.bridge.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.app.bridge.store.get("SELECT attempts FROM jobs WHERE id='reply:fixture-message-2'").attempts, 0);
  f.advance(60001); await f.app.bridge.tick(); assert.equal(f.sends.length, 2);
});
test('uncertain QQ acknowledgement is never automatically retried or given a new msg_seq', async t => {
  let sendAttempts = 0;
  const f = await harness({ sendOverride: async url => {
    if (url.includes('/v2/users/')) { sendAttempts++; throw new Error('lost acknowledgement'); }
  } }); t.after(f.close); await delivered(f); await f.reply(); await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'uncertain');
  f.advance(10000); await f.app.bridge.tick(); await f.reply(); assert.equal(sendAttempts, 1);
});
test('crashed QQ send becomes uncertain; crashed event resumes with its durable event ID', async t => {
  const f = await harness(); t.after(f.close); await delivered(f); await f.reply();
  f.app.bridge.store.run("UPDATE jobs SET state='processing',lease_until=?,lease_token='crashed' WHERE kind='reply'", f.now() - 1);
  await f.app.bridge.tick(); assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'uncertain'); assert.equal(f.sends.length, 0);
  const g = await harness(); t.after(g.close); await g.subscribe(); await g.postQq();
  g.app.bridge.store.run("UPDATE jobs SET state='processing',lease_until=?,lease_token='crashed' WHERE kind='event'", g.now() - 1);
  await g.app.bridge.tick(); assert.equal(g.deliveries.length, 1);
});
test('independent SQLite handles enforce one lease and reject stale completion', t => {
  const initial = config({ dbPath: temp(t) }), store = new Store(initial), other = new Store(initial);
  try {
    const now = Date.parse('2026-10-02T12:00:00Z');
    store.saveSubscription({ id: 'sub-one', principal: initial.principal, url: 'https://receiver.example.com/x', secret: FIXTURE_SECRET, expires: now + 60000, verified_until: now + 60000 }, now);
    store.ingest({ id: 'm', sourceEventId: 'e', owner: initial.ownerOpenid, text: 'hello', timestamp: new Date(now).toISOString(), expires: now + 60000 }, 'r', now);
    const job = store.claim(now); assert.ok(job); assert.equal(other.claim(now), undefined);
    other.finish({ ...job, lease_token: 'wrong' }, 'dead');
    assert.equal(store.get('SELECT state FROM jobs').state, 'processing');
    other.finish(job, 'delivered'); assert.equal(store.get('SELECT state FROM jobs').state, 'delivered');
  } finally { other.close(); store.close(); }
});
test('text retention removes plaintext records while permanent tombstones preserve de-duplication', async t => {
  const f = await harness(); t.after(f.close); await delivered(f); await f.reply(); await f.app.bridge.tick();
  f.advance(8 * 86400000); f.app.bridge.store.prune(f.now());
  assert.equal(f.app.bridge.store.message('fixture-message-1').text, null); assert.equal(f.app.bridge.store.replyText('fixture-message-1'), null);
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
});
