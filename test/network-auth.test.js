import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makePublicRequester, publicAddress, destinationUrl, resolveDestination } from '../src/network.js';
import { createAuthenticator } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { config, FIXTURE_TOKEN } from './helpers.js';

test('callback address policy blocks private, local, mapped, reserved and documentation ranges', () => {
  for (const ip of ['0.1.2.3','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.0.0.8',
    '192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1',
    '::','::1','fe80::1','fc00::1','::ffff:8.8.8.8','2001:db8::1','2001:0db8::1','2002:0808:0808::1','2001:20::1','3fff::1','bad']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(publicAddress(ip), true, ip);
});
test('callback URL requires exact allowlisted hostname, HTTPS, no credentials, fragment or non-443 port', () => {
  const hosts = ['receiver.example.com'];
  assert.equal(destinationUrl('https://receiver.example.com/path?q=1', hosts).hostname, hosts[0]);
  for (const url of ['https://receiver.example.com.evil/x','https://receiver.example.com./x','http://receiver.example.com/x',
    'https://user:pass@receiver.example.com/x','https://receiver.example.com:8443/x','https://receiver.example.com/x#frag','https://127.0.0.1/x']) assert.throws(() => destinationUrl(url, hosts));
  assert.throws(() => destinationUrl('https://receiver.example.com/x', []));
});
test('all DNS results must be public and are rechecked after DNS rebinding', async () => {
  let count = 0;
  const lookup = async () => ++count === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  const hosts = ['receiver.example.com'];
  await resolveDestination('https://receiver.example.com/x', hosts, lookup);
  await assert.rejects(resolveDestination('https://receiver.example.com/x', hosts, lookup));
  await assert.rejects(resolveDestination('https://receiver.example.com/x', hosts, async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]));
});
test('HTTPS requester pins the vetted IP while preserving TLS SNI and never follows redirects', async () => {
  let called = 0;
  const request = (url, options, callback) => {
    called++; assert.equal(url.hostname, 'receiver.example.com'); assert.equal(options.servername, url.hostname); assert.equal(options.rejectUnauthorized, true);
    options.lookup(url.hostname, { all: true }, (error, answers) => { assert.equal(error, null); assert.deepEqual(answers, [{ address: '8.8.8.8', family: 4 }]); });
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'https://127.0.0.1/secrets' };
      callback(res); res.emit('end'); req.emit('close');
    });
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    return req;
  };
  const send = makePublicRequester({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request });
  const response = await send('https://receiver.example.com/x', { hosts: ['receiver.example.com'] });
  assert.equal(response.status, 302); assert.equal(called, 1);
});
test('DNS timeout and non-public destinations fail before opening an HTTP connection', async () => {
  let called = false;
  const request = () => { called = true; throw new Error('must not connect'); };
  const privateSend = makePublicRequester({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request });
  await assert.rejects(privateSend('https://receiver.example.com/x', { hosts: ['receiver.example.com'] })); assert.equal(called, false);
  const stalled = makePublicRequester({ lookup: async () => new Promise(() => {}), timeoutMs: 15, request });
  await assert.rejects(stalled('https://receiver.example.com/x', { hosts: ['receiver.example.com'] }), error => error.data.reason === 'timeout');
});
test('revocation during DNS is checked after resolution and before HTTPS connection', async () => {
  let authorized = true, connected = false;
  const send = makePublicRequester({ lookup: async () => { authorized = false; return [{ address: '8.8.8.8', family: 4 }]; },
    request: () => { connected = true; throw new Error('must not connect'); } });
  await assert.rejects(send('https://receiver.example.com/x', { hosts: ['receiver.example.com'], beforeConnect: () => {
    if (!authorized) throw new Error('revoked');
  } }), /revoked/);
  assert.equal(connected, false);
});
test('HTTPS response bytes and stalled connections have bounded limits', async () => {
  for (const oversized of [true, false]) {
    const request = (_url, _options, callback) => {
      const req = new EventEmitter();
      req.destroy = error => { req.emit('error', error); req.emit('close'); };
      req.end = () => { if (oversized) queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
        res.destroy = error => { res.emit('error', error); req.emit('close'); };
        callback(res); res.emit('data', Buffer.alloc(17));
      }); };
      return req;
    };
    const send = makePublicRequester({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request, maxBytes: 16, timeoutMs: 15 });
    await assert.rejects(send('https://receiver.example.com/x', { hosts: ['receiver.example.com'] }), error =>
      oversized ? error.message === 'Response too large' : error.data.reason === 'timeout');
  }
});
test('configuration defaults deny, refuses dev network exposure and never accepts arbitrary QQ origins', () => {
  assert.equal(readConfig({}).authMode, 'deny'); assert.equal(readConfig({}).ownerOpenid, '');
  assert.throws(() => readConfig({ AUTH_MODE: 'dev', HOST: '0.0.0.0', DEV_BEARER_TOKEN: FIXTURE_TOKEN, MCP_OWNER_SUBJECT: 'owner' }));
  assert.throws(() => readConfig({ AUTH_MODE: 'dev', PUBLIC_ORIGIN: 'https://bridge.example', DEV_BEARER_TOKEN: FIXTURE_TOKEN, MCP_OWNER_SUBJECT: 'owner' }));
  assert.throws(() => readConfig({ QQ_API_PROFILE: 'https://evil.example' }));
  assert.throws(() => readConfig({ OAUTH_REQUIRED_SCOPE: 'scope"bad' }));
  assert.equal(readConfig({ QQ_API_PROFILE: 'tencent-sdk' }).qqApiProfile, 'tencent-sdk');
});
test('dev authentication requires exact bearer token and actual loopback peer; clientInfo cannot impersonate owner', async () => {
  const authenticate = createAuthenticator(config(), async () => { throw new Error('no network'); });
  const request = { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal((await authenticate(request)).id, 'fixture-owner');
  await assert.rejects(authenticate({ ...request, socket: { remoteAddress: '8.8.8.8' } }));
  await assert.rejects(authenticate({ ...request, headers: { authorization: 'Bearer wrong' } }));
  await assert.rejects(createAuthenticator(config({ authMode: 'deny' }), async () => {})(request));
});

const now = Date.parse('2026-10-02T12:00:00Z');
// Ephemeral synthetic RSA keys stay inside the test process; no account is created.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const oauthSettings = config({ authMode: 'oauth', oauthIssuer: 'https://issuer.example.com', oauthJwksUrl: 'https://issuer.example.com/jwks',
  oauthAudience: 'https://bridge.example.com/mcp', publicOrigin: 'https://bridge.example.com' });
