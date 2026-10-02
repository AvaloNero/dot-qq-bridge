import assert from 'node:assert/strict';
import { harness } from '../test/helpers.js';

const fixture = await harness();
try {
  const discover = await fixture.postMcp('server/discover');
  assert.equal(discover.body.result.supportedVersions[0], '2026-07-28');
  assert.equal((await fixture.postMcp('events/list')).body.result.events.length, 1);
  assert.equal((await fixture.subscribe()).status, 200);
  assert.equal((await fixture.postQq()).status, 200);
  assert.equal((await fixture.postQq()).status, 200);
  await fixture.app.bridge.tick();
  assert.equal(fixture.deliveries.length, 1);
  assert.equal((await fixture.reply()).body.result.structuredContent.status, 'pending');
  assert.equal((await fixture.reply()).body.result.structuredContent.status, 'pending');
  await fixture.app.bridge.tick();
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0].body.msg_id, 'fixture-message-1');
  assert.equal(fixture.sends[0].body.msg_seq, 1);
  const status = await fixture.postMcp('tools/call', { name: 'get_qq_message', arguments: { message_id: 'fixture-message-1' } });
  assert.equal(status.body.result.structuredContent.reply.status, 'sent');
  process.stdout.write(JSON.stringify({ mode: 'OFFLINE_SIMULATION', current_dot_connected: false, real_qq_connected: false,
    mcp_version: discover.body.result.supportedVersions[0], callback_verification: 'passed',
    signed_qq_callback: 'passed', duplicate_callbacks: 'deduplicated', events_delivered: fixture.deliveries.length,
    idempotent_reply: 'passed', qq_replies: fixture.sends.length, same_conversation: true,
    question: fixture.deliveries[0].data.text, answer: fixture.sends[0].body.content }, null, 2) + '\n');
} finally { await fixture.close(); }
