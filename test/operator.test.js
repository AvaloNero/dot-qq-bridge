import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { config, qqPayload, qqHeaders, FIXTURE_SECRET } from './helpers.js';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-qq-operator-test-'));
  t.after(() => {
    const absolute = path.resolve(dir);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('dot-qq-operator-test-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return dir;
}
function capture(t, signedAt = Date.now()) {
  const dir = temporary(t), settings = config();
  const text = 'fixture private body must never be printed';
  const body = Buffer.from(JSON.stringify(qqPayload(Date.now(), { content: text,
    message_scene: { ext: { auth_token: 'fixture-private-auth-field' } } })));
  const bodyPath = path.join(dir, 'body.bin'), headersPath = path.join(dir, 'headers.json');
  fs.writeFileSync(bodyPath, body); fs.writeFileSync(headersPath, JSON.stringify(qqHeaders(settings, body, signedAt)));
  return { dir, bodyPath, headersPath, settings, text };
}
function inspect(c, changes = {}) {
  return spawnSync(process.execPath, ['scripts/verify-qq-capture.js', c.bodyPath, c.headersPath], { encoding: 'utf8',
    env: { ...process.env, QQ_APP_ID: c.settings.qqAppId, QQ_BOT_SECRET: c.settings.qqSecret, ...changes } });
}
test('fresh signed capture prints only verified identity and never automatically binds owner', t => {
  const c = capture(t), result = inspect(c);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verified_author_openid, c.settings.ownerOpenid);
  assert.equal(output.owner_binding_changed, false);
  for (const value of [c.text, c.settings.qqSecret, 'fixture-private-auth-field']) assert.equal(result.stdout.includes(value), false);
  assert.deepEqual(fs.readdirSync(c.dir).sort(), ['body.bin', 'headers.json']);
});
test('capture inspector rejects tampering, stale signatures, wrong AppID and missing configuration', t => {
  const c = capture(t), stale = capture(t, Date.now() - 600000);
  assert.equal(inspect(stale).status, 1);
  assert.equal(inspect(c, { QQ_APP_ID: 'wrong-app' }).status, 1);
  assert.equal(inspect(c, { QQ_BOT_SECRET: '' }).status, 1);
  fs.appendFileSync(c.bodyPath, ' ');
  const rejected = inspect(c); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
});
test('operator status reads an existing SQLite file without outputting identity, text or secret', t => {
  const dir = temporary(t), dbPath = path.join(dir, 'state.sqlite'), settings = config({ dbPath });
  const store = new Store(settings), now = Date.now();
  store.saveSubscription({ id: 'sub-fixture', principal: settings.principal, url: 'https://receiver.example.com/x',
    secret: FIXTURE_SECRET, expires: now + 60000, verified_until: now + 60000 }, now);
  store.ingest({ id: 'private-message-id', sourceEventId: 'private-event-id', owner: settings.ownerOpenid,
    text: 'private status fixture', timestamp: new Date(now).toISOString(), expires: now + 60000 }, 'private-replay', now);
  store.close();
  const before = fs.readFileSync(dbPath);
  const result = spawnSync(process.execPath, ['scripts/status.js'], { encoding: 'utf8',
    env: { ...process.env, AUTH_MODE: 'deny', DATABASE_PATH: dbPath } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout); assert.equal(output.active_subscriptions, 1);
  assert.deepEqual(output.jobs, [{ kind: 'event', state: 'pending', count: 1 }]);
  for (const value of [settings.ownerOpenid, settings.principal, FIXTURE_SECRET, 'private-message-id', 'private status fixture']) assert.equal(result.stdout.includes(value), false);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});
test('missing database and missing startup storage key fail without creating a database or a listener', t => {
  const dbPath = path.join(temporary(t), 'absent.sqlite');
  const env = { ...process.env, AUTH_MODE: 'deny', DATABASE_PATH: dbPath, STORAGE_KEY: '' };
  const status = spawnSync(process.execPath, ['scripts/status.js'], { encoding: 'utf8', env });
  assert.equal(status.status, 1); assert.equal(fs.existsSync(dbPath), false);
  const start = spawnSync(process.execPath, ['src/main.js', '--run', '--confirm-persistent-service'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(start.status, 1);
  const preflight = JSON.parse(start.stdout); assert.equal(preflight.event, 'service_preflight');
  assert.equal(preflight.ready_to_start, false); assert.equal(preflight.network_checked, false);
  assert.ok(preflight.missing_settings.includes('STORAGE_KEY')); assert.equal(fs.existsSync(dbPath), false);
});
