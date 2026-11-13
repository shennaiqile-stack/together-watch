const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Media extends EventTarget {
  constructor(tagName){super();this.tagName=tagName;this.readyState=0;this.paused=true;this.duration=60;this.currentTime=0;}
  pause(){this.paused=true;}load(){}removeAttribute(){this.error=null;}
}
function boot(){
  const context=vm.createContext({window:{},setTimeout,clearTimeout,requestAnimationFrame(){},console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/player.js'),'utf8'),context);
  const classes=new Set();const shell=new EventTarget();
  shell.classList={add(...args){args.forEach(x=>classes.add(x));},remove(...args){args.forEach(x=>classes.delete(x));},toggle(x,on){if(on)classes.add(x);else classes.delete(x);}};
  const video=new Media('VIDEO'),audio=new Media('AUDIO');
  return {player:new context.window.Player({video,audio,shell}),video,audio,classes};
}
test('play stays hidden until both DASH tracks load, and failed audio identifies the track',async()=>{
  const a=boot();const pending=a.player.load({mode:'dash',video:'/video',audio:'/audio'});
  assert(a.classes.has('no-video'));
  a.video.readyState=2;a.video.dispatchEvent(new Event('loadeddata'));
  a.audio.error={code:3};a.audio.dispatchEvent(new Event('error'));
  await assert.rejects(pending,/音轨：解码失败.*3/);
  assert(a.classes.has('no-video'));assert.equal(a.player.ready,false);
  const retry=a.player.load({mode:'dash',video:'/video2',audio:'/audio2'});
  a.audio.readyState=2;a.audio.dispatchEvent(new Event('loadeddata'));await retry;
  assert.equal(a.player.ready,true);assert(!a.classes.has('no-video'));
});
test('unsupported video reports a format error and remains safe to retry',async()=>{
  const a=boot();const pending=a.player.load({mode:'mp4',url:'/video'});
  a.video.error={code:4};a.video.dispatchEvent(new Event('error'));
  await assert.rejects(pending,/视频：格式或播放地址不受支持/);assert(a.classes.has('no-video'));
});
