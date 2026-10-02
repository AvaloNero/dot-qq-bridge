import { createHash, timingSafeEqual } from 'node:crypto';

export class BridgeError extends Error {
  constructor(message, { status = 400, code = -32602, data, retryable = false, uncertain = false } = {}) {
    super(message);
    Object.assign(this, { status, code, data, retryable, uncertain });
  }
}

export const hash = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new BridgeError('Invalid object fields');
  }
  return value;
}
export function string(value, max = 512) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new BridgeError('Invalid string');
  }
  return value;
}
export function plainText(value, max = 2000) {
  string(value, max);
  if (!value.trim() || Buffer.byteLength(value) > max * 4 || /\p{Surrogate}/u.test(value)) {
    throw new BridgeError('Invalid plain text');
  }
  return value;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new BridgeError('Invalid RFC3339 timestamp');
  }
  return Date.parse(value);
}
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result,
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'dot-qq-bridge', version: '0.1.0' } } } };
}
export function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}
