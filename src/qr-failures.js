import { BridgeError } from './common.js';

// Only classifications attached by this integration may leave the scanner.
// Never infer a reason from an SDK message, response body, identity or elapsed time.
const reasons = new Set([
  'invalid_configuration', 'local_deadline_reached', 'cancelled',
  'official_qr_expired', 'sdk_reported_failure', 'qr_display_rejected',
  'result_count_rejected', 'expected_app_mismatch', 'owner_identity_missing',
  'owner_identity_invalid', 'credential_result_invalid', 'sdk_start_failed',
  'setup_failed', 'credential_save_failed', 'provider_probe_failed', 'unknown_failure',
]);
const classifications = new WeakMap();

export function sanitizeQrFailureReason(value) {
  return typeof value === 'string' && reasons.has(value) ? value : 'unknown_failure';
}

export function qrFailure(message, reason) {
  const error = new BridgeError(message);
  classifications.set(error, sanitizeQrFailureReason(reason));
  return error;
}

export function qrFailureReason(error, fallback = 'unknown_failure') {
  return classifications.get(error) ?? sanitizeQrFailureReason(fallback);
}
