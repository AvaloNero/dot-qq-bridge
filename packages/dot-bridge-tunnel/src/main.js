import { readConfig } from './config.js';
import { createApp } from './server.js';
import { supervisedStop } from '../../dot-bridge-platform/supervised-stop.js';
let app, shuttingDown, stopSupervision = () => {}, shutdownCode = 0;
async function shutdown(code) {
  shutdownCode = Math.max(shutdownCode, code); stopSupervision();
  process.exitCode = shutdownCode;
  if (!shuttingDown) shuttingDown = (async () => {
    try { await app?.close(); process.exitCode = shutdownCode; }
    catch { process.exitCode = 1; }
  })();
  return shuttingDown;
}
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
stopSupervision = supervisedStop(() => shutdown(0));
try {
  const config=readConfig();
  if(config.operation === 'live' && !process.argv.includes('--confirm-live'))throw new Error('Explicit live startup confirmation required');
  if(process.argv.slice(2).some(arg=>arg!=='--confirm-live') || (config.operation!=='live' && process.argv.includes('--confirm-live')))throw new Error('Invalid startup operation');
  app = createApp(config,{approvedLive:config.operation === 'live' && process.argv.includes('--confirm-live')});
  await app.listen();
  process.stdout.write(config.operation === 'live' ? 'Private live routing aggregator started; delivery remains unverified.\n' : 'Private readiness aggregator started; provider forwarding disabled.\n');
} catch {
  process.stderr.write('Readiness aggregator refused or failed; no secret values printed.\n');
  await shutdown(1);
}
