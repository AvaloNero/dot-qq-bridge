import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateMkdtempSync, privateMkdirSync, fixtureChmodSync, fixtureSymlinkSync, cleanupPrivateFixture, beforeFixtureCleanup, assertPrivateFixture } from '../packages/dot-bridge-platform/test-fixtures.js';
import { windowsPrivateDirectory, windowsPrivateMetadata, windowsPrivateDatabase, windowsReadPrivateFile, windowsWritePrivateFile } from '../packages/dot-bridge-platform/index.js';
import { readPrivateJson, writePrivateJson, assertPrivateDestination } from '../../dot-lark-bridge/src/private-files.js';
import { acquireModeLock } from '../src/bridge-mode.js';
import { Store } from '../src/store.js';
import { config } from './helpers.js';

const native = { skip: process.platform !== 'win32' };
function fixture(t) {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'windows-bridge-security-'));
  cleanupPrivateFixture(t, directory);
  return { directory, file: name => path.join(directory, name) };
}
test('Windows credential JSON has a verified owner/DACL and atomic exclusive publication', native, t => {
  const { file } = fixture(t), target = file('credentials.json'), value = { synthetic: true };
  assert.equal(assertPrivateDestination(target), target); writePrivateJson(target, value);
  assertPrivateFixture(assert, target, 0o600); assert.deepEqual(readPrivateJson(target), value);
  assert.throws(() => writePrivateJson(target, { replacement: true })); assert.throws(() => assertPrivateDestination(target));
  assert.deepEqual(readPrivateJson(target), value);
});
test('Windows actual public ACL, insufficient owner access and unsafe parent ACL refuse reads and writes', native, t => {
  const { directory, file } = fixture(t), target = file('fixture.json'); writePrivateJson(target, { synthetic: true });
  for (const mode of [0o400, 0o640, 0o644, 0o1600]) { fixtureChmodSync(target, mode); assert.throws(() => readPrivateJson(target)); }
  fixtureChmodSync(target, 0o600);
  for (const mode of [0o500, 0o750, 0o755, 0o1700]) {
    fixtureChmodSync(directory, mode);
    assert.throws(() => readPrivateJson(target)); assert.throws(() => writePrivateJson(file('new.json'), { synthetic: true }));
    assert.throws(() => assertPrivateDestination(file('new.json')));
    assert.equal(fs.existsSync(file('new.json')), false);
  }
  fixtureChmodSync(directory, 0o700); assert.deepEqual(readPrivateJson(target), { synthetic: true });
});
test('Windows final and ancestor junctions, dangling reparse points and hard links are refused', native, t => {
  const { directory, file } = fixture(t); writePrivateJson(file('fixture.json'), { synthetic: true });
  fixtureSymlinkSync(file('fixture.json'), file('final-link')); fixtureSymlinkSync(file('missing'), file('dangling-link'));
  privateMkdirSync(file('child')); fixtureSymlinkSync(directory, file('child/ancestor-link'));
  for (const target of [file('final-link'), file('dangling-link'), file('child/ancestor-link/fixture.json')]) {
    assert.throws(() => readPrivateJson(target)); assert.throws(() => assertPrivateDestination(target));
    assert.throws(() => writePrivateJson(target, { replacement: true }));
  }
  fs.linkSync(file('fixture.json'), file('hard-link')); assert.throws(() => readPrivateJson(file('fixture.json')));
  fs.unlinkSync(file('hard-link')); assert.deepEqual(readPrivateJson(file('fixture.json')), { synthetic: true });
});
test('Windows invalid JSON and bounded reads/writes expose fixed errors and leave no partial destination', native, t => {
  const { file } = fixture(t);
  for (const text of ['synthetic-sensitive-looking-invalid-json', ' '.repeat(16385)]) {
    fs.writeFileSync(file('bad.json'), text);
    assert.throws(() => readPrivateJson(file('bad.json')), error => error.message === 'Private file is unavailable or unsafe');
  }
  assert.throws(() => writePrivateJson(file('large.json'), { text: 'x'.repeat(16385) }));
  assert.throws(() => writePrivateJson(file('undefined.json'), undefined));
  assert.equal(fs.existsSync(file('large.json')), false); assert.equal(fs.existsSync(file('undefined.json')), false);
});
test('Windows pinned directory and SQLite handles prevent ancestor/database replacement while active', native, t => {
  assert.throws(() => new Store(config({ authMode: 'tunnel-service', tunnelServiceReadinessOnly: false, dbPath: ':memory:' })));
  const { directory, file } = fixture(t);
  const held = windowsPrivateDirectory(directory); beforeFixtureCleanup(t, () => held.close());
  assert.throws(() => fs.renameSync(directory, directory + '-replacement')); held.close(); held.close();
  const store = new Store(config({ dbPath: file('fixture.sqlite') })); beforeFixtureCleanup(t, () => store.close());
  assert.throws(() => fs.renameSync(file('fixture.sqlite'), file('replacement.sqlite')));
  assert.throws(() => fs.renameSync(directory, directory + '-replacement'));
  assertPrivateFixture(assert, file('fixture.sqlite'), 0o600);
  assertPrivateFixture(assert, file('fixture.sqlite-wal'), 0o600);
  assertPrivateFixture(assert, file('fixture.sqlite-shm'), 0o600);
});
test('Windows pre-existing SQLite sidecars reject public ACLs, hard links and reparse points before database creation', native, t => {
  const { file } = fixture(t), db = file('fixture.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.writeFileSync(db + suffix, 'synthetic'); fixtureChmodSync(db + suffix, 0o644);
    assert.throws(() => windowsPrivateDatabase(db, { create: true })); assert.equal(fs.existsSync(db), false);
    fs.unlinkSync(db + suffix);
  }
  windowsWritePrivateFile(file('source'), Buffer.from('synthetic'));
  fs.linkSync(file('source'), db + '-wal'); assert.throws(() => windowsPrivateDatabase(db, { create: true }));
  fs.unlinkSync(db + '-wal'); fixtureSymlinkSync(file('source'), db + '-journal');
  assert.throws(() => windowsPrivateDatabase(db, { create: true })); assert.equal(fs.existsSync(db), false);
});
test('Windows mode lock rejects concurrent modes, replacement and changed link identity; rejected release can recover safely', native, t => {
  const { directory } = fixture(t), release = acquireModeLock(directory, 'qq', 'synthetic-app', 'tunnel');
  beforeFixtureCleanup(t, release);
  assert.throws(() => acquireModeLock(directory, 'qq', 'synthetic-app', 'sites'));
  const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.lock')));
  assert.throws(() => fs.renameSync(file, file + '.replacement'));
  fs.linkSync(file, file + '.hardlink'); assert.throws(release);
  fs.unlinkSync(file + '.hardlink'); release(); release(); assert.equal(fs.existsSync(file), false);
});
test('Windows private traversal refuses device/UNC/ADS/reserved/trailing-dot paths and normalization changes', native, t => {
  const { file } = fixture(t);
  for (const target of ['\\\\localhost\\C$\\synthetic', '\\\\?\\C:\\synthetic', 'C:relative', file('NUL'), file('a:stream'), file('trailing.'), file('trailing '), file('..\\out')]) {
    assert.throws(() => windowsReadPrivateFile(target)); assert.throws(() => windowsWritePrivateFile(target, Buffer.from('synthetic')));
  }
});