function jwt(claimChanges = {}, headerChanges = {}, key = pair.privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: jwk.kid, ...headerChanges });
  const claims = encode({ iss: oauthSettings.oauthIssuer, sub: oauthSettings.principal, aud: oauthSettings.oauthAudience,
    scope: 'qq:bridge', exp: now / 1000 + 3600, iat: now / 1000, ...claimChanges });
  const value = `${header}.${claims}`;
  return `${value}.${sign('RSA-SHA256', Buffer.from(value), key).toString('base64url')}`;
}
function bearer(token) { return { headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '8.8.8.8' } }; }
test('OAuth JWT validates RS256, JWKS, issuer, resource audience, owner subject, scope and expiration', async () => {
  let requests = 0;
  const auth = createAuthenticator(oauthSettings, async (url, options) => {
    requests++; assert.equal(url, oauthSettings.oauthJwksUrl); assert.equal(options.method, 'GET');
    assert.deepEqual(options.hosts, ['issuer.example.com']);
    return { status: 200, body: Buffer.from(JSON.stringify({ keys: [jwk] })) };
  }, () => now);
  assert.equal((await auth(bearer(jwt()))).id, 'fixture-owner');
  assert.equal((await auth(bearer(jwt({ aud: [oauthSettings.oauthAudience] })))).validUntil, now + 3600000);
  assert.equal(requests, 1);
  for (const claims of [{ iss: 'https://attacker.example.com' }, { sub: 'someone-else' }, { aud: 'other-resource' }, { scope: 'qq:read' },
    { exp: now / 1000 }, { exp: null }, { nbf: now / 1000 + 1 }, { iat: now / 1000 + 31 }]) await assert.rejects(auth(bearer(jwt(claims))), error => error.status === 401);
});
test('OAuth rejects algorithm confusion, token-directed JWKS, unknown/duplicate kid and forged signatures', async () => {
  const auth = createAuthenticator(oauthSettings, async () => ({ status: 200, body: Buffer.from(JSON.stringify({ keys: [jwk] })) }), () => now);
  for (const header of [{ alg: 'HS256' }, { alg: 'none' }, { jku: 'https://evil.example.com' }, { x5u: 'https://evil.example.com' }, { crit: ['b64'] }, { kid: 'unknown' }]) await assert.rejects(auth(bearer(jwt({}, header))));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); await assert.rejects(auth(bearer(jwt({}, {}, other.privateKey))));
  const duplicate = createAuthenticator(oauthSettings, async () => ({ status: 200, body: Buffer.from(JSON.stringify({ keys: [jwk, jwk] })) }), () => now);
  await assert.rejects(duplicate(bearer(jwt())));
  await assert.rejects(auth(bearer('not-a-jwt')));
});
