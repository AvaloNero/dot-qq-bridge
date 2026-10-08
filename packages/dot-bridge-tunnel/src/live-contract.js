// Closed protocol projection, not a reverse proxy. No provider identity is an input.
import { isIP } from 'node:net';
import { BridgeError, object } from './common.js';
import { projectCallbackTransportStatus, TRANSPORT_ERROR_CODES } from '../../dot-bridge-transport/index.js';
export const CHANNELS = Object.freeze(['qq', 'lark']);
export const MAX_LEASE_MS = 604800000;
const statuses = new Set(['none','pending','processing','sent','expired','dead','cancelled','uncertain']);
const transportReasons = new Set([...TRANSPORT_ERROR_CODES, 'transport_unverified']);
const settings = ['QQ_APP_ID','QQ_BOT_SECRET','QQ_OWNER_OPENID','MCP_OWNER_SUBJECT','AUTH_MODE','MCP_CALLBACK_ALLOWED_HOSTS'];
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const unavailable = () => new BridgeError('Local bridge request unavailable or incompatible', { status: 502, code: -32030 });
export const forbidden = () => new BridgeError('Operation is not enabled for this channel', { status: 403, code: -32012 });
export function enabled(config, channel) { return config.operation === 'live' && config.liveChannels.includes(channel); }
export function boundedString(value, max, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || Buffer.byteLength(value) > max * 4 ||
      /\p{Surrogate}/u.test(value) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) throw new BridgeError('Invalid bounded string');
  return value;
}
export function validHostname(value) {
  return typeof value === 'string' && value.length <= 253 && !isIP(value) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
export function callbackUrl(value) {
  boundedString(value, 2048);
  let url; try { url = new URL(value); } catch { throw new BridgeError('Invalid callback URL'); }
  if (value !== value.trim() || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !validHostname(url.hostname)) throw new BridgeError('Invalid callback URL');
  return url;
}
function signingSecret(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BridgeError('Invalid webhook signing secret');
  const encoded = value.slice(6), bytes = Buffer.from(encoded, 'base64');
  try { if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new BridgeError('Invalid webhook signing secret'); }
  finally { bytes.fill(0); }
}
const toolChannels = Object.freeze({check_bridge_setup:'qq',get_qq_message:'qq',reply_to_qq:'qq',check_lark_readiness:'lark',get_lark_message:'lark',reply_to_lark:'lark'});
const eventChannels = Object.freeze({'qq.message.created':'qq','lark.message.created':'lark'});
export function validateToolCall(config, params) {
  object(params,['name','arguments','_meta'],['name','arguments']);
  if(typeof params.name !== 'string')throw forbidden();
  const channel = Object.hasOwn(toolChannels,params.name) ? toolChannels[params.name] : undefined;
  if (!channel) throw forbidden();
  const live = enabled(config,channel), args = params.arguments;
  if (params.name === 'check_lark_readiness') {
    object(args,live ? ['callback_url'] : []);if(args.callback_url !== undefined)callbackUrl(args.callback_url);
    return {channel,name:params.name,arguments:args.callback_url === undefined ? {} : {callback_url:args.callback_url}};
  }
  if (params.name === 'check_bridge_setup') {
    object(args,live ? ['callback_url'] : []);
    if (args.callback_url !== undefined) callbackUrl(args.callback_url);
    return {channel,name:params.name,arguments:args.callback_url === undefined ? {} : {callback_url:args.callback_url}};
  }
  if (!live) throw forbidden();
  const reply = params.name.startsWith('reply_to_');
  object(args,reply ? ['message_id','text'] : ['message_id'],reply ? ['message_id','text'] : ['message_id']);
  boundedString(args.message_id,256);
  if (reply) { boundedString(args.text,2000,{multiline:true}); if (!args.text.trim()) throw new BridgeError('Invalid reply text'); }
  return {channel,name:params.name,arguments:reply ? {message_id:args.message_id,text:args.text} : {message_id:args.message_id}};
}
export function validateEventCall(config, method, params) {
  if(config.operation !== 'live')throw forbidden();
  if (!['events/subscribe','events/unsubscribe'].includes(method)) throw forbidden();
  object(params,method === 'events/subscribe' ? ['name','arguments','delivery','cursor','ttlMs','_meta'] : ['name','arguments','delivery','_meta'],['name','arguments','delivery']);
  if(typeof params.name !== 'string')throw forbidden();
  const channel = Object.hasOwn(eventChannels,params.name) ? eventChannels[params.name] : undefined;
  if (!channel || !enabled(config,channel)) throw forbidden();
  object(params.arguments,['conversation'],['conversation']);
  if (params.arguments.conversation !== 'owner') throw forbidden();
  const subscribe = method === 'events/subscribe';
  object(params.delivery,subscribe ? ['mode','url','secret'] : ['mode','url'],subscribe ? ['mode','url','secret'] : ['mode','url']);
  if (params.delivery.mode !== 'webhook') throw new BridgeError('Only webhook delivery is supported');
  callbackUrl(params.delivery.url);
  if (subscribe) {
    signingSecret(params.delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null) throw new BridgeError('Replay cursors are unsupported');
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0 || params.ttlMs > MAX_LEASE_MS)) throw new BridgeError('Invalid bounded ttlMs');
  }
  return {channel,params:{name:params.name,arguments:{conversation:'owner'},delivery:{mode:'webhook',url:params.delivery.url,...(subscribe ? {secret:params.delivery.secret} : {})},
    ...(subscribe && Object.hasOwn(params,'cursor') ? {cursor:params.cursor} : {}),...(subscribe && Object.hasOwn(params,'ttlMs') ? {ttlMs:params.ttlMs} : {})}};
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw unavailable();
  return value;
}
function projectStatus(value,id) {
  object(value,['message_id','status','error'],['message_id','status','error']);
  if (value.message_id !== id || !statuses.has(value.status) || !(value.error === null || typeof value.error === 'string')) throw unavailable();
  return {message_id:id,status:value.status,error:value.error === null ? null : 'backend_reported_error'};
}
export function projectToolResult(call,result,live) {
  try {
    if (!record(result) || result.isError !== false || !record(result.structuredContent)) throw unavailable();
    const value=result.structuredContent;
    if (call.name === 'check_bridge_setup') {
      object(value,['configuration_ready','events_discoverable','missing_settings','callback_hostname','callback_policy','qq_api_profile','network_checked','next_step','callback_transport'],['configuration_ready','events_discoverable','missing_settings','callback_hostname','callback_policy','qq_api_profile','network_checked','next_step',...(live?['callback_transport']:[])]);
      const transport = value.callback_transport === undefined ? undefined : projectCallbackTransportStatus(value.callback_transport);
      if (typeof value.configuration_ready !== 'boolean' || typeof value.events_discoverable !== 'boolean' ||
          (!live && (value.configuration_ready || value.events_discoverable)) || value.network_checked !== false ||
          !['documented','tencent-sdk','tencent-sandbox'].includes(value.qq_api_profile) || !Array.isArray(value.missing_settings) ||
          value.missing_settings.length > settings.length || value.missing_settings.some(x=>!settings.includes(x)) || new Set(value.missing_settings).size !== value.missing_settings.length ||
          !['not_provided','invalid_url','blocked','allowlisted'].includes(value.callback_policy)) throw unavailable();
      let hostname=null;
      if (call.arguments.callback_url === undefined) { if (value.callback_policy !== 'not_provided' || value.callback_hostname !== null) throw unavailable(); }
      else {
        hostname=callbackUrl(call.arguments.callback_url).hostname;
        if (value.callback_hostname !== hostname || !['blocked','allowlisted'].includes(value.callback_policy)) throw unavailable();
      }
      return {configuration_ready:value.configuration_ready,events_discoverable:value.events_discoverable,missing_settings:[...value.missing_settings],
        callback_hostname:hostname,callback_policy:value.callback_policy,qq_api_profile:value.qq_api_profile,network_checked:false,...(transport?{callback_transport:transport}:{}),
        next_step:live ? 'Local configuration check only. Callback trust and message delivery are validated by the selected backend; no destination was approved by this check.' :
          'Readiness-only connection verified. QQ provider configuration and end-to-end message delivery remain unverified.'};
    }
    if (!live) throw unavailable();
    if (call.name.startsWith('get_')) {
      object(value,['message_id','text','reply_deadline','reply'],['message_id','text','reply_deadline','reply']);
      if (value.message_id !== call.arguments.message_id) throw unavailable();
      if (value.text !== null) boundedString(value.text,2000,{empty:true,multiline:true});
      return {message_id:call.arguments.message_id,text:value.text,reply_deadline:iso(value.reply_deadline),reply:projectStatus(value.reply,call.arguments.message_id)};
    }
    return projectStatus(value,call.arguments.message_id);
  } catch { throw unavailable(); }
}
export function projectSubscription(result,params,startedAt) {
  try {
    object(result,['resultType','_meta','id','refreshBefore','cursor','truncated'],['id','refreshBefore','cursor','truncated']);
    if (typeof result.id !== 'string' || !/^sub_[a-f0-9]{64}$/.test(result.id) || result.cursor !== null || result.truncated !== false) throw unavailable();
    const expiry=Date.parse(iso(result.refreshBefore)), ceiling=Date.now()+(params.ttlMs ?? MAX_LEASE_MS);
    if (expiry <= Date.now() || expiry > ceiling) throw unavailable();
    return {id:result.id,refreshBefore:result.refreshBefore,cursor:null,truncated:false};
  } catch { throw unavailable(); }
}

