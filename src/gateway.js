import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { BridgeError, hash } from './common.js';
import { ownerConfigured } from './setup.js';
import { makePublicWebSocket } from './gateway-network.js';

const INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT; the bridge still accepts owner C2C text only.
const fatalCodes = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
const delays = [1000, 2000, 5000, 10000, 30000, 60000];

// Protocol adapter only. No model, OpenClaw backend, pairing, or proactive sender.
export class QqGateway {
  constructor(bridge, { clock = Date.now, connectSocket = makePublicWebSocket(), report = () => {},
    schedule = setTimeout, cancel = clearTimeout, repeat = setInterval, cancelRepeat = clearInterval, random = Math.random } = {}) {
    if (bridge.config.qqTransport !== 'gateway' || !ownerConfigured(bridge.config)) {
      throw new BridgeError('QQ Gateway requires a complete explicit owner binding before network access', { status: 503 });
    }
    Object.assign(this, { bridge, clock, connectSocket, report, schedule, cancel, repeat, cancelRepeat, random });
    this.token = randomUUID(); this.stopped = true; this.phase = 'stopped'; this.failures = 0; this.ownsLease = false;
  }
  status() { return { transport: 'gateway', phase: this.phase, connected: this.phase === 'connected' }; }
  setPhase(phase, code) {
    this.phase = phase;
    // Never emit token, session ID, payload, owner ID, URL or QQ close reason.
    try { this.report({ ...this.status(), ...(code ? { close_code: code } : {}) }); } catch { /* operator logging cannot change acceptance */ }
  }
  authorize() {
    if (this.stopped || this.blocked || !this.bridge.ready() || !this.bridge.store.activeSubscription(this.clock())) {
      throw new BridgeError('QQ Gateway waits for an active authenticated dot subscription', { status: 503 });
    }
    this.bridge.store.assertGatewayLease(this.token, this.clock());
  }
  async start() {
    if (!this.stopped) return;
    this.stopped = false; this.blocked = false;
    this.leaseTimer = this.repeat(() => {
      if (!this.ownsLease || this.stopped || this.blocked) return;
      try {
        if (!this.bridge.store.renewGatewayLease(this.token, this.clock())) throw new Error('lease');
        if (this.ws && (!this.bridge.ready() || !this.bridge.store.activeSubscription(this.clock()))) this.disconnect('waiting_subscription', 5000);
      } catch { this.ownsLease = false; this.disconnect('waiting_lease', 5000); }
    }, 5000);
    await this.connect();
  }
  async connect() {
    if (this.stopped || this.blocked || this.dialing || this.ws) return;
    this.cancel(this.reconnectTimer); this.reconnectTimer = undefined;
    this.dialing = true;
    this.dial = this.open().catch(error => {
      if (this.stopped) return;
      if (error instanceof BridgeError && !error.retryable && error.status !== 503) this.block('blocked_configuration');
      else this.disconnect('retrying');
    }).finally(() => { this.dialing = false; });
    await this.dial;
  }
  async open() {
    if (!this.bridge.ready() || !this.bridge.store.activeSubscription(this.clock())) {
      this.setPhase('waiting_subscription'); this.reconnectAfter(5000); return;
    }
    this.ownsLease = this.bridge.store.acquireGatewayLease(this.token, this.clock());
    if (!this.ownsLease) { this.setPhase('waiting_lease'); this.reconnectAfter(5000); return; }
    this.authorize(); this.setPhase('discovering');
    this.session = this.bridge.store.gatewaySession();
    const info = await this.bridge.qq.gatewayInfo({ authorize: () => this.authorize() });
    this.authorize();
    if (!this.session && info.remaining === 0) {
      this.setPhase('quota_exhausted'); this.reconnectAfter(Math.min(86400000, Math.max(60000, info.resetAfter))); return;
    }
    const ws = await this.connectSocket(info.url, { hosts: this.bridge.config.gatewayHosts, beforeConnect: () => this.authorize() });
    if (this.stopped || this.blocked) { ws.on('error', () => {}); ws.terminate(); return; }
    try { this.authorize(); } catch (error) { ws.on('error', () => {}); ws.terminate(); throw error; }
    this.ws = ws; this.accessToken = info.accessToken; this.hello = false; this.awaitingAck = false;
    this.setPhase('connecting');
    this.handshakeTimer = this.schedule(() => { if (this.ws === ws) this.disconnect('handshake_timeout'); }, 30000);
    ws.on('open', () => { if (this.ws === ws) this.setPhase('waiting_hello'); });
    ws.on('error', () => { if (this.ws === ws) this.disconnect('connection_error'); });
    ws.on('close', code => { if (this.ws === ws) this.closed(code); });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws || this.stopped || this.blocked) return;
      try {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (isBinary || bytes.length > 32768) throw new BridgeError('Unsupported Gateway frame');
        this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      } catch (error) {
        if (error instanceof BridgeError && error.status === 429) this.disconnect('inbound_rate_limited', 60000);
        else this.disconnect('acceptance_failed');
      }
    });
  }
  send(payload) {
    if (!this.ws || this.ws.readyState !== 1 || this.ws.bufferedAmount > 32768) throw new BridgeError('Gateway connection unavailable', { status: 503 });
    const ws = this.ws;
    ws.send(JSON.stringify(payload), error => { if (error && this.ws === ws) this.disconnect('send_failed'); });
  }
  heartbeat() {
    try {
      this.authorize();
      if (this.awaitingAck) { this.disconnect('heartbeat_timeout'); return; }
      this.awaitingAck = true; this.send({ op: 1, d: this.session?.lastSeq ?? null });
    } catch { this.disconnect('waiting_subscription', 5000); }
  }
  checkpoint(seq, sessionId = this.session?.sessionId) { return { sessionId, lastSeq: seq, leaseToken: this.token }; }
  receive(payload) {
    this.authorize();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isInteger(payload.op)) throw new BridgeError('Invalid Gateway payload');
    if (payload.op === 10) {
      const interval = payload.d?.heartbeat_interval;
      if (this.hello || !Number.isSafeInteger(interval) || interval < 1000 || interval > 300000) throw new BridgeError('Invalid Gateway HELLO');
      this.hello = true; this.setPhase('authenticating');
      if (this.session) this.send({ op: 6, d: { token: `QQBot ${this.accessToken}`, session_id: this.session.sessionId, seq: this.session.lastSeq } });
      else this.send({ op: 2, d: { token: `QQBot ${this.accessToken}`, intents: INTENTS, shard: [0, 1] } });
      this.heartbeatTimer = this.repeat(() => this.heartbeat(), interval);
      return;
    }
    if (!this.hello) throw new BridgeError('Gateway HELLO required');
    if (payload.op === 11) { this.awaitingAck = false; return; }
    if (payload.op === 1) { this.send({ op: 1, d: this.session?.lastSeq ?? null }); return; }
    if (payload.op === 7) { this.disconnect('server_reconnect'); return; }
    if (payload.op === 9) {
      if (typeof payload.d !== 'boolean') throw new BridgeError('Invalid Gateway session response');
      if (!payload.d) this.clearSession();
      this.disconnect('invalid_session', 3000); return;
    }
    if (payload.op !== 0 || typeof payload.t !== 'string' || !Number.isSafeInteger(payload.s) || payload.s < 0) throw new BridgeError('Unsupported Gateway payload');
    if (payload.t === 'READY') {
      if (this.phase !== 'authenticating') throw new BridgeError('Unexpected Gateway READY');
      const checkpoint = this.checkpoint(payload.s, payload.d?.session_id);
      this.bridge.store.recordGatewayCheckpoint(checkpoint, this.clock());
      this.session = { sessionId: checkpoint.sessionId, lastSeq: payload.s }; this.connected(); return;
    }
    if (!this.session) throw new BridgeError('Gateway session required');
    if (payload.s <= this.session.lastSeq) {
      if (payload.t === 'RESUMED') this.connected();
      return; // Already durably accepted or deliberately rejected in this session.
    }
    const checkpoint = this.checkpoint(payload.s);
    if (payload.t === 'C2C_MESSAGE_CREATE') {
      const verified = { ...payload, id: payload.id ?? `gw_${hash(`${this.session.sessionId}:${payload.s}`)}` };
      try { this.bridge.acceptQq(verified, `gateway:${verified.id}`, checkpoint); }
      catch (error) {
        // Deliberately reject unauthorized, stale, rich or malformed input. Capacity and
        // subscription failures keep the previous seq so a short-lived RESUME can retry.
        if (!(error instanceof BridgeError) || ![400, 403].includes(error.status)) throw error;
        this.bridge.store.recordGatewayCheckpoint(checkpoint, this.clock());
      }
    } else this.bridge.store.recordGatewayCheckpoint(checkpoint, this.clock());
    this.session.lastSeq = payload.s;
    if (payload.t === 'RESUMED') this.connected();
  }
  connected() {
    this.cancel(this.handshakeTimer); this.handshakeTimer = undefined; this.failures = 0; this.setPhase('connected');
  }
  clearSession() { this.bridge.store.clearGatewaySession(this.token, this.clock()); this.session = null; }
  closed(code) {
    if (fatalCodes.has(code)) { this.block('blocked_account_or_protocol', code); return; }
    try {
      if (code === 4004) this.bridge.qq.clearToken();
      if (![1000, 1001, 1005, 1006, 4008, 4009].includes(code)) this.clearSession();
    } catch { this.ownsLease = false; }
    this.disconnect('connection_closed', code === 4008 ? 60000 : undefined, code);
  }
  cleanSocket() {
    this.cancel(this.handshakeTimer); this.cancelRepeat(this.heartbeatTimer);
    this.handshakeTimer = this.heartbeatTimer = undefined;
    const ws = this.ws; this.ws = null; this.accessToken = undefined;
    if (ws) { try { ws.terminate(); } catch { /* disconnected */ } }
  }
  disconnect(phase, delay, code) {
    this.cleanSocket();
    if (this.stopped || this.blocked) return;
    this.setPhase(phase, code);
    this.failures++;
    if (this.failures > 100) { this.block('retry_limit'); return; }
    this.reconnectAfter(delay ?? Math.round(delays[Math.min(this.failures - 1, delays.length - 1)] * (1 + this.random() / 5)));
  }
  reconnectAfter(delay) {
    this.cancel(this.reconnectTimer);
    if (this.stopped || this.blocked) return;
    this.reconnectTimer = this.schedule(() => { this.reconnectTimer = undefined; void this.connect(); }, delay);
  }
  block(phase, code) {
    this.blocked = true; this.cleanSocket(); this.cancel(this.reconnectTimer); this.cancelRepeat(this.leaseTimer);
    if (this.ownsLease) this.bridge.store.releaseGatewayLease(this.token);
    this.ownsLease = false; this.setPhase(phase, code);
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; this.cleanSocket(); this.cancel(this.reconnectTimer); this.cancelRepeat(this.leaseTimer);
    await this.dial;
    if (this.ownsLease) this.bridge.store.releaseGatewayLease(this.token);
    this.ownsLease = false; this.setPhase('stopped');
  }
}
