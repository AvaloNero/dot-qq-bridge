import { readConfig } from './config.js';
import { createApp } from './server.js';
import { acquireModeLock, bridgeMode } from './bridge-mode.js';
import { createSitesApp } from './sites-runtime.js';
import { QqGateway } from './gateway.js';
import { assertApprovedTunnelLive, validateTunnelServiceOperation } from './tunnel-service-operation.js';
import { preflightCallbackTransport } from '../packages/dot-bridge-transport/index.js';
import { callbackTransportStatus } from './callback-transport.js';

const REQUIRED = ['QQ_APP_ID', 'QQ_BOT_SECRET', 'QQ_OWNER_OPENID', 'MCP_OWNER_SUBJECT', 'STORAGE_KEY',
  'PUBLIC_ORIGIN', 'OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'OAUTH_AUDIENCE', 'DATABASE_PATH'];
export function servicePreflight(env) {
  let selected; try { selected = bridgeMode(env); } catch { selected = 'invalid'; }
  const tunnelLive = selected === 'tunnel' && env.AUTH_MODE === 'tunnel-service';
  const required = tunnelLive ? ['QQ_APP_ID','QQ_CREDENTIALS_FILE','QQ_API_PROFILE','STORAGE_KEY_FILE','DATABASE_PATH','BRIDGE_LOCK_DIRECTORY','TUNNEL_SERVICE_KEY_FILE','TUNNEL_SERVICE_OWNER_ID','TUNNEL_SERVICE_OPERATION'] : selected === 'sites' ? ['QQ_APP_ID','QQ_BOT_SECRET','QQ_OWNER_OPENID','MCP_OWNER_SUBJECT','STORAGE_KEY','DATABASE_PATH','BRIDGE_LOCK_DIRECTORY','SITES_ORIGIN','SITES_BINDING_ID','SITES_SERVICE_CREDENTIAL','SITES_CONNECTOR_CREDENTIAL'] : [...REQUIRED, 'BRIDGE_LOCK_DIRECTORY'];
  const missing = required.filter(key => typeof env[key] !== 'string' || !env[key].trim());
  const invalid = [];
  if (selected === 'invalid') invalid.push('BRIDGE_MODE');
  if (!tunnelLive && env.AUTH_MODE !== (selected === 'sites' ? 'sites' : 'oauth')) invalid.push('AUTH_MODE');
  if (tunnelLive && env.TUNNEL_SERVICE_OPERATION !== 'live') invalid.push('TUNNEL_SERVICE_OPERATION');
  if (env.QQ_TRANSPORT !== 'gateway') invalid.push('QQ_TRANSPORT');
  if (env.DATABASE_PATH === ':memory:') invalid.push('DATABASE_PATH');
  let config;
  if (!missing.length && !invalid.length) {
    try { config = readConfig(env); } catch { invalid.push('CONFIGURATION'); }
    if (config && (Buffer.from(config.storageKey, 'base64').length !== 32 || Buffer.from(config.storageKey, 'base64').toString('base64') !== config.storageKey)) invalid.push('STORAGE_KEY');
  }
  return { ready_to_start: !missing.length && !invalid.length, missing_settings: missing, invalid_settings: invalid,
    callback_transport: preflightCallbackTransport({ proxyEnv: env }),
    callback_allowlist_configured: !!config?.callbackHosts.length, network_checked: false, current_dot_connected: false };
}
export function serviceSnapshot(app, gateway, clock = Date.now) {
  const subscription = !!app.bridge.store.activeSubscription(clock());
  const configured = app.bridge.ready();
  const gatewayState = gateway.status();
  const connected = gatewayState.connected === true;
  const phases = ['stopped', 'waiting_subscription', 'waiting_lease', 'discovering', 'connecting', 'waiting_hello', 'authenticating',
    'connected', 'retrying', 'quota_exhausted', 'blocked_configuration', 'blocked_account_or_protocol', 'retry_limit',
    'acceptance_failed', 'connection_closed', 'connection_error', 'handshake_timeout', 'heartbeat_timeout', 'inbound_rate_limited',
    'invalid_session', 'send_failed', 'server_reconnect'];
  const phase = phases.includes(gatewayState.phase) ? gatewayState.phase : 'unknown';
  const pendingCallback = app.bridge.config?.authMode === 'tunnel-service' && app.bridge.config.tunnelServiceOperation === 'live' && !app.bridge.config.callbackHosts.length;
  const callbackTransport = callbackTransportStatus({ callbackPreflight: () => app.bridge.callbackTransport?.() });
  const pendingTransport = app.bridge.config?.authMode === 'tunnel-service' && app.bridge.config.tunnelServiceOperation === 'live' && !callbackTransport.ready;
  return { event: 'service_status', stage: pendingCallback ? 'pending_callback_policy' : pendingTransport ? 'pending_callback_transport' : !configured ? 'waiting_configuration' : !subscription ? 'waiting_dot_subscription' :
    ['blocked_configuration', 'blocked_account_or_protocol', 'retry_limit'].includes(phase) ? 'gateway_blocked' : connected ? 'gateway_connected' : 'waiting_gateway', authenticated_subscription_active: subscription,
    gateway_phase: phase, gateway_connected: connected, ready_for_owner_message: configured && subscription && connected,
    callback_transport: callbackTransport, current_dot_roundtrip_verified: false };
}
// Runtime only: revalidates approved file references, never provisions credentials,
// performs onboarding, creates OAuth grants or fabricates subscriptions.
// Operator/supervisor supplies explicitly authorized configuration and owns log retention/restart.
export async function startPersistentService(config, { appFactory = config.bridgeMode === 'sites' ? createSitesApp : createApp, gatewayFactory = (bridge, options) => new QqGateway(bridge, options),
  report = () => {}, clock = Date.now, repeat = setInterval, cancel = clearInterval, signal,
  onClosed = () => {}, onStopFailure = () => {}, approvedLive = false } = {}) {
  if (signal?.aborted) throw new Error('Persistent service startup cancelled');
  assertApprovedTunnelLive(config, approvedLive);
  validateTunnelServiceOperation(config);
  const emit = event => { try { report({ timestamp: new Date(clock()).toISOString(), ...event }); } catch { /* logging must not control acceptance */ } };
  let app, gateway, timer, previous, stopPromise, lastReport = 0, stopped = false;
  let settleStartup, startupFinished = false;
  const startupSettled = new Promise(resolve => { settleStartup = resolve; });
  const finishStartup = () => { startupFinished = true; settleStartup(); };
  const snapshot = () => serviceSnapshot(app, gateway, clock);
  const tick = () => {
    try { const state = snapshot(), key = JSON.stringify(state);
      if (key !== previous || clock() - lastReport >= 60000) { emit(state); previous = key; lastReport = clock(); }
    } catch { emit({ event: 'service_status', stage: 'status_unavailable', current_dot_roundtrip_verified: false }); }
  };
  const close = () => {
    if (stopPromise) return stopPromise;
    stopped = true; cancel(timer); signal?.removeEventListener('abort', onAbort);
    const closedAfterStartup = startupFinished;
    stopPromise = (async () => {
      emit({ event: 'service_lifecycle', stage: 'stopping' });
      try {
        await app?.close();
        // An in-flight listen/start must settle before another consumer can
        // acquire the lock, even when close itself returns early.
        await startupSettled;
        // Release authority is independent of best-effort logging. A failed
        // constructor is not evidence that its resources are closed.
        // A listen/start completion could create resources after an early close.
        // Keep the lock conservatively when shutdown raced startup.
        if (app && !closedAfterStartup) throw new Error('Startup shutdown requires operator recovery');
        if (app) await onClosed();
        emit({ event: 'service_lifecycle', stage: 'stopped' });
      } catch {
        emit({ event: 'service_lifecycle', stage: 'stop_failed' });
        try { onStopFailure(); } catch { /* preserve safe error */ }
        throw new Error('Service stop failed');
      }
    })();
    return stopPromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    app = appFactory(config, { approvedLive });
    gateway = gatewayFactory(app.bridge, { report: () => { if (!stopped) tick(); } });
    app.attachGateway(gateway); await app.listen();
    if (stopped || signal?.aborted) throw new Error();
    emit({ event: 'service_lifecycle', stage: config.bridgeMode === 'sites' ? 'sites_worker_started' : 'mcp_listening', public_reachability_verified: false });
    await gateway.start();
    if (stopped || signal?.aborted) throw new Error();
    finishStartup();
    tick(); timer = repeat(tick, 5000);
    return { close, snapshot };
  } catch { finishStartup(); await close().catch(() => {}); throw new Error('Persistent service startup failed'); }
}

// All executable entrypoints use this wrapper. Retain the lock unless consumer
// close positively completes; crashes require explicit operator recovery.
export async function startLockedPersistentService(config, { lockDirectory, lockFactory = acquireModeLock, ...options } = {}) {
  if (options.signal?.aborted) throw new Error('Persistent service startup cancelled');
  assertApprovedTunnelLive(config, options.approvedLive);
  validateTunnelServiceOperation(config);
  let release;
  if (config.authMode === 'tunnel-service' && lockDirectory !== config.bridgeLockDirectory) throw new Error('Persistent service mode-lock scope differs');
  try { release = lockFactory(lockDirectory, 'qq', config.qqAppId, config.bridgeMode); }
  catch { throw new Error('Persistent service mode lock unavailable'); }
  return startPersistentService(config, { ...options, onClosed: async () => { await release(); } });
}
