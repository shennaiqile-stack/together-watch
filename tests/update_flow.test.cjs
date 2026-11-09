const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/js/updates.js'),'utf8');
async function boot(platform,result){
  const nodes=new Map();let startup;
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,open:false,showModal(){this.open=true;}});return nodes.get(id);},addEventListener(event,fn){startup=fn;}};
  let call,scheduled;
  const window={PhoneRooms:platform==='android'?{}:undefined};
  vm.runInNewContext(source,{window,document,AbortController,setTimeout(fn,ms){if(ms===1800)scheduled=fn;return 1;},clearTimeout(){},fetch:async(url,options)=>{call={url,options};if(result instanceof Error)throw result;return result;}});
  startup();await scheduled();
  return {nodes,window,call};
}
const release={body:'<script>unsafe()</script>',assets:[{name:'TogetherWatch-Android-v5.6.apk',state:'uploaded',size:123,browser_download_url:'https://github.com/shennaiqile-stack/together-watch/releases/download/release-2/TogetherWatch-Android-v5.6.apk'}]};
test('every Android launch checks and offers matching newer package safely',async()=>{
  const a=await boot('android',{ok:true,json:async()=>release});
  assert(a.nodes.get('dlg-app-update').open);
  assert.equal(a.nodes.get('app-update-notes').textContent,release.body);
  assert.equal(a.call.options.credentials,'omit');
  let opened,prevented=false;a.window.PhoneUpdates={openDownload(url){opened=url;}};
  a.nodes.get('app-update-download').onclick({preventDefault(){prevented=true;}});
  assert(prevented);assert.equal(opened,release.assets[0].browser_download_url);
  assert.equal(a.nodes.get('btn-check-app-update').disabled,false);
});
test('offline startup stays usable and manual retry is available',async()=>{
  const a=await boot('windows',new Error('offline'));
  assert.match(a.nodes.get('app-update-status').textContent,/暂时无法连接/);
  assert.equal(a.nodes.get('btn-check-app-update').disabled,false);
  assert(!a.nodes.get('dlg-app-update').open);
});
test('equal installed version does not prompt',async()=>{
  const r=JSON.parse(JSON.stringify(release));r.assets[0].name='TogetherWatch-Android-v5.5.apk';
  const a=await boot('android',{ok:true,json:async()=>r});
  assert.match(a.nodes.get('app-update-status').textContent,/已是最新/);assert(!a.nodes.get('dlg-app-update').open);
});
