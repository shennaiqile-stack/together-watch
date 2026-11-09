const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
let socket;
const sockets=[];
class WebSocket { constructor(url){this.url=url;socket=this;this.readyState=0;this.sent=[];sockets.push(this);} send(value){this.sent.push(JSON.parse(value));} close(){this.readyState=3;this.closed=true;} }
const context=vm.createContext({window:{API:{base:'http://example.test:8770',key:'test-key'}},
 API:{base:'http://example.test:8770',key:'test-key'},WebSocket,setTimeout,clearTimeout,console});
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../web/js/sync.js'),'utf8'),context);
(async()=>{
 const client=new context.window.SyncClient();let pong=null,state=null;
 client.on('pong',e=>pong=e);client.on('state',e=>state=e);
 const connected=client.connect();socket.readyState=1;socket.onopen();await connected;
 socket.onmessage({data:JSON.stringify({op:'pong',t:123.4})});
 assert.equal(pong.t,123.4);
 socket.onmessage({data:JSON.stringify({op:'sync',event:{type:'state',position:70}})});
 assert.equal(state.position,70);
 console.log('PASS: real WebSocket pong reaches latency estimator; state dispatch preserved');
 const old=socket;
 context.API.base=context.window.API.base='http://friend.test:8770';
 const join=client.join({room:'SAMEROOM',username:'friend',port:8999});
 assert.notEqual(socket,old);assert.equal(old.closed,true);assert.equal(socket.url,'ws://friend.test:8770/ws?k=test-key');
 const next=socket;next.readyState=1;next.onopen();await join;
 assert.equal(next.sent[0].room,'SAMEROOM');assert.equal(old.sent.length,0);
 old.onclose();assert.equal(client.ws,next);assert.equal(client.open,true);
 const before=state;old.onmessage({data:JSON.stringify({op:'sync',event:{type:'state',position:999}})});assert.equal(state,before);
 console.log('PASS switching invite servers closes the old socket; the new join reaches only the invited server; stale callbacks cannot replace it');
 client.leave();assert.equal(next.closed,true);assert.equal(client.open,false);
 const again=client.connect();socket.readyState=1;socket.onopen();await again;assert.notEqual(socket,next);
 client.leave();
 console.log('PASS leaving closes the connection and joining again creates a fresh socket');
})().catch(e=>{console.error(e);process.exitCode=1});
