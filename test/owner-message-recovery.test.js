import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { readConfig } from '../src/config.js';
import { installQqOwnerMessagePolicy } from '../src/owner-message-policy.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';

const KEY = 'qq_owner_single_message:v1', CONTEXT = 'qq-owner-single-message:v1';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = readConfig({ AUTH_MODE: 'dev', DEV_BEARER_TOKEN: 'synthetic-fixture-token-000000000000', MCP_OWNER_SUBJECT: 'fixture-principal', QQ_APP_ID: 'fixture-app',
    QQ_BOT_SECRET: 'fixture-secret', QQ_OWNER_OPENID: 'owner', STORAGE_KEY: Buffer.alloc(32, 7).toString('base64'), MCP_CALLBACK_ALLOWED_HOSTS: 'receiver.example.com', DATABASE_PATH: path.join(directory, 'original.sqlite') });
  let providerCalls = 0;
  const send = async (_url, options) => {
    if (options.purpose !== 'callback') { providerCalls++; throw new Error('Unexpected synthetic provider request'); }
    const body = JSON.parse(options.body); return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
  };
  send.callbackPreflight = () => preflightCallbackTransport({ proxyEnv: {} });
  return { open: () => new Bridge(config, { send }), providerCalls: () => providerCalls };
}

test('unconsumed original file resumes without replacing its budget and still accepts at most one message', async t => {
  const f = fixture(t); let bridge = f.open();
  installQqOwnerMessagePolicy(bridge, { fixedReply: 'fixed reply' });
  const original = bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY).value;
  bridge.store.close(); // Synthetic process loss: no graceful cancel or budget reset.
  bridge = f.open();
  try {
    const policy = installQqOwnerMessagePolicy(bridge, { existingDatabase: true, fixedReply: 'fixed reply' });
    assert.equal(policy.status().budget_recovered, true);
    assert.equal(bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY).value, original);
    const now = Date.now();
    await bridge.subscribe({ name: 'qq.message.created', arguments: { conversation: 'owner' }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/fixture', secret: 'whsec_' + Buffer.alloc(32, 4).toString('base64') } }, { id: bridge.config.principal, validUntil: now + 60000 });
    const payload = id => ({ op: 0, t: 'C2C_MESSAGE_CREATE', id: 'event-' + id, d: { id, author: { user_openid: 'owner' }, content: 'ordinary owner text', timestamp: new Date(now).toISOString() } });
    assert.equal(bridge.acceptQq(payload('one'), 'one'), 'queued');
    assert.equal(bridge.acceptQq(payload('two'), 'two'), 'ignored');
    assert.equal(bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
    assert.equal(f.providerCalls(), 0);
  } finally { bridge.store.close(); }
});

test('existing file with no budget, corrupted budget, changed reply or consumed state cannot initialize a fresh budget', t => {
  for (const change of ['missing', 'corrupt', 'reply', 'accepted', 'reply_attempted', 'sent', 'uncertain', 'cancelled', 'attempt-flag']) {
    const f = fixture(t); const bridge = f.open();
    try {
      if (change !== 'missing') installQqOwnerMessagePolicy(bridge, { fixedReply: 'fixed reply' });
      if (!['missing', 'reply'].includes(change)) {
        const row = bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY);
        const saved = bridge.store.vault.open(row.value, CONTEXT);
        if (change === 'attempt-flag') saved.replyAttempted = true;
        else saved.phase = change;
        bridge.store.run('UPDATE metadata SET value=? WHERE key=?', change === 'corrupt' ? 'synthetic-corrupt' : bridge.store.vault.seal(saved, CONTEXT), KEY);
      }
      const before = bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY)?.value;
      assert.throws(() => installQqOwnerMessagePolicy(bridge, { existingDatabase: true, fixedReply: change === 'reply' ? 'different reply' : 'fixed reply' }), /cannot be reset/);
      assert.equal(bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY)?.value, before);
      assert.equal(f.providerCalls(), 0);
    } finally { bridge.store.close(); }
  }
});

test('even a waiting budget is not resumed when protocol or queue history exists', t => {
  for (const kind of ['subscription_epoch', 'gateway_session', 'gateway_lease', 'replay', 'subscription']) {
    const f = fixture(t); const bridge = f.open();
    try {
      installQqOwnerMessagePolicy(bridge, { fixedReply: 'fixed reply' });
      const before = bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY).value;
      if (kind === 'subscription_epoch' || kind === 'gateway_session') bridge.store.run('INSERT INTO metadata VALUES (?,?)', kind, 'synthetic-history');
      if (kind === 'gateway_lease') bridge.store.run('INSERT INTO gateway_lease VALUES (1,?,?)', 'synthetic', Date.now() + 10000);
      if (kind === 'replay') bridge.store.run('INSERT INTO replays VALUES (?,?)', 'synthetic', Date.now() + 10000);
      if (kind === 'subscription') bridge.store.run('INSERT INTO subscriptions(id,principal,callback,expires,verified_until,active) VALUES (?,?,?,?,?,?)', 'synthetic', bridge.config.principal, 'synthetic-not-read', 1, 1, 0);
      assert.throws(() => installQqOwnerMessagePolicy(bridge, { existingDatabase: true, fixedReply: 'fixed reply' }), /cannot be reset/);
      assert.equal(bridge.store.get('SELECT value FROM metadata WHERE key=?', KEY).value, before);
      assert.equal(f.providerCalls(), 0);
    } finally { bridge.store.close(); }
  }
});
