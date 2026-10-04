import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectionPlan, connectorReview, inspectQrCredentials, runQrWizard } from '../src/connection-wizard.js';

const accounts = [{ appId: 'fixture-app', appSecret: 'fixture-very-private-secret', userOpenid: 'fixture-owner' }];
const selection = { confirmedOwnerOpenid: 'fixture-owner', ownerEvidence: 'official-qr-response' };
const options = { scanAuthorized: true, licenseReviewReference: 'synthetic fixture only; no real SDK', selection, displayQr: () => {} };

test('connection plan accurately reports the UNLICENSED documented SDK dependency and starts no scan', () => {
  const plan = connectionPlan(); assert.equal(plan.real_scan_started, false); assert.equal(plan.owner_binding_changed, false);
  assert.equal(connectorReview.npm_license, 'UNLICENSED'); assert.equal(connectorReview.installed, true);
  assert.equal(connectorReview.bundled_license_file, false); assert.equal(plan.required_authorizations.length, 4);
});

test('credential selection requires one explicitly confirmed owner and rejects missing, mismatched or multiple identities', () => {
  assert.equal(inspectQrCredentials(accounts, selection).ownerOpenid, 'fixture-owner');
  assert.throws(() => inspectQrCredentials(accounts), /Explicitly confirm/);
  assert.throws(() => inspectQrCredentials(accounts, { ...selection, confirmedOwnerOpenid: 'wrong-owner' }), /does not match/);
  assert.throws(() => inspectQrCredentials([{ ...accounts[0], userOpenid: undefined }], selection), /no owner/);
  const independentlyVerified = inspectQrCredentials([{ ...accounts[0], userOpenid: undefined }], { ...selection, ownerEvidence: 'verified-qq-message' });
  assert.equal(independentlyVerified.ownerOpenid, 'fixture-owner');
  const multiple = [...accounts, { ...accounts[0], appId: 'fixture-second-app' }];
  assert.throws(() => inspectQrCredentials(multiple, selection), /select exactly one/);
  assert.equal(inspectQrCredentials(multiple, { ...selection, appId: 'fixture-second-app' }).appId, 'fixture-second-app');
  assert.throws(() => inspectQrCredentials([...accounts, ...accounts], selection), /Duplicate/);
  for (const input of [[], [{}], [{ ...accounts[0], userOpenid: '*' }], [{ ...accounts[0], appSecret: 'secret\ninject' }]]) {
    assert.throws(() => inspectQrCredentials(input, selection));
  }
});

test('QR adapter is never called without scan authorization and separate license review', async () => {
  let called = 0; const adapter = () => { called++; };
  await assert.rejects(runQrWizard(adapter, {}), /authorization/);
  await assert.rejects(runQrWizard(adapter, { ...options, scanAuthorized: false }), /authorization/);
  await assert.rejects(runQrWizard(adapter, { ...options, licenseReviewReference: '' }), /authorization/);
  assert.equal(called, 0);
});

test('prepared public QR callback interface disables SDK logs, displays only official URLs and disposes', async () => {
  let disposed = 0, displayed;
  const candidate = await runQrWizard((callbacks, settings) => {
    assert.equal(settings.displayQrCodeToConsole, false); assert.equal(settings.source, '');
    queueMicrotask(() => { callbacks.onQrDisplayed('https://q.qq.com/fixture-only'); callbacks.onSuccess(accounts); });
    return () => { disposed++; };
  }, { ...options, displayQr: url => { displayed = url; } });
  assert.equal(candidate.appSecret, accounts[0].appSecret); assert.equal(displayed, 'https://q.qq.com/fixture-only'); assert.equal(disposed, 1);
});

test('invalid QR destinations and raw SDK errors are rejected without exposing secrets', async () => {
  for (const url of ['https://evil.example.com/x', 'http://q.qq.com/x', 'https://user:secret@q.qq.com/x', 'https://q.qq.com/x#secret']) {
    await assert.rejects(runQrWizard(callbacks => { queueMicrotask(() => callbacks.onQrDisplayed(url)); return () => {}; }, options), /official HTTPS QQ/);
  }
  await assert.rejects(runQrWizard(callbacks => {
    queueMicrotask(() => callbacks.onFailure(new Error(accounts[0].appSecret))); return () => {};
  }, options), error => { assert.equal(error.message.includes(accounts[0].appSecret), false); return true; });
});

test('cancellation and a fixed timeout stop polling without accepting late credentials', async () => {
  const controller = new AbortController(); let callbacks, disposed = 0;
  const pending = runQrWizard(value => { callbacks = value; return () => { disposed++; }; }, { ...options, signal: controller.signal });
  controller.abort(); callbacks.onSuccess(accounts); await assert.rejects(pending, /cancelled/); assert.equal(disposed, 1);
  let timedOut = 0;
  await assert.rejects(runQrWizard(() => () => { timedOut++; }, { ...options, timeoutMs: 10 }), /timed out/); assert.equal(timedOut, 1);
  let started = false;
  await assert.rejects(runQrWizard(() => { started = true; }, { ...options, signal: AbortSignal.abort() }), /cancelled/); assert.equal(started, false);
});

test('synchronous QR success requires a valid disposer and late duplicate callbacks do not rebind', async () => {
  let disposed = 0;
  const candidate = await runQrWizard(callbacks => {
    callbacks.onSuccess(accounts); callbacks.onSuccess([{ ...accounts[0], userOpenid: 'different-owner' }]);
    return () => { disposed++; };
  }, options);
  assert.equal(candidate.ownerOpenid, 'fixture-owner'); assert.equal(disposed, 1);
  await assert.rejects(runQrWizard(callbacks => { callbacks.onSuccess(accounts); }, options), /adapter failed/);
});

test('connection CLI inspects a protected input without logging values, writing configuration or permitting --scan', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-qq-qr-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('dot-qq-qr-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'result.json'); fs.writeFileSync(file, JSON.stringify({ credentials: accounts, selection }));
  const before = fs.readFileSync(file);
  const result = spawnSync(process.execPath, ['scripts/connect-qq.js', '--inspect', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const summary = JSON.parse(result.stdout);
  assert.equal(summary.credentials_valid, true); assert.equal(summary.credentials_written, false); assert.equal(summary.owner_binding_changed, false);
  for (const value of [accounts[0].appSecret, accounts[0].appId, accounts[0].userOpenid]) assert.equal((result.stdout + result.stderr).includes(value), false);
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(dir), ['result.json']);
  const forbidden = spawnSync(process.execPath, ['scripts/connect-qq.js', '--scan'], { encoding: 'utf8' });
  assert.equal(forbidden.status, 1); assert.equal(forbidden.stdout, ''); assert.ok(forbidden.stderr.includes('official scanner'));
});
