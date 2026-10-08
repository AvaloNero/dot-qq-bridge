import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import https from 'node:https';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import { scanOfficialBot } from '../src/official-qr.js';
import { superviseQrChild } from '../src/qr-child-boundary.js';
import { qrFailure, qrFailureReason, sanitizeQrFailureReason } from '../src/qr-failures.js';
import { QR_LOCAL_WAIT_MS } from '../src/qr-limits.js';

const good = { appId: 'fixture-app', appSecret: 'synthetic-private-secret', userOpenid: 'fixture-owner' };
const options = { approved: true, scannerIsOwner: true, expectedAppId: good.appId, displayQr() {} };
const sdk = action => callbacks => { queueMicrotask(() => action(callbacks)); return () => {}; };
const rejectsAs = (promise, reason) => assert.rejects(promise, error => {
  assert.equal(qrFailureReason(error), reason);
  assert.ok(!error.message.includes('synthetic-private'));
  return true;
});

test('scope rejection categories come from explicit validation branches without identities', async () => {
  for (const [value, reason] of [
    [null, 'result_count_rejected'], [[], 'result_count_rejected'], [[good, good], 'result_count_rejected'],
    [[null], 'credential_result_invalid'], [[{ ...good, appId: null }], 'credential_result_invalid'],
    [[{ ...good, appId: 'synthetic-private-other-app' }], 'expected_app_mismatch'],
    [[{ ...good, userOpenid: undefined }], 'owner_identity_missing'],
    [[{ ...good, userOpenid: null }], 'owner_identity_missing'],
    [[{ ...good, userOpenid: '' }], 'owner_identity_missing'],
    [[{ ...good, userOpenid: 'synthetic-private invalid owner' }], 'owner_identity_invalid'],
    [[{ ...good, userOpenid: 123 }], 'owner_identity_invalid'],
    [[{ ...good, appSecret: 'short' }], 'credential_result_invalid'],
  ]) await rejectsAs(scanOfficialBot(sdk(callbacks => callbacks.onSuccess(value)), options), reason);
});

test('SDK expiry, SDK failure, local deadline, cancellation and startup failure stay distinct', async () => {
  await rejectsAs(scanOfficialBot(sdk(c => c.onQrExpired()), options), 'official_qr_expired');
  await rejectsAs(scanOfficialBot(sdk(c => c.onFailure(new Error('EXPIRED synthetic-private'))), options), 'sdk_reported_failure');
  await rejectsAs(scanOfficialBot(() => { throw new Error('synthetic-private'); }, options), 'sdk_start_failed');
  await rejectsAs(scanOfficialBot(() => () => {}, { ...options, timeoutMs: 1 }), 'local_deadline_reached');
  await rejectsAs(scanOfficialBot(() => () => {}, { ...options, signal: AbortSignal.abort() }), 'cancelled');
  await rejectsAs(scanOfficialBot(() => () => {}, { ...options, approved: false }), 'invalid_configuration');
  await rejectsAs(scanOfficialBot(sdk(c => c.onQrDisplayed('https://invalid.example/')), options), 'qr_display_rejected');
});

test('a resumed success past the wall-clock deadline is local expiry, never official expiry', async () => {
  const originalNow = Date.now; let now = originalNow(), callback;
  Date.now = () => now;
  try {
    const waiting = scanOfficialBot(c => { callback = c; return () => {}; }, options);
    const rejected = rejectsAs(waiting, 'local_deadline_reached');
    now += QR_LOCAL_WAIT_MS; callback.onSuccess([good]); await rejected;
  } finally { Date.now = originalNow; }
});

test('only integration-tagged errors can select classifications', () => {
  assert.equal(qrFailureReason(qrFailure('safe', 'official_qr_expired')), 'official_qr_expired');
  assert.equal(qrFailureReason(Object.assign(new Error('EXPIRED synthetic-private'), { failure_reason: 'official_qr_expired' })), 'unknown_failure');
  assert.equal(qrFailureReason(new Error('synthetic-private'), 'credential_save_failed'), 'credential_save_failed');
  for (const value of ['synthetic-private', {}, null, undefined, 3]) assert.equal(sanitizeQrFailureReason(value), 'unknown_failure');
});

test('parent IPC preserves only fixed failure reasons and excludes them from successful results', () => {
  for (const supplied of ['official_qr_expired', 'expected_app_mismatch', 'owner_identity_missing', 'synthetic-private', { private: true }, undefined]) {
    const child = new EventEmitter(); child.kill = () => {}; const reports = [];
    superviseQrChild(child, { output: value => reports.push(value) });
    child.emit('message', { type: 'result', status: 'scan_failed_or_scope_rejected', failure_reason: supplied, appSecret: 'synthetic-private', owner: 'synthetic-private', body: 'synthetic-private' });
    assert.equal(reports[0].failure_reason, sanitizeQrFailureReason(supplied));
    assert.ok(!JSON.stringify(reports).includes('synthetic-private'));
  }
  const child = new EventEmitter(); child.kill = () => {}; let result;
  superviseQrChild(child, { output: value => { result = value; } });
  child.emit('message', { type: 'result', status: 'official_scan_validated', failure_reason: 'official_qr_expired' });
  assert.equal(Object.hasOwn(result, 'failure_reason'), false);
});

test('installed SDK EXPIRED response reaches only the official-expiry category and never refreshes', async () => {
  const original = https.request; let calls = 0;
  https.request = (requestOptions, callback) => {
    calls++; const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      assert.equal(requestOptions.path, calls === 1 ? '/lite/create_bind_task' : '/lite/poll_bind_result');
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit('data', JSON.stringify({ retcode: 0, data: calls === 1 ? { task_id: 'fixture' } : { status: 3 } }));
      response.emit('end');
    });
    return request;
  };
  try {
    await rejectsAs(scanOfficialBot(startQrConnect, options), 'official_qr_expired');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
  } finally { https.request = original; }
});

test('real isolated worker emits only the setup stage on an unsafe destination without network', async t => {
  const child = fork(new URL('../scripts/qq-scan-worker.js', import.meta.url), [], { env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill());
  const result = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Worker exited without a result'))); });
  child.send({ approved: true, scannerIsOwner: true, expectedAppId: good.appId, credentialDirectory: 'relative-synthetic-private', profile: 'tencent-sdk', persistCredentials: true, probeApproved: false });
  const event = await result;
  assert.equal(event.type, 'result'); assert.equal(event.failure_reason, 'setup_failed');
  assert.equal(event.credentials_written, false);
  assert.ok(!JSON.stringify(event).includes('synthetic-private'));
});
