import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BridgeError } from './common.js';

const fail = (message, reason = 'connection_refused') => new BridgeError(message, { code: -32015, data: { reason }, retryable: true });
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase(), first = Number.parseInt(normalized.split(':')[0], 16);
    // Accept the global-unicast allocation only; reject transition/documentation blocks.
    return first >= 0x2000 && first <= 0x3fff && !normalized.includes('.') &&
      !normalized.startsWith('2002:') && !normalized.startsWith('3fff:') &&
      !(first === 0x2001 && (Number.parseInt(normalized.split(':')[1] || '0', 16) < 0x200 || Number.parseInt(normalized.split(':')[1] || '0', 16) === 0xdb8));
  }
  return false;
}
export function validHostname(host) {
  return typeof host === 'string' && host.length <= 253 && !isIP(host) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}
// Structural inspection only: no DNS, connection, trust or policy changes.
export function callbackUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new BridgeError('Malformed callback URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !validHostname(url.hostname)) {
    throw new BridgeError('Callback requires an HTTPS DNS hostname on port 443, without credentials or fragment');
  }
  return url;
}
export function destinationUrl(raw, hosts) {
  const url = callbackUrl(raw);
  if (!hosts.includes(url.hostname)) throw new BridgeError('Destination hostname is not explicitly allowed');
  return url;
}
export async function resolveDestination(raw, hosts, lookup = dnsLookup) {
  const url = destinationUrl(raw, hosts);
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.length > 32 || answers.some(answer => !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) {
    throw fail('Destination has a non-public address');
  }
  return { url, answers };
}
export function makePublicRequester({ lookup = dnsLookup, request = https.request, timeoutMs = 10000, maxBytes = 262144 } = {}) {
  return async function send(raw, { method = 'POST', headers = {}, body = Buffer.alloc(0), hosts, beforeConnect = () => {} }) {
    // The DNS check is repeated on EVERY attempt; the vetted answers are pinned in lookup.
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Destination timeout', 'timeout')), timeoutMs); });
    let destination;
    try { destination = await Promise.race([resolveDestination(raw, hosts, lookup), timeout]); }
    finally { clearTimeout(timer); }
    const { url, answers } = destination;
    beforeConnect();
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers: { ...headers, 'Content-Length': body.length }, agent: false,
        lookup: (_hostname, options, callback) => options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family),
        servername: url.hostname, rejectUnauthorized: true }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) res.destroy(fail('Response too large', 'http_4xx'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      const deadline = setTimeout(() => req.destroy(fail('Destination timeout', 'timeout')), timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', error => reject(error instanceof BridgeError ? error : fail('Destination connection failed', error.code?.startsWith('ERR_TLS') || error.code?.includes('CERT') ? 'tls_error' : 'connection_refused')));
      req.end(body);
    });
  };
}
