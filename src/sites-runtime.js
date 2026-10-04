import { Bridge } from './bridge.js';
import { Store } from './store.js';
import { createSitesClient } from './sites-client.js';
import { makePublicRequester } from './network.js';
import { ownerConfigured } from './setup.js';

// QQ identities stay local. Only verified owner text and opaque message IDs go to Sites.
export class SitesBridge extends Bridge {
  constructor(config, { clock = Date.now, send = makePublicRequester(), client = createSitesClient(config, { clock, send }), store = new Store(config) } = {}) {
    super(config, { clock, send, store }); this.client = client;
    store.db.exec("CREATE TABLE IF NOT EXISTS sites_claims (message_id TEXT PRIMARY KEY, payload TEXT NOT NULL, ack_state TEXT NOT NULL DEFAULT 'pending', expires INTEGER NOT NULL)");
    // Persist only the authenticated remote subscription identity for relational
    // message/job references. This row alone never authorizes a connection: the
    // in-memory server lease below is required again after every restart.
    store.run('UPDATE subscriptions SET active=0');
    store.activeSubscription = now => {
      const lease = client.active(); if (!lease || lease.expires <= now) return undefined;
      const marker = store.vault.seal({ mode: 'sites', remote_subscription_id: lease.id }, `subscription:${lease.id}`);
      store.run('INSERT INTO subscriptions(id,principal,callback,expires,verified_until,active) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,active=1',
        lease.id, config.principal, marker, lease.expires, lease.expires);
      return lease;
    };
    store.subscription = id => { const lease = client.active(); return lease?.id === id ? lease : undefined; };
  }
  ready() { return this.config.bridgeMode === 'sites' && ownerConfigured(this.config); }
  retainedClaim() {
    const row = this.store.get("SELECT * FROM sites_claims WHERE ack_state='pending' ORDER BY expires LIMIT 1");
    return row ? this.store.vault.open(row.payload, `sites_claim:${row.message_id}`) : null;
  }
  async tick() {
    if (this.running) return false; this.running = true; let local, remote;
    try {
      remote = this.retainedClaim();
      const lease = this.client.active(); if (!lease || lease.expires - this.clock() < 60000) await this.client.renew();
      if (!remote) {
        remote = await this.client.claim();
        if (remote) {
          const message = this.store.authorizeMessage(remote.message_id, this.config.principal, this.clock());
          if (remote.subscription_id !== this.client.active()?.id || Date.parse(remote.reply_deadline) !== message.expires ||
              Date.parse(remote.claim_expires_at) <= this.clock()) throw new Error('Sites claim scope mismatch');
          this.store.run('INSERT INTO sites_claims(message_id,payload,expires) VALUES (?,?,?)', message.id,
            this.store.vault.seal(remote, `sites_claim:${message.id}`), Date.parse(remote.claim_expires_at));
        }
      }
      if (remote && Date.parse(remote.claim_expires_at) > this.clock()) this.store.queueReply(remote.message_id, remote.text, this.config.principal, this.clock());
      local = this.store.claim(this.clock());
      if (local) {
        const message = this.store.message(local.message_id), live = this.client.active();
        if (!live || message.subscription_id !== live.id || message.expires <= this.clock()) this.store.finish(local, 'cancelled', 'authorization_inactive');
        else if (local.kind === 'event') {
          await this.client.ingest(message);
          this.store.run('UPDATE messages SET attempted_at=? WHERE id=?', this.clock(), message.id);
          this.store.finish(local, 'delivered');
        } else {
          const authorize = () => {
            const current = this.client.active();
            if (!remote || remote.message_id !== message.id || Date.parse(remote.claim_expires_at) <= this.clock() ||
                !current || current.id !== message.subscription_id) throw new Error('Sites claim inactive');
            this.authorizeJob(local);
          };
          authorize(); this.store.tx(() => this.store.rate('reply', this.config.repliesPerMinute, this.clock()));
          const outbound = await this.sendQq(message, this.store.replyText(message.id), { authorize });
          this.store.recordReplyAck(local, outbound);
        }
      }
    } catch {
      if (local) {
        const current = this.store.get('SELECT state FROM jobs WHERE id=?', local.id);
        if (current?.state === 'processing') this.store.finish(local, local.kind === 'reply' ? 'uncertain' : 'pending', 'sites_worker_failed', this.clock() + 5000);
      }
    } finally {
      // A claim survives unrelated queue work, send errors, and process restart.
      // Only receipt ACKs retry; a terminal/uncertain QQ send is never repeated.
      if (remote) {
        try {
          if (Date.parse(remote.claim_expires_at) <= this.clock()) {
            this.store.run("UPDATE jobs SET state='uncertain',last_error='sites_claim_expired' WHERE id=? AND state IN ('pending','processing')", `reply:${remote.message_id}`);
            this.store.run("UPDATE sites_claims SET ack_state='expired' WHERE message_id=?", remote.message_id);
          } else {
            const status = this.store.replyStatus(remote.message_id).status;
            if (['sent','uncertain','dead','expired','cancelled'].includes(status)) {
              await this.client.ack(remote, ['sent','uncertain'].includes(status) ? status : 'dead');
              this.store.run("UPDATE sites_claims SET ack_state='acked' WHERE message_id=?", remote.message_id);
            }
          }
        } catch { /* durable pending receipt retries until claim expiry */ }
      }
      this.running = false;
    }
    return true;
  }
}
export function createSitesApp(config, options = {}) {
  const bridge = new SitesBridge(config, options); let gateway, interval, pending = Promise.resolve(), stopping = false, lastPrune = 0;
  const tick = () => { if (!stopping && !bridge.running) pending = bridge.tick().then(() => { if (bridge.clock() - lastPrune > 3600000) { bridge.store.prune(bridge.clock()); bridge.store.run('DELETE FROM sites_claims WHERE expires<?', bridge.clock() - config.textRetentionMs); lastPrune = bridge.clock(); } }).catch(() => { bridge.client.revoke(); }); };
  return { bridge, attachGateway(value) { gateway = value; },
    async listen() { tick(); interval = setInterval(tick, 1000); },
    async close() { stopping = true; clearInterval(interval); await gateway?.stop(); await pending; bridge.client.revoke(); bridge.qq.clearToken(); bridge.store.close(); }
  };
}
