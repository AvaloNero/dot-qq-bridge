import { callbackTransportStatusSchema, projectCallbackTransportStatus, TRANSPORT_ERROR_CODES } from '../packages/dot-bridge-transport/index.js';
import { BridgeError } from './common.js';

export { callbackTransportStatusSchema };
const reasons = new Set(TRANSPORT_ERROR_CODES);
export const unverifiedCallbackTransport = Object.freeze({ ready: false, mode: 'blocked', reason: 'transport_unverified',
  proxy_configured: null, destination_binding: 'unverified', network_checked: false });
export function callbackTransportStatus(send) {
  try { return projectCallbackTransportStatus(send?.callbackPreflight?.()); }
  catch { return unverifiedCallbackTransport; }
}
export function callbackTransportFailure(error, send) {
  // Only fixed shared transport codes survive. No raw message, cause or data.
  const reason = reasons.has(error?.code) ? error.code : reasons.has(error?.data?.reason) ? error.data.reason :
    error?.code === 'transport_unverified' ? 'adapter_invalid' : 'connection_failed';
  return new BridgeError('Callback transport failed', { code: -32015,
    data: { reason, callback_transport: callbackTransportStatus(send) },
    retryable: ['dns_failed', 'timeout', 'connection_failed', 'adapter_failed'].includes(reason) });
}
