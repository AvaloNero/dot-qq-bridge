import { BridgeError, plainText, string, timestamp } from './common.js';

export function incomingMessage(payload, config, now) {
  if (!config.ownerOpenid || !config.principal || config.authMode === 'deny') throw new BridgeError('Owner binding is not configured', { status: 503 });
  if (payload.op !== 0 || payload.t !== 'C2C_MESSAGE_CREATE') return null;
  const data = payload.d;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BridgeError('Invalid QQ message');
  if (data.author?.user_openid !== config.ownerOpenid) throw new BridgeError('QQ identity is not allowlisted', { status: 403 });
  if (data.author.bot === true || (data.message_type !== undefined && data.message_type !== 0) ||
      (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.length)) ||
      data.ark_data || (data.msg_elements !== undefined && (!Array.isArray(data.msg_elements) || data.msg_elements.length)) ||
      data.message_reference || data.group_openid || data.guild_id || data.channel_id) return null;
  string(data.id, 256); string(payload.id, 256); plainText(data.content);
  const occurred = timestamp(data.timestamp);
  if (occurred > now + 30000 || occurred + config.replyTtlMs <= now) throw new BridgeError('QQ message is too old or in the future');
  return { id: data.id, sourceEventId: payload.id, owner: data.author.user_openid,
    text: data.content, timestamp: data.timestamp, expires: occurred + config.replyTtlMs };
}

export function createQqSender(config, send, clock = Date.now) {
  const apiOrigin = config.qqApiProfile === 'tencent-sandbox' ? 'https://sandbox.api.sgroup.qq.com' :
    config.qqApiProfile === 'tencent-sdk' ? 'https://api.sgroup.qq.com' : 'https://api.bot.qq.com';
  const tokenOrigin = config.qqApiProfile === 'documented' ? 'https://api.bot.qq.com' : 'https://bots.qq.com';
  let token, expires = 0, pending;
  async function getToken() {
    if (token && expires > clock() + 60000) return token;
    if (!pending) pending = (async () => {
      try {
        const response = await send(`${tokenOrigin}/app/getAppAccessToken`, { hosts: [new URL(tokenOrigin).hostname],
          headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ appId: config.qqAppId, clientSecret: config.qqSecret })) });
        const data = JSON.parse(response.body.toString('utf8'));
        if (response.status !== 200 || (data.code !== undefined && data.code !== 0) ||
            typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 60) {
          throw new BridgeError('QQ token request rejected', { retryable: response.status === 429 || response.status >= 500 || data.code === 100001 });
        }
        token = data.access_token; expires = clock() + Number(data.expires_in) * 1000;
        return token;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('QQ token request failed', { retryable: true });
      }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return async function sendReply(message, text, { authorize = () => {} } = {}) {
    const accessToken = await getToken();
    // Recheck the passive deadline after token refresh, immediately before the send.
    if (message.expires <= clock()) throw new BridgeError('QQ passive reply window expired');
    authorize();
    let response;
    try {
      response = await send(`${apiOrigin}/v2/users/${encodeURIComponent(message.owner)}/messages`, {
        hosts: [new URL(apiOrigin).hostname], headers: { 'Authorization': `QQBot ${accessToken}`, 'Content-Type': 'application/json', 'X-Bot-Appid': config.qqAppId },
        body: Buffer.from(JSON.stringify({ msg_type: 0, content: text, msg_id: message.id, msg_seq: 1 })), beforeConnect: authorize
      });
    } catch (error) {
      if (error instanceof BridgeError && error.code === -32012) throw error;
      throw new BridgeError('QQ send acknowledgement unknown', { uncertain: true });
    }
    if (response.status === 401) { token = undefined; expires = 0; throw new BridgeError('QQ authentication rejected', { retryable: true }); }
    if (response.status === 429) throw new BridgeError('QQ rate limited', { retryable: true });
    if (response.status >= 500) throw new BridgeError('QQ send acknowledgement unknown', { uncertain: true });
    let data;
    try { data = JSON.parse(response.body.toString('utf8')); } catch { throw new BridgeError('QQ send acknowledgement unknown', { uncertain: true }); }
    if (response.status < 200 || response.status >= 300 || (data.err_code !== undefined && data.err_code !== 0) || (data.code !== undefined && data.code !== 0)) {
      throw new BridgeError('QQ send rejected');
    }
    if (typeof data.id !== 'string' || !data.id) throw new BridgeError('QQ send acknowledgement unknown', { uncertain: true });
    return data.id;
  };
}
