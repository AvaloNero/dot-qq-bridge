import { QR_LOCAL_WAIT_MS, QR_PARENT_MAX_MS, QR_REQUEST_BUDGET } from '../src/qr-limits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { officialQrUrl, installQrTransport, scanOfficialBot } from '../src/official-qr.js';
const qr = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture&source=&_wv=2';
const credentials = [{ appId: 'existing-bot', appSecret: 'synthetic-secret-only', userOpenid: 'owner-fixture' }];
const options = { approved: true, scannerIsOwner: true, expectedAppId: 'existing-bot', displayQr() {} };
const sdk = action => (callbacks, config) => { queueMicrotask(() => action(callbacks, config)); return () => {}; };
test('official scan gates run before SDK and enforce existing bot and explicit owner', async () => {
  for (const override of [{ approved: false }, { scannerIsOwner: false }, { expectedAppId: '' }]) {
    await assert.rejects(scanOfficialBot(() => { assert.fail('SDK called'); }, { ...options, ...override }));
  }
  for (const response of [[{ ...credentials[0], appId: 'new-bot' }], [{ ...credentials[0], userOpenid: undefined }], [...credentials, ...credentials]]) {
    await assert.rejects(scanOfficialBot(sdk(c => c.onSuccess(response)), options), /scope/);
  }
});
test('official SDK callback preserves secrets in memory only, disables printing, stops once', async () => {
  let disposed = 0, settings, displayed;
  const result = await scanOfficialBot((callbacks, config) => {
    settings = config; queueMicrotask(() => { callbacks.onQrDisplayed(qr); callbacks.onSuccess(credentials); }); return () => disposed++;
  }, { ...options, displayQr: url => { displayed = url; } });
  assert.equal(result.appSecret, credentials[0].appSecret); assert.equal(displayed, qr);
  assert.equal(settings.displayQrCodeToConsole, false); assert.equal(settings.source, '');
  assert.equal(settings.signal.aborted, true); assert.equal(disposed, 1);
});
test('wall-clock deadline rejects a resumed success before its overdue timer runs', async () => {
  const originalNow = Date.now; let now = originalNow(), callbacks;
  Date.now = () => now;
  try {
    const waiting = scanOfficialBot(c => { callbacks = c; return () => {}; }, options);
    const rejected = assert.rejects(waiting, /expired/);
    now += QR_LOCAL_WAIT_MS;
    callbacks.onSuccess(credentials);
    await rejected;
  } finally { Date.now = originalNow; }
});
test('official scan QR validation rejects altered host/path/query without showing it', () => {
  assert.equal(officialQrUrl(qr), qr);
  for (const url of [qr.replace('q.qq.com', 'q.qq.com.evil'), qr.replace('https:', 'http:'), qr + '&task_id=second',
    qr + '&secret=untrusted', qr.replace('source=', 'source=impersonation'), qr.replace('/qqbot/', '/other/'),
    qr.replace('q.qq.com', 'user:password@q.qq.com'), qr + '#secret']) assert.throws(() => officialQrUrl(url));
});
test('cancel/expiry/failure/late or malformed synchronous SDK callbacks fail closed', async () => {
  await assert.rejects(scanOfficialBot(sdk(c => c.onFailure(new Error(credentials[0].appSecret))), options), e => !e.message.includes(credentials[0].appSecret));
  await assert.rejects(scanOfficialBot(sdk(c => c.onQrExpired()), options), /expired/);
  await assert.rejects(scanOfficialBot(() => () => {}, { ...options, timeoutMs: 5 }), /expired/);
  await assert.rejects(scanOfficialBot(() => { assert.fail(); }, { ...options, signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(scanOfficialBot(c => { c.onSuccess(credentials); }, options), /could not start/);
  const ac = new AbortController(); let callback;
  const pending = scanOfficialBot(c => { callback = c; return () => {}; }, { ...options, signal: ac.signal });
  ac.abort(); callback.onSuccess(credentials); await assert.rejects(pending, /cancelled/);
});
test('isolated QR proxy transport pins request scope, count, response size and restores agent', () => {
  let hostRule, added = 0, destroyed = 0; const previous = {}; const target = { globalAgent: previous };
  const fake = { addRequest() { added++; }, destroy() { destroyed++; } };
  const restore = installQrTransport({ target, factory: ({ allowedHost }) => { hostRule = allowedHost; return fake; } });
  assert.equal(hostRule('q.qq.com'), true); for (const host of ['test.q.qq.com','q.qq.com.evil','api.sgroup.qq.com']) assert.equal(hostRule(host), false);
  const req = new EventEmitter(); req.destroy = () => { destroyed++; };
  assert.throws(() => fake.addRequest(req, { method: 'GET', path: '/lite/create_bind_task' }));
  assert.throws(() => fake.addRequest(req, { method: 'POST', path: '/lite/create_bind_task?redirect=1' }));
  fake.addRequest(req, { method: 'POST', path: '/lite/create_bind_task' }); assert.equal(added, 1);
  const res = new EventEmitter(); res.destroy = () => { destroyed++; };
  req.emit('response', res); res.emit('data', Buffer.alloc(262145)); assert.equal(destroyed, 2);
  for (let i = 0; i < QR_REQUEST_BUDGET - 3; i++) fake.addRequest(new EventEmitter(), { method: 'POST', path: '/lite/poll_bind_result' });
  assert.throws(() => fake.addRequest(req, { method: 'POST', path: '/lite/poll_bind_result' }));
  restore(); assert.equal(target.globalAgent, previous); assert.equal(destroyed, 3);
  assert.throws(() => installQrTransport({ target, factory: () => null }), /proxy/);
});
test('official scan CLI plan and missing consent never load SDK or start a session', () => {
  for (const args of [[], ['--plan']]) {
    const result = spawnSync(process.execPath, ['scripts/qq-official-scan.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).scan_started, false);
  }
  for (const args of [['--scan'], ['--scan','--confirm-official-scan'], ['--scan','--confirm-official-scan','--confirm-scanner-is-owner','--expected-app-id','fixture','--profile','tencent-sdk']]) {
    const result = spawnSync(process.execPath, ['scripts/qq-official-scan.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
});

import { qrChildEnvironment, superviseQrChild } from '../src/qr-child-boundary.js';
test('scanner child receives only allowlisted proxy/runtime settings, no unrelated credentials', () => {
  assert.deepEqual(qrChildEnvironment({ PATH: '/bin', HTTPS_PROXY: 'http://proxy', SECRET_KEY: 'never', QQ_BOT_SECRET: 'never', NODE_OPTIONS: 'never', NODE_DEBUG: 'never' }), { PATH: '/bin', HTTPS_PROXY: 'http://proxy' });
});
test('parent redacts malicious IPC fields and emits only one terminal result', () => {
  const child = new EventEmitter(); let killed = 0; child.kill = () => { killed++; }; const output = [];
  superviseQrChild(child, { output: value => output.push(value) });
  child.emit('message', { type: 'result', status: 'official_scan_validated', appSecret: 'never-secret', diagnostic: { status: 'provider_discovery_passed', token: 'never-token' } });
  child.emit('exit', 0); child.emit('disconnect'); child.emit('message', { type: 'qr', url: qr });
  assert.equal(output.length, 1); assert.equal(killed, 1); assert.ok(!JSON.stringify(output).includes('never'));
  assert.equal(output[0].current_dot_connected, false);
});
test('parent fails once on abrupt child exit, invalid IPC, cancellation or deadline', async () => {
  for (const event of ['exit', 'disconnect', 'error', 'message', 'abort', 'timeout']) {
    const child = new EventEmitter(); let killed = 0, failed = 0; child.kill = () => killed++;
    const output = []; const ac = new AbortController();
    superviseQrChild(child, { output: value => output.push(value), failed: () => failed++, signal: ac.signal, timeoutMs: 5 });
    if (event === 'abort') ac.abort(); else if (event === 'timeout') await new Promise(resolve => setTimeout(resolve, 15));
    else child.emit(event, { secret: 'never' });
    child.emit('exit'); assert.equal(output.length, 1); assert.equal(killed, 1); assert.equal(failed, 1); assert.ok(!JSON.stringify(output).includes('never'));
  }
});

import https from 'node:https';
import crypto from 'node:crypto';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
test('installed SDK public API completes against synthetic HTTPS responses without network or console secrets', async () => {
  const original = https.request; let calls = 0, key; const paths = [];
  https.request = (options, callback) => {
    calls++; paths.push(options.path); assert.equal(options.hostname, 'q.qq.com'); assert.equal(options.method, 'POST');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => queueMicrotask(() => {
      const input = JSON.parse(body); let data;
      if (calls === 1) { key = Buffer.from(input.key, 'base64'); data = { task_id: 'fixture' }; }
      else {
        const nonce = Buffer.alloc(12, 7); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        const ciphertext = Buffer.concat([cipher.update(credentials[0].appSecret), cipher.final()]);
        data = { status: 2, bot_appid: credentials[0].appId, user_openid: credentials[0].userOpenid,
          bot_encrypt_secret: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64') };
      }
      const res = new EventEmitter(); res.statusCode = 200; callback(res);
      res.emit('data', JSON.stringify({ retcode: 0, data })); res.emit('end');
    }); return req;
  };
  try {
    const candidate = await scanOfficialBot(startQrConnect, options);
    assert.equal(candidate.appSecret, credentials[0].appSecret); assert.equal(candidate.ownerOpenid, credentials[0].userOpenid);
    assert.deepEqual(paths, ['/lite/create_bind_task', '/lite/poll_bind_result']); assert.equal(calls, 2);
  } finally { https.request = original; key?.fill(0); }
});
test('installed SDK rejects redirect status without following destination', async () => {
  const original = https.request; let calls = 0;
  https.request = (options, callback) => {
    calls++; const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'https://evil.example/' }; res.resume = () => {}; callback(res); });
    return req;
  };
  try { await assert.rejects(scanOfficialBot(startQrConnect, options), /scan failed/); assert.equal(calls, 1); }
  finally { https.request = original; }
});

import { sanitizeQrDiagnostic } from '../src/qr-child-boundary.js';
test('transport diagnostics are fixed enums and numbers only and strip hostile payload fields', () => {
  const event = { type: 'transport', stage: 'poll', method: 'POST', sequence: 2, phase: 'error', status: null,
    elapsed_ms: 3, code: 'OTHER', error: 'never-secret', url: 'https://q.qq.com/?private', body: 'never-secret' };
  const safe = sanitizeQrDiagnostic(event); assert.ok(safe); assert.ok(!JSON.stringify(safe).includes('never-secret'));
  for (const change of [{ stage: 'private' }, { code: 'private' }, { sequence: QR_REQUEST_BUDGET + 1 }, { elapsed_ms: Infinity }, { status: 'private' }]) assert.equal(sanitizeQrDiagnostic({ ...event, ...change }), null);
  const target = {}; const agent = { addRequest() {}, destroy() {} }; const reports = [];
  const restore = installQrTransport({ target, factory: () => agent, diagnostic: value => reports.push(value) });
  const req = new EventEmitter(); agent.addRequest(req, { method: 'POST', path: '/lite/poll_bind_result' });
  req.emit('error', { code: 'RAW_PRIVATE_SECRET', message: 'never-secret' }); restore();
  assert.equal(reports[0].stage, 'poll'); assert.equal(reports[1].code, 'OTHER');
  assert.ok(reports.every(sanitizeQrDiagnostic)); assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
});

test('local wait is ten minutes, expires at boundary, and never extends official expiry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let disposed=0;
  const waiting=scanOfficialBot(()=>()=>disposed++,options);
  const rejected=assert.rejects(waiting,/expired/);
  t.mock.timers.tick(QR_LOCAL_WAIT_MS-1);assert.equal(disposed,0);
  t.mock.timers.tick(1);await rejected;assert.equal(disposed,1);
  await assert.rejects(scanOfficialBot(()=>()=>{}, {...options,timeoutMs:QR_LOCAL_WAIT_MS+1}));
});
test('parent wait includes bounded cleanup grace after the ten-minute local limit', t => {
  t.mock.timers.enable({apis:['setTimeout']});const child=new EventEmitter();let killed=0;child.kill=()=>killed++;
  superviseQrChild(child,{output() {}});
  t.mock.timers.tick(QR_PARENT_MAX_MS-1);assert.equal(killed,0);t.mock.timers.tick(1);assert.equal(killed,1);
});

test('scanner preserves the SDK request timeout and honors cancellation', t => {
  t.mock.timers.enable({apis:['setTimeout']});let passed,timeout,destroyed;
  const agent={addRequest(req,options){passed=options;},destroy(){}};const ac=new AbortController();
  const restore=installQrTransport({target:{},factory:()=>agent,signal:ac.signal});
  const req=new EventEmitter();req.setTimeout=v=>{timeout=v;};req.destroy=e=>{destroyed=e;req.emit('close');};
  agent.addRequest(req,{method:'POST',path:'/lite/create_bind_task',timeout:10000});
  assert.equal(timeout,undefined);assert.equal(passed.timeout,10000);
  t.mock.timers.tick(29999);assert.equal(destroyed,undefined);ac.abort();assert.equal(destroyed.code,'ABORT_ERR');restore();
});
test('scanner retains SDK connection timeout while adding a separate total deadline', async t => {
  let connectionTimeout;
  class OfflineAgent extends https.Agent {
    createConnection(options, callback) {
      connectionTimeout = options.timeout;
      queueMicrotask(() => callback(Object.assign(new Error('offline fixture'), { code: 'OFFLINE_FIXTURE' })));
    }
  }
  const agent = new OfflineAgent({ keepAlive: false });
  const restore = installQrTransport({ target: {}, factory: () => agent });
  t.after(restore);
  const error = await new Promise(resolve => {
    const req = https.request({ hostname: 'q.qq.com', method: 'POST', path: '/lite/create_bind_task', timeout: 10000, agent });
    req.once('error', resolve);
    req.end();
  });
  assert.equal(error.code, 'OFFLINE_FIXTURE');
  assert.equal(connectionTimeout, 10000);
});
test('scanner total per-request deadline remains bounded at thirty seconds', t => {
  t.mock.timers.enable({apis:['setTimeout']});let destroyed;
  const agent={addRequest(){},destroy(){}};const restore=installQrTransport({target:{},factory:()=>agent});
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=e=>{destroyed=e;req.emit('close');};
  agent.addRequest(req,{method:'POST',path:'/lite/poll_bind_result',timeout:10000});
  t.mock.timers.tick(30000);assert.equal(destroyed.code,'ETIMEDOUT');restore();
});


test('scanner transport clears pending timers and abort listeners on close, restore and synchronous failure', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const ending of ['close', 'restore', 'throw']) {
    let destroyed = 0; const controller = new AbortController();
    const agent = { addRequest() { if (ending === 'throw') throw new Error('synthetic'); }, destroy() {} };
    const restore = installQrTransport({ target: {}, factory: () => agent, signal: controller.signal });
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => { destroyed++; };
    const add = () => agent.addRequest(req, { method: 'POST', path: '/lite/create_bind_task' });
    if (ending === 'throw') assert.throws(add, /synthetic/);
    else { add(); assert.equal(getEventListeners(controller.signal, 'abort').length, 1); }
    if (ending === 'close') req.emit('close');
    if (ending === 'restore') restore();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(req.listenerCount('close'), 0);
    t.mock.timers.tick(30000); controller.abort(); assert.equal(destroyed, 0); restore();
  }
});

test('cancelled scanner does not delegate a new request', () => {
  const controller = new AbortController(); controller.abort(); let called = 0;
  const agent = { addRequest() { called++; }, destroy() {} };
  const restore = installQrTransport({ target: {}, factory: () => agent, signal: controller.signal });
  try {
    assert.throws(() => agent.addRequest(new EventEmitter(), { method: 'POST', path: '/lite/create_bind_task' }), /cancelled/);
    assert.equal(called, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { restore(); }
});
