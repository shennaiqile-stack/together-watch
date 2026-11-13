const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const encode=s=>Buffer.from(s).toString('base64url');
const decode=s=>Buffer.from(s,'base64url').toString();
const context=vm.createContext({window:{},URL,atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),location:{href:'http://client.test/',origin:'http://client.test'}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/media-source.js'),'utf8'),context);
const route=context.window.MediaSourceRoute;
const primary='https://peer.mcdn.bilivideo.cn/video?token=example';
const edge='https://peer.edge.mountaintoys.cn/video';
const cdn='https://cn-test.bilivideo.com/video?token=example';
const original='/relay?u='+encode(primary)+'&b='+encode(JSON.stringify([edge,cdn]));
test('native playback uses a supplied standard CDN and retains the original routes',()=>{
  const output=route.local({mode:'dash',video:original,audio:original},'http://127.0.0.1:1234/session');
  for(const key of ['video','audio']){
    const u=new URL(output[key]);assert.equal(u.pathname,'/session/relay');assert.equal(decode(u.searchParams.get('u')),cdn);
    assert.deepEqual(u.searchParams.getAll('backup').map(decode),[primary,edge]);
  }
});
test('desktop routing preserves the response and malformed backups keep the primary',()=>{
  assert.equal(route.local({mode:'mp4',url:original}).url,original);
  const bad='/relay?u='+encode(primary)+'&b=invalid';
  const output=route.local({mode:'mp4',url:bad},'http://127.0.0.1:1234/session');
  assert.equal(decode(new URL(output.url).searchParams.get('u')),primary);
});
