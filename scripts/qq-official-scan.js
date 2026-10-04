import { fork } from 'node:child_process';
import { qrChildEnvironment, superviseQrChild } from '../src/qr-child-boundary.js';
const args = process.argv.slice(2);
const usage = 'Usage: node scripts/qq-official-scan.js --scan --confirm-official-scan --confirm-scanner-is-owner --expected-app-id ID [--confirm-provider-check --profile tencent-sdk|tencent-sandbox|documented]';
if (!args.length || args.join(' ') === '--plan') {
  console.log(JSON.stringify({ mode: 'OFFICIAL_QR_PLAN', sdk: '@tencent-connect/qqbot-connector@1.2.0',
    scan_started: false, credentials_written: false, current_dot_connected: false,
    needs: ['Approve an official QQ binding session and temporary in-memory credential receipt',
      'Specify existing bot AppID; owner personally scans and verifies existing bot in QQ',
      'Separately approve two provider diagnostic requests and profile if desired'],
    caveat: 'SDK cannot guarantee the QQ page will only reuse an existing bot. Cancel if it proposes creation or replacement.', usage }));
} else {
  let child, timer;
  try {
    const flags = new Set(['--scan', '--confirm-official-scan', '--confirm-scanner-is-owner', '--confirm-provider-check']);
    const values = new Map(); const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const key = args[i]; if (seen.has(key)) throw new Error(); seen.add(key);
      if (flags.has(key)) continue;
      if (!['--expected-app-id', '--profile'].includes(key) || !args[i + 1]) throw new Error(); values.set(key, args[++i]);
    }
    if (!['--scan', '--confirm-official-scan', '--confirm-scanner-is-owner'].every(key => seen.has(key)) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(values.get('--expected-app-id') ?? '') ||
        seen.has('--confirm-provider-check') !== seen.has('--profile') ||
        (seen.has('--profile') && !['documented', 'tencent-sdk', 'tencent-sandbox'].includes(values.get('--profile')))) throw new Error();
    const env = qrChildEnvironment(process.env);
    child = fork(new URL('./qq-scan-worker.js', import.meta.url), [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    superviseQrChild(child, { output: value => console.log(JSON.stringify(value)),
      failed: () => { process.exitCode = 1; }, signal: controller.signal });
    child.send({ approved: true, scannerIsOwner: true, expectedAppId: values.get('--expected-app-id'),
      probeApproved: seen.has('--confirm-provider-check'), profile: values.get('--profile') });
  } catch { clearTimeout(timer); child?.kill(); console.error(usage); process.exitCode = 1; }
}
