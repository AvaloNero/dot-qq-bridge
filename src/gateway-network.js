import WebSocket from 'ws';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BridgeError } from './common.js';
import { resolveDestination } from './network.js';

export function gatewayUrl(raw, hosts) {
  let url;
  try { url = new URL(raw); } catch { throw new BridgeError('Invalid QQ Gateway URL'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new BridgeError('QQ Gateway requires WSS on port 443 without credentials or fragments');
  }
  const httpsUrl = new URL(url); httpsUrl.protocol = 'https:';
  // Use the exact host policy and public-IP checks from the HTTP requester.
  return { url, httpsUrl, hosts };
}
export function makePublicWebSocket({ lookup = dnsLookup, WebSocketClass = WebSocket, timeoutMs = 10000 } = {}) {
  return async (raw, { hosts, beforeConnect = () => {} }) => {
    const { url, httpsUrl } = gatewayUrl(raw, hosts);
    let timer, destination;
    try {
      destination = await Promise.race([resolveDestination(httpsUrl.href, hosts, lookup),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('QQ Gateway DNS timeout', { retryable: true })), timeoutMs); })]);
    } finally { clearTimeout(timer); }
    beforeConnect();
    const answers = destination.answers;
    return new WebSocketClass(url.href, {
      headers: { 'User-Agent': 'dot-qq-bridge/0.1.0' }, handshakeTimeout: timeoutMs, maxPayload: 32768,
      followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true, servername: url.hostname,
      lookup: (_hostname, options, callback) => options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family)
    });
  };
}
