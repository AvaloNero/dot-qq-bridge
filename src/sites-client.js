import { randomUUID } from 'node:crypto';
import { makePublicRequester } from './network.js';
import { plainText } from './common.js';
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(value);
export function createSitesClient(config, { send = makePublicRequester(), clock = Date.now, instanceId = randomUUID() } = {}) {
  const url = new URL(config.sitesOrigin);
  if (url.protocol !== 'https:' || url.origin !== config.sitesOrigin || url.username || url.password || !identifier(config.sitesBindingId) ||
      !config.sitesPlatformToken || !config.sitesConnectorToken) throw new Error('Invalid Sites connector configuration');
  let lease;
  function authorize() {
    if (!lease || lease.expires <= clock()) throw new Error('Sites subscription lease inactive');
    return lease;
  }
  async function request(route, body, protectedRequest = true) {
    const captured = protectedRequest ? authorize() : null;
    const stillAuthorized = () => { const current = authorize(); if (current.id !== captured.id || current.token !== captured.token) throw new Error('Sites lease changed'); };
    const response = await send(`${url.origin}${route}`, { method: 'POST', hosts: [url.hostname],
      headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': `Bearer ${config.sitesPlatformToken}`, Authorization: `Bearer ${config.sitesConnectorToken}` },
      body: Buffer.from(JSON.stringify({ binding_id: config.sitesBindingId, ...(protectedRequest ? { lease_token: captured.token } : {}), ...body })),
      beforeConnect: () => { if (protectedRequest) stillAuthorized(); } });
    if (response.status !== 200) { if ([401, 403, 409, 410].includes(response.status)) lease = undefined; throw new Error('Sites connector request rejected'); }
    if (protectedRequest) stillAuthorized();
    try { return JSON.parse(response.body.toString('utf8')); } catch { throw new Error('Invalid Sites connector response'); }
  }
  return {
    active() { try { return authorize(); } catch { return null; } },
    revoke() { lease = undefined; },
    async renew() {
      try {
        const result = await request('/bridge/lease', { instance_id: instanceId }, false), expires = Date.parse(result.expires_at);
        if (result.binding_id !== config.sitesBindingId || result.channel !== 'qq' || result.mode !== 'sites' || result.subscription_active !== true ||
          !identifier(result.subscription_id) || !identifier(result.lease_token) || !Number.isFinite(expires) || expires <= clock() || expires > clock() + 90000) throw new Error();
        lease = { id: result.subscription_id, token: result.lease_token, expires, active: true, principal: config.principal }; return lease;
      } catch { lease = undefined; throw new Error('Sites subscription lease unavailable'); }
    },
    async ingest(message) {
      const current = authorize(); if (message.subscription_id !== current.id) throw new Error('Sites subscription changed');
      const result = await request('/bridge/inbox', { subscription_id: current.id, message_id: message.id, event_id: message.event_id, text: message.text,
        occurred_at: message.occurred_at, reply_deadline: new Date(message.expires).toISOString() });
      if (result.message_id !== message.id || !['accepted', 'duplicate'].includes(result.status)) throw new Error('Invalid Sites ingest receipt');
      return result;
    },
    async claim() {
      const current = authorize();
      const result = await request('/bridge/outbox/claim', {}); if (result.job === null) return null;
      const job = result.job; if (!job || !identifier(job.message_id) || !identifier(job.claim_token) || !Number.isFinite(Date.parse(job.reply_deadline)) || job.subscription_id !== current.id || !Number.isFinite(Date.parse(job.claim_expires_at)) || Date.parse(job.claim_expires_at) <= clock() || Date.parse(job.claim_expires_at) > Math.min(clock() + 60000, current.expires)) throw new Error('Invalid Sites reply job');
      plainText(job.text); return { subscription_id: current.id, message_id: job.message_id, claim_token: job.claim_token, text: job.text, reply_deadline: job.reply_deadline, claim_expires_at: job.claim_expires_at };
    },
    async ack(job, status) {
      if (job.subscription_id !== authorize().id) throw new Error('Sites reply subscription changed');
      if (!['sent', 'uncertain', 'dead'].includes(status)) throw new Error('Invalid Sites reply receipt');
      const result = await request('/bridge/outbox/ack', { message_id: job.message_id, claim_token: job.claim_token, status });
      if (result.message_id !== job.message_id || result.status !== status) throw new Error('Invalid Sites ack receipt');
      return { message_id: result.message_id, status };
    }
  };
}