// The sole error-data exception is an approval-needed hostname derived from the
// caller's own validated callback. No backend exception text or other data leaks.
export function projectUpstreamError(value,params,{method,channel}={}) {
  const e=value?.error;
  if(method==='events/subscribe'&&record(e)&&e.code===-32015&&record(e.data)&&
      typeof e.data.reason==='string'&&transportReasons.has(e.data.reason)){
    let transport;
    try { if(e.data.callback_transport!==undefined)transport=projectCallbackTransportStatus(e.data.callback_transport); }
    catch { return unavailable(); }
    return new BridgeError('Selected backend callback transport is unavailable or rejected the request',
      {status:503,code:-32015,data:{reason:e.data.reason,...(transport?{callback_transport:transport}:{})}});
  }
  const policyRequired=record(e)&&record(e.data)&&((channel==='lark'&&e.code===-32015&&e.data.reason==='callback_policy_required') ||
    (channel==='qq'&&e.code===-32012&&e.data.callback_policy==='blocked'));
  if (method === 'events/subscribe' && policyRequired && params.delivery?.url) {
    let host; try { host=callbackUrl(params.delivery.url).hostname; } catch { return unavailable(); }
    if (e.data.callback_hostname === host) return new BridgeError('Callback hostname requires separate approval',
      {status:403,code:-32015,data:{reason:'callback_policy_required',callback_hostname:host}});
  }
  const messages = new Map([[-32012,'Selected backend rejected authorization or message access'],[-32013,'Selected backend limit reached'],
    [-32014,'Selected backend does not support this event option'],[-32015,'Selected backend callback validation failed'],[-32602,'Selected backend rejected operation parameters']]);
  if (record(e) && messages.has(e.code)) return new BridgeError(messages.get(e.code),{status:400,code:e.code});
  return unavailable();
}

