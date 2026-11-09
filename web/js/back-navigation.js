/* Android gestures and the physical Back key use the same page-aware order. */
(() => {
  window.WatchBack = {handle() {
    if (window.WatchFullscreen && WatchFullscreen.element()) {
      WatchFullscreen.exit(); return true;
    }
    const dialogs=Array.from(document.querySelectorAll('dialog[open]'));
    if(dialogs.length){dialogs[dialogs.length-1].close();return true;}
    if(window.SettingsPage && SettingsPage.active){SettingsPage.close();return true;}
    if(document.body.classList.contains('in-room')) {
      document.getElementById('btn-back').click(); return true;
    }
    if(document.body.classList.contains('entering-room')) {
      document.getElementById('nav-home').click(); return true;
    }
    return false;
  }};
})();
