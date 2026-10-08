import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {drainAggregate} from '../src/drain-main.js';

test('planned aggregate replacement drains an accepted response before closing upstream resources',async t=>{
 let entered,release,finished=false,upstreamClosed=false;
 const received=new Promise(resolve=>{entered=resolve;}),allowed=new Promise(resolve=>{release=resolve;});
 const server=http.createServer(async(_req,res)=>{entered();await allowed;res.writeHead(200,{connection:'close'});res.once('finish',()=>{finished=true;});res.end('synthetic reply');});
 t.after(()=>{release();server.closeAllConnections();server.close();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const reply=new Promise((resolve,reject)=>{const req=http.get(`http://127.0.0.1:${server.address().port}`,res=>{let data='';res.on('data',chunk=>{data+=chunk;});res.on('end',()=>resolve(data));});req.on('error',reject);});
 await received;const drained=drainAggregate({server,async close(){assert.equal(finished,true);upstreamClosed=true;}});
 assert.equal(upstreamClosed,false);release();assert.equal(await reply,'synthetic reply');await drained;assert.equal(upstreamClosed,true);
});
test('draining a missing or not-yet-listening app still settles cleanly',async()=>{
 await drainAggregate();let closed=0;const server=http.createServer();
 await drainAggregate({server,async close(){closed++;}});assert.equal(closed,1);
});
test('draining CLI requires exact explicit live confirmation before reading configuration',()=>{
 for(const args of [[],['--other'],['--confirm-live','--confirm-live']]){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/drain-main.js',import.meta.url)),...args],{env:{TUNNEL_SERVICE_KEY_FILE:'/synthetic-private-must-not-read'},encoding:'utf8',timeout:2000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('synthetic-private-must-not-read'),false);
 }
});
