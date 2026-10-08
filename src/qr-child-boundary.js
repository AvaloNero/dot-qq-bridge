import { QR_PARENT_MAX_MS, QR_REQUEST_BUDGET } from './qr-limits.js';
import { officialQrUrl } from './official-qr.js';
export function qrChildEnvironment(env) {
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key)));
}
export function superviseQrChild(child, { output, failed = () => {}, signal, timeoutMs = QR_PARENT_MAX_MS, allowCredentialsWritten = false } = {}) {
  let terminal = false;
  const finish = () => { terminal = true; clearTimeout(timer); signal?.removeEventListener('abort', failure); child.kill(); };
  const failure = () => { if (terminal) return; output({ status: 'scanner_process_failed' }); failed(); finish(); };
  const timer = setTimeout(() => { if (terminal) return; output({ status: 'scan_deadline_reached' }); failed(); finish(); }, timeoutMs);
  signal?.addEventListener('abort', failure, { once: true });
  child.on('message', event => {
    if (terminal) return;
    if (event?.type === 'transport') {
      const safe = sanitizeQrDiagnostic(event);
      if (safe) output(safe); else failure();
    } else if (event?.type === 'qr') {
      try { output({ type: 'qr', url: officialQrUrl(event.url) }); } catch { failure(); }
    } else if (event?.type === 'result') {
      const safe = { status: event.status === 'official_scan_validated' ? 'official_scan_validated' : 'scan_failed_or_scope_rejected',
        credentials_written: allowCredentialsWritten === true && event.credentials_written === true, current_dot_connected: false, owner_identity_verified: event.owner_identity_verified === true };
      if (event.diagnostic) safe.provider_discovery_passed = event.diagnostic.status === 'provider_discovery_passed';
      output(safe); if (safe.status !== 'official_scan_validated') failed(); finish();
    } else failure();
  });
  child.on('error', failure); child.on('exit', failure); child.on('disconnect', failure);
  if (signal?.aborted) failure();
  return failure;
}

export function sanitizeQrDiagnostic(event) {
  if (!['create', 'poll'].includes(event?.stage) || event.method !== 'POST' ||
      !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > QR_REQUEST_BUDGET ||
      !['start', 'response', 'error', 'timeout'].includes(event.phase) ||
      !Number.isInteger(event.elapsed_ms) || event.elapsed_ms < 0 || event.elapsed_ms > QR_PARENT_MAX_MS ||
      !(event.status === null || (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599)) ||
      ![null, 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
        'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_NETWORK_ACCESS_DENIED', 'OTHER'].includes(event.code)) return null;
  return { type: 'transport', stage: event.stage, method: 'POST', sequence: event.sequence,
    phase: event.phase, status: event.status, elapsed_ms: event.elapsed_ms, code: event.code };
}
