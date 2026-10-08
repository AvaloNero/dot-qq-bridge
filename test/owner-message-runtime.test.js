import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readConfig } from '../src/config.js';
import { saveQqCredentials } from '../src/credential-store.js';
import { startQqOwnerMessage } from '../src/owner-message-runtime.js';
import { makeOwnerMessageExperimentTransport } from '../packages/dot-bridge-transport/experimental/owner-message.js';
import { createApp as createAggregate } from '../packages/dot-bridge-tunnel/src/server.js';
import { readConfig as aggregateConfig } from '../packages/dot-bridge-tunnel/src/config.js';
import { VERSION, SERVICE_HEADER, metadata } from '../packages/dot-bridge-tunnel/src/common.js';

test('owner-wait runtime requires explicit scope and refuses to reset an existing database', async t => {
  await assert.rejects(startQqOwnerMessage({}, {}), /approval/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-runtime-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'existing.db'); fs.writeFileSync(file, 'synthetic');
  await assert.rejects(startQqOwnerMessage({ bridgeMode: 'tunnel', authMode: 'tunnel-service', tunnelServiceOperation: 'live', qqTransport: 'gateway', qqApiProfile: 'tencent-sdk', dbPath: file },
    { approvedSingleMessage: true, acceptAnyOwnerText: true, waitForOwner: true, fixedReply: 'fixed' }), /cannot be reset/);
});

