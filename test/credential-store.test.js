import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveQqCredentials, prepareCredentialDestination } from '../src/credential-store.js';
const candidate = {appId:'fixture',appSecret:'synthetic-secret-only',ownerOpenid:'fixture-owner',ownerEvidence:'official-qr-response'};
test('credential save is exclusive private and preserves original on a second attempt', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'credential-fixture-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const directory=path.join(base,'qq');
  assert.equal(saveQqCredentials(candidate,{directory,expectedAppId:'fixture',profile:'tencent-sdk'}).credentials_written,true);
  assert.equal(fs.statSync(directory).mode&0o777,0o700); const file=path.join(directory,'credentials.json');
  assert.equal(fs.statSync(file).mode&0o777,0o600); const original=fs.readFileSync(file);
  assert.throws(()=>saveQqCredentials(candidate,{directory,expectedAppId:'fixture',profile:'tencent-sdk'}));assert.deepEqual(fs.readFileSync(file),original);
});
test('unsafe destination and mismatched scope refuse before credential write', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'credential-fixture-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.symlinkSync(base,path.join(base,'link'));assert.throws(()=>prepareCredentialDestination(path.join(base,'link','qq')));
  fs.mkdirSync(path.join(base,'open'),{mode:0o755});assert.throws(()=>prepareCredentialDestination(path.join(base,'open')));
  assert.throws(()=>saveQqCredentials(candidate,{directory:path.join(base,'qq'),expectedAppId:'other',profile:'tencent-sdk'}));assert.equal(fs.existsSync(path.join(base,'qq')),false);
});
test('persistent authorization requires explicit deployment settings and its default plan reveals no selected identity or path', () => {
  const env = { QQ_APP_ID: 'synthetic-selected-app', QQ_CREDENTIAL_DIRECTORY: '/synthetic-selected-private-path' };
  const plan = spawnSync(process.execPath, ['scripts/qq-authorize-persistent.js'], { env, encoding: 'utf8' });
  assert.equal(plan.status, 0); const report = JSON.parse(plan.stdout);
  assert.equal(report.scan_started, false); assert.equal(report.credentials_written, false);
  assert.deepEqual(report.required_settings, ['QQ_APP_ID', 'QQ_CREDENTIAL_DIRECTORY']);
  assert.equal(plan.stdout.includes(env.QQ_APP_ID), false); assert.equal(plan.stdout.includes(env.QQ_CREDENTIAL_DIRECTORY), false);
  const args = ['scripts/qq-authorize-persistent.js', '--confirm-official-scan', '--confirm-scanner-is-owner', '--confirm-save-qq-credentials'];
  for (const invalid of [{}, { QQ_APP_ID: 'fixture' }, { QQ_APP_ID: 'not/valid', QQ_CREDENTIAL_DIRECTORY: '/synthetic-not-created' },
    { QQ_APP_ID: 'fixture', QQ_CREDENTIAL_DIRECTORY: 'relative-not-created' }]) {
    const refused = spawnSync(process.execPath, args, { env: invalid, encoding: 'utf8' });
    assert.equal(refused.status, 1); assert.deepEqual(JSON.parse(refused.stdout), { status: 'persistent_authorization_setup_failed', service_started: false });
  }
  assert.throws(() => prepareCredentialDestination());
  assert.throws(() => saveQqCredentials(candidate, { expectedAppId: 'fixture', profile: 'tencent-sdk' }));
});

import { EventEmitter } from 'node:events';
import { superviseQrChild } from '../src/qr-child-boundary.js';
test('saved-credential status is forwarded only by explicitly approved persistent parent', () => {
  for (const approved of [false,true]) {
    const child=new EventEmitter();child.kill=()=>{};let result;
    superviseQrChild(child,{allowCredentialsWritten:approved,output:value=>{result=value;}});
    child.emit('message',{type:'result',status:'official_scan_validated',credentials_written:true,appSecret:'never',owner_identity_verified:true});
    assert.equal(result.credentials_written,approved);assert.ok(!JSON.stringify(result).includes('never'));
  }
});
