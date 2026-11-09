(() => {
  'use strict';
  function apply(mode) {
    mode = ['light','dark'].includes(mode) ? mode : 'system';
    document.documentElement.dataset.theme = mode;
    return mode;
  }
  let mode = 'system';
  try { mode = localStorage.getItem('wt.theme') || mode; } catch (_) {}
  apply(mode);
  window.WatchTheme = { apply };
})();