test('real Bridge/Store owner-wait composition renews only the same authenticated grant and reports protocol READY', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-runtime-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, 'qq'); saveQqCredentials({ appId: 'fixture', appSecret: 'synthetic-secret', ownerOpenid: 'owner', ownerEvidence: 'official-qr-response' }, { directory: credentials, expectedAppId: 'fixture', profile: 'tencent-sdk' });
  const serviceKey = path.join(directory, 'service-key'), storageKey = path.join(directory, 'storage-key');
  fs.writeFileSync(serviceKey, Buffer.alloc(32, 2).toString('base64url'), { mode: 0o600 }); fs.writeFileSync(storageKey, Buffer.alloc(32, 3).toString('base64url'), { mode: 0o600 });
  const config = readConfig({ BRIDGE_MODE: 'tunnel', AUTH_MODE: 'tunnel-service', TUNNEL_SERVICE_OPERATION: 'live', TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:dot-bridge',
    TUNNEL_SERVICE_KEY_FILE: serviceKey, QQ_APP_ID: 'fixture', QQ_CREDENTIALS_FILE: path.join(credentials, 'credentials.json'), QQ_API_PROFILE: 'tencent-sdk', QQ_TRANSPORT: 'gateway',
    STORAGE_KEY_FILE: storageKey, DATABASE_PATH: path.join(directory, 'owner.sqlite'), BRIDGE_LOCK_DIRECTORY: directory });
  let app, runtimeReport, challenges = 0, aggregate, lark;
  const proxyEnv = { HTTPS_PROXY: 'http://synthetic.proxy.example:8080' };
  const runtime = await startQqOwnerMessage(config, { approvedSingleMessage: true, acceptAnyOwnerText: true, waitForOwner: true, fixedReply: 'fixed', proxyEnv,
    callbackFactory: options => makeOwnerMessageExperimentTransport({ ...options, connect: async (_url, _proxy, request) => {
      request.beforeConnect(); const body = JSON.parse(request.body); challenges++; return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
    } }),
    async startService(settings, options) { app = options.appFactory(settings, { approvedLive: true, send: options.send, worker: false }); await app.listen(0); runtimeReport = options.report; return { close: () => app.close() }; } });
  try {
    const principal = { id: config.principal, validUntil: Date.now() + 60000 };
    const initialSetup = await app.bridge.rpc('tools/call', { name: 'check_bridge_setup', arguments: {} }, principal);
    assert.equal(initialSetup.structuredContent.callback_transport.mode, 'blocked');
    assert.equal(Object.hasOwn(initialSetup.structuredContent, 'pending_message'), false);
    const ingressKey = path.join(directory, 'ingress-key'), larkKey = path.join(directory, 'lark-key');
    fs.writeFileSync(ingressKey, Buffer.alloc(32, 11).toString('base64url'), { mode: 0o600 }); fs.writeFileSync(larkKey, Buffer.alloc(32, 12).toString('base64url'), { mode: 0o600 });
    lark = http.createServer(async (req, res) => {
      assert.equal(req.headers[SERVICE_HEADER], Buffer.alloc(32, 12).toString('base64url'));
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const request = JSON.parse(Buffer.concat(chunks));
      const result = request.method === 'server/discover' ? { supportedVersions: [VERSION], capabilities: { tools: {}, events: {} } } : request.method === 'tools/list' ? { tools: [] } : { events: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ...result } }));
    });
    await new Promise(resolve => lark.listen(0, '127.0.0.1', resolve));
    aggregate = createAggregate(aggregateConfig({ AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_OPERATION: 'live', TUNNEL_LIVE_CHANNELS: 'qq',
      TUNNEL_SERVICE_OWNER_ID: config.principal, TUNNEL_SERVICE_KEY_FILE: ingressKey, QQ_SERVICE_KEY_FILE: serviceKey, LARK_SERVICE_KEY_FILE: larkKey,
      QQ_MCP_PORT: String(app.server.address().port), LARK_MCP_PORT: String(lark.address().port) }), { approvedLive: true });
    const address = await aggregate.listen(0);
    const post = (method, params = {}) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'fixture-client', method, params: { ...params, _meta: metadata() } });
      const req = http.request({ host: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method, 'mcp-protocol-version': VERSION,
          ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), [SERVICE_HEADER]: Buffer.alloc(32, 11).toString('base64url') } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      }); req.on('error', reject); req.end(body);
    });
    assert.equal((await post('tools/list')).status, 200);
    const initialHttp = await post('tools/call', { name: 'check_bridge_setup', arguments: {} });
    assert.equal(initialHttp.status, 200); assert.equal(Object.hasOwn(initialHttp.body.result.structuredContent, 'pending_message'), false);
    const params = { name: 'qq.message.created', arguments: { conversation: 'owner' }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/current-dot', secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64') } };
    await app.bridge.subscribe(params, principal); assert.equal(challenges, 1);
    await app.bridge.subscribe(params, { ...principal, validUntil: principal.validUntil + 60000 }); assert.equal(challenges, 1);
    await assert.rejects(app.bridge.subscribe(params, { ...principal, id: 'other' }));
    await assert.rejects(app.bridge.subscribe({ ...params, delivery: { ...params.delivery, secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') } }, principal));
    runtimeReport({ event: 'service_status', gateway_connected: false, gateway_phase: 'waiting_hello', authenticated_subscription_active: true, ready_for_owner_message: false });
    assert.equal(runtime.status().gateway_ready, false);
    runtimeReport({ event: 'service_status', gateway_connected: true, gateway_phase: 'connected', authenticated_subscription_active: true, ready_for_owner_message: true });
    assert.equal(runtime.status().gateway_ready, true); assert.equal(runtime.status().ready_for_owner_message, true);
    assert.equal(runtime.status().inbound_selected, false);
    app.bridge.acceptQq({ op: 0, t: 'C2C_MESSAGE_CREATE', id: 'fixture-event', d: { id: 'fixture-message', author: { user_openid: 'owner' }, content: 'ordinary message', timestamp: new Date().toISOString() } }, 'fixture-replay');
    await app.bridge.tick();
    const pending = await app.bridge.rpc('tools/call', { name: 'check_bridge_setup', arguments: {} }, principal);
    assert.equal(pending.structuredContent.callback_transport.mode, 'owner_single_message_proxy');
    assert.equal(pending.structuredContent.pending_message.message_id, 'fixture-message');
    const pendingHttp = await post('tools/call', { name: 'check_bridge_setup', arguments: {} });
    assert.equal(pendingHttp.status, 200); assert.equal(pendingHttp.body.result.structuredContent.pending_message.message_id, 'fixture-message');
    const queuedHttp = await post('tools/call', { name: 'reply_to_qq', arguments: { message_id: 'fixture-message', text: 'fixed' } });
    assert.equal(queuedHttp.status, 200); assert.equal(queuedHttp.body.result.structuredContent.status, 'pending');
    assert.equal(runtime.status().provider_acknowledged, false);
  } finally { await aggregate?.close(); if (lark) await new Promise(resolve => { lark.close(resolve); lark.closeAllConnections(); });
    await runtime.close(); assert.deepEqual(await runtime.closed, { closed: true }); }
});

test('abort listener consumes cleanup rejection while closed still reports it to the caller', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-abort-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const runtime = await startQqOwnerMessage({ bridgeMode: 'tunnel', authMode: 'tunnel-service', tunnelServiceOperation: 'live', qqTransport: 'gateway', qqApiProfile: 'tencent-sdk', callbackHosts: [], dbPath: path.join(directory, 'unused.sqlite') },
    { approvedSingleMessage: true, acceptAnyOwnerText: true, waitForOwner: true, fixedReply: 'fixed', signal: controller.signal,
      proxyEnv: { HTTPS_PROXY: 'http://synthetic.proxy.example:8080' }, startService: async () => ({ close: async () => { throw new Error('synthetic cleanup failure'); } }) });
  controller.abort();
  await assert.rejects(runtime.closed, /cleanup not confirmed/);
  await assert.rejects(runtime.close(), /cleanup not confirmed/);
  await new Promise(resolve => setImmediate(resolve));
});
