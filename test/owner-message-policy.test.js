import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { readConfig } from '../src/config.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';
import { installQqOwnerMessagePolicy, pendingQqMessageSchema } from '../src/owner-message-policy.js';

function fixture(failed = false, earlyReply = false) {
  let time = Date.now(), attempts = 0; const terminal = [];
  const config = { ...readConfig({ AUTH_MODE: 'dev', DEV_BEARER_TOKEN: 'synthetic-fixture-token-000000000000', MCP_OWNER_SUBJECT: 'fixture-principal', QQ_APP_ID: 'fixture-app', QQ_BOT_SECRET: 'fixture-secret', QQ_OWNER_OPENID: 'owner', STORAGE_KEY: Buffer.alloc(32, 7).toString('base64'), MCP_CALLBACK_ALLOWED_HOSTS: 'receiver.example.com' }), dbPath: ':memory:' };
  let bridge;
  const send = async (url, options) => {
    options.beforeConnect?.(); const body = JSON.parse(options.body.toString());
    if (options.purpose === 'callback') {
      if (earlyReply && body.type !== 'verification') await bridge.rpc('tools/call', { name: 'reply_to_qq', arguments: { message_id: body.data.message_id, text: 'fixed reply' } }, { id: config.principal, validUntil: time + 3600000 });
      return { status: body.type === 'verification' ? 200 : 202, body: Buffer.from(JSON.stringify(body.type === 'verification' ? { challenge: body.challenge } : {})) };
    }
    if (url.endsWith('/app/getAppAccessToken')) return { status: 200, body: Buffer.from('{"access_token":"synthetic-token","expires_in":7200}') };
    const row = bridge.store.get('SELECT value FROM metadata WHERE key=?', 'qq_owner_single_message:v1');
    assert.equal(bridge.store.vault.open(row.value, 'qq-owner-single-message:v1').replyAttempted, true);
    attempts++; return failed ? { status: 500, body: Buffer.from('{}') } : { status: 200, body: Buffer.from('{"id":"synthetic-receipt"}') };
  };
  send.callbackPreflight = () => preflightCallbackTransport({ proxyEnv: {} });
  bridge = new Bridge(config, { send, clock: () => time });
  const policy = installQqOwnerMessagePolicy(bridge, { fixedReply: 'fixed reply', clock: () => time, onTerminal: value => terminal.push(value) });
  const principal = { id: config.principal, validUntil: time + 3600000 };
  const params = { name: 'qq.message.created', arguments: { conversation: 'owner' }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/current-dot', secret: 'whsec_' + Buffer.alloc(32, 3).toString('base64') } };
  const payload = (id, owner = 'owner', text = 'any ordinary message') => ({ op: 0, t: 'C2C_MESSAGE_CREATE', id: 'event-' + id, d: { id, author: { user_openid: owner }, content: text, timestamp: new Date(time).toISOString() } });
  return { bridge, policy, principal, params, payload, terminal, advance: value => { time += value; }, attempts: () => attempts };
}

test('any owner text after five minutes is accepted once; queue is not sent, ACK is durable and bodies are cleared', async () => {
  const f = fixture(); try {
    await f.bridge.subscribe(f.params, f.principal); f.advance(360000);
    assert.throws(() => f.bridge.acceptQq(f.payload('other', 'stranger'), 'other'));
    assert.equal(f.bridge.acceptQq(f.payload('first'), 'first'), 'queued');
    assert.equal(f.bridge.acceptQq(f.payload('second'), 'second'), 'ignored');
    assert.equal(f.policy.pendingMessage(), null);
    await f.bridge.tick();
    const setup = await f.bridge.rpc('tools/call', { name: 'check_bridge_setup', arguments: {} }, f.principal);
    assert.equal(f.policy.pendingMessage().message_id, 'first');
    assert.equal(Object.hasOwn(setup.structuredContent, 'pending_message'), false); // Ordinary transport does not expose the extension.
    await assert.rejects(f.bridge.rpc('tools/call', { name: 'check_bridge_setup', arguments: {} }, { ...f.principal, id: 'other' }));
    await assert.rejects(f.bridge.rpc('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'first', text: 'different' } }, f.principal));
    const queued = await f.bridge.rpc('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'first', text: 'fixed reply' } }, f.principal);
    assert.equal(queued.structuredContent.status, 'pending'); assert.equal(f.policy.status().provider_acknowledged, false);
    await f.bridge.tick();
    assert.equal(f.attempts(), 1); assert.equal(f.bridge.store.replyStatus('first').status, 'sent');
    assert.equal(f.policy.status().provider_acknowledged, true); assert.equal(f.policy.status().bodies_cleared, true);
    assert.equal(f.bridge.store.get('SELECT text FROM messages WHERE id=?', 'first').text, null);
    assert.equal(f.bridge.store.get('SELECT text FROM replies WHERE message_id=?', 'first').text, null);
    assert.equal(f.policy.pendingMessage(), null); assert.equal(f.terminal.length, 1);
    assert.throws(() => installQqOwnerMessagePolicy(f.bridge, { fixedReply: 'fixed reply' }), /cannot be reset/);
    const catalog = await f.bridge.rpc('tools/list', {}, f.principal);
    assert.deepEqual(catalog.tools.find(x => x.name === 'check_bridge_setup').outputSchema.properties.pending_message, pendingQqMessageSchema);
  } finally { f.bridge.store.close(); }
});

test('provider uncertainty consumes persisted budget and never resends', async () => {
  const f = fixture(true); try {
    await f.bridge.subscribe(f.params, f.principal); f.bridge.acceptQq(f.payload('one'), 'one'); await f.bridge.tick();
    await f.bridge.rpc('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'one', text: 'fixed reply' } }, f.principal);
    await f.bridge.tick(); await f.bridge.tick();
    assert.equal(f.attempts(), 1); assert.equal(f.policy.status().phase, 'uncertain');
    assert.equal(f.bridge.store.replyStatus('one').status, 'uncertain'); assert.equal(f.policy.status().provider_acknowledged, false);
    assert.equal(f.policy.status().bodies_cleared, true);
  } finally { f.bridge.store.close(); }
});

test('a reply queued before the callback ACK keeps its advanced phase and sends once', async () => {
  const f = fixture(false, true); try {
    await f.bridge.subscribe(f.params, f.principal); f.bridge.acceptQq(f.payload('one'), 'one'); await f.bridge.tick();
    assert.equal(f.policy.status().phase, 'reply_queued');
    await f.bridge.tick(); assert.equal(f.attempts(), 1); assert.equal(f.bridge.store.replyStatus('one').status, 'sent');
  } finally { f.bridge.store.close(); }
});

test('message admission and the durable one-input budget commit or roll back together', async () => {
  const f = fixture(); try {
    await f.bridge.subscribe(f.params, f.principal);
    const run = f.bridge.store.run.bind(f.bridge.store); let inject = true;
    f.bridge.store.run = (sql, ...args) => {
      if (inject && sql.startsWith('INSERT INTO metadata(key,value)')) { inject = false; throw new Error('synthetic admission persistence failure'); }
      return run(sql, ...args);
    };
    assert.throws(() => f.bridge.acceptQq(f.payload('one'), 'one'));
    assert.equal(f.bridge.store.get('SELECT count(*) AS n FROM messages').n, 0);
    assert.equal(f.bridge.store.get('SELECT count(*) AS n FROM jobs').n, 0);
    assert.equal(f.bridge.acceptQq(f.payload('two'), 'two'), 'queued');
    assert.equal(f.bridge.acceptQq(f.payload('three'), 'three'), 'ignored');
    assert.equal(f.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
  } finally { f.bridge.store.close(); }
});

test('received-message expiry remains authoritative and stop clears only the selected body', async () => {
  const f = fixture(); try {
    await f.bridge.subscribe(f.params, f.principal); f.bridge.acceptQq(f.payload('one'), 'one'); await f.bridge.tick();
    f.advance(240001); assert.equal(f.policy.pendingMessage(), null);
    await assert.rejects(f.bridge.rpc('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'one', text: 'fixed reply' } }, f.principal));
    f.policy.expire(); assert.equal(f.policy.status().phase, 'expired'); assert.equal(f.attempts(), 0);
    assert.equal(f.bridge.store.get('SELECT count(*) AS n FROM messages').n, 1);
    assert.equal(f.bridge.store.get('SELECT text FROM messages').text, null);
  } finally { f.bridge.store.close(); }
});
