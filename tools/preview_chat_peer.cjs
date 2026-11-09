const fs=require('fs'),vm=require('vm'),path=require('path'),readline=require('readline');
const api={base:'http://127.0.0.1:8789',key:''};
const context=vm.createContext({window:{API:api},API:api,WebSocket,setTimeout,clearTimeout,console});vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../web/js/sync.js'),'utf8'),context);
const peer=new context.window.SyncClient();peer.on('connected',()=>console.log('PEER_READY'));peer.on('chat',event=>console.log(JSON.stringify({name:event.username,message:event.message})));
setInterval(()=>peer.send({op:'ping',t:Date.now()}),3000);
peer.join({username:'快捷回复测试员',room:'PHONE51CHAT',port:9020}).catch(e=>console.error(e.message));
readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='exit'){peer.leave();process.exit(0);}else if(line==='notify-test'){[0,6000,12000].forEach((delay,index)=>setTimeout(()=>peer.chat('全屏消息测试 '+(index+1)+'：可以直接输入或快捷回复。'),delay));}else peer.chat(line);});
setTimeout(()=>{peer.leave();process.exit(0);},3600000);
