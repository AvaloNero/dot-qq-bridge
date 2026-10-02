import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, subscriptionParams, qqPayload, qqHeaders } from './helpers.js';

function gate() {
  let open;
  return { promise: new Promise(resolve => { open = resolve; }), open: () => open() };
}
async function unsubscribe(f) {
  const params = subscriptionParams(); delete params.delivery.secret; delete params.cursor;
  assert.equal((await f.postMcp('events/unsubscribe', params)).status, 200);
}
async function prepare(f) { await f.subscribe(); await f.postQq(); await f.app.bridge.tick(); await f.reply(); }

test('unsubscribe while refreshing QQ token prevents the passive reply request', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async url => {
    if (url.endsWith('/app/getAppAccessToken')) { entered.open(); await release.promise; }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await prepare(f); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work;
  assert.equal(f.sends.length, 0);
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'cancelled');
});
test('unsubscribe while waiting for callback DNS prevents connection and completion overwrite', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) {
      entered.open(); await release.promise; options.beforeConnect();
    }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await f.subscribe(); await f.postQq(); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work;
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state, 'cancelled');
});
test('QQ success already in flight is recorded after unsubscribe without any subsequent send', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async url => {
    if (url.includes('/v2/users/')) {
      entered.open(); await release.promise;
      return { status: 200, body: Buffer.from('{"id":"ack-already-in-flight"}') };
    }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await prepare(f); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work; await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'sent');
  assert.equal(f.app.bridge.store.message('fixture-message-1').outbound_id, 'ack-already-in-flight');
  assert.equal(f.requests.filter(r => r.url.includes('/v2/users/')).length, 1);
});
test('graceful shutdown waits for the active timer worker even after skipped intervals', async t => {
  const entered = gate(), release = gate(); let closing;
  const f = await harness({ worker: true, overrides: { workerIntervalMs: 5 }, sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) {
      entered.open(); await release.promise;
      return { status: 202, body: Buffer.from('{}') };
    }
  } });
  t.after(async () => { release.open(); await (closing ?? f.close()); });
  await f.subscribe(); await f.postQq(); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  let closed = false; closing = f.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release.open(); await closing; assert.equal(closed, true);
});
test('a valid QQ signature over different raw bytes cannot authorize a tampered message', async t => {
  const f = await harness(); t.after(f.close); await f.subscribe();
  const original = Buffer.from(JSON.stringify(qqPayload(f.now())));
  const changed = Buffer.from(JSON.stringify(qqPayload(f.now(), { content: 'tampered text' })));
  const response = await f.postQq(undefined, { rawBody: changed, headers: qqHeaders(f.config, original, f.now()) });
  assert.equal(response.status, 401);
  assert.equal(f.app.bridge.store.get('SELECT count(*) AS n FROM messages').n, 0);
});
