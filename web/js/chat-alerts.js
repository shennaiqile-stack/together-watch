/* Incoming messages stay reachable while the video owns fullscreen. */
(() => {
  let context=null,dock=null,list=null,input=null,sender=null,send=null,count=0,expanded=false;
  const enabled=()=>{try{return localStorage.getItem('wt.chat-sound')!=='off';}catch(_){return true;}};
  const stage=()=>window.WatchFullscreen?WatchFullscreen.element():document.fullscreenElement;
  function prime(){try{context=context||new(window.AudioContext||window.webkitAudioContext)();if(context.state==='suspended')context.resume().catch(()=>{});}catch(_){}}
  function sound(){if(!enabled()||!context||context.state!=='running')return;try{const tone=context.createOscillator(),gain=context.createGain();tone.type='sine';tone.frequency.setValueAtTime(784,context.currentTime);gain.gain.setValueAtTime(0,context.currentTime);gain.gain.linearRampToValueAtTime(.055,context.currentTime+.012);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.17);tone.connect(gain);gain.connect(context.destination);tone.start();tone.stop(context.currentTime+.18);}catch(_){}}

  function setUnread(n){
    count=Math.max(0,n);
    const badge=dock&&dock.querySelector('.chat-dock-count');
    if(!badge)return;
    badge.hidden=!count||expanded;
    badge.textContent=count>99?'99+':String(count);
  }

  function fillHistory(){
    const src=document.getElementById('chat-list');
    list.textContent='';
    if(src)Array.prototype.forEach.call(src.children,child=>list.appendChild(child.cloneNode(true)));
    list.scrollTop=list.scrollHeight;
  }

  function seed(){
    const src=document.getElementById('chat-list');
    const msgs=src?Array.prototype.filter.call(src.children,n=>n.classList.contains('chat-msg')):[];
    if(!msgs.length)return;
    const last=msgs[msgs.length-1];
    const name=last.querySelector('.chat-name'),text=last.querySelector('.chat-text');
    if(name)dock.querySelector('.chat-dock-name').textContent=name.textContent.replace('（你）','');
    if(text)dock.querySelector('.chat-dock-msg').textContent=text.textContent.slice(0,140);
    const avatar=last.querySelector('.chat-avatar'),slot=dock.querySelector('.chat-dock-avatar');
    if(avatar&&slot){slot.textContent='';slot.appendChild(avatar.cloneNode(true));}
  }

  function expand(next){
    expanded=next;
    dock.classList.toggle('open',next);
    dock.querySelector('.chat-dock-head').setAttribute('aria-expanded',String(next));
    dock.querySelector('.chat-dock-body').hidden=!next;
    if(next){fillHistory();setUnread(0);input.focus();}
    else setUnread(count);
  }

  function create(){
    if(dock)return;
    dock=document.createElement('aside');
    dock.className='chat-dock';dock.hidden=true;dock.setAttribute('aria-label','聊天');
    dock.innerHTML='<button type="button" class="chat-dock-head" aria-expanded="false"><span class="chat-dock-avatar"></span><span class="chat-dock-copy"><strong class="chat-dock-name">聊天</strong><span class="chat-dock-msg">点开看看大家在说什么</span></span><span class="chat-dock-count" hidden></span><svg class="chat-dock-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="chat-dock-body" hidden><div class="chat-dock-list" role="log" aria-live="polite"></div><form class="chat-dock-form"><input aria-label="全屏聊天输入" placeholder="说点什么…" maxlength="500" autocomplete="off"><button class="btn filled" type="submit">发送</button></form></div>';
    list=dock.querySelector('.chat-dock-list');
    input=dock.querySelector('input');
    ['pointerdown','click','dblclick','keydown'].forEach(type=>dock.addEventListener(type,event=>event.stopPropagation()));
    dock.querySelector('.chat-dock-head').onclick=()=>expand(!expanded);
    dock.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const value=input.value.trim();
      if(!value)return;
      if(!send||send(value))input.value='';
    };
  }

  function mount(){
    const parent=stage();
    if(!parent){
      if(dock&&dock.parentNode!==document.body)document.body.appendChild(dock);
      return null;
    }
    create();
    if(dock.parentNode!==parent)parent.appendChild(dock);
    dock.hidden=false;
    return parent;
  }

  window.ChatAlerts={prime,configure(fn){send=fn;},reset(){if(dock){expand(false);setUnread(0);dock.hidden=true;}if(dock&&dock.parentNode!==document.body)document.body.appendChild(dock);},
    notify(name,message,avatar){
      sound();
      if(!mount())return;
      sender=name;
      dock.querySelector('.chat-dock-name').textContent=name;
      dock.querySelector('.chat-dock-msg').textContent=String(message||'').slice(0,140);
      const slot=dock.querySelector('.chat-dock-avatar');
      slot.textContent='';
      if(avatar)slot.appendChild(avatar);
      if(expanded){
        const src=document.getElementById('chat-list'),last=src&&src.lastElementChild;
        if(last)list.appendChild(last.cloneNode(true));
        list.scrollTop=list.scrollHeight;
      }else setUnread(count+1);
      dock.hidden=false;
    }};
  document.addEventListener('pointerdown',prime,{once:true,capture:true});
  document.addEventListener('fullscreenchange',()=>{
    if(stage()){if(mount())seed();}
    else if(dock){expand(false);setUnread(0);dock.hidden=true;document.body.appendChild(dock);}
  });
  document.addEventListener('DOMContentLoaded',()=>{
    const input=document.getElementById('set-chat-sound');if(!input)return;input.checked=enabled();input.onchange=()=>{try{localStorage.setItem('wt.chat-sound',input.checked?'on':'off');}catch(_){}if(input.checked)prime();};
  });
})();
