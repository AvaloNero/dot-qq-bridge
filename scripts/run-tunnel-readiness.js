// Safe private ingress: empty ephemeral database, no provider configuration or workers.
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { supervisedStop } from '../packages/dot-bridge-platform/supervised-stop.js';
let app, stopSupervision = () => {};
try {
  if (process.env.DATABASE_PATH || process.env.STORAGE_KEY || process.env.STORAGE_KEY_FILE || process.env.QQ_CREDENTIALS_FILE ||
      (process.env.TUNNEL_SERVICE_OPERATION && process.env.TUNNEL_SERVICE_OPERATION !== 'readiness')) throw new Error();
  const config = readConfig({ ...process.env, TUNNEL_SERVICE_OPERATION: 'readiness', STORAGE_KEY: randomBytes(32).toString('base64') });
  if (config.authMode !== 'tunnel-service' || !config.tunnelServiceReadinessOnly) throw new Error();
  app = createApp(config, { worker: false, send: async () => { throw new Error('Readiness network disabled'); } });
  const stop = () => { stopSupervision(); return app.close().catch(() => { process.exitCode = 1; }); };
  stopSupervision = supervisedStop(stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await app.listen();
  process.stdout.write('Tunnel MCP readiness listener started; provider forwarding disabled.\n');
} catch {
  stopSupervision();
  process.stderr.write('Tunnel readiness listener refused or failed; no secret values printed.\n');
  if (app) await app.close().catch(() => {});
  process.exitCode = 1;
}
