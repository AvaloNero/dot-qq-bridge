import { privateMkdtempSync, privateMkdirSync, fixtureChmodSync, cleanupPrivateFixture, beforeFixtureCleanup } from '../../dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/server.js';
import { OWNER, VERSION, SERVICE_HEADER, metadata } from '../src/common.js';
// QQ contains this package; Lark is a sibling clone of the QQ repository.
const sibling = name => name === 'dot-qq-bridge' ? new URL('../../../src/', import.meta.url)
  : process.env.LARK_BRIDGE_SOURCE_ROOT ? pathToFileURL(path.resolve(process.env.LARK_BRIDGE_SOURCE_ROOT) + path.sep)
  : new URL('../../../../dot-lark-bridge/src/', import.meta.url);
const qqSource = new URL('server.js', sibling('dot-qq-bridge'));
const larkSource = new URL('server.js', sibling('dot-lark-bridge'));
const available = fs.existsSync(qqSource) && fs.existsSync(larkSource);
test('synthetic compatibility with actual sibling QQ and Lark readiness contracts; no provider traffic', { skip: !available }, async t => {
  const dir = privateMkdtempSync(path.join(os.tmpdir(), 'dot-aggregate-contract-')); fixtureChmodSync(dir, 0o700);
  cleanupPrivateFixture(t, dir);
  const keys = [51,52,53].map(value => Buffer.alloc(32, value).toString('base64url'));
  const files = keys.map((key,i) => { const file = path.join(dir, `key-${i}`); fs.writeFileSync(file, key, { mode: 0o600 }); return file; });
  const { createApp: createQq } = await import(qqSource); const { createApp: createLark } = await import(larkSource);
  const { readConfig: readQq } = await import(new URL('config.js', sibling('dot-qq-bridge')));
  const { readConfig: readLark } = await import(new URL('config.js', sibling('dot-lark-bridge')));
  const env = { AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_OWNER_ID: OWNER,
    QQ_TRANSPORT: 'disabled', LARK_TRANSPORT: 'disabled' };
  let providerRequests = 0;
  const send = async () => { providerRequests++; throw Error('Synthetic tests forbid provider traffic'); };
  const qq = createQq({ ...readQq({ ...env, TUNNEL_SERVICE_KEY_FILE: files[1] }), dbPath: ':memory:', storageKey: Buffer.alloc(32,54).toString('base64') }, { worker: false, send });
  const lark = createLark({ ...readLark({ ...env, TUNNEL_SERVICE_KEY_FILE: files[2] }), dbPath: ':memory:', storageKey: Buffer.alloc(32,54).toString('base64') }, { worker: false, send });
  beforeFixtureCleanup(t, async () => { await qq.close(); await lark.close(); });
  const qqAddress = await qq.listen(0), larkAddress = await lark.listen(0);
  const app = createApp({ host: '127.0.0.1', port: 8789, owner: OWNER, ingressKeyFile: files[0], qqKeyFile: files[1], larkKeyFile: files[2], qqPort: qqAddress.port, larkPort: larkAddress.port });
  beforeFixtureCleanup(t, () => app.close()); const address = await app.listen(0);
  const call = name => new Promise((resolve,reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {}, _meta: metadata() } });
    const req = http.request({ host: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST', agent: false,
      headers: { [SERVICE_HEADER]: keys[0], 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-method': 'tools/call', 'mcp-name': name, 'mcp-protocol-version': VERSION } }, res => {
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });req.on('error',reject);req.end(body);
  });
  const qqResult = await call('check_bridge_setup'), larkResult = await call('check_lark_readiness');
  assert.equal(qqResult.status, 200); assert.equal(qqResult.body.result.structuredContent.configuration_ready, false);
  assert.equal(larkResult.status, 200); assert.equal(larkResult.body.result.structuredContent.authenticated_mcp_reachable, true);
  assert.equal(providerRequests, 0);
  assert.equal(await qq.bridge.tick(), false); assert.equal(await lark.bridge.tick(), false);
  // Verify copied strict protocol implementation remains byte-identical to both originals.
  const extract = source => source.slice(source.indexOf('function decodedName('), source.indexOf('\n\nexport function createApp'));
  const originalQq = fs.readFileSync(qqSource, 'utf8'), originalLark = fs.readFileSync(larkSource, 'utf8');
  const local = fs.readFileSync(new URL('../src/protocol.js', import.meta.url), 'utf8');
  assert.equal(local.slice(local.indexOf('function decodedName(')).trim(), extract(originalQq).trim());
  assert.equal(extract(originalQq), extract(originalLark));
});

