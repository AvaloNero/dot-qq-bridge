import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqSender } from '../src/qq.js';
import { config, harness, qqPayload, qqHeaders } from './helpers.js';

test('both explicitly selected official endpoint profiles send the same passive msg_id/msg_seq route', async () => {
  for (const profile of ['documented', 'tencent-sdk']) {
    const calls = [], now = Date.now();
    const sender = createQqSender(config({ qqApiProfile: profile }), async (url, options) => {
      calls.push({ url, options });
      return { status: 200, body: Buffer.from(JSON.stringify(url.includes('getAppAccessToken') ? { access_token: 'synthetic', expires_in: '7200' } : { id: 'outbound' })) };
    }, () => now);
    assert.equal(await sender({ owner: 'owner', id: 'verified', expires: now + 10000 }, 'answer'), 'outbound');
    assert.equal(calls[0].url, profile === 'documented' ? 'https://api.bot.qq.com/app/getAppAccessToken' : 'https://bots.qq.com/app/getAppAccessToken');
    assert.equal(calls[1].url, profile === 'documented' ? 'https://api.bot.qq.com/v2/users/owner/messages' : 'https://api.sgroup.qq.com/v2/users/owner/messages');
    assert.deepEqual(JSON.parse(calls[1].options.body), { msg_type: 0, content: 'answer', msg_id: 'verified', msg_seq: 1 });
  }
});
test('QQ access token caching is singleflight and refreshes inside the published 60-second overlap', async () => {
  let now = Date.now(), tokenCalls = 0;
  const sender = createQqSender(config(), async url => ({ status: 200, body: Buffer.from(JSON.stringify(url.includes('getAppAccessToken') ?
    { access_token: `synthetic-${++tokenCalls}`, expires_in: 7200 } : { id: 'outbound' })) }), () => now);
  const message = () => ({ owner: 'owner', id: 'verified', expires: now + 10000 });
  await Promise.all([sender(message(), 'answer'), sender(message(), 'answer')]); assert.equal(tokenCalls, 1);
  now += 7141000; await sender(message(), 'answer'); assert.equal(tokenCalls, 2);
});
test('QQ token API business errors at HTTP 200 are failures and do not send a message', async () => {
  let calls = 0;
  const sender = createQqSender(config(), async () => { calls++; return { status: 200, body: Buffer.from('{"code":100016,"message":"invalid"}') }; });
  await assert.rejects(sender({ owner: 'owner', id: 'verified', expires: Date.now() + 10000 }, 'answer'), error => !error.retryable && !error.uncertain);
  assert.equal(calls, 1);
});
test('QQ token timeout is safe to retry before sending, and token fetch cannot outlive passive deadline', async () => {
  let now = Date.now(), calls = 0;
  const sender = createQqSender(config(), async () => { calls++; now += 15000; return { status: 200, body: Buffer.from('{"access_token":"synthetic","expires_in":7200}') }; }, () => now);
  await assert.rejects(sender({ owner: 'owner', id: 'verified', expires: now + 10000 }, 'answer')); assert.equal(calls, 1);
});
for (const status of [401, 429]) test(`QQ HTTP ${status} safely retries the original passive reply`, async t => {
  let calls = 0;
  const f = await harness({ sendOverride: async url => {
    if (url.includes('/v2/users/') && ++calls === 1) return { status, body: Buffer.from('{}') };
  } }); t.after(f.close);
  await f.subscribe(); await f.postQq(); await f.app.bridge.tick(); await f.reply(); await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'pending');
  f.advance(1100); await f.app.bridge.tick(); assert.equal(f.sends.length, 1);
  assert.ok(f.requests.filter(entry => entry.url.includes('/v2/users/')).every(entry => JSON.parse(entry.options.body).msg_seq === 1));
});
test('QQ HTTP 500, successful response without id, and business errors have distinct terminal states', async t => {
  for (const [status, body, state] of [[500, '{}', 'uncertain'], [200, '{}', 'uncertain'], [200, '{"err_code":40034005}', 'dead'], [400, '{"code":40054005}', 'dead']]) {
    const f = await harness({ sendOverride: async url => url.includes('/v2/users/') ? { status, body: Buffer.from(body) } : undefined });
    try {
      await f.subscribe(); await f.postQq(); await f.app.bridge.tick(); await f.reply(); await f.app.bridge.tick();
      assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, state);
    } finally { await f.close(); }
  }
});
test('QQ signed requests may omit AppID header: the configured secret authenticates the single account', async t => {
  const f = await harness(); t.after(f.close); await f.subscribe();
  const body = Buffer.from(JSON.stringify(qqPayload(f.now()))), headers = qqHeaders(f.config, body, f.now()); delete headers['X-Bot-Appid'];
  const result = await fetch(`${f.origin}/qq/webhook`, { method: 'POST', headers, body });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { op: 12, d: 0 });
});
