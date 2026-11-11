/* Incoming messages stay reachable while the video owns fullscreen. */
(() => {
  let context=null,dock=null,list=null,input=null,send=null,count=0,state='mini',hideTimer=0;
  const POS_KEY='wt.chat-dock-pos';
  let pos=null,suppressClick=false;
  const enabled=()=>{try{return localStorage.getItem('wt.chat-sound')!=='off';}catch(_){return true;}};
  const stage=()=>window.WatchFullscreen?WatchFullscreen.element():document.fullscreenElement;
  function prime(){try{context=context||new(window.AudioContext||window.webkitAudioContext)();if(context.state==='suspended')context.resume().catch(()=>{});}catch(_){}}
  function sound(){if(!enabled()||!context||context.state!=='running')return;try{const tone=context.createOscillator(),gain=context.createGain();tone.type='sine';tone.frequency.setValueAtTime(784,context.currentTime);gain.gain.setValueAtTime(0,context.currentTime);gain.gain.linearRampToValueAtTime(.055,context.currentTime+.012);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.17);tone.connect(gain);gain.connect(context.destination);tone.start();tone.stop(context.currentTime+.18);}catch(_){}}

  function loadPos(){
    try{
      const saved=JSON.parse(localStorage.getItem(POS_KEY)||'null');
      if(saved&&(saved.side==='left'||saved.side==='right')&&Number.isFinite(saved.top))
        pos={side:saved.side,top:saved.top};
    }catch(_){}
  }
  function savePos(){if(!pos)return;try{localStorage.setItem(POS_KEY,JSON.stringify(pos));}catch(_){}}
  function box(){
    const parent=(dock&&dock.offsetParent)||document.body;
    return {w:parent.clientWidth||window.innerWidth,h:parent.clientHeight||window.innerHeight};
  }
  function gap(){return box().w<=740?14:22;}
  /* 松手后贴住最近的左右边框；纵向保持拖到的位置，并夹在可视区内。 */
  function place(){
    if(!dock||!pos)return;
    const {w,h}=box(),g=gap();
    dock.style.bottom='auto';
    dock.style.left=pos.side==='left'?g+'px':'auto';
    dock.style.right=pos.side==='right'?g+'px':'auto';
    let top=Math.min(Math.max(pos.top,g),Math.max(g,h-46-g));
    if(state!=='mini'){
      const card=dock.querySelector('.chat-dock-card');
      const cardH=card?card.offsetHeight:0;
      if(cardH&&top+cardH+g>h)top=Math.max(g,h-cardH-g);
    }
    dock.style.top=top+'px';
  }
  function snap(left,top){
    const {w,h}=box(),g=gap();
    pos={side:left+23<w/2?'left':'right',top:Math.min(Math.max(top,g),Math.max(g,h-46-g))};
    place();savePos();
  }
  function bindDrag(){
    const handle=dock.querySelector('.chat-dock-mini');
    const head=dock.querySelector('.chat-dock-head');
    let grab=null;
    const start=event=>{
      if(event.button!==0&&event.pointerType==='mouse')return;
      const own=dock.getBoundingClientRect();
      const parent=dock.offsetParent||document.body,base=parent.getBoundingClientRect();
      grab={id:event.pointerId,x:event.clientX,y:event.clientY,
            left:own.left-base.left,top:own.top-base.top,moved:false};
      try{event.currentTarget.setPointerCapture(event.pointerId);}catch(_){}
    };
    const move=event=>{
      if(!grab||grab.id!==event.pointerId)return;
      const dx=event.clientX-grab.x,dy=event.clientY-grab.y;
      if(!grab.moved&&Math.hypot(dx,dy)<4)return;
      grab.moved=true;
      dock.classList.add('dragging');
      const {w,h}=box(),g=gap(),own=dock.offsetWidth||46;
      const left=Math.min(Math.max(grab.left+dx,g),Math.max(g,w-own-g));
      const top=Math.min(Math.max(grab.top+dy,g),Math.max(g,h-46-g));
      dock.style.bottom='auto';dock.style.right='auto';
      dock.style.left=left+'px';dock.style.top=top+'px';
    };
    const finish=event=>{
      if(!grab||grab.id!==event.pointerId)return;
      const moved=grab.moved;grab=null;
      try{event.currentTarget.releasePointerCapture(event.pointerId);}catch(_){}
      if(!moved){dock.classList.remove('dragging');return;}
      /* 用拖动时写下的坐标判定，避免读到吸附过渡动画的中间值 */
      const parent=dock.offsetParent||document.body,base=parent.getBoundingClientRect();
      const rect=dock.getBoundingClientRect();
      const left=parseFloat(dock.style.left),top=parseFloat(dock.style.top);
      dock.classList.remove('dragging');
      suppressClick=true;setTimeout(()=>{suppressClick=false;},30);
      snap(Number.isFinite(left)?left:rect.left-base.left,Number.isFinite(top)?top:rect.top-base.top);
    };
    [handle,head].forEach(el=>{
      el.addEventListener('pointerdown',start);
      el.addEventListener('pointermove',move);
      el.addEventListener('pointerup',finish);
      el.addEventListener('pointercancel',finish);
      el.addEventListener('click',event=>{
        if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}
      },true);
    });
    handle.onclick=()=>{if(!suppressClick)peek(8000);};
    window.addEventListener('resize',place);
  }

  function setUnread(n){
    count=Math.max(0,n);
    if(!dock)return;
    dock.querySelectorAll('.chat-dock-count').forEach(badge=>{
      badge.hidden=!count;
      badge.textContent=count>99?'99+':String(count);
    });
  }

  function apply(){
    dock.classList.toggle('mini',state==='mini');
    dock.classList.toggle('open',state==='open');
    dock.querySelector('.chat-dock-head').setAttribute('aria-expanded',String(state==='open'));
    dock.querySelector('.chat-dock-body').hidden=state!=='open';
    place();
  }

  function later(ms){
    clearTimeout(hideTimer);
    hideTimer=setTimeout(()=>{if(state==='peek'){state='mini';apply();}},ms);
  }

  function peek(ms){
    if(state==='open')return;
    state='peek';
    apply();
    if(ms)later(ms);else clearTimeout(hideTimer);
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
    if(text){
      const raw=text.textContent;
      dock.querySelector('.chat-dock-msg').textContent=(raw.indexOf('【弹幕】')===0?'分享了一条弹幕 · '+raw.slice(4):raw).slice(0,140);
    }
    const avatar=last.querySelector('.chat-avatar'),slot=dock.querySelector('.chat-dock-avatar');
    if(avatar&&slot){slot.textContent='';slot.appendChild(avatar.cloneNode(true));}
  }

  function create(){
    if(dock)return;
    dock=document.createElement('aside');
    dock.className='chat-dock mini';dock.hidden=true;dock.setAttribute('aria-label','聊天');
    dock.innerHTML='<button type="button" class="chat-dock-mini" aria-label="聊天"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.6-4.8A8 8 0 1 1 21 12Z"/></svg><span class="chat-dock-count" hidden></span></button><div class="chat-dock-card"><button type="button" class="chat-dock-head" aria-expanded="false"><span class="chat-dock-avatar"></span><span class="chat-dock-copy"><strong class="chat-dock-name">聊天</strong><span class="chat-dock-msg">点开看看大家在说什么</span></span><span class="chat-dock-count" hidden></span><svg class="chat-dock-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="chat-dock-body" hidden><div class="chat-dock-list" role="log" aria-live="polite"></div><form class="chat-dock-form"><input aria-label="全屏聊天输入" placeholder="说点什么…" maxlength="500" autocomplete="off"><button class="btn filled" type="submit">发送</button></form></div></div>';
    list=dock.querySelector('.chat-dock-list');
    input=dock.querySelector('input');
    ['pointerdown','click','dblclick','keydown'].forEach(type=>dock.addEventListener(type,event=>event.stopPropagation()));
    dock.querySelector('.chat-dock-head').onclick=()=>{
      if(state==='open'){state='peek';apply();later(8000);}
      else{state='open';apply();fillHistory();setUnread(0);input.focus();}
    };
    dock.addEventListener('mouseenter',()=>clearTimeout(hideTimer));
    dock.addEventListener('mouseleave',()=>{if(state==='peek')later(3000);});
    dock.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const value=input.value.trim();
      if(!value)return;
      if(!send||send(value))input.value='';
    };
    loadPos();
    bindDrag();
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
    place();
    return parent;
  }

  window.ChatAlerts={prime,configure(fn){send=fn;},reset(){state='mini';clearTimeout(hideTimer);if(dock){apply();setUnread(0);dock.hidden=true;}if(dock&&dock.parentNode!==document.body)document.body.appendChild(dock);},
    notify(name,message,avatar){
      sound();
      if(!mount())return;
      dock.querySelector('.chat-dock-name').textContent=name;
      dock.querySelector('.chat-dock-msg').textContent=String(message||'').slice(0,140);
      const slot=dock.querySelector('.chat-dock-avatar');
      slot.textContent='';
      if(avatar)slot.appendChild(avatar);
      if(state==='open'){
        const src=document.getElementById('chat-list'),last=src&&src.lastElementChild;
        if(last)list.appendChild(last.cloneNode(true));
        list.scrollTop=list.scrollHeight;
        setUnread(0);
      }else{
        setUnread(count+1);
        peek(8000);
      }
      dock.hidden=false;
    }};
  document.addEventListener('pointerdown',prime,{once:true,capture:true});
  document.addEventListener('pointerdown',event=>{
    if(!dock||dock.contains(event.target))return;
    if(state==='open'){state='peek';apply();later(8000);}
    else if(state==='peek'){state='mini';apply();}
  },true);
  document.addEventListener('fullscreenchange',()=>{
    if(stage()){if(mount()){seed();apply();}}
    else if(dock){state='mini';clearTimeout(hideTimer);apply();dock.hidden=true;document.body.appendChild(dock);}
  });
  function bindSound(){
    const toggle=document.getElementById('set-chat-sound');
    if(!toggle)return;
    toggle.checked=enabled();
    toggle.onchange=()=>{try{localStorage.setItem('wt.chat-sound',toggle.checked?'on':'off');}catch(_){}if(toggle.checked)prime();};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindSound);else bindSound();
})();
