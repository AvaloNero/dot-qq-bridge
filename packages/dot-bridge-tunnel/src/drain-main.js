import {pathToFileURL} from 'node:url';
import {readConfig} from './config.js';
import {createApp} from './server.js';
import {supervisedStop} from '../../dot-bridge-platform/supervised-stop.js';

// Planned listener replacement: finish accepted HTTP responses before closing
// their upstream requests. Existing body/upstream/socket deadlines stay in force.
export async function drainAggregate(app){
 if(!app)return;
 await new Promise((resolve,reject)=>{
  app.server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve());
 });
 await app.close();
}
async function main(){
 let app,closing,finishStart,stopSupervision=()=>{};
 const settled=new Promise(resolve=>{finishStart=resolve;});
 const stop=()=>{
  stopSupervision();
  if(!closing)closing=(async()=>{await settled;try{await drainAggregate(app);}catch{process.exitCode=1;}})();
  return closing;
 };
 for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.once(name,()=>{void stop();});
 stopSupervision=supervisedStop(stop);
 try{
  if(process.argv.length!==3||process.argv[2]!=='--confirm-live')throw Error();
  const config=readConfig();if(config.operation!=='live')throw Error();
  app=createApp(config,{approvedLive:true});await app.listen();
 }catch{
  process.exitCode=1;process.stderr.write('Live aggregate entry refused or failed; no private values printed.\n');
  finishStart();await stop();
 }finally{finishStart();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
