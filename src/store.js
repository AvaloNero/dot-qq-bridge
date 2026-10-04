import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, canonical, hash } from './common.js';
import { Vault } from './signatures.js';
import { openPrivateDirectory, privateDatabasePath } from './private-files.js';
import { destinationUrl } from './network.js';

export class Store {
  constructor(config) {
    this.config = config;
    this.vault = new Vault(config.storageKey);
    if ((config.authMode === 'tunnel-service' && !config.tunnelServiceReadinessOnly) || (process.platform === 'win32' && config.dbPath !== ':memory:')) {
      if (process.platform === 'win32' && config.authMode !== 'tunnel-service') openPrivateDirectory(path.dirname(config.dbPath), { create: true }).close();
      this.privatePath = privateDatabasePath(config.dbPath, { create: true });
    } else if (config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(config.dbPath)) fs.closeSync(fs.openSync(config.dbPath, 'wx', 0o600));
    }
    try { this.db = new DatabaseSync(this.privatePath?.path ?? config.dbPath); }
    catch (error) { this.privatePath?.close(); throw error; }
    try {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, callback TEXT NOT NULL, expires INTEGER NOT NULL,
        verified_until INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        principal TEXT NOT NULL, owner TEXT NOT NULL, subscription_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL, expires INTEGER NOT NULL, received INTEGER NOT NULL, text TEXT,
        outbound_id TEXT, attempted_at INTEGER);
      CREATE TABLE IF NOT EXISTS replies (
        message_id TEXT PRIMARY KEY REFERENCES messages(id), digest TEXT NOT NULL, text TEXT,
        created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id), state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease_until INTEGER,
        lease_token TEXT, last_error TEXT);
      CREATE INDEX IF NOT EXISTS due_jobs ON jobs(state,next_at);
      CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rates (kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_window ON rates(kind,at);
      CREATE TABLE IF NOT EXISTS gateway_lease (slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL, expires INTEGER NOT NULL);`);
      for (const table of ['subscriptions', 'messages']) {
        if (!this.all(`PRAGMA table_info(${table})`).some(column => column.name === 'generation')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`);
      }
      const bridgeMode = config.bridgeMode || 'tunnel';
      const storedMode = this.get('SELECT value FROM metadata WHERE key=?', 'bridge_mode');
      if (storedMode && storedMode.value !== bridgeMode) throw new Error('Stored bridge mode differs; explicit migration is required');
      if (!storedMode && bridgeMode === 'sites' && this.get('SELECT count(*) AS n FROM metadata').n > 0) throw new Error('Legacy database requires explicit mode migration');
      if (!storedMode) this.run('INSERT INTO metadata VALUES (?,?)', 'bridge_mode', bridgeMode);
      const check = this.get('SELECT value FROM metadata WHERE key=?', 'vault');
      if (check) this.vault.open(check.value, 'metadata');
      else this.run('INSERT INTO metadata VALUES (?,?)', 'vault', this.vault.seal({ version: 1 }, 'metadata'));
      const binding = canonical({ app: config.qqAppId, owner: config.ownerOpenid, principal: config.principal });
      const existing = this.get('SELECT value FROM metadata WHERE key=?', 'binding');
      if (existing && existing.value !== binding) throw new Error('Stored owner/AppID/principal binding differs; do not reuse this database for a different identity');
      if (!existing && config.qqAppId && config.ownerOpenid && config.principal) this.run('INSERT INTO metadata VALUES (?,?)', 'binding', binding);
      if (config.qqAppId && config.ownerOpenid && config.principal) {
        const environment = config.qqApiProfile === 'tencent-sandbox' ? 'sandbox' : 'production';
        const previous = this.get('SELECT value FROM metadata WHERE key=?', 'qq_environment');
        if ((previous && previous.value !== environment) || (!previous && environment === 'sandbox' && this.get('SELECT count(*) AS n FROM messages').n)) {
          throw new Error('QQ environment differs or existing messages have an unclassified environment; use a separate sandbox/production database');
        }
        if (!previous) this.run('INSERT INTO metadata VALUES (?,?)', 'qq_environment', environment);
      }
    } catch (error) { this.db.close(); this.privatePath?.close(); throw error; }
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquireGatewayLease(token, now) {
    return this.tx(() => {
      this.run(`INSERT INTO gateway_lease VALUES (1,?,?) ON CONFLICT(slot) DO UPDATE SET token=excluded.token,expires=excluded.expires
        WHERE gateway_lease.expires<=? OR gateway_lease.token=?`, token, now + this.config.leaseMs, now, token);
      return this.get('SELECT token FROM gateway_lease WHERE slot=1').token === token;
    });
  }
  releaseGatewayLease(token) { this.run('DELETE FROM gateway_lease WHERE slot=1 AND token=?', token); }
  renewGatewayLease(token, now) {
    return this.run('UPDATE gateway_lease SET expires=? WHERE slot=1 AND token=? AND expires>?', now + this.config.leaseMs, token, now).changes === 1;
  }
  assertGatewayLease(token, now) {
    const lease = this.get('SELECT token,expires FROM gateway_lease WHERE slot=1');
    if (!lease || lease.token !== token || lease.expires <= now) throw new BridgeError('QQ Gateway lease lost', { status: 503 });
  }
  gatewaySession() {
    const row = this.get('SELECT value FROM metadata WHERE key=?', 'gateway_session');
    return row ? this.vault.open(row.value, 'gateway_session') : null;
  }
  // Must run inside the same transaction as acceptance of an incoming Gateway message.
  saveGatewayCheckpoint(checkpoint, now) {
    this.assertGatewayLease(checkpoint.leaseToken, now);
    if (typeof checkpoint.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(checkpoint.sessionId) ||
        !Number.isSafeInteger(checkpoint.lastSeq) || checkpoint.lastSeq < 0) throw new BridgeError('Invalid QQ Gateway checkpoint');
    const session = this.vault.seal({ sessionId: checkpoint.sessionId, lastSeq: checkpoint.lastSeq }, 'gateway_session');
    this.run('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'gateway_session', session);
  }
  recordGatewayCheckpoint(checkpoint, now) { this.tx(() => this.saveGatewayCheckpoint(checkpoint, now)); }
  clearGatewaySession(token, now) {
    this.tx(() => { this.assertGatewayLease(token, now); this.run('DELETE FROM metadata WHERE key=?', 'gateway_session'); });
  }
  subscription(id) {
    const row = this.get('SELECT * FROM subscriptions WHERE id=?', id);
    return row ? { ...row, ...this.vault.open(row.callback, `subscription:${id}`) } : undefined;
  }
  activeSubscription(now) {
    const row = this.get('SELECT id FROM subscriptions WHERE active=1 AND expires>? AND principal=?', now, this.config.principal);
    const subscription = row ? this.subscription(row.id) : undefined;
    if (subscription && this.config.bridgeMode !== 'sites') {
      try { destinationUrl(subscription.url, this.config.callbackHosts); } catch { return undefined; }
    }
    return subscription;
  }
  subscriptionEpoch() { return Number(this.get('SELECT value FROM metadata WHERE key=?', 'subscription_epoch')?.value ?? 0); }
  bumpSubscriptionEpoch() { this.run('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'subscription_epoch', String(this.subscriptionEpoch() + 1)); }
  saveSubscription(subscription, now, expectedEpoch = this.subscriptionEpoch()) {
    return this.tx(() => {
      if (this.subscriptionEpoch() !== expectedEpoch) throw new BridgeError('Subscription changed during verification', { code: -32012 });
      const other = this.get('SELECT id FROM subscriptions WHERE active=1 AND expires>? AND id<>?', now, subscription.id);
      if (other) throw new BridgeError('Only one current-dot subscription is allowed', { code: -32013, data: { limit: 'subscriptions', max: 1 } });
      const existing = this.get('SELECT active,expires,generation FROM subscriptions WHERE id=?', subscription.id);
      const generation = existing ? existing.generation + (existing.active && existing.expires > now ? 0 : 1) : 1;
      const callback = this.vault.seal({ url: subscription.url, secret: subscription.secret,
        oldSecret: subscription.oldSecret ?? null, oldSecretUntil: subscription.oldSecretUntil ?? 0 }, `subscription:${subscription.id}`);
      this.run(`INSERT INTO subscriptions(id,principal,callback,expires,verified_until,active,generation) VALUES (?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET callback=excluded.callback,expires=excluded.expires,verified_until=excluded.verified_until,active=1,generation=excluded.generation`,
        subscription.id, subscription.principal, callback, subscription.expires, subscription.verified_until, generation);
      this.bumpSubscriptionEpoch();
    });
  }
  unsubscribe(id) {
    this.tx(() => {
      this.bumpSubscriptionEpoch();
      this.run('UPDATE subscriptions SET active=0 WHERE id=? AND principal=?', id, this.config.principal);
      this.run("UPDATE jobs SET state='cancelled',last_error='unsubscribed',lease_token=NULL WHERE subscription_id=? AND state IN ('pending','processing')", id);
    });
  }
  rate(kind, limit, now) {
    this.run('DELETE FROM rates WHERE at<=?', now - 60000);
    const count = this.get('SELECT count(*) AS n FROM rates WHERE kind=? AND at>?', kind, now - 60000).n;
    if (count >= limit) throw new BridgeError('Rate limit reached', { status: 429, code: -32013, retryable: true, data: { limit: kind, max: limit } });
    this.run('INSERT INTO rates VALUES (?,?)', kind, now);
  }
  capacity() {
    if (this.get("SELECT count(*) AS n FROM jobs WHERE state IN ('pending','processing')").n >= this.config.queueLimit) {
      throw new BridgeError('Queue capacity reached', { status: 503, code: -32013, retryable: true, data: { limit: 'queue', max: this.config.queueLimit } });
    }
  }
  ingest(message, replayId, now, checkpoint) {
    return this.tx(() => {
      if (checkpoint) this.saveGatewayCheckpoint(checkpoint, now);
      this.run('DELETE FROM replays WHERE expires<?', now);
      if (this.get('SELECT id FROM replays WHERE id=?', replayId) || this.get('SELECT id FROM messages WHERE id=? OR source_event_id=?', message.id, message.sourceEventId)) return 'duplicate';
      const subscription = this.activeSubscription(now);
      if (!subscription) throw new BridgeError('No active current-dot subscription', { status: 503 });
      this.capacity();
      this.rate('inbound', this.config.inboundPerMinute, now);
      const eventId = `evt_${hash(`${this.config.qqAppId}:${message.id}`)}`;
      this.run(`INSERT INTO messages(id,source_event_id,event_id,principal,owner,subscription_id,occurred_at,expires,received,text,generation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, message.id, message.sourceEventId, eventId, this.config.principal,
        message.owner, subscription.id, message.timestamp, message.expires, now, this.vault.seal(message.text, `message:${message.id}`), subscription.generation ?? (this.config.bridgeMode === 'sites' ? 1 : undefined));
      this.run('INSERT INTO jobs(id,kind,message_id,subscription_id,next_at) VALUES (?,?,?,?,?)', `event:${eventId}`, 'event', message.id, subscription.id, now);
      this.run('INSERT INTO replays VALUES (?,?)', replayId, now + 2 * this.config.signatureSkewSeconds * 1000);
      return 'queued';
    });
  }
  message(id) {
    const row = this.get('SELECT * FROM messages WHERE id=?', id);
    return row ? { ...row, text: row.text ? this.vault.open(row.text, `message:${id}`) : null } : undefined;
  }
  authorizeMessage(id, principal, now) {
    const message = this.message(id), subscription = message && this.subscription(message.subscription_id);
    if (!message || message.principal !== principal || message.owner !== this.config.ownerOpenid || !subscription?.active ||
        subscription.expires <= now || subscription.principal !== principal ||
        (subscription.generation ?? (this.config.bridgeMode === 'sites' ? 1 : undefined)) !== message.generation ||
        this.activeSubscription(now)?.id !== subscription.id || !message.attempted_at) {
      throw new BridgeError('Message unavailable to this subscription', { code: -32012 });
    }
    return message;
  }
  queueReply(id, text, principal, now) {
    return this.tx(() => {
      const message = this.authorizeMessage(id, principal, now);
      const previous = this.get('SELECT digest FROM replies WHERE message_id=?', id);
      if (previous) {
        if (previous.digest !== hash(text)) throw new BridgeError('This message already has a different reply');
        return this.replyStatus(id);
      }
      if (message.expires <= now) throw new BridgeError('QQ passive reply window expired');
      this.capacity();
      this.run('INSERT INTO replies VALUES (?,?,?,?)', id, hash(text), this.vault.seal(text, `reply:${id}`), now);
      this.run('INSERT INTO jobs(id,kind,message_id,subscription_id,next_at) VALUES (?,?,?,?,?)', `reply:${id}`, 'reply', id, message.subscription_id, now);
      return this.replyStatus(id);
    });
  }
  replyStatus(id) {
    const row = this.get("SELECT state,last_error FROM jobs WHERE id=? AND kind='reply'", `reply:${id}`);
    return { message_id: id, status: row?.state ?? 'none', error: row?.last_error ?? null };
  }
  claim(now) {
    return this.tx(() => {
      // A crashed event delivery can be retried by eventId. A crashed QQ send is ambiguous.
      this.run("UPDATE jobs SET state='uncertain',last_error='worker_interrupted' WHERE kind='reply' AND state='processing' AND lease_until<=?", now);
      this.run("UPDATE jobs SET state='pending',lease_token=NULL WHERE kind='event' AND state='processing' AND lease_until<=?", now);
      const job = this.get("SELECT * FROM jobs WHERE state='pending' AND next_at<=? ORDER BY next_at,id LIMIT 1", now);
      if (!job) return undefined;
      const token = randomUUID();
      this.run("UPDATE jobs SET state='processing',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?", now + this.config.leaseMs, token, job.id);
      return { ...job, attempts: job.attempts + 1, lease_token: token };
    });
  }
  finish(job, state, reason = null, next = 0) {
    this.run("UPDATE jobs SET state=?,last_error=?,next_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=? AND state='processing'", state, reason, next, job.id, job.lease_token);
  }
  replyText(id) {
    const row = this.get('SELECT text FROM replies WHERE message_id=?', id);
    return row?.text ? this.vault.open(row.text, `reply:${id}`) : null;
  }
  recordReplyAck(job, outboundId) {
    // Revocation cannot undo an HTTP request already on the wire. Record its
    // positive acknowledgement even if unsubscribe cancelled the local lease.
    this.tx(() => {
      this.run('UPDATE messages SET outbound_id=? WHERE id=?', outboundId, job.message_id);
      this.run("UPDATE jobs SET state='sent',last_error=NULL,lease_until=NULL,lease_token=NULL WHERE id=? AND kind='reply'", job.id);
    });
  }
  prune(now) {
    this.tx(() => {
      const cutoff = now - this.config.textRetentionMs;
      this.run('UPDATE messages SET text=NULL WHERE received<? AND expires<?', cutoff, now);
      this.run('UPDATE replies SET text=NULL WHERE created<?', cutoff);
      // Tombstones intentionally survive text deletion to preserve durable deduplication.
      this.run('DELETE FROM replays WHERE expires<?', now);
      this.run('DELETE FROM rates WHERE at<=?', now - 60000);
    });
  }
  close() { try { this.db.close(); } finally { this.privatePath?.close(); } }
}
