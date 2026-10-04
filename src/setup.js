import { callbackUrl } from './network.js';
import { callbackTransportStatusSchema, unverifiedCallbackTransport } from './callback-transport.js';
import { projectCallbackTransportStatus } from '../packages/dot-bridge-transport/index.js';

const bindings = { qqAppId: 'QQ_APP_ID', qqSecret: 'QQ_BOT_SECRET', ownerOpenid: 'QQ_OWNER_OPENID', principal: 'MCP_OWNER_SUBJECT' };
export function ownerConfigured(config) {
  return !config.tunnelServiceReadinessOnly && config.authMode !== 'deny' && Object.keys(bindings).every(key => !!config[key]);
}
export function checkSetup(config, url, transport = unverifiedCallbackTransport) {
  let callbackTransport;
  try { callbackTransport = projectCallbackTransportStatus(transport); } catch { callbackTransport = unverifiedCallbackTransport; }
  const missing = Object.entries(bindings).filter(([key]) => !config[key]).map(([, setting]) => setting);
  if (config.authMode === 'deny') missing.push('AUTH_MODE');
  if (!config.callbackHosts.length) missing.push('MCP_CALLBACK_ALLOWED_HOSTS');
  let hostname = null, policy = 'not_provided';
  if (url !== undefined) {
    try { hostname = callbackUrl(url).hostname; policy = config.callbackHosts.includes(hostname) ? 'allowlisted' : 'blocked'; }
    catch { policy = 'invalid_url'; }
  }
  const nextStep = policy === 'invalid_url' ? 'Use HTTPS port 443 with a DNS hostname; remove credentials, IP literals and fragments.' :
    policy === 'blocked' ? 'Independently verify this hostname belongs to the official ChatGPT event callback. Only then add the exact hostname to MCP_CALLBACK_ALLOWED_HOSTS, restart, refresh metadata and retry. No host was trusted or contacted.' :
    missing.length ? `Complete ${missing.join(', ')}. With the owner bound, a subscription attempt returns only its blocked hostname for manual review. No host is automatically approved.` :
    !callbackTransport.ready ? 'Callback transport is unavailable or unverified. Review its fixed status and use a supported adapter; no DNS or request was attempted by this diagnostic.' :
    'Configuration is present. Actual DNS, TLS and signed challenge checks still run during subscription; this diagnostic proves no connectivity.';
  return { configuration_ready: ownerConfigured(config) && !!config.callbackHosts.length && callbackTransport.ready, events_discoverable: ownerConfigured(config),
    missing_settings: missing, callback_hostname: hostname, callback_policy: policy, qq_api_profile: config.qqApiProfile,
    callback_transport: callbackTransport, network_checked: false, next_step: nextStep };
}
export const setupTool = {
  name: 'check_bridge_setup', title: 'Check bridge setup and callback hostname',
  description: 'Authenticated owner-only local preflight. Reports missing setting names and optionally the callback hostname, never its path, query, credentials or secret. No network request, DNS check, host approval or configuration change. Use when an event is hidden or subscription is rejected; manually review a hostname before allowlisting it.',
  inputSchema: { type: 'object', properties: { callback_url: { type: 'string', minLength: 1, maxLength: 2048 } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { configuration_ready: { type: 'boolean' }, events_discoverable: { type: 'boolean' },
    missing_settings: { type: 'array', items: { type: 'string' } }, callback_hostname: { type: ['string', 'null'] },
    callback_policy: { type: 'string', enum: ['not_provided', 'invalid_url', 'blocked', 'allowlisted'] },
    callback_transport: callbackTransportStatusSchema,
    qq_api_profile: { type: 'string', enum: ['documented', 'tencent-sdk', 'tencent-sandbox'] }, network_checked: { type: 'boolean', const: false }, next_step: { type: 'string' } },
    required: ['configuration_ready', 'events_discoverable', 'missing_settings', 'callback_hostname', 'callback_policy', 'callback_transport', 'qq_api_profile', 'network_checked', 'next_step'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};
