import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startLockedPersistentService } from '../src/service-runtime.js';
const config = { qqAppId: 'fixture', bridgeMode: 'tunnel' };
function fixture(extra = {}) {
  let releases = 0, closes = 0;
  const app = { bridge: { ready: () => false, store: { activeSubscription: () => null } }, attachGateway() {},
    async listen() {}, async close() { closes++; } };
  const options = { lockDirectory: '/synthetic', lockFactory(directory, channel, appId, mode) {
    assert.deepEqual([directory, channel, appId, mode], ['/synthetic', 'qq', 'fixture', 'tunnel']); return () => { releases++; };
  }, appFactory: () => app, gatewayFactory: () => ({ async start() {}, status: () => ({ connected: false }) }),
  repeat: () => 1, cancel() {}, ...extra };
  return { app, options, released: () => releases, closed: () => closes };
}
test('lock release does not depend on logging and concurrent close waits for one shutdown', async () => {
  const f = fixture({ report() { throw Error('logging unavailable'); } });
  let complete;
  f.app.close = () => new Promise(resolve => { complete = resolve; });
  const runtime = await startLockedPersistentService(config, f.options);
  const a = runtime.close(), b = runtime.close();
  assert.equal(a, b); assert.equal(f.released(), 0);
  complete(); await a; assert.equal(f.released(), 1);
});
test('failed shutdown or constructor retains lock and exposes only safe error', async () => {
  const f = fixture(); f.app.close = async () => { throw Error('private-secret'); };
  const runtime = await startLockedPersistentService(config, f.options);
  await assert.rejects(runtime.close(), e => e.message === 'Service stop failed');
  assert.equal(f.released(), 0);
  const g = fixture({ appFactory() { throw Error('private-secret'); } });
  await assert.rejects(startLockedPersistentService(config, g.options), e => e.message === 'Persistent service startup failed');
  assert.equal(g.released(), 0);
});
test('startup failure releases only after successful cleanup', async () => {
  const f = fixture(); f.app.listen = async () => { throw Error('listen failure'); };
  await assert.rejects(startLockedPersistentService(config, f.options), /startup failed/);
  assert.equal(f.closed(), 1); assert.equal(f.released(), 1);
  const g = fixture(); g.app.listen = f.app.listen; g.app.close = async () => { throw Error('private-secret'); };
  await assert.rejects(startLockedPersistentService(config, g.options), /startup failed/);
  assert.equal(g.released(), 0);
});
test('abort racing asynchronous startup conservatively retains lock', async () => {
  const ac = new AbortController(); const f = fixture({ signal: ac.signal }); let finishListen;
  f.app.listen = () => new Promise(resolve => { finishListen = resolve; });
  const starting = startLockedPersistentService(config, f.options);
  ac.abort(); await Promise.resolve(); assert.equal(f.released(), 0);
  finishListen(); await assert.rejects(starting, /startup failed/); assert.equal(f.released(), 0);
});
test('release failure is sanitized and reports failed shutdown independently of logs', async () => {
  let failures = 0;
  const f = fixture({ lockFactory: () => () => { throw Error('private-lock-path'); }, onStopFailure: () => failures++ });
  const runtime = await startLockedPersistentService(config, f.options);
  await assert.rejects(runtime.close(), e => e.message === 'Service stop failed'); assert.equal(failures, 1);
});
test('legacy and formal entrypoints default to offline plan and reject unconfirmed runs', () => {
  for (const entry of ['src/main.js', 'scripts/qq-service.js']) {
    const plan = spawnSync(process.execPath, [entry], { env: {}, encoding: 'utf8' });
    assert.equal(plan.status, 0); assert.equal(JSON.parse(plan.stdout).started, false);
    const run = spawnSync(process.execPath, [entry, '--run'], { env: {}, encoding: 'utf8' });
    assert.equal(run.status, 1); assert.equal(run.stdout, '');
  }
});
