import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {makeCallbackTransport,preflightCallbackTransport,projectCallbackTransportStatus,callbackTransportStatusSchema,
  CallbackTransportError,TRANSPORT_ERROR_CODES,signedHeaders} from '../index.js';
const URL='https://callback.example.test/private-path?synthetic=only';
const HOST='callback.example.test',PROXY={HTTPS_PROXY:'http://proxy.example.test:3128'},BODY=Buffer.from('{"kind":"synthetic"}');
const HEADERS=signedHeaders({id:'sub_test',key:Buffer.alloc(32,99)},'evt_test',BODY,1800000000000);
const opts=(extra={})=>({method:'POST',headers:HEADERS,body:BODY,hosts:[HOST],beforeConnect:()=>{},...extra});
const response=(status=200,body=Buffer.from('{}'),headers={})=>({status,headers,body});
function direct(config={}){
  const calls={dns:0,requests:[],gates:0};
  const lookup=async()=>{calls.dns++;return config.answers??[{address:'93.184.216.34',family:4}];};
  const request=(url,options,receive)=>{
    const req=new EventEmitter();req.destroy=()=>{if(req.closed)return;req.closed=true;queueMicrotask(()=>req.emit('close'));};
    req.end=body=>{req.body=body;queueMicrotask(()=>{if(req.closed)return;if(config.error){req.emit('error',Object.assign(new Error('PRIVATE_UPSTREAM'),{code:config.error}));return;}
      const res=new EventEmitter();res.statusCode=config.status??200;res.headers=config.headers??{};res.rawHeaders=config.rawHeaders??Object.entries(res.headers).flat();res.complete=false;
      res.destroy=()=>{if(res.closed)return;res.closed=true;queueMicrotask(()=>res.emit('close'));};receive(res);if(res.closed)return;res.emit('data',config.body??Buffer.from('{}'));res.complete=true;res.emit('end');res.destroy();req.destroy();});};
    calls.requests.push({url,options,req});return req;
  };
  const send=makeCallbackTransport({lookup,request,proxyEnv:{},...config.transport});
  return {send,calls,run:extra=>send(URL,opts({beforeConnect:()=>calls.gates++,...extra}))};
}
test('shared six-field schema and projector enforce consistent closed status combinations',()=>{
  assert.equal(callbackTransportStatusSchema.required.length,6);assert.equal(callbackTransportStatusSchema.additionalProperties,false);assert.ok(Object.isFrozen(callbackTransportStatusSchema.properties.mode.enum));
  const states=[preflightCallbackTransport({proxyEnv:{}}),preflightCallbackTransport({proxyEnv:PROXY}),preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:{send:async()=>response()}}),
    {ready:false,mode:'blocked',reason:'transport_unverified',proxy_configured:null,destination_binding:'unverified',network_checked:false}];
  for(const state of states){const projected=projectCallbackTransportStatus(state);assert.deepEqual(projected,state);assert.notEqual(projected,state);assert.ok(Object.isFrozen(projected));}
  for(const value of [undefined,null,{},[],{...states[0],network_checked:true},{...states[0],ready:false},{...states[1],ready:true},{...states[2],destination_binding:'direct_pinned'},
    {...states[3],proxy_configured:false},{...states[0],hostname:HOST}])assert.throws(()=>projectCallbackTransportStatus(value));
});
test('factory can construct blocked readiness; missing adapter refuses before DNS and never implies verified policy',async()=>{
  let calls=0;const send=makeCallbackTransport({proxyEnv:PROXY,lookup:async()=>{calls++;return[];},request:()=>{calls++;}});
  assert.deepEqual(send.preflight(),{ready:false,mode:'blocked',reason:'proxy_policy_unverified',proxy_configured:true,destination_binding:'unverified',network_checked:false});
  await assert.rejects(()=>send(URL,opts()),e=>e instanceof CallbackTransportError&&e.code==='proxy_policy_unverified'&&e.reason===e.code);assert.equal(calls,0);
  assert.equal(preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:{verified:true}}).reason,'adapter_invalid');
  assert.equal(preflightCallbackTransport({proxyEnv:{...PROXY,CALLBACK_PROXY_VERIFIED:'true'}}).ready,false);
});
test('production exact-host policy is mandatory and fails before DNS for unapproved destinations',async()=>{
  const f=direct();for(const hosts of [undefined,[],['other.example.test'],['*'],['.example.test'],HOST])await assert.rejects(()=>f.run({hosts}),e=>e.code==='host_not_allowed');assert.equal(f.calls.dns,0);
  await f.run();assert.equal(f.calls.dns,1);assert.equal(f.calls.requests.length,1);assert.equal(f.calls.requests[0].options.headers.host,HOST);
  assert.equal(f.send.preflight().destination_binding,'direct_pinned');
});
test('dynamic callback policy is explicit code-only and does not weaken production defaults',async()=>{
  const f=direct({transport:{callbackPolicy:'authenticated-dynamic-public-https'}});await f.run({hosts:undefined});assert.equal(f.calls.requests.length,1);
  await assert.rejects(()=>f.run({hosts:[HOST]}),e=>e.code==='invalid_input');
  assert.throws(()=>makeCallbackTransport({callbackPolicy:'environment_verified'}),e=>e.code==='invalid_options');
});
test('production body/response ceiling is 256KiB; header cap stays 8KiB and bounds remain separate',async()=>{
  const body=Buffer.alloc(262144,120),f=direct({body});await f.run({body});assert.equal(f.calls.requests[0].req.body.length,262144);
  await assert.rejects(()=>f.run({body:Buffer.alloc(262145)}),e=>e.code==='invalid_input');
  const responseBound=direct({body:Buffer.alloc(8193),transport:{maxBytes:8192}});await assert.rejects(()=>responseBound.run(),e=>e.code==='response_too_large');
  const requestBound=direct({transport:{maxRequestBytes:8192}});await assert.rejects(()=>requestBound.run({body:Buffer.alloc(8193)}),e=>e.code==='invalid_input');
  const headerBound=direct({headers:{'x-long':'x'.repeat(8193)}});await assert.rejects(()=>headerBound.run(),e=>e.code==='invalid_response');
  for(const config of [{maxBytes:262145},{maxRequestBytes:262145},{timeoutMs:30001}])assert.throws(()=>makeCallbackTransport(config),e=>e.code==='invalid_options');
  assert.equal(makeCallbackTransport({timeoutMs:30000,maxBytes:262144,proxyEnv:{}}).preflight().ready,true);
});
test('bounded 408/410/429/5xx statuses reach the app without retry; redirects never follow',async()=>{
  for(const status of [200,204,400,408,410,429,500,503,599]){const f=direct({status});assert.equal((await f.run()).status,status);assert.equal(f.calls.requests.length,1);}
  for(const status of [301,302,307,308]){const f=direct({status,headers:{location:'https://other.example.test'}});await assert.rejects(()=>f.run(),e=>e.code==='redirect_rejected');assert.equal(f.calls.requests.length,1);}
});
test('direct pin validates every answer and preserves original TLS identity with no multi-address retry',async()=>{
  const f=direct({answers:[{address:'93.184.216.34',family:4},{address:'2606:4700:4700::1111',family:6}],error:'ERR_TLS_CERT_ALTNAME_INVALID'});
  await assert.rejects(()=>f.run(),e=>e.code==='tls_failed');assert.equal(f.calls.dns,1);assert.equal(f.calls.requests.length,1);
  const {options}=f.calls.requests[0];assert.equal(options.agent,false);assert.equal(options.autoSelectFamily,false);assert.equal(options.servername,HOST);assert.equal(options.rejectUnauthorized,true);
  const privateAnswer=direct({answers:[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]});await assert.rejects(()=>privateAnswer.run(),e=>e.code==='blocked_address');assert.equal(privateAnswer.calls.requests.length,0);
});
test('injected managed adapter receives immutable validated target and current revocation gate; no built-in route is used',async()=>{
  let directCalls=0,adapterCalls=0;const managedAdapter={send:async(target,request)=>{
    adapterCalls++;assert.ok(Object.isFrozen(target));assert.ok(Object.isFrozen(target.addresses));assert.ok(Object.isFrozen(target.addresses[0]));assert.ok(Object.isFrozen(target.tls));
    assert.equal(target.url,URL);assert.equal(target.hostname,HOST);assert.equal(target.port,443);assert.equal(target.destinationBinding,'delegated_unverified');assert.equal(target.tls.rejectUnauthorized,true);assert.equal(target.tls.servername,HOST);
    assert.equal(request.method,'POST');assert.equal(request.headers.host,HOST);assert.equal(request.headers.authorization,undefined);assert.ok(request.signal instanceof AbortSignal);await request.beforeConnect();return response(202,Buffer.from('{}'),{'x-private':'PRIVATE_UPSTREAM'});
  }};
  const send=makeCallbackTransport({proxyEnv:PROXY,managedAdapter,lookup:async()=>[{address:'93.184.216.34',family:4}],request:()=>{directCalls++;throw Error('no direct');}});
  assert.equal(send.preflight().mode,'managed');assert.equal(send.preflight().network_checked,false);const result=await send(URL,opts());assert.equal(result.status,202);assert.deepEqual(Object.keys(result.headers),[]);assert.equal(adapterCalls,1);assert.equal(directCalls,0);
});
test('managed response validation and callback failures remain bounded/static and never fall back',async()=>{
  for(const reply of [()=>{throw Error('PRIVATE_SECRET '+URL);},()=>response(302),()=>response(200,Buffer.alloc(8193)),()=>response(200,Buffer.from('{}'),{'content-encoding':'gzip'}),()=>({status:200,body:'not-buffer'})]){
    let calls=0;const send=makeCallbackTransport({maxBytes:8192,proxyEnv:PROXY,lookup:async()=>[{address:'93.184.216.34',family:4}],request:()=>assert.fail('no direct fallback'),managedAdapter:{send:async()=>{calls++;return reply();}}});
    await assert.rejects(()=>send(URL,opts()),e=>e instanceof CallbackTransportError&&TRANSPORT_ERROR_CODES.includes(e.code)&&e.reason===e.code&&!JSON.stringify(e).includes('PRIVATE')&&e.cause===undefined);assert.equal(calls,1);
  }
});
test('managed abort and total deadline cancel the adapter; late results cannot report success or reconnect',async()=>{
  for(const mode of ['abort','timeout']){
    let enter;const ready=new Promise(r=>enter=r);let release;const pending=new Promise(r=>release=r);const c=new AbortController();let request;
    const send=makeCallbackTransport({timeoutMs:mode==='timeout'?10:1000,proxyEnv:PROXY,lookup:async()=>[{address:'93.184.216.34',family:4}],managedAdapter:{send:async(_t,r)=>{request=r;enter();return pending;}}});
    const sending=send(URL,opts({signal:c.signal}));await ready;if(mode==='abort')c.abort();await assert.rejects(sending,e=>e.code===mode||e.code==='aborted');assert.equal(request.signal.aborted,true);
    release(response());await assert.rejects(async()=>request.beforeConnect(),e=>e.code==='aborted');
  }
});
test('selected proxy and NO_PROXY CIDR are enforced before delegation; unsupported fallbacks never become direct',async()=>{
  const env={https_proxy:'http://chosen.example.test',HTTPS_PROXY:'unused-invalid',ALL_PROXY:'socks5://unused/path',no_proxy:'10.0.0.0/8',NO_PROXY:'invalid/unused'};
  assert.equal(preflightCallbackTransport({proxyEnv:env}).reason,'proxy_policy_unverified');assert.equal(preflightCallbackTransport({proxyEnv:{ALL_PROXY:'socks5://only/path'}}).reason,'proxy_unsupported');
  let delegated=0;const send=makeCallbackTransport({proxyEnv:{...env,no_proxy:'93.184.216.0/24'},lookup:async()=>[{address:'93.184.216.34',family:4}],managedAdapter:{send:async()=>{delegated++;return response();}}});
  await assert.rejects(()=>send(URL,opts()),e=>e.code==='proxy_unsupported');assert.equal(delegated,0);
  assert.equal(preflightCallbackTransport({proxyEnv:null}).reason,'proxy_unsupported');
});
test('mutating selected proxy or adapter cannot silently change an existing sender route',async()=>{
  const proxyEnv={...PROXY},managedAdapter={send:async()=>response()};const send=makeCallbackTransport({proxyEnv,managedAdapter,lookup:async()=>assert.fail('no DNS after mutation')});
  managedAdapter.send=async()=>response();assert.equal(send.preflight().reason,'adapter_invalid');await assert.rejects(()=>send(URL,opts()),e=>e.code==='adapter_invalid');
  const other=makeCallbackTransport({proxyEnv,managedAdapter});delete proxyEnv.HTTPS_PROXY;assert.equal(other.preflight().reason,'proxy_unsupported');await assert.rejects(()=>other(URL,opts()),e=>e.code==='proxy_unsupported');
});
test('managed guarded-operation callback preserves same-stack authorization and fences queued revocation',async()=>{
  let checks=0,revoked=false,operations=0;
  const send=makeCallbackTransport({proxyEnv:PROXY,lookup:async()=>[{address:'93.184.216.34',family:4}],managedAdapter:{send:async(_target,request)=>{
    const value=request.beforeConnect(()=>{assert.equal(revoked,false);operations++;return 'synchronous';});
    assert.equal(value,'synchronous');await Promise.resolve();assert.equal(revoked,true);
    request.beforeConnect(()=>{operations++;});return response();
  }}});
  await assert.rejects(()=>send(URL,opts({beforeConnect:()=>{checks++;if(revoked)throw Error('revoked');if(checks===4)queueMicrotask(()=>{revoked=true;});}})),e=>e.code==='gate_failed');
  assert.equal(operations,1);
});
test('status preflight never substitutes explicit null or trusts inherited adapter methods',()=>{
  assert.deepEqual(makeCallbackTransport({proxyEnv:null}).preflight(),{ready:false,mode:'blocked',reason:'proxy_unsupported',proxy_configured:false,destination_binding:'unverified',network_checked:false});
  const inherited=Object.assign(Object.create({send:async()=>response()}),{unrelated:true});assert.equal(preflightCallbackTransport({proxyEnv:PROXY,managedAdapter:inherited}).reason,'adapter_invalid');
  const hostile={};Object.defineProperty(hostile,'https_proxy',{get(){throw Error('PRIVATE_CONFIGURATION');}});
  assert.doesNotThrow(()=>makeCallbackTransport({proxyEnv:hostile}).preflight());assert.equal(makeCallbackTransport({proxyEnv:hostile}).preflight().reason,'proxy_unsupported');
});
test('shared package copies independently without dependencies, workspace paths or network setup',t=>{
  const root=fileURLToPath(new globalThis.URL('../',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'callback-package-copy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['package.json','index.js','status.js','transport.js','README.md'])fs.copyFileSync(path.join(root,name),path.join(dir,name));
  const script=`import {makeCallbackTransport,callbackTransportStatusSchema} from ${JSON.stringify(pathToFileURL(path.join(dir,'index.js')).href)}; const send=makeCallbackTransport({proxyEnv:{}}); if(!send.preflight().ready||callbackTransportStatusSchema.required.length!==6)throw Error('copy contract');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{},encoding:'utf8',timeout:3000});assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});
