import { incomingMessage } from './qq.js';
import { BridgeError, plainText, hash, toolResult } from './common.js';

const KEY = 'qq_owner_single_message:v1';
const CONTEXT = 'qq-owner-single-message:v1';
const terminalStates = new Set(['sent', 'uncertain', 'dead', 'cancelled', 'expired']);
export const pendingQqMessageSchema = { anyOf: [{ type: 'null' }, { type: 'object', properties: {
  message_id: { type: 'string', minLength: 1, maxLength: 256 }, reply_deadline: { type: 'string', format: 'date-time' },
}, required: ['message_id', 'reply_deadline'], additionalProperties: false }] };

// One approved owner input and one fixed provider attempt. The existing Store
// remains authoritative for owner, subscription, passive reply window and ACKs.
export function installQqOwnerMessagePolicy(bridge, { fixedReply, clock = Date.now, onSelected = () => {}, onTerminal = () => {} } = {}) {
  plainText(fixedReply);
  const store = bridge.store;
  if (store.get('SELECT value FROM metadata WHERE key=?', KEY) ||
      ['messages', 'replies', 'jobs', 'subscriptions'].some(table => store.get(`SELECT count(*) AS n FROM ${table}`).n)) {
    throw new Error('Owner-message test requires an unused durable queue; existing budgets cannot be reset');
  }
  let state = { version: 1, phase: 'waiting', messageId: null, expires: null, replyAttempted: false, replyDigest: hash(fixedReply) };
  let closed = false, bodiesCleared = false, providerAcknowledged = false;
  const save = (phase, changes = {}, withinTransaction = false) => {
    const next = { ...state, ...changes, phase };
    const write = () => { store.run('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, store.vault.seal(next, CONTEXT)); };
    if (withinTransaction) write(); else store.tx(write);
    state = next;
  };
  save('waiting');
  const active = () => {
    if (closed || (state.expires !== null && clock() >= state.expires)) throw new BridgeError('Owner-message scope closed', { code: -32012 });
  };
  const clearBodies = () => {
    if (state.messageId !== null) store.tx(() => {
      store.run('UPDATE messages SET text=NULL WHERE id=?', state.messageId);
      store.run('UPDATE replies SET text=NULL WHERE message_id=?', state.messageId);
    });
    bodiesCleared = true;
  };
  const status = () => ({ phase: state.phase, inbound_selected: state.messageId !== null,
    reply_queued: ['reply_queued', 'reply_attempted', 'sent', 'uncertain'].includes(state.phase),
    reply_attempted: state.replyAttempted, provider_acknowledged: providerAcknowledged,
    bodies_cleared: bodiesCleared, closed, max_incoming: 1, max_reply_attempts: 1,
    reply_deadline: state.expires === null ? null : new Date(state.expires).toISOString(), current_dot_roundtrip_verified: false });
  const finishScope = (phase, acknowledged = false) => {
    if (closed && !acknowledged) return;
    try { save(phase); clearBodies(); }
    catch { state = { ...state, phase: 'storage_failed' }; }
    closed = true;
    try { onTerminal(status()); } catch { /* reporting never widens scope */ }
  };
  const accept = bridge.acceptQq.bind(bridge), ingest = store.ingest.bind(store), queue = store.queueReply.bind(store), send = bridge.sendQq.bind(bridge);
  const recordAck = store.recordReplyAck.bind(store), finishJob = store.finish.bind(store), rpc = bridge.rpc.bind(bridge);
  store.ingest = (message, replayId, now, checkpoint) => ingest(message, replayId, now, checkpoint, () => {
    active();
    if (state.messageId !== null && state.messageId !== message.id) throw new BridgeError('Single-message input budget exhausted', { code: -32012 });
    save('accepted', { messageId: message.id, expires: message.expires }, true);
  });
  bridge.acceptQq = (payload, replayId, checkpoint) => {
    active();
    const message = incomingMessage(payload, bridge.config, clock());
    if (!message) return 'ignored';
    if (state.messageId !== null && message.id !== state.messageId) return 'ignored';
    const result = accept(payload, replayId, checkpoint);
    if (result === 'queued') onSelected({ expires: message.expires });
    return result;
  };
  store.queueReply = (id, text, principal, now) => {
    active();
    if (state.messageId === null || id !== state.messageId || text !== fixedReply) throw new BridgeError('Reply outside approved one-message scope', { code: -32012 });
    const result = queue(id, text, principal, now);
    if (!state.replyAttempted) save('reply_queued');
    return result; // Queued is never a provider acknowledgement.
  };
  bridge.sendQq = async (message, text, { authorize = () => {} } = {}) => {
    active();
    if (state.phase !== 'reply_queued' || state.replyAttempted || message.id !== state.messageId ||
        text !== fixedReply || message.owner !== bridge.config.ownerOpenid) throw new BridgeError('Single-message send budget exhausted', { code: -32012 });
    save('reply_attempted', { replyAttempted: true }); // Durable before any provider I/O.
    return send(message, text, { authorize() { active(); authorize(); } });
  };
  store.recordReplyAck = (job, outboundId) => {
    const result = recordAck(job, outboundId);
    if (job.message_id === state.messageId) { providerAcknowledged = true; finishScope('sent', true); }
    return result;
  };
  store.finish = (job, outcome, reason, next) => {
    // A one-attempt experiment must not retry an ambiguous event or reply.
    if (job.message_id === state.messageId && outcome === 'pending') outcome = 'uncertain';
    const result = finishJob(job, outcome, reason, next);
    if (job.message_id === state.messageId) {
      if (job.kind === 'event' && outcome === 'delivered' && !closed && state.phase === 'accepted') save('event_delivered');
      else if (terminalStates.has(outcome)) finishScope(outcome);
    }
    return result;
  };
  const pendingMessage = () => {
    if (closed || !['event_delivered', 'reply_queued', 'reply_attempted'].includes(state.phase)) return null;
    try { active(); const message = store.authorizeMessage(state.messageId, bridge.config.principal, clock());
      return { message_id: message.id, reply_deadline: new Date(message.expires).toISOString() };
    } catch { return null; }
  };
  bridge.rpc = async (method, params, principal) => {
    const result = await rpc(method, params, principal); // Original authentication/validation first.
    if (method === 'tools/call' && params.name === 'check_bridge_setup') {
      const setup = result.structuredContent;
      return toolResult({ ...setup, ...(setup.callback_transport?.mode === 'owner_single_message_proxy' ? { pending_message: pendingMessage() } : {}) });
    }
    if (method === 'tools/list') return { ...result, tools: result.tools.map(tool => tool.name === 'check_bridge_setup' ?
      { ...tool, outputSchema: { ...tool.outputSchema, properties: { ...tool.outputSchema.properties, pending_message: pendingQqMessageSchema } } } : tool) };
    return result;
  };
  return { status, pendingMessage, selected: () => state.messageId !== null,
    expire() { if (!state.replyAttempted) finishScope('expired'); }, close() { finishScope(state.replyAttempted ? 'uncertain' : 'cancelled'); } };
}
