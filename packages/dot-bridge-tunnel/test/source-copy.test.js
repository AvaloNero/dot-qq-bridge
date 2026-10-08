import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-copies.json'), 'utf8'));
const adaptations = new Set([
  "dot-bridge-transport/README.md",
  "dot-bridge-transport/candidate/node-proxy-connection.js",
  "dot-bridge-transport/experimental/owner-message.js",
  "dot-bridge-transport/package.json",
  "dot-bridge-transport/status.js",
  "dot-bridge-transport/test/contract.test.js",
  "dot-bridge-transport/test/native-proxy.test.js",
  "dot-bridge-transport/test/network-safety.test.js",
  "dot-bridge-transport/test/owner-message.test.js",
  "dot-bridge-transport/transport.js",
  "dot-bridge-tunnel/README.md",
  "dot-bridge-tunnel/src/auth.js",
  "dot-bridge-tunnel/src/catalog.js",
  "dot-bridge-tunnel/src/live-contract.js",
  "dot-bridge-tunnel/src/upstream.js",
  "dot-bridge-tunnel/src/main.js",
  "dot-bridge-tunnel/test/aggregator.test.js",
  "dot-bridge-tunnel/test/live.test.js",
  "dot-bridge-tunnel/test/sibling-contract.test.js"
]);

test('packaged sources match reviewed hashes and declare layout, Windows and transport adaptations', () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 30);
  const seen = new Set();
  for (const item of manifest.files) {
    assert.ok(['dot-bridge-transport', 'dot-bridge-tunnel'].includes(item.package));
    assert.match(item.file, /^(?:(?:src|test|candidate|experimental)\/)?[a-z0-9.-]+$/i);
    assert.ok(!item.file.includes('..'));
    const name = `${item.package}/${item.file}`;
    assert.ok(!seen.has(name)); seen.add(name);
    const file = path.join(root, name);
    assert.ok(fs.lstatSync(file).isFile(), name);
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.match(item.source_sha256, /^[a-f0-9]{64}$/);
    assert.equal(actual, item.packaged_sha256, `${name}: reviewed packaged snapshot changed`);
    if (adaptations.has(name)) {
      assert.equal(typeof item.adaptation, 'string');
      assert.ok(item.adaptation.length > 0);
    } else {
      assert.equal(item.adaptation, null);
      assert.equal(actual, item.source_sha256, `${name}: original source copy differs`);
    }
  }
});

test('package trees contain only the declared production files and offline tests', () => {
  for (const name of ['dot-bridge-transport', 'dot-bridge-tunnel']) {
    const files = [];
    const visit = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        assert.equal(entry.isSymbolicLink(), false, child);
        if (entry.isDirectory()) visit(path.join(directory, entry.name), child);
        else { assert.ok(entry.isFile(), child); files.push(child); }
      }
    };
    visit(path.join(root, name));
    const expected = manifest.files.filter(item => item.package === name).map(item => item.file);
    if (name === 'dot-bridge-tunnel') expected.push('test/source-copy.test.js');
    assert.deepEqual(files.sort(), expected.sort());
  }
});
