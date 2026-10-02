import { createPrivateKey, createPublicKey, createHmac, randomBytes, sign, verify, createCipheriv, createDecipheriv } from 'node:crypto';
import { BridgeError, equal } from './common.js';

// QQ's published algorithm repeats UTF-8 Bot Secret bytes, then takes 32 bytes.
export function qqKey(secret) {
  if (!secret) throw new BridgeError('QQ signing is not configured', { status: 503 });
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}
export function qqVerify(secret, headers, body, now, skewSeconds = 300) {
  const ts = headers['x-signature-timestamp'], signature = headers['x-signature-ed25519'];
  if (typeof ts !== 'string' || !/^\d{10}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > skewSeconds ||
      typeof signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(signature)) {
    throw new BridgeError('Invalid or stale QQ signature', { status: 401 });
  }
  const bytes = Buffer.from(signature, 'hex');
  if ((bytes[63] & 224) || !verify(null, Buffer.concat([Buffer.from(ts), body]), createPublicKey(qqKey(secret)), bytes)) {
    throw new BridgeError('Invalid QQ signature', { status: 401 });
  }
  return `${ts}:${signature.toLowerCase()}`;
}
export function qqChallenge(secret, plainToken, eventTs) {
  return sign(null, Buffer.from(eventTs + plainToken), qqKey(secret)).toString('hex');
}
export function webhookKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new BridgeError('Invalid webhook signing secret');
  const encoded = secret.slice(6), bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new BridgeError('Webhook signing key must contain 24–64 bytes');
  }
  return bytes;
}
export function webhookHeaders(subscription, id, body, now) {
  const ts = String(Math.floor(now / 1000));
  const keys = [subscription.secret];
  if (subscription.oldSecret && subscription.oldSecretUntil > now) keys.push(subscription.oldSecret);
  const signatures = keys.map(secret => `v1,${createHmac('sha256', webhookKey(secret)).update(`${id}.${ts}.`).update(body).digest('base64')}`);
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts,
    'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id };
}
// Used only by the offline receiver, never as a credential creation path.
export function verifyWebhook(secret, headers, body, now) {
  const ts = headers['webhook-timestamp'];
  if (!/^\d{10}$/.test(ts ?? '') || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', webhookKey(secret)).update(`${headers['webhook-id']}.${ts}.`).update(body).digest('base64');
  return (headers['webhook-signature'] ?? '').split(' ').some(signature => equal(signature, `v1,${expected}`));
}
export class Vault {
  constructor(encoded) {
    const bytes = Buffer.from(encoded ?? '', 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== encoded) throw new Error('STORAGE_KEY must be a canonical base64 32-byte key');
    this.key = bytes;
  }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  open(encoded, context) {
    const bytes = Buffer.from(encoded, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
}
