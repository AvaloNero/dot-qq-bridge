import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { QqGateway } from '../src/gateway.js';
import { harness, qqPayload } from '../test/helpers.js';

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Loopback Gateway simulation timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const fixture = await harness({ overrides: { qqTransport: 'gateway' } });
const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 32768, perMessageDeflate: false });
let resumedFrom, connections = 0, gateway;
try {
  await once(receiver, 'listening');
  const origin = `ws://127.0.0.1:${receiver.address().port}`;
  receiver.on('connection', socket => {
    connections++; socket.on('error', () => {});
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString('utf8'));
      if (data.op === 2) {
        assert.equal(data.d.intents, 1 << 25);
        socket.send(JSON.stringify({ op: 0, s: 0, t: 'READY', d: { session_id: 'fixture-session' } }));
        socket.send(JSON.stringify({ ...qqPayload(fixture.now()), s: 1 }));
        socket.send(JSON.stringify({ ...qqPayload(fixture.now()), s: 2 }));
      } else if (data.op === 6) {
        resumedFrom = data.d.seq;
        socket.send(JSON.stringify({ ...qqPayload(fixture.now()), s: 3 }));
        socket.send(JSON.stringify({ op: 0, s: 4, t: 'RESUMED', d: '' }));
      } else if (data.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  await fixture.subscribe();
  gateway = new QqGateway(fixture.app.bridge, { clock: fixture.now, random: () => 0,
    // Explicit loopback fixture injection. Production uses public WSS/DNS/TLS validation.
    connectSocket: async (_officialUrl, options) => { options.beforeConnect(); return new WebSocket(origin, { perMessageDeflate: false, maxPayload: 32768 }); } });
  fixture.app.attachGateway(gateway); await gateway.start();
  await waitFor(() => fixture.app.bridge.store.gatewaySession()?.lastSeq === 2);
  for (const socket of receiver.clients) socket.close(4009, 'synthetic resume exercise');
  await waitFor(() => gateway.status().connected && fixture.app.bridge.store.gatewaySession()?.lastSeq === 4);
  assert.equal(resumedFrom, 2); assert.equal(connections, 2);
  await fixture.app.bridge.tick(); assert.equal(fixture.deliveries.length, 1);
  assert.equal((await fixture.reply()).body.result.structuredContent.status, 'pending');
  assert.equal((await fixture.reply()).body.result.structuredContent.status, 'pending');
  await fixture.app.bridge.tick(); assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0].body.msg_id, 'fixture-message-1'); assert.equal(fixture.sends[0].body.msg_seq, 1);
  assert.equal(fixture.sends[0].url, 'https://api.bot.qq.com/v2/users/fixture_qq_owner/messages');
  process.stdout.write(JSON.stringify({ mode: 'OFFLINE_GATEWAY_SIMULATION', real_qq_connected: false, current_dot_connected: false,
    loopback_websocket: true, connections, resumed_from_committed_seq: resumedFrom, durable_final_seq: 4,
    replay_deduplicated: true, events_delivered: fixture.deliveries.length, qq_replies: fixture.sends.length,
    same_conversation: true, question: fixture.deliveries[0].data.text, answer: fixture.sends[0].body.content }, null, 2) + '\n');
} finally {
  await fixture.close();
  for (const socket of receiver.clients) socket.terminate();
  await new Promise(resolve => receiver.close(resolve));
}
