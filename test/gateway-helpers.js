import { EventEmitter } from 'node:events';
import { QqGateway } from '../src/gateway.js';

export class FixtureSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.terminated = false; }
  send(body, callback) { this.sent.push(JSON.parse(body)); callback?.(); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006); }
  push(payload) { this.emit('message', Buffer.from(JSON.stringify(payload)), false); }
}
export function fixtureGateway(f, overrides = {}) {
  const sockets = [], calls = [], reports = [], timeouts = new Set(), intervals = new Set();
  const gateway = new QqGateway(f.app.bridge, { clock: f.now, random: () => 0,
    schedule: (fn, ms) => { const timer = { fn, ms }; timeouts.add(timer); return timer; }, cancel: timer => timeouts.delete(timer),
    repeat: (fn, ms) => { const timer = { fn, ms }; intervals.add(timer); return timer; }, cancelRepeat: timer => intervals.delete(timer),
    report: event => reports.push(event),
    connectSocket: async (url, options) => { options.beforeConnect(); calls.push({ url, options }); const socket = new FixtureSocket(); sockets.push(socket); return socket; },
    ...overrides });
  return { gateway, sockets, calls, reports, timeouts, intervals,
    hello: () => sockets.at(-1).push({ op: 10, d: { heartbeat_interval: 1000 } }),
    ready: (seq = 0) => sockets.at(-1).push({ op: 0, t: 'READY', s: seq, d: { session_id: 'fixture-session-private' } }) };
}
