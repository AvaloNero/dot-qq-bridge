import http from 'node:http';
import { TextDecoder } from 'node:util';
import { VERSION, SERVICE_HEADER, metadata, loopback, object } from './common.js';
import { validateConfig } from './config.js';
import { canonicalKey } from './auth.js';
import { expectedBackendTools, liveEventDefinitions, sameSchema, matchesBackendOutputSchema } from './catalog.js';
import { record, unavailable, enabled, validateToolCall, validateEventCall, projectToolResult, projectSubscription, projectUpstreamError, projectLarkPreflight } from './live-contract.js';
const MAX_RESPONSE = 32768, MAX_REQUEST = 32768;
const empty = value => record(value) && Object.keys(value).length === 0;
export function createUpstreamClient(input, keys, { approvedLive = false } = {}) {
  const config=validateConfig(input);
  if(config.operation === 'live' && approvedLive !== true)throw new Error('Explicit live activation approval is required');
  if (!canonicalKey(keys?.qq) || !canonicalKey(keys?.lark) || keys.qq === keys.lark) throw new Error('Independent upstream service keys required');
  // Fixed local endpoints only. No proxy env/global agent, redirects or caller
  // headers. Callback URLs are opaque validated parameters to one fixed backend.
  const routes=Object.freeze({qq:Object.freeze({port:config.qqPort,key:keys.qq}),lark:Object.freeze({port:config.larkPort,key:keys.lark})});
  const active=new Set();let stopping=false;
  function call(routeName,method,params={}) {
    const route=routes[routeName];
    if (stopping || !route || !['server/discover','tools/list','events/list','tools/call','events/subscribe','events/unsubscribe'].includes(method)) return Promise.reject(unavailable());
    if (method === 'tools/call') {
      const input=params.name === 'check_lark_setup' ? {...params,name:'check_lark_readiness'} : params;
      const checked=validateToolCall(config,input);
      if(checked.channel !== routeName || (params.name === 'check_lark_setup' && !enabled(config,'lark')) || params.name === 'check_lark_readiness') return Promise.reject(unavailable());
    }
    if (method.startsWith('events/') && method !== 'events/list') { const checked=validateEventCall(config,method,params);if(checked.channel !== routeName) return Promise.reject(unavailable()); }
    const body=JSON.stringify({jsonrpc:'2.0',id:'readiness',method,params:{...params,_meta:metadata()}});
    if(Buffer.byteLength(body)>MAX_REQUEST)return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      let done=false,timer,req;
      const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);active.delete(req);if(error){req?.destroy();reject(error instanceof Error ? error : unavailable());}else resolve(result);};
      try {
        req=http.request({hostname:'127.0.0.1',port:route.port,path:'/mcp',method:'POST',agent:false,maxHeaderSize:8192,
          headers:{host:`127.0.0.1:${route.port}`,'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(body),connection:'close',
            'mcp-protocol-version':VERSION,'mcp-method':method,...(method === 'tools/call' ? {'mcp-name':params.name} : {}),[SERVICE_HEADER]:route.key}},res=>{
          if (![200,400,401,403,404,409,429,500,502,503].includes(res.statusCode) || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '') ||
              (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'])>MAX_RESPONSE) {finish(true);res.destroy();return;}
          let size=0;const chunks=[];
          res.on('data',chunk=>{size+=chunk.length;if(size>MAX_RESPONSE){finish(true);res.destroy();}else chunks.push(chunk);});
          res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
          res.on('end',()=>{if(done)return;try{
            const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
            if(!record(value)||value.jsonrpc!=='2.0'||value.id!=='readiness')throw new Error();
            if(Object.hasOwn(value,'error')) { finish(config.operation === 'live' ? projectUpstreamError(value,params,{method,channel:routeName}) : true);return; }
            if(res.statusCode!==200||!record(value.result)||value.result.resultType!=='complete')throw new Error();
            finish(false,value.result);
          }catch{finish(true);}});
        });active.add(req);
        req.on('socket',socket=>socket.once('connect',()=>{if(!loopback(socket.remoteAddress))finish(true);}));req.on('error',()=>finish(true));
        // No automatic retries: a timed-out mutation may already have committed.
        timer=setTimeout(()=>finish(true),method === 'events/subscribe' ? 35000 : 3000);req.end(body);
      }catch{finish(true);}
    });
  }
  async function checkCatalog(channel) {
    const live=enabled(config,channel),discover=await call(channel,'server/discover');
    if(!Array.isArray(discover.supportedVersions)||discover.supportedVersions.length!==1||discover.supportedVersions[0]!==VERSION||!record(discover.capabilities)||
       !empty(discover.capabilities.tools)||!empty(discover.capabilities.events)||Object.keys(discover.capabilities).some(k=>!['tools','events'].includes(k)))throw unavailable();
    const catalog=await call(channel,'tools/list'),expected=expectedBackendTools(channel,live);
    if(!Array.isArray(catalog.tools)||catalog.tools.length!==expected.length||new Set(catalog.tools.map(t=>t?.name)).size!==expected.length)throw unavailable();
    for(const tool of catalog.tools){const target=expected.find(x=>x.name===tool?.name);if(!target)throw unavailable();
      if(live && (!sameSchema(tool.inputSchema,target.inputSchema)||!matchesBackendOutputSchema(channel,tool.name,tool.outputSchema,target.outputSchema)||!sameSchema(tool.annotations,target.annotations)))throw unavailable();}
    const events=await call(channel,'events/list');
    if(!Array.isArray(events.events)||events.events.length!==(live?1:0)||[catalog,events].some(v=>Object.hasOwn(v,'nextCursor')&&v.nextCursor!==null))throw unavailable();
    if(live){const e=events.events[0],target=liveEventDefinitions[channel];if(!record(e)||e.name!==target.name||!sameSchema(e.delivery,target.delivery)||!sameSchema(e.inputSchema,target.inputSchema)||!sameSchema(e.payloadSchema,target.payloadSchema))throw unavailable();}
  }
  async function tool(params) {
    const checked=validateToolCall(config,params);await checkCatalog(checked.channel);
    if(checked.name==='check_lark_readiness') {
      if(!enabled(config,'lark'))return {authenticated_mcp_reachable:true,readiness_catalog_only:true,provider_network_checked:false,ready_for_delivery:false,end_to_end_verified:false};
      const result=await call('lark','tools/call',{name:'check_lark_setup',arguments:checked.arguments});return projectLarkPreflight(checked,result);
    }
    const result=await call(checked.channel,'tools/call',{name:checked.name,arguments:checked.arguments});
    return projectToolResult(checked,result,enabled(config,checked.channel));
  }
  return {
    verifyCatalogs:async()=>{await checkCatalog('qq');await checkCatalog('lark');},
    qqSetup:()=>tool({name:'check_bridge_setup',arguments:{}}),larkReadiness:()=>tool({name:'check_lark_readiness',arguments:{}}),tool,
    async event(method,params){
      const checked=validateEventCall(config,method,params);await checkCatalog(checked.channel);
      const startedAt=Date.now(),result=await call(checked.channel,method,checked.params);
      if(method==='events/subscribe')return projectSubscription(result,checked.params,startedAt);
      try{object(result,['resultType','_meta']);return {};}catch{throw unavailable();}
    },
    close(){stopping=true;for(const req of active)req.destroy();active.clear();}
  };
}
