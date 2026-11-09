/* Incoming messages stay reachable while the video owns fullscreen. */
(() => {
  let context=null,node=null,badge=null,timer=null,sender=null,send=null,count=0;
  const enabled=()=>{try{return localStorage.getItem('wt.chat-sound')!=='off';}catch(_){return true;}};
  function prime(){try{context=context||new(window.AudioContext||window.webkitAudioContext)();if(context.state==='suspended')context.resume().catch(()=>{});}catch(_){}}
  function sound(){if(!enabled()||!context||context.state!=='running')return;try{const tone=context.createOscillator(),gain=context.createGain();tone.type='sine';tone.frequency.setValueAtTime(784,context.currentTime);gain.gain.setValueAtTime(0,context.currentTime);gain.gain.linearRampToValueAtTime(.055,context.currentTime+.012);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.17);tone.connect(gain);gain.connect(context.destination);tone.start();tone.stop(context.currentTime+.18);}catch(_){}}
  function hide(){if(node)node.hidden=true;if(badge)badge.hidden=true;count=0;clearTimeout(timer);}
  function submit(text){const value=String(text||'').trim();if(!value)return;if(send&&send(value)){node.querySelector('input').value='';hide();}}
  function create(){
    if(node)return;
    node=document.createElement('aside');node.className='chat-alert';node.hidden=true;node.setAttribute('aria-label','新聊天消息');
    node.innerHTML='<div class="chat-alert-head"><span class="chat-alert-avatar"></span><strong></strong><button type="button" class="icon-btn" aria-label="收起聊天提醒"><svg><use href="#i-close"/></svg></button></div><p role="status" aria-live="polite"></p><div class="chat-presets"><button type="button">收到</button><button type="button">等我一下</button><button type="button">暂停一下</button></div><form><input aria-label="全屏快捷回复" placeholder="回复一句…" maxlength="500" autocomplete="off"><button class="btn filled" type="submit">发送</button></form>';
    node.addEventListener('click',event=>event.stopPropagation());node.addEventListener('pointerdown',event=>event.stopPropagation());node.addEventListener('keydown',event=>event.stopPropagation());
    node.addEventListener('dblclick',event=>event.stopPropagation());
    node.querySelector('.icon-btn').onclick=hide;node.querySelector('form').onsubmit=event=>{event.preventDefault();submit(node.querySelector('input').value);};
    node.querySelectorAll('.chat-presets button').forEach(button=>button.onclick=()=>submit(button.textContent));
    node.querySelector('input').onfocus=()=>clearTimeout(timer);
    document.body.appendChild(node);
    badge=document.createElement('button');badge.type='button';badge.className='chat-reopen btn tonal';badge.hidden=true;
    badge.onclick=event=>{event.stopPropagation();badge.hidden=true;node.hidden=false;node.querySelector('input').focus();};
    ['pointerdown','keydown','dblclick'].forEach(type=>badge.addEventListener(type,event=>event.stopPropagation()));document.body.appendChild(badge);
  }
  window.ChatAlerts={prime,configure(fn){send=fn;},reset:hide,notify(name,message,avatar){
    sound();if(!(window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement))return;
    create();sender=name;const parent=(window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement);parent.appendChild(node);parent.appendChild(badge);count++;badge.textContent='聊天（'+count+'）· 回复';badge.hidden=true;
    node.querySelector('strong').textContent=name;node.querySelector('p').textContent=String(message||'').slice(0,500);
    const slot=node.querySelector('.chat-alert-avatar');slot.textContent='';if(avatar)slot.appendChild(avatar);
    node.hidden=false;clearTimeout(timer);timer=setTimeout(()=>{if(!node.contains(document.activeElement)){node.hidden=true;badge.hidden=false;}},10000);
  }};
  document.addEventListener('pointerdown',prime,{once:true,capture:true});
  document.addEventListener('fullscreenchange',()=>{if(node){hide();document.body.appendChild(node);document.body.appendChild(badge);}});
  document.addEventListener('DOMContentLoaded',()=>{
    const input=document.getElementById('set-chat-sound');if(!input)return;input.checked=enabled();input.onchange=()=>{try{localStorage.setItem('wt.chat-sound',input.checked?'on':'off');}catch(_){}if(input.checked)prime();};
  });
})();
