import fs from 'node:fs';
import path from 'node:path';
import { openPrivateDirectory, readPrivateFile } from './private-files.js';
import { windowsPrivateDestination, windowsWritePrivateFile } from '../packages/dot-bridge-platform/index.js';
export function prepareCredentialDestination(directory) {
  const parent = openPrivateDirectory(directory, { create: true });
  try {
    if (process.platform === 'win32') return windowsPrivateDestination(path.join(directory, 'credentials.json'));
    try { fs.lstatSync(`${parent.path}/credentials.json`); throw new Error('Credential destination already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return path.join(directory, 'credentials.json');
  } finally { parent.close(); }
}
export function saveQqCredentials(candidate, { directory, expectedAppId, profile } = {}) {
  if (!candidate || candidate.appId !== expectedAppId || !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.ownerOpenid ?? '') ||
      typeof candidate.appSecret !== 'string' || candidate.appSecret.length < 8 || candidate.appSecret.length > 256 ||
      /[\s\x00-\x1f\x7f]/.test(candidate.appSecret) || profile !== 'tencent-sdk' ||
      candidate.ownerEvidence !== 'official-qr-response') throw new Error('Credential scope rejected');
  prepareCredentialDestination(directory);
  if (process.platform === 'win32') {
    const bytes = Buffer.from(JSON.stringify({ version: 1, provider: 'qq', profile, app_id: candidate.appId,
      app_secret: candidate.appSecret, owner_openid: candidate.ownerOpenid, owner_evidence: 'official-qr-response' }) + '\n');
    try { windowsWritePrivateFile(path.join(directory, 'credentials.json'), bytes); return { credentials_written: true }; }
    catch { throw new Error('Private credential file could not be saved'); }
    finally { bytes.fill(0); }
  }
  const parent = openPrivateDirectory(directory);
  let fd;
  try {
    fd = fs.openSync(`${parent.path}/credentials.json`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, provider: 'qq', profile, app_id: candidate.appId,
      app_secret: candidate.appSecret, owner_openid: candidate.ownerOpenid, owner_evidence: 'official-qr-response' }) + '\n');
    fs.fsyncSync(fd);
    fs.fsyncSync(parent.fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); parent.close(); }
  return { credentials_written: true };
}

export function readQqCredentials(file, { expectedAppId, profile } = {}) {
  try {
    const saved = JSON.parse(readPrivateFile(file, { maxBytes: 2048 }).toString('utf8'));
    const fields = ['version', 'provider', 'profile', 'app_id', 'app_secret', 'owner_openid', 'owner_evidence'];
    if (!saved || Array.isArray(saved) || Object.keys(saved).length !== fields.length || !fields.every(key => Object.hasOwn(saved, key)) ||
        saved.version !== 1 || saved.provider !== 'qq' || saved.profile !== 'tencent-sdk' || saved.profile !== profile ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(expectedAppId ?? '') || saved.app_id !== expectedAppId ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(saved.owner_openid ?? '') || saved.owner_evidence !== 'official-qr-response' ||
        typeof saved.app_secret !== 'string' || saved.app_secret.length < 8 || saved.app_secret.length > 256 ||
        /[\s\x00-\x1f\x7f]/.test(saved.app_secret)) throw new Error();
    return { qqSecret: saved.app_secret, ownerOpenid: saved.owner_openid };
  } catch { throw new Error('QQ credential file is unavailable, unsafe, or outside approved scope'); }
}
