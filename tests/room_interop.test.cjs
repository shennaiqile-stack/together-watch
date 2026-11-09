const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
function load(native){
 const window={SyncClient:class{},...(native?{PhoneRooms:{}}:{})};
 const context=vm.createContext({window,URL,document:{addEventListener(){}},localStorage:{getItem(){return null},setItem(){}},setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync('web/js/phone-rooms.js','utf8'),context);
 context.PhoneRoomMode=window.PhoneRoomMode;
 return context;
}
const phone=load(true),pc=load(false);
for(const context of [phone,pc]){
 const mode=context.window.PhoneRoomMode;
 const invite=mode.parse('syncplay://syncplay.pl:8999/ab2345');
 assert.equal(invite.server,'syncplay.pl');assert.equal(invite.port,8999);assert.equal(invite.room,'AB2345');
 mode.use(invite);assert.equal(mode.invite(invite.room),'syncplay://syncplay.pl:8999/AB2345');
 assert.equal(mode.parse('https://example.com/?room=AB2345'),null);
 assert.throws(()=>mode.parse('syncplay://user:secret@syncplay.pl:8999/AB2345'));
 assert.throws(()=>mode.parse('syncplay://syncplay.pl:8999/..'));
}
assert.equal(pc.window.SyncClient.name,'SyncClient');
assert.equal(phone.window.SyncClient.name,'PhoneSync');
const owner=pc.window.PhoneRoomMode;
owner.use({server:'syncplay.pl',port:8995});
const webInvite=owner.webInvite('https://example.test','LQDPQY','test-key');
assert.equal(new URL(webInvite).searchParams.get('room'),'LQDPQY');
assert.equal(new URL(webInvite).searchParams.get('k'),'test-key');
assert.equal(new URL(webInvite).searchParams.get('sync'),'syncplay.pl:8995');
for(const context of [phone,pc]){
 const endpoint=context.window.PhoneRoomMode.fromHttp(webInvite);
 assert.equal(endpoint.server,'syncplay.pl');assert.equal(endpoint.port,8995);
 assert.equal(context.window.PhoneRoomMode.fromHttp('https://example.test/?room=LQDPQY'),null);
 assert.throws(()=>context.window.PhoneRoomMode.fromHttp('https://example.test/?sync=syncplay.pl:99999'));
}
console.log('PASS web invitations preserve the exact public sync server, non-default port, room and access key on both clients');
const app=fs.readFileSync('web/js/app.js','utf8');
assert.ok(app.includes('PhoneRoomMode.endpoint.server'));
assert.ok(app.includes('(isHost || !remote)'));
console.log('PASS phone and PC share invite server, port and room; HTTP invitations preserved; native and desktop transports retained');