export function projectLarkPreflight(call,result) {
  try {
    if(!record(result)||result.isError!==false)throw unavailable();const s=result.structuredContent;
    object(s,['callback_hostname','callback_policy','binding_ready','delivery_configured','network_checked','callback_transport','pending_message'],['callback_hostname','callback_policy','binding_ready','delivery_configured','network_checked','callback_transport']);
    const transport=projectCallbackTransportStatus(s.callback_transport);
    if(typeof s.binding_ready!=='boolean'||typeof s.delivery_configured!=='boolean'||(s.delivery_configured&&!s.binding_ready)||s.network_checked!==false||!['not_provided','invalid','not_allowlisted','allowlisted'].includes(s.callback_policy))throw unavailable();
    if(call.arguments.callback_url===undefined){if(s.callback_hostname!==null||s.callback_policy!=='not_provided')throw unavailable();}
    else {const host=callbackUrl(call.arguments.callback_url).hostname;if(s.callback_hostname!==host||!['not_allowlisted','allowlisted'].includes(s.callback_policy))throw unavailable();}
    let pending;
    if(Object.hasOwn(s,'pending_message')) {
      if(transport.mode!=='owner_single_message_proxy')throw unavailable();
      pending=null;
      if(s.pending_message!==null) {
        object(s.pending_message,['message_id','reply_deadline'],['message_id','reply_deadline']);
        const id=boundedString(s.pending_message.message_id,256),deadline=iso(s.pending_message.reply_deadline);
        if(!s.binding_ready||!s.delivery_configured)throw unavailable();
        if(Date.parse(deadline)>Date.now())pending={message_id:id,reply_deadline:deadline};
      }
    }
    return {authenticated_mcp_reachable:true,readiness_catalog_only:false,provider_network_checked:false,ready_for_delivery:false,end_to_end_verified:false,
      callback_hostname:s.callback_hostname,callback_policy:s.callback_policy,binding_ready:s.binding_ready,delivery_configured:s.delivery_configured,network_checked:false,callback_transport:transport,...(pending===undefined?{}:{pending_message:pending})};
  }catch{throw unavailable();}
}
