import { configuredProviderProxy, createProviderProxyAgent, PROVIDER_HOSTS } from './provider-network.js';
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
export function makePublicWebSocket({ lookup = dnsLookup, WebSocketClass = WebSocket, timeoutMs = 10000, proxyEnv = process.env, proxyAgentFactory = createProviderProxyAgent } = {}) {
  return async (raw, { hosts, beforeConnect = () => {} }) => {
    const { url, httpsUrl } = gatewayUrl(raw, hosts);
    if (configuredProviderProxy(proxyEnv)) {
      if (!hosts.includes(url.hostname) || !PROVIDER_HOSTS.includes(url.hostname)) throw new BridgeError('QQ proxy gateway destination is not approved');
      const agent = proxyAgentFactory({ env: proxyEnv, allowedHost: host => hosts.includes(host) && PROVIDER_HOSTS.includes(host) });
      try {
        beforeConnect();
        const socket = new WebSocketClass(url.href, { agent, headers: { 'User-Agent': 'dot-qq-bridge/0.1.0' }, handshakeTimeout: timeoutMs,
          maxPayload: 32768, followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true, servername: url.hostname });
        socket.once('close', () => agent.destroy());
        socket.once('error', () => agent.destroy());
        return socket;
      } catch { agent.destroy(); throw new BridgeError('QQ proxy gateway connection failed', { retryable: true }); }
    }
    let timer, destination;
    try {
      destination = await Promise.race([resolveDestination(httpsUrl.href, hosts, lookup),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('QQ Gateway DNS timeout', { retryable: true })), timeoutMs); })]);
    } finally { clearTimeout(timer); }
    beforeConnect();
    const answers = destination.answers;
    return new WebSocketClass(url.href, {
      agent: false, headers: { 'User-Agent': 'dot-qq-bridge/0.1.0' }, handshakeTimeout: timeoutMs, maxPayload: 32768,
      followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true, servername: url.hostname,
      lookup: (_hostname, options, callback) => options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family)
    });
  };
}
