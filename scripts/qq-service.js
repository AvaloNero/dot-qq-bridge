import { createServiceSender } from '../src/network.js';
import { readConfig } from '../src/config.js';
import { servicePreflight, startLockedPersistentService } from '../src/service-runtime.js';
import { supervisedStop } from '../packages/dot-bridge-platform/supervised-stop.js';
const args = process.argv.slice(2);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
let stopSupervision = () => {};
if (!args.length || args.join(' ') === '--plan') {
  write({ mode: 'QQ_PERSISTENT_SERVICE_PLAN', started: false, credentials_written: false,
    prerequisites: ['Approved runtime/secret storage', 'Reachable authenticated MCP ingress', 'OAuth owner subject or explicit private Tunnel live operation with fixed service owner',
      'Current-dot Events subscription with pinned callback validation', 'Persistent volume and process supervisor'],
    entry: 'node scripts/qq-service.js --run --confirm-persistent-service', current_dot_connected: false });
} else if (args.join(' ') === '--check-config') {
  const send = createServiceSender({ proxyEnv: process.env });
  const status = servicePreflight(process.env, { send }); write(status); if (!status.ready_to_start) process.exitCode = 1;
} else if (args.join(' ') === '--run --confirm-persistent-service') {
  try {
    const send = createServiceSender({ proxyEnv: process.env });
    const status = servicePreflight(process.env, { send }); write({ event: 'service_preflight', ...status });
    if (!status.ready_to_start) process.exitCode = 1;
    else {
      const controller = new AbortController();
      const stop = () => { stopSupervision(); controller.abort(); };
      stopSupervision = supervisedStop(stop);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await startLockedPersistentService(readConfig(process.env), { lockDirectory: process.env.BRIDGE_LOCK_DIRECTORY, approvedLive: true, send,
        report: write, signal: controller.signal, onStopFailure: () => { stopSupervision(); process.exitCode = 1; } });
    }
  } catch { stopSupervision(); write({ event: 'service_lifecycle', stage: 'startup_failed' }); process.exitCode = 1; }
} else { process.stderr.write('Use --plan, --check-config, or --run --confirm-persistent-service.\n'); process.exitCode = 1; }
