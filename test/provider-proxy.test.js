import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { makeProviderRequester, createProviderProxyAgent, configuredProviderProxy, proxyBypassed } from '../src/provider-network.js';
import { makePublicRequester } from '../src/network.js';
import { makePublicWebSocket } from '../src/gateway-network.js';
const HOST = 'api.sgroup.qq.com';
let dir, ca, target, proxy, wss, proxyEnv, connects = [], received = [];
const sockets = new Set();
before(async () => {
  // Disposable synthetic TLS fixture: never used as account auth or global CA.
  dir = mkdtempSync(join(tmpdir(), 'bridge-proxy-fixture-'));
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj',`/CN=${HOST}`,'-addext',`subjectAltName=DNS:${HOST}`,'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')], { stdio: 'ignore' });
  ca = readFileSync(join(dir,'cert.pem'));
  target = https.createServer({ key:readFileSync(join(dir,'key.pem')), cert:ca }, (req,res) => {
    received.push({path:req.url,host:req.headers.host,proxyAuth:req.headers['proxy-authorization']});
    if(req.url==='/redirect'){res.writeHead(302,{location:'https://attacker.invalid/'});res.end();}
    else if(req.url==='/large'){res.end('x'.repeat(1000));}
    else res.end('fixture-ok');
  });
  target.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  wss=new WebSocketServer({server:target});wss.on('connection',s=>s.on('message',b=>s.send(b)));
  await new Promise(r=>target.listen(0,'127.0.0.1',r));
  proxy=http.createServer();proxy.on('connect',(req,client,head)=>{
    connects.push(req.url);
    const upstream=net.connect(target.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
    for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});}
    client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  proxyEnv={HTTPS_PROXY:`http://127.0.0.1:${proxy.address().port}`};
});
after(async()=>{for(const c of wss.clients)c.terminate();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>target.close(r))]);wss.close();rmSync(dir,{recursive:true,force:true});});
function requester(options={}){return makeProviderRequester({env:proxyEnv,timeoutMs:1000,agentFactory:opts=>createProviderProxyAgent({...opts,ca}),...options});}
const options={method:'GET',hosts:[HOST]};

test('native provider HTTPS uses loopback CONNECT with original hostname TLS verification',async()=>{const n=connects.length;const out=await requester()(`https://${HOST}/`,options);assert.equal(out.status,200);assert.equal(out.body.toString(),'fixture-ok');assert.equal(connects[n],`${HOST}:443`);assert.equal(received.at(-1).host,HOST);assert.equal(received.at(-1).proxyAuth,undefined);});
test('provider redirects and response limits fail closed',async()=>{await assert.rejects(requester()(`https://${HOST}/redirect`,options),e=>e.data.reason==='redirect_rejected');await assert.rejects(requester({maxBytes:100})(`https://${HOST}/large`,options));});
test('provider opt-in cannot route arbitrary or malformed destinations',async()=>{const n=connects.length;for(const url of ['https://attacker.invalid/','http://'+HOST+'/',`https://${HOST}:444/`,`https://u:p@${HOST}/`,`https://${HOST}/#x`])await assert.rejects(requester()(url,{...options,hosts:[new URL(url).hostname]}));assert.equal(connects.length,n);});
test('missing, unsupported, malformed proxies and NO_PROXY do not downgrade to direct',async()=>{assert.equal(configuredProviderProxy({}),null);assert.throws(()=>configuredProviderProxy({HTTPS_PROXY:'socks5://127.0.0.1:1'}));assert.throws(()=>configuredProviderProxy({HTTPS_PROXY:'invalid'}));assert.equal(configuredProviderProxy({https_proxy:'http://lower.example:1',HTTPS_PROXY:'http://upper.example:2'}),'http://lower.example:1/');for(const rule of ['*',HOST,`.${HOST.split('.').slice(1).join('.')}`,`${HOST}:443`]){assert.equal(proxyBypassed(HOST,{NO_PROXY:rule}),true);const n=connects.length;await assert.rejects(requester({env:{...proxyEnv,NO_PROXY:rule}})(`https://${HOST}/`,options));assert.equal(connects.length,n);}await assert.rejects(requester({env:{}})(`https://${HOST}/`,options));});
test('revocation prevents provider connection creation',async()=>{const n=connects.length;await assert.rejects(requester()(`https://${HOST}/`,{...options,beforeConnect(){throw new Error('revoked');}}),/revoked/);assert.equal(connects.length,n);});
test('TLS mismatch rejects without downgrade',async()=>{const send=makeProviderRequester({env:proxyEnv,timeoutMs:1000});await assert.rejects(send(`https://${HOST}/`,options),e=>e.data.reason==='tls_error');});
test('unmarked and OAuth requests retain the original DNS-pinned path for official hostnames',async()=>{let providerCalls=0,dnsCalls=0;const send=makePublicRequester({proxyEnv,lookup:async()=>{dnsCalls++;return [{address:'127.0.0.1',family:4}];},providerSend:async()=>{providerCalls++;return {status:200};}});await assert.rejects(send(`https://${HOST}/`,options));await assert.rejects(send(`https://${HOST}/`,{...options,purpose:'oauth'}));assert.equal(providerCalls,0);assert.equal(dnsCalls,2);await send(`https://${HOST}/`,{...options,purpose:'provider'});assert.equal(providerCalls,1);});
test('CONNECT errors are sanitized and never expose proxy credentials',async()=>{const bad=http.createServer();bad.on('connect',(req,s)=>s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));await new Promise(r=>bad.listen(0,'127.0.0.1',r));try{const send=requester({env:{HTTPS_PROXY:`http://synthetic-user:synthetic-pass@127.0.0.1:${bad.address().port}`}});await assert.rejects(send(`https://${HOST}/`,options),e=>!String(e).includes('synthetic-pass')&&!String(e).includes('127.0.0.1'));}finally{await new Promise(r=>bad.close(r));}});
test('provider WSS uses native proxy with verified TLS and closes cleanly',async()=>{const n=connects.length;const ws=await makePublicWebSocket({proxyEnv,proxyAgentFactory:opts=>createProviderProxyAgent({...opts,ca})})(`wss://${HOST}/`,{hosts:[HOST]});await once(ws,'open');ws.send('fixture');const [bytes]=await once(ws,'message');assert.equal(bytes.toString(),'fixture');assert.equal(connects[n],`${HOST}:443`);ws.close();await once(ws,'close');});

test('noncanonical proxy URLs normalize, CRLF and agent construction errors are sanitized',async()=>{for(const raw of ['HTTP://proxy.example:80','  http://proxy.example:80  '])assert.equal(configuredProviderProxy({HTTPS_PROXY:raw}),'http://proxy.example/');assert.throws(()=>configuredProviderProxy({HTTPS_PROXY:'http://user:password@proxy.example\r\n/'}),e=>!String(e).includes('password'));await assert.rejects(requester({agentFactory(){throw new Error('http://user:password@proxy.example');}})(`https://${HOST}/`,options),e=>e.data.reason==='proxy_configuration'&&!String(e).includes('password'));const n=connects.length;await requester({env:{HTTPS_PROXY:proxyEnv.HTTPS_PROXY.replace('http:','HTTP:')}})(`https://${HOST}/`,options);assert.equal(connects.length,n+1);});
