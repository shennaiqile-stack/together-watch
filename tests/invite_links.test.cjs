const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function boot(native){
 let value=native,interval;
 const context=vm.createContext({window:{WT_MEDIA_BASE:'native'},PhoneInvites:{takePending(){const v=value;value=null;return v;}},URL,AbortController,setTimeout,clearTimeout,setInterval(fn){interval=fn;}});
 context.window.PhoneInvites=context.PhoneInvites;
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/invite-links.js'),'utf8'),context);
 return {context,set(value2){value=value2},poll(){return interval();}};
}
test('new and old links retain custom ports and reject credentials and command injection',()=>{
 const {context:c}=boot();const parse=c.window.InviteLinks.parse;
 assert.equal(parse('syncplay://example.net:12345/abc234').url,'togetherwatch://example.net:12345/ABC234');
 for(const value of ['https://host/ABC234','togetherwatch://u:p@host/ABC234','togetherwatch://host:0/ABC234','togetherwatch://host/ABC234?x=1','togetherwatch://host/%22','togetherwatch://host/ABC234 --port 90'])assert.throws(()=>parse(value));
});
test('cold and warm native invitations wait for UI readiness and consume once',async()=>{
 const a=boot('togetherwatch://154.64.252.247:8999/ABC234');const received=[];
 a.context.window.WatchInvites.start(async value=>received.push(value));await Promise.resolve();
 assert.equal(received.length,1);await a.poll();assert.equal(received.length,1);
 a.set('togetherwatch://host:9000/DEF567');await a.poll();await Promise.resolve();assert.equal(received[1],'togetherwatch://host:9000/DEF567');
});
test('custom invitations work on WebViews whose URL implementation lacks custom-scheme authorities',()=>{
 const {context:c}=boot();
 c.URL=class{constructor(){this.protocol='togetherwatch:';this.hostname='';this.port='';this.pathname='//154.64.252.247:8999/ABC234';}};
 const parsed=c.window.InviteLinks.parse('togetherwatch://154.64.252.247:8999/ABC234');
 assert.equal(parsed.server,'154.64.252.247');assert.equal(parsed.port,8999);assert.equal(parsed.room,'ABC234');
});
