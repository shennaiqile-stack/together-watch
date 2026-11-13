const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/js/updates.js'),'utf8');
const currentAndroid=require('../web/js/updates.js').versions.android;
const nextAndroid=currentAndroid.split('.').map(Number);
nextAndroid[nextAndroid.length-1]++;
const nextAndroidVersion=nextAndroid.join('.');
async function boot(platform,result){
  const nodes=new Map();let startup;
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,open:false,showModal(){this.open=true;}});return nodes.get(id);},addEventListener(event,fn){startup=fn;}};
  let call,scheduled,poll;
  const window={PhoneRooms:platform==='android'?{}:undefined};
  vm.runInNewContext(source,{window,document,AbortController,setInterval(fn){poll=fn;return 1;},setTimeout(fn,ms){if(ms===1800)scheduled=fn;return 1;},clearTimeout(){},fetch:async(url,options)=>{if(url.startsWith('/api/'))return {ok:true,json:async()=>({stage:'idle'})};call={url,options};if(result instanceof Error)throw result;return result;}});
  startup();await scheduled();
  return {nodes,window,call,poll:()=>poll()};
}
const release={body:'<script>unsafe()</script>',assets:[{name:`TogetherWatch-Android-v${nextAndroidVersion}.apk`,state:'uploaded',size:123,digest:'sha256:'+'a'.repeat(64),browser_download_url:`https://github.com/shennaiqile-stack/together-watch/releases/download/release-2/TogetherWatch-Android-v${nextAndroidVersion}.apk`}]};
test('every Android launch checks and offers matching newer package safely',async()=>{
  const a=await boot('android',{ok:true,json:async()=>release});
  assert(a.nodes.get('dlg-app-update').open);
  assert.equal(a.nodes.get('app-update-notes').textContent,release.body);
  assert.equal(a.call.options.credentials,'omit');
  let descriptor,prevented=false,stage='downloading',installed=false;
  a.window.PhoneUpdates={start(value){descriptor=JSON.parse(value);},status(){return JSON.stringify({stage,total:123,downloaded:50});},install(){installed=true;}};
  await a.nodes.get('app-update-download').onclick({preventDefault(){prevented=true;}});
  assert(prevented);assert.equal(descriptor.url,release.assets[0].browser_download_url);assert.equal(descriptor.sha256,'a'.repeat(64));
  assert.equal(a.nodes.get('app-update-download').disabled,true);
  stage='ready';await a.poll();assert.equal(a.nodes.get('app-update-download').textContent,'安装更新');
  await a.nodes.get('app-update-download').onclick({preventDefault(){}});assert(installed);
  assert.equal(a.nodes.get('btn-check-app-update').disabled,false);
});
test('offline startup stays usable and manual retry is available',async()=>{
  const a=await boot('windows',new Error('offline'));
  assert.match(a.nodes.get('app-update-status').textContent,/暂时无法连接/);
  assert.equal(a.nodes.get('btn-check-app-update').disabled,false);
  assert(!a.nodes.get('dlg-app-update').open);
});
test('equal installed version does not prompt',async()=>{
  const r=JSON.parse(JSON.stringify(release));r.assets[0].name=`TogetherWatch-Android-v${currentAndroid}.apk`;
  const a=await boot('android',{ok:true,json:async()=>r});
  assert.match(a.nodes.get('app-update-status').textContent,/已是最新/);assert(!a.nodes.get('dlg-app-update').open);
});
