const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function boot(){
  const timers=new Map();let next=0,last,fail=false;
  const bridge={close(){},connect(value){last=JSON.parse(value);if(fail)throw new Error('bridge unavailable');},send(){}};
  const context=vm.createContext({URL,PhoneRooms:bridge,document:{addEventListener(){}},
    window:{PhoneRooms:bridge,SyncClient:class{constructor(){this.retry=0;}leave(){}emit(){} }},
    setTimeout(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/phone-rooms.js'),'utf8'),context);
  context.PhoneRoomMode=context.window.PhoneRoomMode;context.PhoneRoomMode.use({server:'example.test',port:8999});
  const client=new context.window.SyncClient();
  return {client,context,timers,options:{room:'ABC234'},get last(){return last;},fail(){fail=true;},
    receive(id,type,data={}){context.window.PhoneSyncReceive(id,type,data);},
    fire(ms){const entry=[...timers].find(([,v])=>v.ms===ms);assert(entry,'timer '+ms);timers.delete(entry[0]);entry[1].fn();}};
}
test('native timeout reports its real reason and retries; late callbacks cannot revive it',async()=>{
  const a=boot();const pending=a.client.join(a.options);const rejected=assert.rejects(pending,/连接同步服务器超时/);
  const old=a.last.serial;a.fire(30000);await rejected;
  assert.equal(a.client.open,false);assert.equal(a.client.closedByUser,false);
  a.receive(old,'connected');assert.equal(a.client.open,false);
  a.fire(1200);assert.notEqual(a.last.serial,old);
  a.receive(a.last.serial,'connected');await Promise.resolve();assert.equal(a.client.open,true);a.client.leave();
});
test('native error clears connected state and explicit leave cancels recovery',async()=>{
  const a=boot();const pending=a.client.join(a.options);a.receive(a.last.serial,'connected');await pending;
  a.receive(a.last.serial,'error',{message:'network lost'});assert.equal(a.client.open,false);
  assert.equal(a.client.send({op:'state'}),false);
  a.client.leave();assert.equal(a.timers.size,0);
});
test('a thrown native bridge call rejects cleanly without retaining the join timeout',async()=>{
  const a=boot();a.fail();await assert.rejects(a.client.join(a.options),/bridge unavailable/);
  assert(![...a.timers.values()].some(t=>t.ms===30000));a.client.leave();
});
