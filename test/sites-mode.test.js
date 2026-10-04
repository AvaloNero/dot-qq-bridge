import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { acquireModeLock, bridgeMode } from '../src/bridge-mode.js';
import { createSitesClient } from '../src/sites-client.js';
import { SitesBridge } from '../src/sites-runtime.js';
const now = Date.now();
const config = () => ({ ...readConfig({ BRIDGE_MODE: 'sites', AUTH_MODE: 'sites', QQ_APP_ID: 'fixture', QQ_BOT_SECRET: 'fixture-secret', QQ_OWNER_OPENID: 'owner', MCP_OWNER_SUBJECT: 'sites:binding', QQ_TRANSPORT: 'gateway', STORAGE_KEY: Buffer.alloc(32,1).toString('base64') }), dbPath: ':memory:', sitesOrigin: 'https://site.example', sitesBindingId: 'binding', sitesPlatformToken: 'platform-fixture', sitesConnectorToken: 'connector-fixture' });
test('mode must be explicit and shared lock rejects simultaneous tunnel/sites consumers', t => {
  assert.throws(() => bridgeMode({})); assert.equal(bridgeMode({ BRIDGE_MODE: 'sites' }), 'sites');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lock-test-')); t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const release = acquireModeLock(directory,'qq','app','tunnel');
  assert.throws(() => acquireModeLock(directory,'qq','app','sites')); release(); release();
  acquireModeLock(directory,'qq','app','sites')();
});
test('Sites client validates authenticated lease, fixed routes, subscription and two credential separation', async () => {
  const calls = []; let time = now;
  const client = createSitesClient(config(), { clock: () => time, send: async (url, options) => {
    options.beforeConnect(); calls.push({url,options}); const route = new URL(url).pathname;
    const value = route === '/bridge/lease' ? {binding_id:'binding',channel:'qq',mode:'sites',subscription_id:'sub',lease_token:'lease',expires_at:new Date(now+90000).toISOString(),subscription_active:true} : {message_id:'message',status:'accepted'};
    return {status:200,body:Buffer.from(JSON.stringify(value))};
  } });
  assert.equal(client.active(),null); await client.renew();
  await client.ingest({id:'message',subscription_id:'sub',event_id:'event',text:'fixture text',occurred_at:new Date(now).toISOString(),expires:now+60000});
  assert.equal(calls[1].options.headers.Authorization,'Bearer connector-fixture');
  assert.equal(JSON.parse(calls[1].options.body).subscription_id,'sub');
  assert.ok(!calls[1].options.body.toString().includes('owner')); assert.ok(!calls[1].options.body.toString().includes('fixture-secret'));
  await assert.rejects(client.ingest({subscription_id:'other'})); time += 90001; assert.equal(client.active(),null);
});
test('Sites QQ adapter uploads verified owner message and replies once with durable receipt', async () => {
  const lease = {id:'sub',token:'lease',expires:now+90000,active:true,principal:'sites:binding'}; let remote=null, sends=0, uploaded=0, acked=0;
  const client = {active:()=>lease,async renew(){return lease;},async claim(){const value=remote;remote=null;return value;},async ingest(){uploaded++;},async ack(){acked++;remote=null;},revoke(){}};
  const bridge = new SitesBridge(config(),{clock:()=>now,client,send:async()=>{throw new Error('No network');}});
  try {
    bridge.acceptQq({op:0,t:'C2C_MESSAGE_CREATE',id:'evt',d:{id:'message',author:{user_openid:'owner'},content:'fixture text',timestamp:new Date(now).toISOString()}},'replay');
    await bridge.tick(); assert.equal(uploaded,1);
    remote={subscription_id:'sub',message_id:'message',text:'fixture reply',reply_deadline:new Date(now+240000).toISOString(),claim_token:'claim',claim_expires_at:new Date(now+60000).toISOString()};
    bridge.acceptQq({op:0,t:'C2C_MESSAGE_CREATE',id:'evt2',d:{id:'message2',author:{user_openid:'owner'},content:'another fixture',timestamp:new Date(now).toISOString()}},'replay2');
    bridge.sendQq=async(message,text,{authorize})=>{authorize();sends++;return 'outbound';};
    await bridge.tick(); assert.equal(sends,0); assert.ok(bridge.retainedClaim());
    await bridge.tick(); assert.equal(sends,1); assert.equal(acked,1); assert.equal(bridge.store.replyStatus('message').status,'sent');
    await bridge.tick(); assert.equal(sends,1);
  } finally {bridge.store.close();}
});

test('durable claim expiry prevents delayed reply and leaves an uncertain terminal outcome', async () => {
  let time=now, remote, sends=0;
  const lease={id:'sub',token:'lease',expires:now+90000,active:true,principal:'sites:binding'};
  const client={active:()=>lease,async renew(){return lease;},async claim(){const value=remote;remote=null;return value;},async ingest(){},async ack(){},revoke(){}};
  const bridge=new SitesBridge(config(),{clock:()=>time,client,send:async()=>{throw new Error('No network');}});
  const ingest=(id)=>bridge.acceptQq({op:0,t:'C2C_MESSAGE_CREATE',id:'evt'+id,d:{id,author:{user_openid:'owner'},content:'fixture',timestamp:new Date(now).toISOString()}},'replay'+id);
  try {
    ingest('message');await bridge.tick();ingest('message2');
    remote={subscription_id:'sub',message_id:'message',text:'reply',reply_deadline:new Date(now+240000).toISOString(),claim_token:'claim',claim_expires_at:new Date(now+1000).toISOString()};
    bridge.sendQq=async()=>{sends++;return 'out';};
    await bridge.tick();time+=2000;await bridge.tick();assert.equal(sends,0);assert.equal(bridge.store.replyStatus('message').status,'uncertain');
  } finally {bridge.store.close();}
});
test('failed acknowledgement retries from durable claim without sending reply again', async () => {
  let remote, sends=0, acknowledgements=0;
  const lease={id:'sub',token:'lease',expires:now+90000,active:true,principal:'sites:binding'};
  const client={active:()=>lease,async renew(){return lease;},async claim(){const value=remote;remote=null;return value;},async ingest(){},async ack(){if(++acknowledgements===1)throw new Error('fixture timeout');},revoke(){}};
  const bridge=new SitesBridge(config(),{clock:()=>now,client,send:async()=>{throw new Error('No network');}});
  try {
    bridge.acceptQq({op:0,t:'C2C_MESSAGE_CREATE',id:'evt',d:{id:'message',author:{user_openid:'owner'},content:'fixture',timestamp:new Date(now).toISOString()}},'replay');await bridge.tick();
    remote={subscription_id:'sub',message_id:'message',text:'reply',reply_deadline:new Date(now+240000).toISOString(),claim_token:'claim',claim_expires_at:new Date(now+60000).toISOString()};
    bridge.sendQq=async(message,text,{authorize})=>{authorize();sends++;return 'out';};
    await bridge.tick();assert.ok(bridge.retainedClaim());await bridge.tick();assert.equal(sends,1);assert.equal(acknowledgements,2);assert.equal(bridge.retainedClaim(),null);
  } finally {bridge.store.close();}
});
