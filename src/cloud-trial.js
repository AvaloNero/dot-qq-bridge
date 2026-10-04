import { readConfig } from './config.js';
import { createQqClient } from './qq.js';
import { makePublicRequester } from './network.js';
import { gatewayUrl } from './gateway-network.js';
import { PROVIDER_HOSTS } from './provider-network.js';
import { BridgeError } from './common.js';

export function cloudTrialPlan() {
  return { mode: 'QQ_CLOUD_COMPUTER_TRIAL_PLAN', network_started: false, credentials_read: false, credentials_written: false,
    existing_bot_only: true, steps: ['Use an explicitly selected existing official QQ bot',
      'After separate secure credential authorization, check one token exchange and one official Gateway discovery',
      'Report only stage, HTTP status and approved-host/quota booleans; do not IDENTIFY, receive messages or reply',
      'Resolve MCP ingress, owner authentication and pinned callback delivery before current-dot message acceptance'],
    scan_available: true, scan_blocker: 'Official SDK scanner requires specific scan consent and existing bot selection; no real cloud scan has been verified',
    live_gateway_connected: false, current_dot_connected: false,
    maximum_requests: 2, request_timeout_ms: 30000, secret_destination_configured: false };
}

// Deliberately separate provider-only operator diagnosis from live bridge config.
// This does not weaken OAuth/owner/subscription checks on the real message path.
export function readCloudTrialConfig(env = process.env) {
  const config = readConfig({ QQ_APP_ID: env.QQ_APP_ID, QQ_BOT_SECRET: env.QQ_BOT_SECRET,
    QQ_API_PROFILE: env.QQ_API_PROFILE, QQ_GATEWAY_ALLOWED_HOSTS: env.QQ_GATEWAY_ALLOWED_HOSTS });
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(config.qqAppId) || typeof config.qqSecret !== 'string' || config.qqSecret.length < 8 ||
      config.qqSecret.length > 256 || /[\s\x00-\x1f\x7f]/.test(config.qqSecret)) throw new BridgeError('Existing QQ bot credentials are missing or invalid; no values were printed');
  return config;
}

export async function probeExistingQqBot(config, { approved = false, signal, clock = Date.now,
  send = makePublicRequester({ timeoutMs: 30000, providerTimeoutMs: 30000 }) } = {}) {
  if (approved !== true) throw new BridgeError('Separate approval is required for existing QQ bot credential use and two official read-only requests');
  // Revalidate a caller-supplied configuration without touching storage/OAuth.
  const selected = readCloudTrialConfig({ QQ_APP_ID: config.qqAppId, QQ_BOT_SECRET: config.qqSecret,
    QQ_API_PROFILE: config.qqApiProfile, QQ_GATEWAY_ALLOWED_HOSTS: config.gatewayHosts?.join(',') });
  const expires = clock() + 60000;
  let stage = 'not_started', requests = 0, httpStatus = null;
  const authorize = () => { if (signal?.aborted || clock() >= expires) throw new BridgeError('QQ diagnostic cancelled or expired'); };
  const wrappedSend = async (url, options) => {
    authorize(); if (++requests > 2) throw new BridgeError('QQ diagnostic request budget exceeded');
    stage = url.endsWith('/app/getAppAccessToken') ? 'token' : 'gateway_discovery';
    const prior = options.beforeConnect;
    const response = await send(url, { ...options, beforeConnect() { authorize(); prior?.(); } });
    httpStatus = response.status; return response;
  };
  const client = createQqClient(selected, wrappedSend, clock);
  const base = { mode: 'QQ_EXISTING_BOT_READ_ONLY_DIAGNOSTIC', credentials_written: false, live_gateway_connected: false,
    owner_identity_verified: false, current_dot_connected: false, messages_received: 0, messages_sent: 0 };
  try {
    const info = await client.gatewayInfo({ authorize }); authorize();
    // Never return access token, full WSS URL, query, AppID, owner or raw error.
    const { url } = gatewayUrl(info.url, selected.gatewayHosts);
    const allowed = selected.gatewayHosts.includes(url.hostname) && PROVIDER_HOSTS.includes(url.hostname);
    return { ...base, status: allowed ? 'provider_discovery_passed' : 'gateway_host_blocked', requests,
      stage: 'gateway_policy', last_http_status: httpStatus, gateway_host_allowed: allowed,
      gateway_quota_available: info.remaining > 0, next_step: allowed ?
        'Provider discovery succeeded only. Complete current-dot authentication, ingress and callback verification before receiving messages.' :
        'Returned Gateway hostname is not approved by both exact policies. Review the official account configuration; no socket was opened.' };
  } catch {
    return { ...base, status: signal?.aborted || clock() >= expires ? 'cancelled_or_expired' : 'provider_check_failed',
      requests, stage, last_http_status: httpStatus, gateway_host_allowed: false, gateway_quota_available: false,
      next_step: 'Review the selected official bot profile, permissions and IP allowlist using the official console. No automatic retry or alternate endpoint was used.' };
  } finally { client.clearToken(); }
}
