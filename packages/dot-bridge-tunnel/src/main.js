import { readConfig } from './config.js';
import { createApp } from './server.js';
let app, shuttingDown;
async function shutdown(code) {
  if (!shuttingDown) shuttingDown = (async () => { await app?.close(); process.exitCode = code; })();
  return shuttingDown;
}
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
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
