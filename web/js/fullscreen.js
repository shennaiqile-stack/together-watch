/* Keep the complete player UI, chat and quick replies together on Android. */
(() => {
  function element(){return document.fullscreenElement||document.querySelector('.player-shell.app-fullscreen');}
  function nativeState(enabled){fetch('/api/fullscreen?enabled='+(enabled?'1':'0'),{cache:'no-store'}).catch(()=>{});document.dispatchEvent(new Event('fullscreenchange'));}
  function exit(){
    const app=document.querySelector('.player-shell.app-fullscreen');
    if(app){app.classList.remove('app-fullscreen');document.body.classList.remove('native-fullscreen');nativeState(false);}
    else if(document.fullscreenElement)return document.exitFullscreen().catch(()=>{});
  }
  window.WatchFullscreen={element,exit,toggle(shell){
    if(element()){exit();return;}
    if(window.WT_MEDIA_BASE){shell.classList.add('app-fullscreen');document.body.classList.add('native-fullscreen');nativeState(true);}
    else if(shell.requestFullscreen)shell.requestFullscreen().catch(()=>{});
  }};
})();
