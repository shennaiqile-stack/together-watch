const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),requests=[];
const rule={id:'giri',name:'giriGiriLove',base:'https://ani.girigirilove.com',rule:'giriGiriLove',version:'2.6',hash:'old'};
const context=vm.createContext({window:{API:{base:'http://room.example:8770'}},console,AbortController,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,Uint8Array,Map,Set,crypto:crypto.webcrypto,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),fetch:async url=>{
  requests.push(url);if(url==='/art/providers.json')return {json:async()=>[rule]};
  const source=new URL(url,'http://device.local');assert.equal(source.pathname,'/api/source-http');const target=source.searchParams.get('u');let data;
  if(target.includes('get_list'))data={info:{rows:[{vod_id:1,vod_name:'Test'}]}};
  else if(target.includes('get_detail'))data={info:{vod_name:'Test',vod_play_from:'original',vod_play_url:'01$https://ana.girigirilove.com/test.mp4'}};
  else if(target.includes('raw.githubusercontent.com'))data={version:'2.7'};
  else return {ok:true,json:async()=>({ok:true,kind:'mp4',bytes:4096})};
  return {ok:true,json:async()=>({ok:true,body:JSON.stringify(data)})};
}});vm.runInContext(fs.readFileSync(path.join(root,'web/js/source-engine.js'),'utf8'),context);
(async()=>{const engine=context.window.SourceEngine;await engine.ready;const result=await engine.probe('giri','Test');assert.equal(result.status,'playable');assert.equal(result.target,'anime:giri:1:1:1');const video=await engine.video(result.target);assert.match(video.source.url,/^\/anime-media\?u=/);assert.ok(requests.every(url=>url.startsWith('/')));assert.equal((await engine.update('giri')).changed,true);assert.ok(engine.isTarget('anime:aki:dPDDDE:5:1'));assert.ok(!engine.isTarget('anime:evil:../../x:1:1'));console.log('PASS source search, metadata, probe and media resolve on this device; update changes and stable episode identities are recognized');})().catch(e=>{console.error(e);process.exitCode=1;});
