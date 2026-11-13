/* OS links are queued until the room UI is ready on cold and warm starts. */
(() => {
  let handler=null, pending=null, busy=false, polling=false;
  function parse(value) {
    if(typeof value!=='string'||value.length>2048||/\s/.test(value))throw new Error('邀请链接格式无效');
    // Older Android WebViews treat custom schemes as opaque paths, not URLs
    // with host/port fields. Parse the restricted invitation grammar directly.
    const parts=value.match(/^(?:togetherwatch|syncplay):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?\/([^/?#]+)$/i);
    if(!parts)throw new Error('邀请链接格式无效');
    const host=parts[1].toLowerCase(),port=Number(parts[2]===undefined?8999:parts[2]);
    const room=decodeURIComponent(parts[3]).toUpperCase();
    const label='[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if(host.length>253||!new RegExp('^'+label+'(?:\\.'+label+')*$').test(host)||port<1||port>65535||!/^[A-Z0-9]{3,12}$/.test(room))throw new Error('邀请链接格式无效');
    return {server:host,port,room,url:'togetherwatch://'+host+':'+port+'/'+room};
  }
  async function drain(){
    if(!handler||busy||!pending)return;
    busy=true;
    try{while(pending){const next=pending;pending=null;await handler(next);}}
    catch(error){if(window.toast)window.toast(error.message,true);}
    finally{busy=false;}
  }
  async function poll(){
    if(!handler||polling)return;
    polling=true;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
    try{
      if(window.PhoneInvites){const value=PhoneInvites.takePending();if(value)receive(value);}
      else if(!window.WT_MEDIA_BASE){
        const response=await fetch('/api/invites/next',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal});
        if(response.ok){const data=await response.json();if(data.url)receive(data.url);}
      }
    }catch(_){}finally{clearTimeout(timer);polling=false;}
  }
  function receive(value){const invite=parse(value);pending=invite.url;drain();return true;}
  window.InviteLinks={parse};
  window.WatchInvites={receive,start(fn){handler=fn;poll();setInterval(poll,800);drain();}};
})();
