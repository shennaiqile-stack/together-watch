/* Actual local/public WebSocket clients must share one roster and playback state. */
const fs=require('fs'),vm=require('vm'),path=require('path');
const base='http://127.0.0.1:8770';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(route,body){const response=await fetch(base+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!response.ok)throw new Error('Local service '+response.status);return response.json();}
function client(origin,key){const context=vm.createContext({window:{API:{base:origin,key}},API:{base:origin,key},WebSocket,setTimeout,clearTimeout,console});vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../web/js/sync.js'),'utf8'),context);return new context.window.SyncClient();}
function next(client,event,predicate=()=>true){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out: '+event)),12000);client.on(event,value=>{if(predicate(value)){clearTimeout(timer);resolve(value);}});});}
(async()=>{
 const before=await api('/api/relay');let a,b;let started=false;
 try{
  if(before.status!=='running'){await api('/api/relay/start',{});started=true;}
  let relay;
  for(let i=0;i<30;i++){relay=await api('/api/relay');if(relay.status==='running')break;if(relay.status==='error')throw new Error(relay.error||'External access failed');await delay(500);}
  if(relay.status!=='running'||!relay.url)throw new Error('External access not ready');
  a=client(base,'');b=client(relay.url,relay.token||'');
  const room='NET'+Date.now().toString(36).toUpperCase();
  const ac=next(a,'connected'),bc=next(b,'connected');
  await a.join({username:'NetCheckLocal',room,port:8999});await ac;
  const roster=next(a,'users',e=>((e.rooms||{})[room]||[]).some(u=>u.name==='NetCheckPublic'));
  await b.join({username:'NetCheckPublic',room,port:8999});await bc;
  a.send({op:'list'});await roster;
  const file=next(b,'user_event',e=>(e.file||{}).name==='anime:giri:25524:1:39');
  a.file('anime:giri:25524:1:39',55.055);await file;
  const state=next(b,'state',e=>Math.abs(Number(e.position)-12)<1&&e.paused===true);
  a.state(12,true,true);await state;
  const result={version:(await api('/api/health')).version,publicOrigin:relay.url,room,localAndPublicSameRoster:true,stableEpisodeReceived:true,pauseAndSeekReceived:true,restoredExternalState:before.status};
  fs.writeFileSync(path.resolve(__dirname,'../../refactor-evidence/external-room-'+result.version+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(a)a.leave();if(b)b.leave();if(started)await api('/api/relay/stop',{});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
