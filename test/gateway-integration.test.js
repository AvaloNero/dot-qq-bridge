import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('real loopback WebSocket HELLO, reconnect/RESUME and MCP reply deliver exactly once', async () => {
  const child = spawn(process.execPath, ['scripts/simulate-gateway.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr); const result = JSON.parse(stdout);
    assert.equal(result.real_qq_connected, false); assert.equal(result.current_dot_connected, false);
    assert.equal(result.loopback_websocket, true); assert.equal(result.connections, 2);
    assert.equal(result.resumed_from_committed_seq, 2); assert.equal(result.durable_final_seq, 4);
    assert.equal(result.events_delivered, 1); assert.equal(result.qq_replies, 1); assert.equal(result.same_conversation, true);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});
