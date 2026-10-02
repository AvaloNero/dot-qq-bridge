import { readConfig } from './config.js';
import { createApp } from './server.js';
import { QqGateway } from './gateway.js';

let app;
try {
  const config = readConfig(); app = createApp(config);
  await app.listen();
  process.stdout.write(JSON.stringify({ status: 'listening', host: config.host, port: config.port, mode: config.authMode, qq_transport: config.qqTransport }) + '\n');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (config.qqTransport === 'gateway') {
    const gateway = new QqGateway(app.bridge, { report: status => process.stdout.write(JSON.stringify(status) + '\n') });
    app.attachGateway(gateway); await gateway.start();
  }
} catch (error) {
  try { await app?.close(); } catch { /* keep startup failure bounded and redacted */ }
  process.stderr.write(`Bridge startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
