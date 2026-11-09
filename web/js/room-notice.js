/* A roster seeds presence; only a new, explicit join creates a notification. */
(() => {
  'use strict';
  class RoomPresence {
    constructor() { this.stop(); }
    start(self) { this.self=self;this.active=true;this.ready=false;this.known=new Set(); }
    snapshot(users) {
      if (!this.active || this.ready) return;
      this.known = new Set((users || []).map((user)=>user.name));
      this.ready = true;
    }
    joined(name) {
      if (!this.active || !this.ready || !name || name===this.self || this.known.has(name)) return false;
      this.known.add(name); return true;
    }
    left(name) { this.known.delete(name); }
    stop() { this.active=false;this.ready=false;this.self='';this.known=new Set(); }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {RoomPresence};
  if (typeof window === 'undefined') return;
  window.RoomPresence = RoomPresence;
  let context = null, timer = null, lastSound = 0;
  let sound = true;
  try { sound = localStorage.getItem('wt.join-sound') !== 'off'; } catch (_) {}
  function prime() {
    if (!sound) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      if (!context) context = new Audio();
      if (context.state==='suspended') context.resume().catch(()=>{});
    } catch (_) {}
  }
  function chime() {
    if (!sound || !context || context.state!=='running' || Date.now()-lastSound<800) return;
    lastSound=Date.now();
    try {
      const now=context.currentTime;
      [660,880].forEach((frequency,i)=>{
        const tone=context.createOscillator(), gain=context.createGain();
        tone.type='sine';tone.frequency.value=frequency;
        gain.gain.setValueAtTime(0,now+i*.12);
        gain.gain.linearRampToValueAtTime(.055,now+i*.12+.015);
        gain.gain.exponentialRampToValueAtTime(.001,now+i*.12+.16);
        tone.connect(gain);gain.connect(context.destination);
        tone.start(now+i*.12);tone.stop(now+i*.12+.18);
        tone.onended=()=>{tone.disconnect();gain.disconnect();};
      });
    } catch (_) {}
  }
  function hide() {
    clearTimeout(timer);
    const node=document.getElementById('room-join-notice');
    if(node) node.hidden=true;
  }
  function show(name) {
    const node=document.getElementById('room-join-notice');
    if(!node) return;
    const parent=(window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement) || document.body;
    if(node.parentElement!==parent) parent.appendChild(node);
    document.getElementById('room-join-name').textContent=name;
    node.hidden=false;
    clearTimeout(timer);timer=setTimeout(hide,5000);
    chime();
  }
  window.RoomJoinNotice={prime,show,hide};
  document.addEventListener('DOMContentLoaded',()=>{
    const control=document.getElementById('set-join-sound');
    control.checked=sound;
    control.onchange=()=>{
      sound=control.checked;
      try{localStorage.setItem('wt.join-sound',sound?'on':'off');}catch(_){}
      if(sound) prime();
    };
    document.getElementById('btn-dismiss-join').onclick=hide;
    document.addEventListener('pointerdown',()=>{if(document.body.classList.contains('in-room')) prime();},{passive:true});
  });
})();
