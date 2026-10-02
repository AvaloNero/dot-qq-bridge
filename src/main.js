import { readConfig } from './config.js';
import { createApp } from './server.js';

try {
  const config = readConfig(), app = createApp(config);
  await app.listen();
  process.stdout.write(JSON.stringify({ status: 'listening', host: config.host, port: config.port, mode: config.authMode }) + '\n');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`Bridge startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