test('synthetic actual sibling live catalogs and pending-callback preflight; no gateway/provider/challenge calls', {skip:!available}, async t=>{
  const dir=privateMkdtempSync(path.join(os.tmpdir(),'aggregate-live-contract-'));fixtureChmodSync(dir,0o700);cleanupPrivateFixture(t,dir);
  const qqDir=path.join(dir,'qq'),larkDir=path.join(dir,'lark');privateMkdirSync(qqDir,{mode:0o700});privateMkdirSync(larkDir,{mode:0o700});
  const keyValues=[101,102,103,104,105].map(x=>Buffer.alloc(32,x).toString('base64url'));
  const keyFiles=keyValues.map((value,i)=>{const file=path.join(dir,`key-${i}`);fs.writeFileSync(file,value,{mode:0o600});return file;});
  const {saveQqCredentials}=await import(new URL('credential-store.js',sibling('dot-qq-bridge')));
  saveQqCredentials({appId:'fixture-app',appSecret:'synthetic-qq-secret',ownerOpenid:'fixture_owner',ownerEvidence:'official-qr-response'},
    {directory:qqDir,expectedAppId:'fixture-app',profile:'tencent-sdk'});
  const larkCredentials=path.join(larkDir,'paired.json');fs.writeFileSync(larkCredentials,JSON.stringify({version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-lark-secret',tenantKey:'fixture_tenant',ownerOpenId:'fixture_owner',ownerChatId:'fixture_chat'}),{mode:0o600});
  const {readConfig:readQq}=await import(new URL('config.js',sibling('dot-qq-bridge'))),{readConfig:readLark}=await import(new URL('config.js',sibling('dot-lark-bridge')));
  const {createApp:createQq}=await import(qqSource),{createApp:createLark}=await import(larkSource);
  const common={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',TUNNEL_SERVICE_OWNER_ID:OWNER};
  const qqConfig=readQq({...common,TUNNEL_SERVICE_KEY_FILE:keyFiles[1],QQ_APP_ID:'fixture-app',QQ_CREDENTIALS_FILE:path.join(qqDir,'credentials.json'),QQ_API_PROFILE:'tencent-sdk',QQ_TRANSPORT:'gateway',STORAGE_KEY_FILE:keyFiles[3],DATABASE_PATH:path.join(qqDir,'test.sqlite'),BRIDGE_LOCK_DIRECTORY:qqDir});
  const larkConfig=readLark({...common,TUNNEL_SERVICE_KEY_FILE:keyFiles[2],LARK_EXPECTED_APP_ID:'cli_0123456789abcdef',LARK_CREDENTIALS_FILE:larkCredentials,LARK_TRANSPORT:'long-connection',STORAGE_KEY_FILE:keyFiles[4],DATABASE_PATH:path.join(larkDir,'test.sqlite'),BRIDGE_LOCK_DIRECTORY:larkDir});
  let requests=0,wsStarts=0;const send=async()=>{requests++;throw Error('Synthetic contract test forbids all external requests');};
  class Dispatcher{register(){return this;}async invoke(){}}
  class WS{async start(){wsStarts++;throw Error('Synthetic contract test forbids gateway');}close(){}}
  const sdk={EventDispatcher:Dispatcher,WSClient:WS,LoggerLevel:{warn:1},Domain:{Feishu:'feishu'}};
  const qq=createQq(qqConfig,{approvedLive:true,worker:false,send}),lark=createLark(larkConfig,{approvedLive:true,worker:false,send,sdk});
  beforeFixtureCleanup(t,async()=>{await qq.close();await lark.close();});
  const qa=await qq.listen(0),la=await lark.listen(0);
  const app=createApp({host:'127.0.0.1',port:8789,owner:OWNER,ingressKeyFile:keyFiles[0],qqKeyFile:keyFiles[1],larkKeyFile:keyFiles[2],qqPort:qa.port,larkPort:la.port,operation:'live',liveChannels:['qq','lark']},{approvedLive:true});beforeFixtureCleanup(t,()=>app.close());const address=await app.listen(0);
  const post=(method,params={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:address.port,path:'/mcp',method:'POST',agent:false,headers:{[SERVICE_HEADER]:keyValues[0],'content-type':'application/json',accept:'application/json, text/event-stream','mcp-method':method,'mcp-protocol-version':VERSION,...(method==='tools/call'?{'mcp-name':params.name}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:metadata()}}));});
  const catalog=await post('tools/list');assert.equal(catalog.status,200);assert.equal(catalog.body.result.tools.length,6);
  const events=await post('events/list');assert.equal(events.status,200);assert.equal(events.body.result.events.length,2);
  const callback='https://callback.example.test/private-path?fixture-secret=canary';
  for(const [name,policy]of [['check_bridge_setup','blocked'],['check_lark_readiness','not_allowlisted']]){
    const result=await post('tools/call',{name,arguments:{callback_url:callback}});assert.equal(result.status,200);assert.equal(result.body.result.structuredContent.callback_policy,policy);assert.equal(JSON.stringify(result).includes('private-path'),false);
  }
  for(const channel of ['qq','lark']){const result=await post('events/subscribe',{name:`${channel}.message.created`,arguments:{conversation:'owner'},delivery:{mode:'webhook',url:callback,secret:'whsec_'+Buffer.alloc(32,106).toString('base64')},ttlMs:60000});assert.equal(result.status,403);assert.deepEqual(result.body.error.data,{reason:'callback_policy_required',callback_hostname:'callback.example.test'});assert.equal(JSON.stringify(result).includes('private-path'),false);}
  assert.equal(requests,0);assert.equal(wsStarts,0);
});

for(const replyOutcome of ['sent','uncertain'])test(`actual owner Lark delayed reply returns ${replyOutcome} once through aggregate HTTP`, {skip:!available}, async t=>{
  const dir=privateMkdtempSync(path.join(os.tmpdir(),'aggregate-owner-recovery-'));fixtureChmodSync(dir,0o700);cleanupPrivateFixture(t,dir);
  const keys=[111,112,113].map(value=>Buffer.alloc(32,value).toString('base64url'));
  const files=keys.map((value,i)=>{const file=path.join(dir,`key-${i}`);fs.writeFileSync(file,value,{mode:0o600});return file;});
  const {createApp:createQq}=await import(qqSource),{readConfig:readQq}=await import(new URL('config.js',sibling('dot-qq-bridge')));
  const {readTunnelReadinessConfig}=await import(new URL('config.js',sibling('dot-lark-bridge')));
  const {createLarkOwnerMessageSession}=await import(new URL('owner-message-session.js',sibling('dot-lark-bridge')));
  const {createOwnerMessageRuntime}=await import(new URL('owner-message-runtime.js',sibling('dot-lark-bridge')));
  const {makeOwnerMessageExperimentTransport,ownerMessageExperimentStatus}=await import('../../dot-bridge-transport/experimental/owner-message.js');
  const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OWNER_ID:OWNER,QQ_TRANSPORT:'disabled',LARK_TRANSPORT:'disabled'};
  const qq=createQq({...readQq({...env,TUNNEL_SERVICE_KEY_FILE:files[1]}),dbPath:':memory:',storageKey:Buffer.alloc(32,114).toString('base64')},{worker:false,send:async()=>{throw Error('No QQ provider request');}});
  beforeFixtureCleanup(t,()=>qq.close());const qa=await qq.listen(0);
  const credentials={version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-app-secret',tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'};
  const proxyEnv={HTTPS_PROXY:'http://proxy.example:8080'},text='Synthetic owner message for ID recovery',fixedReply='synthetic fixed reply';
  let dispatcher,callbacks=0,replies=0;
  const transport=makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel:'lark',acceptAnyOwnerText:true,waitForOwner:true,proxyEnv,connect:async(_u,_p,r)=>{
    await r.beforeConnect();callbacks++;const body=JSON.parse(r.body);return{status:200,body:Buffer.from(JSON.stringify(body.type==='verification'?{challenge:body.challenge}:{}))};
  }});
  const providerSend=async(url,options)=>{
    await options.beforeConnect();
    // Real elapsed delay crosses the former aggregate three-second cutoff.
    // Both provider steps remain inert and below their ten-second budgets.
    await new Promise(resolve=>setTimeout(resolve,1700));
    if(url.endsWith('/tenant_access_token/internal'))return{status:200,body:Buffer.from(JSON.stringify({code:0,tenant_access_token:'synthetic-token',expire:7200}))};
    assert.equal(url,'https://open.feishu.cn/open-apis/im/v1/messages/fixture-message/reply');
    assert.equal(JSON.parse(JSON.parse(options.body).content).text,fixedReply);replies++;
    return{status:200,body:Buffer.from(JSON.stringify(replyOutcome==='sent'?{code:0,data:{message_id:'fixture-reply',chat_id:'chat'}}:{code:0,data:{chat_id:'chat'}}))};
  };
  const session=createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,acceptAnyOwnerText:true,fixedReply,waitForOwner:true,authenticatedCallbackDiscovery:true,callbackTransport:transport,recognizeTransport:ownerMessageExperimentStatus,proxyEnv,providerSend});
  const authConfig={...readTunnelReadinessConfig({...env,TUNNEL_SERVICE_KEY_FILE:files[2]}),host:'127.0.0.1',port:0};
  const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,session,authConfig,connectionConfig:{larkAppId:credentials.appId},lockDirectory:dir,providerSend,modeLock:()=>()=>{},connectionFactory:(_c,target)=>{dispatcher=target;return{async start(){},close(){},status:()=> 'connected'};}});
  beforeFixtureCleanup(t,()=>runtime.close());const la=await runtime.start();
  const app=createApp({host:'127.0.0.1',port:8789,owner:OWNER,ingressKeyFile:files[0],qqKeyFile:files[1],larkKeyFile:files[2],qqPort:qa.port,larkPort:la.port,operation:'live',liveChannels:['lark']},{approvedLive:true});
  beforeFixtureCleanup(t,()=>app.close());const address=await app.listen(0);
  const post=(method,params={},key=keys[0])=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:address.port,path:'/mcp',method:'POST',agent:false,headers:{[SERVICE_HEADER]:key,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-method':method,'mcp-protocol-version':VERSION,...(method==='tools/call'?{'mcp-name':params.name}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});
    req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:metadata()}}));
  });
  const call=(name,args={},key)=>post('tools/call',{name,arguments:args},key);
  assert.equal((await call('check_lark_readiness')).status,200);assert.equal(callbacks,0);
  const subscribed=await post('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://callback.example.test/private-fixture',secret:'whsec_'+Buffer.alloc(32,115).toString('base64')},ttlMs:60000});
  assert.equal(subscribed.status,200);assert.equal(callbacks,1);
  const now=Date.now();const envelope={schema:'2.0',header:{event_id:'fixture-event',event_type:'im.message.receive_v1',create_time:String(now),app_id:credentials.appId,tenant_key:'tenant'},event:{sender:{sender_id:{open_id:'owner'},sender_type:'user',tenant_key:'tenant'},message:{message_id:'fixture-message',chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};
  assert.equal((await dispatcher.invoke(envelope)).outcome,'delivered');assert.equal(callbacks,2);
  const unauthorized=await call('check_lark_readiness',{},keys[1]);assert.equal(unauthorized.status,401);assert.equal(JSON.stringify(unauthorized.body).includes('fixture-message'),false);
  const recovered=await call('check_lark_readiness');assert.equal(recovered.status,200);
  const pending=recovered.body.result.structuredContent.pending_message;assert.equal(pending.message_id,'fixture-message');assert.ok(Date.parse(pending.reply_deadline)>Date.now());
  const metadataText=JSON.stringify(recovered.body);for(const privateValue of [text,'synthetic-token','synthetic-app-secret','private-fixture'])assert.equal(metadataText.includes(privateValue),false);
  assert.deepEqual((await call('check_lark_readiness')).body.result.structuredContent.pending_message,pending);assert.equal(replies,0);
  const read=await call('get_lark_message',{message_id:pending.message_id});assert.equal(read.status,200);assert.equal(read.body.result.structuredContent.text,text);
  const replyStarted=Date.now();const reply=await call('reply_to_lark',{message_id:pending.message_id,text:fixedReply});assert.ok(Date.now()-replyStarted>=3300);assert.equal(reply.status,200);assert.equal(reply.body.result.structuredContent.status,replyOutcome);assert.equal(replies,1);
  assert.notEqual((await call('reply_to_lark',{message_id:pending.message_id,text:fixedReply})).status,200);assert.equal(replies,1);assert.equal(callbacks,2);
});
