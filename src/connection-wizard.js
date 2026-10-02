import { BridgeError } from './common.js';

export const connectorReview = Object.freeze({ package: '@tencent-connect/qqbot-connector', version: '1.2.0',
  npm_license: 'UNLICENSED', bundled_license_file: false, permitted_use: 'requires_separate_review', installed: false });

function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
// Only validate an operator-provided result. This neither writes configuration nor trusts
// the first speaker. A missing QR owner can be supplied only from independently verified QQ input.
export function inspectQrCredentials(credentials, { appId, confirmedOwnerOpenid, ownerEvidence } = {}) {
  if (!Array.isArray(credentials) || !credentials.length || credentials.length > 10 || credentials.some(item =>
    !item || !identifier(item.appId) || typeof item.appSecret !== 'string' || item.appSecret.length < 8 || item.appSecret.length > 256 ||
    /[\s\x00-\x1f\x7f]/.test(item.appSecret) || (item.userOpenid !== undefined && !identifier(item.userOpenid)))) {
    throw new BridgeError('Invalid credential result; no credential or identity was saved');
  }
  if (new Set(credentials.map(item => item.appId)).size !== credentials.length) throw new BridgeError('Duplicate account results are rejected');
  if ((!appId && credentials.length !== 1) || (appId !== undefined && !identifier(appId))) throw new BridgeError('Explicitly select exactly one bot account');
  const selected = credentials.find(item => item.appId === (appId ?? credentials[0].appId));
  if (!selected) throw new BridgeError('Selected bot account was not returned');
  if (!identifier(confirmedOwnerOpenid)) throw new BridgeError('Explicitly confirm one verified owner openid; missing identity is rejected');
  if (selected.userOpenid !== undefined) {
    if (ownerEvidence !== 'official-qr-response' || confirmedOwnerOpenid !== selected.userOpenid) {
      throw new BridgeError('Confirmed owner does not match the official QR result');
    }
  } else if (ownerEvidence !== 'verified-qq-message') throw new BridgeError('QR returned no owner; independently verified QQ identity evidence is required');
  // An in-memory candidate, never an automatic credential/owner binding.
  return Object.freeze({ appId: selected.appId, appSecret: selected.appSecret, ownerOpenid: confirmedOwnerOpenid });
}
export function redactedConnectionResult(candidate) {
  return { credentials_valid: !!candidate, single_owner_valid: !!candidate, real_scan_started: false,
    credentials_written: false, owner_binding_changed: false, validated_settings: ['QQ_APP_ID', 'QQ_BOT_SECRET', 'QQ_OWNER_OPENID'] };
}
export function connectionPlan() {
  return { mode: 'OFFLINE_CONNECTION_PLAN', real_scan_started: false, credentials_written: false, owner_binding_changed: false,
    official_guide: 'https://bot.q.qq.com/wiki/agent-qqbot/', connector: connectorReview,
    required_authorizations: ['Owner starts the official scan and approves receipt of bot credentials',
      'Explicitly confirm one returned app-specific owner openid, or an independently verified QQ message identity',
      'Configure secrets in the specifically approved cloud runtime', 'Approve tunnel/endpoint access, plugin link, subscriptions and fee limit'],
    alternative: 'After approval, use existing official QQ console credentials and a verified owner openid; no QR package is required for Gateway.',
    next_step: 'Review docs/connection.md. Use --demo for a synthetic interface exercise or --inspect FILE for an already authorized local result. --scan is disabled pending connector licensing review.' };
}

// Prepared against the public startQrConnect callback contract. No connector package is
// imported, installed or implemented here; the actual adapter requires a reviewed use grant.
export function runQrWizard(startQrConnect, { scanAuthorized = false, licenseReviewReference = '', selection,
  displayQr, signal, timeoutMs = 120000 } = {}) {
  if (!scanAuthorized || typeof licenseReviewReference !== 'string' || !licenseReviewReference.trim()) {
    return Promise.reject(new BridgeError('Official scan authorization and a reviewed connector use grant are required'));
  }
  if (typeof startQrConnect !== 'function' || typeof displayQr !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    return Promise.reject(new BridgeError('Invalid authorized QR adapter configuration'));
  }
  return new Promise((resolve, reject) => {
    let stop, finished = false;
    const finish = (error, candidate) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      try { stop?.(); } catch { /* no credential log */ }
      if (error) reject(error); else resolve(candidate);
    };
    const aborted = () => finish(new BridgeError('QR connection cancelled; no credential or identity was saved'));
    const timer = setTimeout(() => finish(new BridgeError('QR connection timed out; no credential or identity was saved')), timeoutMs);
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      stop = startQrConnect({
        onQrDisplayed(raw) {
          if (finished) return;
          try {
            const url = new URL(raw);
            if (url.protocol !== 'https:' || url.hostname !== 'q.qq.com' || url.username || url.password || url.hash || url.port) throw new Error('untrusted QR');
            displayQr(url.href); // authorized local UI only; no log/chat forwarding in this module.
          } catch { finish(new BridgeError('QR display failed or URL was not an official HTTPS QQ destination')); }
        },
        onQrExpired() { /* SDK manages refresh; the wizard retains its fixed overall deadline. */ },
        onSuccess(credentials) {
          // Check the returned disposer before accepting even a synchronous callback.
          queueMicrotask(() => {
            if (finished) return;
            try { finish(null, inspectQrCredentials(credentials, selection)); }
            catch (error) { finish(error instanceof BridgeError ? error : new BridgeError('Invalid QR result')); }
          });
        },
        onFailure() { finish(new BridgeError('Official QR connection failed; no credential or identity was saved')); }
      }, { displayQrCodeToConsole: false, source: '', signal });
      if (typeof stop !== 'function') throw new Error('adapter contract');
      if (finished) stop(); // Covers synchronous callback completion before stop was assigned.
    } catch { finish(new BridgeError('QR adapter failed; no credential or identity was saved')); }
  });
}
