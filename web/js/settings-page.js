(() => {
  let previous=null,position=0,returnFocus=null;
  function restore(){
    if(!previous)return;
    document.getElementById('dlg-settings').hidden=true;
    previous.forEach(screen=>screen.hidden=false);previous=null;
    document.body.classList.remove('settings-open');
    window.scrollTo(0,position);
    if(returnFocus&&returnFocus.focus)returnFocus.focus({preventScroll:true});
  }
  window.SettingsPage={get active(){return previous!==null;},open(){
    if(previous)return;
    if(window.WatchFullscreen&&WatchFullscreen.element())WatchFullscreen.exit();
    position=window.scrollY;returnFocus=document.activeElement;
    previous=Array.from(document.querySelectorAll('.screen')).filter(screen=>!screen.hidden);
    previous.forEach(screen=>screen.hidden=true);
    document.body.classList.add('settings-open');
    document.getElementById('dlg-settings').hidden=false;
    history.pushState({page:'settings'},'',location.pathname+location.search+'#settings');
    window.scrollTo(0,0);document.getElementById('btn-settings-back').focus();
  },close(){const active=previous!==null;restore();if(active&&location.hash==='#settings')history.back();}};
  window.addEventListener('popstate',()=>{if(location.hash!=='#settings')restore();});
  document.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('btn-settings-back').onclick=()=>SettingsPage.close();
    document.getElementById('nav-home').addEventListener('click',()=>{if(previous)SettingsPage.close();});
    document.getElementById('nav-room').addEventListener('click',()=>{if(previous)SettingsPage.close();});
  });
})();
