import fs from 'node:fs';
import { createApp } from './server.js';
import { makePublicRequester, callbackUrl } from './network.js';
import { startLockedPersistentService } from './service-runtime.js';
import { installQqOwnerMessagePolicy } from './owner-message-policy.js';
import { webhookKey } from './signatures.js';
import { equal, object } from './common.js';
import { makeOwnerMessageExperimentTransport } from '../packages/dot-bridge-transport/experimental/owner-message.js';

// Explicit opt-in only. No credential provisioning, environment module selector,
// self-imposed owner-wait deadline, or change to the ordinary service entrypoint.
export async function startQqOwnerMessage(config, { approvedSingleMessage = false, acceptAnyOwnerText = false,
  waitForOwner = false, fixedReply, proxyEnv = process.env, report = () => {}, signal,
  startService = startLockedPersistentService, callbackFactory = makeOwnerMessageExperimentTransport } = {}) {
  if (approvedSingleMessage !== true || acceptAnyOwnerText !== true || waitForOwner !== true ||
      config?.bridgeMode !== 'tunnel' || config.authMode !== 'tunnel-service' || config.tunnelServiceOperation !== 'live' ||
      config.qqTransport !== 'gateway' || config.qqApiProfile !== 'tencent-sdk' ||
      typeof fixedReply !== 'string' || !fixedReply.trim() || fixedReply.length > 2000 || signal?.aborted ||
      typeof startService !== 'function' || typeof callbackFactory !== 'function') throw new Error('Explicit QQ owner-message approval required');
  if (typeof config.dbPath !== 'string') throw new Error('Dedicated QQ test database required');
  const existingDatabase = fs.existsSync(config.dbPath);
  config = { ...config, callbackHosts: [...config.callbackHosts], maxAttempts: 1 };
  const callback = callbackFactory({ approvedOwnerMessageExperiment: true, channel: 'qq',
    acceptAnyOwnerText: true, waitForOwner: true, proxyEnv });
  const send = makePublicRequester({ callbackTransport: callback, proxyEnv });
  const controller = new AbortController();
  let runtime, pendingApp, policy, timer, closing, resolveClosed, rejectClosed, finishStartup, startupFailed = false, lastGateway = { gateway_connected: false, gateway_phase: 'stopped' };
  const startupSettled = new Promise(resolve => { finishStartup = resolve; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); closed.catch(() => {});
  const emit = event => { try { report(event); } catch { /* diagnostics do not grant authority */ } };
  const status = () => {
    const policyStatus = policy?.status() ?? { phase: 'starting' };
    return { ...lastGateway, gateway_ready: policyStatus.closed !== true && lastGateway.gateway_connected === true && lastGateway.gateway_phase === 'connected',
      ready_for_owner_message: policyStatus.closed !== true && lastGateway.ready_for_owner_message === true,
      ...policyStatus, provider_channel: 'qq', persistent_business_activation: false };
  };
  const close = () => {
    if (!closing) closing = (async () => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      policy?.close(); callback.close(); controller.abort();
      try { await startupSettled; if (startupFailed) throw new Error('Startup cleanup unconfirmed'); await runtime?.close(); lastGateway = { gateway_connected: false, gateway_phase: 'stopped',
        authenticated_subscription_active: false, ready_for_owner_message: false }; resolveClosed({ closed: true }); }
      catch { rejectClosed(new Error('QQ one-message cleanup not confirmed')); throw new Error('QQ one-message cleanup not confirmed'); }
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    runtime = await startService(config, { approvedLive: true, send, lockDirectory: config.bridgeLockDirectory, signal: controller.signal,
      report(event) {
        if (event.event === 'service_status') lastGateway = { gateway_connected: event.gateway_connected === true, gateway_phase: event.gateway_phase,
          authenticated_subscription_active: event.authenticated_subscription_active === true, ready_for_owner_message: event.ready_for_owner_message === true };
        emit(event);
      },
      appFactory(settings, options) {
        const app = createApp(settings, options); pendingApp = app;
        const bridge = app.bridge, subscribe = bridge.subscribe.bind(bridge);
        let bound, verified = false;
        policy = installQqOwnerMessagePolicy(bridge, { fixedReply, existingDatabase,
          onSelected({ expires }) { clearTimeout(timer); timer = setTimeout(() => policy.expire(), Math.max(1, expires - Date.now())); },
          onTerminal() { emit({ event: 'qq_owner_test_terminal', ...status() }); setImmediate(() => close().catch(() => {})); } });
        bridge.subscribe = async (params, principal) => {
          object(params, ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', '_meta'], ['name', 'arguments', 'delivery']);
          object(params.arguments, ['conversation'], ['conversation']); object(params.delivery, ['mode', 'url', 'secret'], ['mode', 'url', 'secret']);
          if (principal?.id !== config.principal || !Number.isFinite(principal.validUntil) || principal.validUntil <= Date.now() ||
              params.name !== 'qq.message.created' || params.arguments.conversation !== 'owner' || params.delivery.mode !== 'webhook' ||
              (params.cursor !== undefined && params.cursor !== null) || policy.selected()) throw new Error('Authenticated owner subscription required');
          if (params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) throw new Error('Invalid subscription lifetime');
          const url = callbackUrl(params.delivery.url); webhookKey(params.delivery.secret);
          if (bound && bound !== url.href) throw new Error('Owner callback is already bound');
          if (!bound && settings.callbackHosts.length && !settings.callbackHosts.includes(url.hostname)) throw new Error('Callback differs from approved scope');
          const expiry = Math.min(principal.validUntil, Date.now() + Math.min(params.ttlMs ?? config.subscriptionTtlMs, config.subscriptionTtlMs));
          const id = bridge.subscriptionId(principal.id, url.href, params.name, params.arguments);
          const existing = bridge.store.subscription(id);
          if (verified && (!existing || !equal(existing.secret, params.delivery.secret))) throw new Error('Single-message callback grant cannot rotate');
          callback.renewLease(expiry); bound ??= url.href;
          if (!settings.callbackHosts.length) settings.callbackHosts.push(url.hostname);
          // Authenticated same-grant renewal retains its original verified challenge.
          // It cannot change URL/secret, reset the event budget or extend a received reply window.
          if (verified) bridge.store.run('UPDATE subscriptions SET verified_until=? WHERE id=?', expiry, id);
          const result = await subscribe(params, { ...principal, validUntil: expiry }); verified = true; return result;
        };
        return app;
      } });
    finishStartup();
    if (controller.signal.aborted) { await close(); throw new Error('QQ owner-message startup cancelled'); }
    return { status, close, closed };
  } catch { startupFailed = true; finishStartup(); callback.close(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await pendingApp?.close().catch(() => {});
    rejectClosed(new Error('QQ owner-message service did not start')); throw new Error('QQ owner-message service did not start'); }
}
