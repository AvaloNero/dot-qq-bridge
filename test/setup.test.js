import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness, config, subscriptionParams } from './helpers.js';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';

async function preflight(f, argumentsValue = {}, options) {
  return f.postMcp('tools/call', { name: 'check_bridge_setup', arguments: argumentsValue }, options);
}
test('setup tool requires authentication, redacts URL and identities, and never contacts or trusts hosts', async t => {
  const f = await harness({ overrides: { callbackHosts: [] } }); t.after(f.close);
  const url = 'https://receiver.example.com/secret-path?key=private-query';
  assert.equal((await preflight(f, { callback_url: url }, { token: 'wrong' })).status, 401);
  const response = await preflight(f, { callback_url: url }); assert.equal(response.status, 200);
  const setup = response.body.result.structuredContent;
  assert.equal(setup.callback_hostname, 'receiver.example.com'); assert.equal(setup.callback_policy, 'blocked');
  assert.equal(setup.network_checked, false); assert.equal(setup.configuration_ready, false);
  for (const sensitive of ['secret-path', 'private-query', f.config.qqSecret, f.config.ownerOpenid, f.config.principal]) assert.equal(JSON.stringify(response.body).includes(sensitive), false);
  assert.deepEqual(f.config.callbackHosts, []); assert.equal(f.requests.length, 0);
  assert.equal(f.app.bridge.store.activeSubscription(f.now()), undefined);
});
test('bound owner can discover an event with an empty callback policy, but subscription returns a safe actionable refusal', async t => {
  const f = await harness({ overrides: { callbackHosts: [] } }); t.after(f.close);
  assert.equal((await f.postMcp('events/list')).body.result.events.length, 1);
  const params = subscriptionParams({ delivery: { ...subscriptionParams().delivery, url: 'https://receiver.example.com/private-path?q=private-query' } });
  const response = await f.subscribe(params); assert.equal(response.body.error.code, -32012);
  assert.equal(response.body.error.data.callback_hostname, 'receiver.example.com');
  assert.deepEqual(response.body.error.data.missing_settings, ['MCP_CALLBACK_ALLOWED_HOSTS']);
  assert.ok(response.body.error.data.next_step.includes('restart'));
  for (const sensitive of ['private-path', 'private-query', params.delivery.secret]) assert.equal(JSON.stringify(response.body).includes(sensitive), false);
  assert.equal(f.requests.length, 0); assert.equal((await f.postQq()).status, 503);
});
test('manual exact-host configuration restores signed subscription validation without approving other destinations', async t => {
  const f = await harness({ overrides: { callbackHosts: [] } }); t.after(f.close);
  await preflight(f, { callback_url: subscriptionParams().delivery.url }); assert.equal((await f.subscribe()).status, 400);
  // Simulates an explicit operator change/restart; the tool never edits this.
  f.config.callbackHosts = ['receiver.example.com'];
  const setup = (await preflight(f, { callback_url: subscriptionParams().delivery.url })).body.result.structuredContent;
  assert.equal(setup.callback_policy, 'allowlisted'); assert.equal(setup.network_checked, false); assert.equal(f.requests.length, 0);
  assert.equal((await f.subscribe()).status, 200); assert.equal(f.requests.length, 1);
  const other = subscriptionParams({ delivery: { ...subscriptionParams().delivery, url: 'https://elsewhere.example.com/x' } });
  assert.equal((await f.subscribe(other)).body.error.code, -32012); assert.equal(f.requests.length, 1);
});
test('invalid callback inputs remain rejected without any DNS request or HTTP connection', async t => {
  const f = await harness(); t.after(f.close);
  for (const url of ['http://receiver.example.com/x', 'https://user:password@receiver.example.com/x', 'https://receiver.example.com/x#fragment',
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://receiver.example.com:8443/x', 'not a URL']) {
    const response = await preflight(f, { callback_url: url });
    assert.equal(response.body.result.structuredContent.callback_policy, 'invalid_url');
    assert.equal(response.body.result.structuredContent.callback_hostname, null);
    assert.equal((await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, url } }))).status, 400);
  }
  assert.equal((await preflight(f, { callback_url: 'https://receiver.example.com', secret: 'forbidden-field' })).status, 400);
  assert.equal(f.requests.length, 0);
});
test('missing owner remains undiscoverable and default-deny even when setup diagnostics are available', async t => {
  const f = await harness({ overrides: { ownerOpenid: '' } }); t.after(f.close);
  const setup = (await preflight(f)).body.result.structuredContent;
  assert.deepEqual(setup.missing_settings, ['QQ_OWNER_OPENID']); assert.equal(setup.events_discoverable, false);
  assert.equal((await f.postMcp('events/list')).body.result.events.length, 0);
  assert.equal((await f.subscribe()).body.error.code, -32012); assert.equal((await f.postQq()).status, 503);
  assert.equal(f.requests.length, 0);
});
test('sandbox closes the simulated HTTP loop using bots token and sandbox messages without production fallback', async t => {
  const f = await harness({ overrides: { qqApiProfile: 'tencent-sandbox' } }); t.after(f.close);
  await f.subscribe(); await f.postQq(); await f.app.bridge.tick(); await f.reply(); await f.app.bridge.tick();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].url, 'https://sandbox.api.sgroup.qq.com/v2/users/fixture_qq_owner/messages');
  assert.equal(f.sends[0].body.msg_seq, 1); assert.equal(f.sends[0].body.msg_id, 'fixture-message-1');
  assert.equal(f.requests.filter(r => r.url.includes('getAppAccessToken'))[0].url, 'https://bots.qq.com/app/getAppAccessToken');
  assert.equal(f.requests.some(r => r.url.startsWith('https://api.sgroup.qq.com/') || r.url.startsWith('https://api.bot.qq.com/')), false);
});
test('configuration accepts only the explicit sandbox profile and exact DNS callback entries', () => {
  assert.equal(readConfig({ QQ_API_PROFILE: 'tencent-sandbox' }).qqApiProfile, 'tencent-sandbox');
  for (const host of ['*', '*.example.com', 'https://receiver.example.com', '127.0.0.1', 'receiver.example.com/path', 'localhost', 'receiver.example.com.', 'x'.repeat(64) + '.com']) {
    assert.throws(() => readConfig({ MCP_CALLBACK_ALLOWED_HOSTS: host }));
  }
});
test('sandbox and production must use separate databases, including legacy production message records', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-qq-setup-test-')), dbPath = path.join(dir, 'bridge.sqlite');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('dot-qq-setup-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const settings = config({ dbPath }); let store = new Store(settings); store.close();
  assert.throws(() => new Store({ ...settings, qqApiProfile: 'tencent-sandbox' }), /separate sandbox\/production database/);
  store = new Store(settings);
  store.run("DELETE FROM metadata WHERE key='qq_environment'");
  store.run('INSERT INTO messages(id,source_event_id,event_id,principal,owner,subscription_id,occurred_at,expires,received) VALUES (?,?,?,?,?,?,?,?,?)',
    'legacy-message', 'legacy-source', 'legacy-event', settings.principal, settings.ownerOpenid, 'legacy-sub', new Date().toISOString(), Date.now(), Date.now());
  store.close();
  assert.throws(() => new Store({ ...settings, qqApiProfile: 'tencent-sandbox' }), /unclassified environment/);
  store = new Store(settings); assert.equal(store.get('SELECT count(*) AS n FROM messages').n, 1); store.close();
});
