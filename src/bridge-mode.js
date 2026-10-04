import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openPrivateDirectory, assertPrivateFile } from './private-files.js';
import { windowsModeLock } from '../packages/dot-bridge-platform/index.js';
export function bridgeMode(env) {
  if (!['tunnel', 'sites'].includes(env.BRIDGE_MODE)) throw new Error('Select exactly one BRIDGE_MODE: tunnel or sites');
  return env.BRIDGE_MODE;
}
// Common authority for both modes on one machine, independent of DB and mode.
// No automatic stale-lock takeover: a crash requires explicit operator recovery.
export function acquireModeLock(directory, channel, appId, mode) {
  if (!path.isAbsolute(directory) || !['qq', 'lark'].includes(channel) || !/^[a-zA-Z0-9_-]{1,128}$/.test(appId) || !['tunnel', 'sites'].includes(mode)) throw new Error('Invalid shared mode-lock configuration');
  if (process.platform === 'win32') {
    try { return windowsModeLock(directory, createHash('sha256').update(`${channel}:${appId}`).digest('hex') + '.lock', { nonce: randomUUID(), mode, pid: process.pid }); }
    catch { throw new Error('Shared mode lock unavailable'); }
  }
  const parent = openPrivateDirectory(directory, { create: true });
  const key = createHash('sha256').update(`${channel}:${appId}`).digest('hex');
  const file = `${parent.path}/${key}.lock`, nonce = randomUUID();
  let fd, original;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ nonce, mode, pid: process.pid })); fs.fsyncSync(fd); original = fs.fstatSync(fd); fs.fsyncSync(parent.fd);
  } catch { parent.close(); throw new Error('Shared mode lock unavailable'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    const lockInfo = fs.lstatSync(file);
    assertPrivateFile(lockInfo, { maxBytes: 1024 });
    if (lockInfo.dev !== original.dev || lockInfo.ino !== original.ino) throw new Error('Shared mode lock changed');
    let reader, content;
    try {
      reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = fs.fstatSync(reader); assertPrivateFile(opened, { maxBytes: 1024 });
      if (opened.dev !== original.dev || opened.ino !== original.ino) throw new Error('Shared mode lock changed');
      content = JSON.parse(fs.readFileSync(reader, 'utf8'));
    } finally { if (reader !== undefined) fs.closeSync(reader); }
    if (content.nonce !== nonce) throw new Error('Shared mode lock changed');
    fs.unlinkSync(file); fs.fsyncSync(parent.fd); parent.close(); released = true;
  };
}
