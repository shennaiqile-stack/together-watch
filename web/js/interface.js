/* Presentation-only interactions. Playback and synchronization stay in app.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let createRoom = '', joinRoom = '';
  function setMode(mode) {
    if (window.WT_MEDIA_BASE && !window.PhoneRooms) mode = 'join';
    const join = mode === 'join', solo = mode === 'solo';
    const previous = document.body.dataset.homeMode || 'create';
    if (previous !== mode) {
      const value = $('room-input').value;
      if (join) { createRoom = value; $('room-input').value = joinRoom; }
      else if (previous === 'join') { joinRoom = value; $('room-input').value = createRoom; }
    }
    document.body.dataset.homeMode = mode;
    $('invite-field').hidden = !join;
    $('room-input').closest('.field').hidden = solo;
    $('btn-create').hidden = join || solo;
    $('btn-join').hidden = !join;
    $('btn-solo').hidden = !solo;
    $('btn-random').hidden = join || solo;
    $('btn-hero-create').classList.toggle('selected', !join && !solo);
    $('btn-hero-join').classList.toggle('selected', join);
    $('btn-hero-solo').classList.toggle('selected', solo);
    $('btn-hero-create').setAttribute('aria-pressed', String(!join && !solo));
    $('btn-hero-join').setAttribute('aria-pressed', String(join));
    $('btn-hero-solo').setAttribute('aria-pressed', String(solo));
    $('room-input-label').textContent = join ? '房间号（或粘贴完整邀请自动填写）' : '你的房间号';
    $('room-field-hint').textContent = join ? '邀请链接会自动选择服务器；只填房号时，两端服务器须一致。' : '已为你准备好，也可以换一个喜欢的。';
    $('entry-title').textContent = solo ? '一个人，慢慢看' : (join ? '加入好友的放映' : '开始一场放映');
    $('entry-description').textContent = solo ? '不建房间，也不连接任何人，安静地看完这一场。'
      : (join ? '带上朋友的邀请，加入同一段精彩。' : (window.PhoneRooms ? '创建跨设备房间，复制邀请给电脑或手机。' : '做这场放映的发起人，邀请朋友来坐坐。'));
    $('entry-footnote').textContent = solo ? '进入后粘贴视频链接即可播放，播放进度只保存在本机。'
      : (join ? '粘贴完整链接，即可连接朋友的外网房间。' : (window.PhoneRooms ? '电脑与手机都可用完整邀请加入。视频由各自设备加载。' : '进入后选择视频，再把邀请链接发给朋友。'));
  }
  function openEntry(mode, title) {
    if (window.WT_MEDIA_BASE && !window.PhoneRooms) mode = 'join';
    window.WatchInterface.pendingSearch = title || '';
    setMode(mode);
    $('screen-home').hidden=true; $('screen-room-entry').hidden=false;
    document.body.classList.add('entering-room');
    history.pushState({page:'room'},'',location.pathname+location.search+'#room');
    window.scrollTo(0,0);
    (mode === 'join' ? $('server-input') : $('name-input')).focus();
  }
  function closeEntry(){ $('screen-room-entry').hidden=true; $('screen-home').hidden=false; document.body.classList.remove('entering-room'); history.replaceState(null,'',location.pathname+location.search); window.scrollTo(0,0); }
  window.WatchInterface = { setMode, openEntry, closeEntry, pendingSearch:'' };
  document.addEventListener('DOMContentLoaded', () => {
    if (window.WT_MEDIA_BASE) {
      if (!window.PhoneRooms) document.documentElement.classList.add('native-guest');
      $('btn-anime-room').lastChild.textContent = window.PhoneRooms ? '开房并搜索' : '加入房间并搜索';
      $('set-open').closest('.field').hidden = true;
      $('set-public').closest('.field').hidden = true;
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px';
    probe.innerHTML = '<div style="height:1px"></div><div style="height:1px"></div>';
    document.body.appendChild(probe);
    document.documentElement.classList.toggle('no-flex-gap', probe.scrollHeight < 3);
    probe.remove();
    $('set-theme').value = document.documentElement.dataset.theme || 'system';
    $('set-theme').onchange = () => {
      const mode = window.WatchTheme.apply($('set-theme').value);
      try { localStorage.setItem('wt.theme', mode); } catch (_) {}
    };
    $('nav-home').onclick = () => {
      if (document.body.classList.contains('in-room')) $('btn-back').click();
      else closeEntry();
    };
    $('nav-room').onclick = () => {
      if (document.body.classList.contains('in-room')) { window.scrollTo(0,0); $('bv-input').focus({preventScroll:true}); }
      else openEntry('create');
    };
    $('btn-entry-home').onclick=closeEntry;
    window.addEventListener('popstate',()=>{if(!document.body.classList.contains('in-room')){if(location.hash==='#room'){ $('screen-home').hidden=true;$('screen-room-entry').hidden=false;document.body.classList.add('entering-room');}else closeEntry();}});
    $('btn-discover-room').onclick = () => openEntry('create');
    $('nav-profile').onclick = () => $('dlg-account').showModal();
    $('btn-account-profile').onclick = () => { $('dlg-account').close(); $('btn-profile').click(); };
    $('btn-account-logout').onclick=async()=>{try{await API.post('/api/logout');await PersonalAccount.refresh();toast('已退出 B 站登录');}catch(e){toast(e.message,true);}};
    $('nav-more').onclick = () => $('dlg-more').showModal();
    document.querySelectorAll('[data-more-action]').forEach(button => button.onclick = () => { $('dlg-more').close(); $(button.dataset.moreAction).click(); });
    $('nav-help').onclick = () => $('dlg-help').showModal();
    $('server-input').addEventListener('input', () => {
      try {
        const text = $('server-input').value.trim();
        const phone = window.PhoneRoomMode && PhoneRoomMode.parse(text);
        if (phone) $('phone-sync-server').value = phone.server + ':' + phone.port;
        const room = phone ? phone.room : new URL(text).searchParams.get('room');
        if (room && /^[a-z0-9]{3,12}$/i.test(room)) $('room-input').value = room.toUpperCase();
      } catch (_) { /* The core validates the complete invite on submit. */ }
    });
    document.querySelectorAll('[data-settings]').forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll('[data-settings]').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.settingsPanel !== button.dataset.settings;
        });
      };
    });
    // Native dialogs keep focus and Escape handling; the rail reflects their state.
    const railDialogs = [['dlg-more','nav-more'],['dlg-profile','nav-profile'],['dlg-account','nav-profile'],['dlg-help','nav-help'],['dlg-settings','btn-settings']];
    const reflect = () => {
      const active = railDialogs.find(([id]) => ($(id).open || id==='dlg-settings'&&!$(id).hidden));
      railDialogs.forEach(([,id]) => $(id).classList.toggle('selected', !!active && id === active[1]));
      const inRoom = document.body.classList.contains('in-room') || document.body.classList.contains('entering-room');
      $('nav-room').classList.toggle('selected', inRoom || !!active && active[1] === 'nav-room');
      $('nav-home').classList.toggle('selected', !active && !inRoom);
      $('nav-home').setAttribute('aria-current', active || inRoom ? 'false' : 'page');
      $('page-label').textContent = inRoom ? '放映室' : '发现';
    };
    const observer = new MutationObserver(reflect);
    railDialogs.forEach(([id]) => observer.observe($(id), { attributes:true, attributeFilter:['open','hidden'] }));
    observer.observe(document.body, { attributes:true, attributeFilter:['class'] });
    if(location.hash==='#room')openEntry('create');
    reflect();
  });
})();
