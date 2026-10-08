import { QR_LOCAL_WAIT_MS, QR_PARENT_MAX_MS, QR_REQUEST_BUDGET, QR_REQUEST_TIMEOUT_MS } from './qr-limits.js';
import https from 'node:https';
import { BridgeError } from './common.js';
import { createProviderProxyAgent } from './provider-network.js';
import { inspectQrCredentials } from './connection-wizard.js';

export const QR_REVIEW = 'Official npm 1.2.0 README public startQrConnect integration; no SDK redistribution or reimplementation';
export function officialQrUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'q.qq.com' || url.port || url.username || url.password || url.hash ||
      url.pathname !== '/qqbot/openclaw/connect.html' || !/^[a-zA-Z0-9_-]{1,256}$/.test(url.searchParams.get('task_id') ?? '') ||
      [...url.searchParams.keys()].some(key => !['task_id', 'source', '_wv'].includes(key)) ||
      url.searchParams.get('source') !== '' || url.searchParams.get('_wv') !== '2' ||
      [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)) throw new BridgeError('Official QR URL rejected');
  return url.href;
}

// Use ONLY inside the isolated scanner child. Never change the bridge's agent,
// callback DNS pinning, or OAuth transport. The SDK's public API has no agent option.
export function installQrTransport({ env = process.env, target = https, factory = createProviderProxyAgent, diagnostic = () => {}, signal } = {}) {
  const agent = factory({ env, allowedHost: host => host === 'q.qq.com' });
  if (!agent) throw new BridgeError('The official scanner requires the configured cloud proxy');
  const add = agent.addRequest.bind(agent); let requests = 0; const pendingCleanups = new Set();
  agent.addRequest = (req, options) => {
    if (++requests > QR_REQUEST_BUDGET || options.method !== 'POST' || !['/lite/create_bind_task', '/lite/poll_bind_result'].includes(options.path)) {
      throw new BridgeError('QR request is outside the approved scope');
    }
    if (signal?.aborted) throw new BridgeError('Official scanner cancelled');
    // Total outer request bound; SDK and proxy timeouts may expire earlier.
    // Do not claim Agent options override ClientRequest's existing timeout.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('QQ request timed out'), { code: 'ETIMEDOUT' })), QR_REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    const abort = () => req.destroy(Object.assign(new Error('QQ request cancelled'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      clearTimeout(deadline); pendingCleanups.delete(cleanup);
      signal?.removeEventListener('abort', abort); req.removeListener('close', cleanup);
    };
    pendingCleanups.add(cleanup); req.once('close', cleanup);
    const sequence = requests, started = Date.now();
    const stage = options.path === '/lite/create_bind_task' ? 'create' : 'poll';
    const report = (phase, status = null, code = null) => diagnostic({ type: 'transport', stage, method: 'POST',
      sequence, phase, status, elapsed_ms: Math.min(QR_PARENT_MAX_MS, Math.max(0, Date.now() - started)), code });
    report('start');
    req.once('error', error => report('error', null, ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH',
      'EAI_AGAIN', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_NETWORK_ACCESS_DENIED'].includes(error?.code) ? error.code : 'OTHER'));
    req.once('timeout', () => report('timeout', null, 'ETIMEDOUT'));
    req.once('response', res => report('response', Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : null));
    // The SDK does not follow redirects. Bound its otherwise unbounded response.
    req.once('response', res => { let bytes = 0; res.on('data', chunk => {
      bytes += chunk.length; if (bytes > 262144) { res.destroy(); req.destroy(); }
    }); });
    try { return add(req, options); }
    catch (error) { cleanup(); throw error; }
  };
  const previous = target.globalAgent; target.globalAgent = agent;
  return () => { target.globalAgent = previous; for (const cleanup of pendingCleanups) cleanup(); agent.destroy(); };
}

export function scanOfficialBot(startQrConnect, { approved = false, expectedAppId, scannerIsOwner = false,
  displayQr, signal, timeoutMs = QR_LOCAL_WAIT_MS } = {}) {
  if (approved !== true || scannerIsOwner !== true || !/^[a-zA-Z0-9_-]{1,128}$/.test(expectedAppId ?? '') ||
      typeof displayQr !== 'function' || typeof startQrConnect !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QR_LOCAL_WAIT_MS) {
    return Promise.reject(new BridgeError('Explicit scan consent, existing bot AppID and scanner-owner confirmation are required'));
  }
  return new Promise((resolve, reject) => {
    let stop, done = false;
    const deadlineEpochMs = Date.now() + timeoutMs;
    const controller = new AbortController();
    const finish = (error, candidate) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      controller.abort(); try { stop?.(); } catch { /* never emit SDK errors */ }
      error ? reject(new BridgeError(error)) : resolve(candidate);
    };
    const cancel = () => finish('Official scan cancelled');
    const timer = setTimeout(() => finish('Official scan expired'), timeoutMs);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      stop = startQrConnect({
        onQrDisplayed(raw) { if (!done) { try { displayQr(officialQrUrl(raw)); } catch { finish('Official QR display rejected'); } } },
        onQrExpired() { finish('Official QR expired; explicit restart required'); },
        onFailure() { finish('Official scan failed'); },
        onSuccess(credentials) {
          queueMicrotask(() => {
            if (done) return;
            if (Date.now() >= deadlineEpochMs) { finish('Official scan expired'); return; }
            try {
              if (!Array.isArray(credentials) || credentials.length !== 1 || credentials[0]?.appId !== expectedAppId) throw new Error();
              const candidate = inspectQrCredentials(credentials, { appId: expectedAppId,
                confirmedOwnerOpenid: credentials[0].userOpenid, ownerEvidence: 'official-qr-response' });
              finish(null, candidate);
            } catch { finish('Returned bot or scanner-owner identity did not match the approved scope'); }
          });
        }
      }, { displayQrCodeToConsole: false, source: '', signal: controller.signal });
      if (typeof stop !== 'function') throw new Error();
      if (done) stop();
    } catch { finish('Official scanner could not start'); }
  });
}
