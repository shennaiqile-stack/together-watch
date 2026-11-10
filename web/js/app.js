/* 一起看 · 界面逻辑 */
(function () {
  const S = {
    version: '',
    config: {},
    user: null,
    selfUser:{logged_in:false},
    share: null,
    room: '',
    name: '',
    isHost: true,
    joined: false,
    solo: false,
    profile: null,
    users: [],
    bvid: '',
    target: '',
    page: 1,
    epId: '',
    cid: '',
    qualities: [],
    qn: 80,
    info: null,
    loading: false,
    loadToken: 0,
    pendingState: null,
    lastRemoteAt: 0,
    dmEnabled: true,
    myName: '',
    rate: 1,
    dragging: false,
    tunnelUrl: '',
    tunnelStatus: 'stopped',
    tunnelError: '',
    relay: { status: 'stopped', url: '', token: '' },
    overrideUntil: 0,
    roomPaused: true,
  };

  let player = null;
  let dm = null;
  let sync = null;
  let sr = null;
  let srMode = 'off';
  let srInit = false;
  let dmOpt = null;
  let qrTimer = null;
  let qrKey = null;
  let loginMode = 'sms';
  let qrGeneration = 0;
  let qrPolling = false;
  let smsTimer = null;
  let smsGeneration = 0;
  let smsActive = false;
  let loginCloseTimer = null;
  let heartbeat = null;
  let seekDebounce = null;
  let idleTimer = null;
  let presence = null;

  const el = {};

  /* ---------------- 好友的电脑（远程模式） ----------------
     朋友的桌面端页面由他自己本机的服务提供，房间 API / WS 指向房主；媒体由本机直接请求 CDN。这样朋友不用开浏览器，
     也不用自己登录 B 站。 */
  function absUrl(u) {
    if (u && u.charAt(0) === '/' && window.API && API.base) {
      if (API.key) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(API.key);
      return API.base + u;
    }
    return u;
  }

  function parseServerInput(text) {
    text = (text || '').trim();
    if (!text) return null;
    try {
      const phone = window.PhoneRoomMode && PhoneRoomMode.parse(text);
      if (phone) return phone;
      const u = new URL(/^https?:\/\//i.test(text) ? text : 'http://' + text);
      if (!u.hostname) return null;
      const room = (u.searchParams.get('room') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      return { base: u.origin, room, key: u.searchParams.get('k') || '', syncEndpoint: window.PhoneRoomMode ? PhoneRoomMode.fromHttp(u.href) : null };
    } catch (e) { return null; }
  }

  function renderServerBadge() {
    if (!el.serverBadge) return;
    if (window.API && API.base) {
      el.serverBadge.textContent = '好友的电脑 · ' + API.base.replace(/^https?:\/\//, '');
    } else {
      el.serverBadge.textContent = '电脑与手机互通 · 公共同步房间';
    }
  }

  /* 返回 false 表示输入格式错误；返回对象表示进入远程模式；null 表示本机 */
  function setRemoteServer(text) {
    if (window.PhoneRoomMode) PhoneRoomMode.use(null);
    if (!text || !text.trim()) {
      if (window.API && API.base) {
        API.base = ''; API.key = '';
        try { sessionStorage.removeItem('wt.server'); sessionStorage.removeItem('wt.key'); sessionStorage.removeItem('wt.link'); } catch (e) {}
      }
      renderServerBadge();
      return null;
    }
    const t = parseServerInput(text);
    if (!t) {
      toast('「好友的电脑」格式看不懂，请粘贴房主发的完整链接', true);
      return false;
    }
    if (window.PhoneRoomMode && (t.phone || t.syncEndpoint)) PhoneRoomMode.use(t.syncEndpoint || t);
    API.base = t.base;
    API.key = t.key;
    try { sessionStorage.setItem('wt.server', t.base); sessionStorage.setItem('wt.key', t.key); sessionStorage.setItem('wt.link', text.trim()); } catch (e) {}
    renderServerBadge();
    return t;
  }

  function cacheDom() {
    const ids = [
      'appbar', 'btn-back', 'room-chip', 'room-chip-code', 'conn-pill', 'conn-text',
      'btn-share', 'btn-settings', 'screen-home', 'screen-room',
      'name-input', 'server-input', 'room-input', 'btn-random', 'btn-create', 'btn-join',
      'btn-hero-create', 'btn-hero-join', 'btn-hero-solo', 'btn-solo', 'server-badge',
      'login-strip', 'avatar', 'login-title', 'login-sub', 'btn-login',
      'player-shell', 'video', 'audio', 'dm-layer', 'pt-title', 'pt-room', 'pt-members',
      'pt-rtt', 'player-center', 'big-play', 'big-play-icon', 'player-empty',
      'player-bottom', 'progress', 'progress-buffer', 'progress-played', 'progress-knob',
      'btn-play', 'btn-play-icon', 'time-label', 'btn-dm', 'btn-dm-icon',
      'btn-dm-set', 'dm-set', 'dm-f-scroll', 'dm-f-fixed', 'dm-f-color',
      'dm-screen-scale', 'dm-avoid-sub', 'dm-block',
      'dm-area', 'dm-area-v', 'dm-opacity', 'dm-opacity-v',
      'dm-font', 'dm-font-v', 'dm-speed', 'dm-speed-v',
      'btn-quality', 'quality-menu', 'btn-sr', 'sr-menu', 'sr-canvas', 'btn-rate', 'rate-menu', 'btn-mute',
      'net-stat',
      'dlg-profile', 'prof-name', 'prof-avatar', 'prof-img', 'prof-initial',
      'prof-file', 'prof-save', 'prof-skip', 'prof-close', 'prof-title', 'btn-profile',
      'btn-search', 'search-panel', 'search-input', 'btn-search-go', 'search-list',
      'btn-mute-icon', 'volume', 'btn-full', 'btn-full-icon',
      'video-title', 'video-sub', 'btn-reload', 'bv-input', 'btn-load', 'bv-hint',
      'episode-bar', 'ep-list',
      'member-count', 'chat-list', 'chat-form', 'chat-input', 'btn-send',
      'member-list', 'panel-chat', 'panel-members', 'foot-conn', 'foot-rtt',
      'foot-server', 'btn-reconnect',
      'dlg-login', 'qr-box', 'qr-status', 'btn-qr-refresh',
      'dlg-share', 'share-qr', 'share-link', 'btn-copy', 'share-hint',
      'btn-tunnel', 'tunnel-status', 'tunnel-row', 'tunnel-link', 'btn-tunnel-copy',
      'dlg-settings', 'set-name', 'set-quality', 'set-mode', 'set-open', 'set-public',
      'set-local', 'set-share', 'set-sync', 'set-version', 'btn-save', 'btn-shutdown',
      'snackbar', 'autoplay-mask', 'btn-autoplay',
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const node = document.getElementById(id);
      if (node) el[key] = node;
    }
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    cacheDom();
    presence = new window.RoomPresence();
    loadProfile();
    bindProfile();
    player = new Player({ video: el.video, audio: el.audio, shell: el.playerShell });
    player.shell.classList.add('paused');
    sr = window.SuperRes ? window.SuperRes.create(el.video, el.srCanvas) : null;
    if (sr) {
      sr.onDegrade = (m) => {
        srMode = m;
        applySr();
        toast(m === 'off' ? '显卡吃力，已自动关闭超分'
          : '显卡吃力，已自动降到「效率优先」', false);
      };
    }
    if (!sr && el.btnSr) {
      el.btnSr.hidden = true;          // 浏览器不支持 WebGL2 就不显示入口
    }
    dm = new Danmaku(el.dmLayer, () => player.time);
    sync = new SyncClient();
    bindPlayer();
    bindSync();
    bindEvents();
    window.addEventListener('resize', () => { if (sr && srMode !== 'off') sr.resize(); });
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => { if (sr && srMode !== 'off') sr.resize(); }, 80);
    });
    dm.setEnabled(true);
    dm.start();
    dmOpt = loadDmOpt();
    applyDmOpt();
    setInterval(updateNetStat, 1000);
    setInterval(pingServer, 5000);
    pingServer();
    watchVersion();

    if(window.PersonalAccount)S.selfUser=await PersonalAccount.refresh();

    /* 手机端壳通过 #srv=<base64url(分享链接)> 传入房主地址，自动进入远程模式 */
    try {
      const hm = location.hash.match(/srv=([A-Za-z0-9\-_]+)/);
      if (hm) {
        let hs = hm[1].replace(/-/g, '+').replace(/_/g, '/');
        while (hs.length % 4) hs += '=';
        const remote = setRemoteServer(atob(hs));
        if (remote && remote.room) {
          history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(remote.room));
        } else history.replaceState(null, '', location.pathname);
      }
    } catch (e) {}

    /* 上次是粘在好友电脑上看的，刷新后恢复连接 */
    try {
      const sb = sessionStorage.getItem('wt.server') || '';
      if (sb && window.API) {
        API.base = sb;
        API.key = sessionStorage.getItem('wt.key') || '';
        if (el.serverInput) el.serverInput.value = sessionStorage.getItem('wt.link')
          || sb + (API.key ? '/?k=' + encodeURIComponent(API.key) : '');
      }
    } catch (e) {}
    renderServerBadge();

    try {
      const st = await API.get('/api/state');
      S.version = st.version;
      S.config = st.config || {};
      if (window.WT_MEDIA_BASE && !API.base) {
        try { S.config = {...S.config,...JSON.parse(localStorage.getItem('wt.client.config') || '{}')}; } catch (_) {}
      }
      S.user = st.user || {};
      S.share = st.share || {};
      S.relay = st.relay || S.relay;
      applyConfig();
      renderLogin();
    } catch (e) {
      toast(e.message, true);
    }

    const q = new URLSearchParams(location.search);
    const room = (q.get('room') || '').trim();
    if (S.profile && S.profile.name) el.nameInput.value = S.profile.name;
    else if (!el.nameInput.value) el.nameInput.value = randomName();
    if (room) {
      el.roomInput.value = room.toUpperCase();
      enterRoom(el.roomInput.value, el.nameInput.value, false);
      if (q.get('demo') === '1') {
        setTimeout(() => loadVideo('BV1mockDEMO0'), 900);
      }
    } else {
      if (document.body.dataset.homeMode !== 'join') el.roomInput.value = randomRoom();
    }
    if (!S.profile) openProfile(true);
  }

  function applyConfig() {
    const c = S.config || {};
    el.nameInput.value = (S.profile && S.profile.name) || c.username || '';
    S.qn = Number(c.quality) || 80;
    el.setName && (el.setName.value = c.username || '');
    if (el.setQuality) el.setQuality.value = String(S.qn);
    if (el.setMode) el.setMode.value = c.prefer_mp4 === false ? 'dash' : 'mp4';
    if (el.setOpen) el.setOpen.value = c.open_mode || 'app';

    if (el.setPublic) el.setPublic.value = c.public_addr || '';
    if (el.setVersion) el.setVersion.textContent = 'v' + (S.version || '1.0.0');
    if (el.setLocal) el.setLocal.textContent = (S.share && S.share.local) || '-';
    if (el.setShare) el.setShare.textContent = (S.share && S.share.primary) || '-';
    if (el.setSync) el.setSync.textContent = ((S.share && S.share.syncplay_port) || 8999) + ' 端口';
    el.volume.value = '80';
    player.setVolume(0.8);
    if (!srInit) {
      /* 超分是每台电脑自己的事，不跟房主配置同步，避免朋友机器被拖卡 */
      srInit = true;
      srMode = localStorage.getItem('wt.sr') || 'off';
      if (!SR_MODES.some((m) => m[0] === srMode)) srMode = 'off';
      if (sr && srMode !== 'off') sr.setMode(srMode);
      applySr();
    }
  }

  /* ---------------- AI 超分（Anime4K，参考 Kazumi 的两档方案） ---------------- */
  const SR_MODES = [
    ['off', '关闭'],
    ['fast', '效率优先（快）'],
    ['quality', '质量优先（清晰）'],
  ];

  function buildSrMenu() {
    el.srMenu.innerHTML = '';
    SR_MODES.forEach(([m, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = m === srMode ? 'active' : '';
      b.onclick = () => {
        el.srMenu.hidden = true;
        setSrMode(m);
      };
      el.srMenu.appendChild(b);
    });
  }

  function applySr() {
    if (!sr) return;
    const on = srMode !== 'off';
    el.playerShell.classList.toggle('sr-on', on);
    el.btnSr.classList.toggle('on', on);
    el.btnSr.textContent = on ? (srMode === 'quality' ? '超分·精' : '超分·快') : '超分';
    el.btnSr.title = on ? 'AI 超分（Anime4K）已开启，点此切换' : 'AI 超分（Anime4K），点此选择';
  }

  function setSrMode(m) {
    if (!sr) return toast('当前浏览器不支持 AI 超分（需要 WebGL2）', true);
    if (!sr.setMode(m)) {
      toast('当前显卡不支持这个档位，已切回效率优先', true);
      srMode = 'off';
      m = 'fast';
      sr.setMode(m);
    }
    srMode = m;
    applySr();
    toast(m === 'off' ? 'AI 超分已关闭'
      : (m === 'quality' ? 'AI 超分：质量优先（较吃显卡）' : 'AI 超分：效率优先'), false);
    try { localStorage.setItem('wt.sr', m); } catch (e) {}
  }

  /* ---------------- 昵称 / 头像 ---------------- */
  let profAvatar = '';

  function randomName() {
    return '观众' + Math.floor(Math.random() * 90 + 10);
  }

  function loadProfile() {
    try {
      S.profile = JSON.parse(localStorage.getItem('wt.profile') || 'null');
    } catch (e) {
      S.profile = null;
    }
    if (S.profile && typeof S.profile.name !== 'string') S.profile = null;
  }

  function renderProfilePreview() {
    const url = profAvatar || '';
    if (url) {
      el.profImg.src = url;
      el.profImg.hidden = false;
      el.profInitial.hidden = true;
    } else {
      el.profImg.hidden = true;
      el.profImg.removeAttribute('src');
      el.profInitial.hidden = false;
      el.profInitial.textContent = initials(el.profName.value || '我');
    }
  }

  function openProfile(first) {
    profAvatar = (S.profile && S.profile.avatar) || '';
    el.profTitle.textContent = first ? '先认识一下你' : '昵称 / 头像';
    el.profSkip.hidden = !first;
    el.profName.value = (S.profile && S.profile.name) || el.nameInput.value || randomName();
    renderProfilePreview();
    if (!el.dlgProfile.open) el.dlgProfile.showModal();
  }

  function fileToAvatar(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = c.height = 96;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2,
          s, s, 0, 0, 96, 96);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不出来，换一张试试'));
      };
      img.src = url;
    });
  }

  function saveProfile() {
    const name = el.profName.value.trim().slice(0, 16);
    if (!name) {
      toast('先写个昵称吧', true);
      el.profName.focus();
      return;
    }
    S.profile = { name, avatar: profAvatar || '' };
    try { localStorage.setItem('wt.profile', JSON.stringify(S.profile)); } catch (e) {}
    el.nameInput.value = name;
    el.dlgProfile.close();
    API.post('/api/config', { username: name }).catch(() => {});
    if (S.joined) {
      if (S.name !== name) {
        S.name = name;
        sync.join({ server: syncServer(), port: syncPort(), username: name,
                    room: S.room, avatar: '',
                    face: (S.selfUser && S.selfUser.logged_in && S.selfUser.face) || '' });
        addSys('昵称已改为 ' + name);
      } else {
        sync.avatar('');
      }
    }
    renderMembers();
  }

  function bindProfile() {
    el.profAvatar.onclick = () => el.profFile.click();
    el.profFile.onchange = async () => {
      const f = el.profFile.files && el.profFile.files[0];
      if (!f) return;
      try {
        profAvatar = await fileToAvatar(f);
        renderProfilePreview();
      } catch (e) {
        toast(e.message, true);
      }
      el.profFile.value = '';
    };
    el.profName.oninput = renderProfilePreview;
    el.profSave.onclick = saveProfile;
    el.profSkip.onclick = () => {
      S.profile = { name: el.profName.value.trim() || randomName(), avatar: '' };
      try { localStorage.setItem('wt.profile', JSON.stringify(S.profile)); } catch (e) {}
      el.nameInput.value = S.profile.name;
      el.dlgProfile.close();
    };
    el.profClose.onclick = () => finishProfileSilently();
    el.dlgProfile.addEventListener('cancel', (e) => {
      e.preventDefault();
      finishProfileSilently();
    });
    if (el.btnProfile) el.btnProfile.onclick = () => openProfile(false);
  }

  function finishProfileSilently() {
    el.dlgProfile.close();
    if (!S.profile) {
      S.profile = { name: el.profName.value.trim() || randomName(), avatar: profAvatar || '' };
      try { localStorage.setItem('wt.profile', JSON.stringify(S.profile)); } catch (e) {}
      el.nameInput.value = S.profile.name;
    }
  }

  /* ---------------- 网络 / 缓冲指示 ---------------- */
  function updateNetStat() {
    if (!el.netStat) return;
    const v = el.video;
    let ahead = 0;
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= v.currentTime + 0.3 && b.end(i) >= v.currentTime) {
          ahead = b.end(i) - v.currentTime;
          break;
        }
      }
    } catch (e) {}
    const ping = S.ping || 0;
    el.netStat.textContent = '缓冲 ' + ahead.toFixed(1) + 's · ' + (ping ? ping + 'ms' : '—');
    el.netStat.classList.toggle('warn', (ahead > 0 && ahead < 1.2) || ping > 600);
  }

  function smoothPing(rtt) {
    rtt = Math.max(1, Math.round(rtt));
    /* 指数平滑，避免延迟数字时高时低乱跳 */
    S.ping = S.ping ? Math.round(S.ping * 0.7 + rtt * 0.3) : rtt;
  }

  /* 程序升级后，已经打开着的网页（尤其是朋友的浏览器）还跑着旧脚本，
     表现就是"改了没变化"。这里定时比对服务端版本，变了就自动刷新。 */
  function watchVersion() {
    setInterval(async () => {
      try {
        const base = (window.API && API.base) || '';
        const r = await fetch(base + '/api/health', { cache: 'no-store' });
        const j = await r.json();
        if (!j || !j.version) return;
        if (!S.version) { S.version = j.version; return; }
        if (j.version !== S.version) {
          S.version = j.version;
          toast('程序已更新，正在刷新页面…');
          setTimeout(() => location.reload(), 1200);
        }
      } catch (e) {}
    }, 15000);
  }

  async function pingServer() {
    /* 在房间里优先走 WS ping：独立连接，不受视频中转排队影响 */
    if (S.joined && sync.ws && sync.ws.readyState === 1) {
      sync.send({ op: 'ping', t: performance.now() });
      return;
    }
    const t = performance.now();
    try {
      /* 连了好友的电脑就测到他那边的延迟 */
      const base = (window.API && API.base) || '';
      await fetch(base + '/api/health', { cache: 'no-store' });
      smoothPing(performance.now() - t);
    } catch (e) {
      S.ping = 0;
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    /* 弹窗右上角 ×：之前只给个别弹窗绑过，二级页面点了没反应 */
    document.querySelectorAll('dialog.dlg').forEach((d) => {
      const btn = d.querySelector('.dlg-head [data-close]');
      if (!btn || btn.id === 'prof-close') return;
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); d.close(); };
    });
    /* 点对话框以外的区域关闭（按坐标判断，避免 backdrop 事件在不同内核下取不到 target） */
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('button, input, label, a, .menu')) return;
      document.querySelectorAll('dialog.dlg[open]').forEach((d) => {
        const r = d.getBoundingClientRect();
        const outside = e.clientX < r.left || e.clientX > r.right
          || e.clientY < r.top || e.clientY > r.bottom;
        if (!outside) return;
        if (d.id === 'dlg-profile') finishProfileSilently();
        else d.close();
      });
    });
    el.btnCreate.onclick = () => enterRoom(el.roomInput.value, el.nameInput.value, true);
    el.btnJoin.onclick = () => enterRoom(el.roomInput.value, el.nameInput.value, false);
    el.btnHeroCreate.onclick = () => window.WatchInterface.setMode('create');
    el.btnHeroJoin.onclick = () => window.WatchInterface.setMode('join');
    el.btnHeroSolo.onclick = () => window.WatchInterface.setMode('solo');
    el.btnSolo.onclick = () => enterRoom('', el.nameInput.value, false, true);
    el.btnRandom.onclick = () => { el.roomInput.value = randomRoom(); };
    el.roomInput.addEventListener('input', () => {
      const pos = el.roomInput.selectionStart;
      el.roomInput.value = el.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      try { el.roomInput.setSelectionRange(pos, pos); } catch (e) {}
    });
    el.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') enterRoom(el.roomInput.value, el.nameInput.value, document.body.dataset.homeMode !== 'join');
    });
    el.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.roomInput.focus();
    });

    el.btnLogin.onclick = openLogin;
    el.btnQrRefresh.onclick = refreshQR;
    el.dlgLogin.addEventListener('close', stopLogin);
    document.getElementById('login-tab-sms').onclick = () => selectLoginMode('sms');
    document.getElementById('login-tab-qr').onclick = () => selectLoginMode('qr');
    document.getElementById('btn-sms-login').onclick = startSmsLogin;
    ['sms', 'qr'].forEach(mode => {
      document.getElementById('login-tab-' + mode).addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 'sms' : e.key === 'End' ? 'qr' : mode === 'sms' ? 'qr' : 'sms';
        selectLoginMode(next);
        document.getElementById('login-tab-' + next).focus();
      });
    });
    el.btnSettings.onclick = openSettings;
    el.btnSr.onclick = () => {
      buildSrMenu();
      el.srMenu.hidden = !el.srMenu.hidden;
    };
    el.btnBack.onclick = leaveRoom;
    el.btnShare.onclick = openShare;
    el.btnTunnel.onclick = toggleExternal;
    el.btnTunnelCopy.onclick = async () => {
      const ok = await copyText(el.tunnelLink.value);
      toast(ok ? '公网链接已复制' : '复制失败，请手动选中', !ok);
    };
    el.btnCopy.onclick = async () => {
      const ok = await copyText(el.shareLink.value);
      toast(ok ? '链接已复制' : '复制失败，请手动选中复制', !ok);
    };
    el.btnSave.onclick = saveSettings;
    el.btnShutdown.onclick = shutdown;

    el.btnPlay.onclick = userToggle;
    el.bigPlay.onclick = () => {
      /* 缓冲中点了播放：不等了，直接边下边看 */
      
      if (!player.ready) { el.bvInput.focus(); return; }
      userToggle();
    };
    player.on('usertoggle', userToggle);
    el.btnFull.onclick = () => player.toggleFullscreen();
    el.volume.oninput = () => player.setVolume(Number(el.volume.value) / 100);
    el.btnMute.onclick = () => {
      player.setMuted(!player.muted);
      updateSoundUI();
    };
    el.btnDm.onclick = () => {
      S.dmEnabled = !S.dmEnabled;
      dm.setEnabled(S.dmEnabled);
      updateDmUI();
      toast(S.dmEnabled ? '弹幕已开启' : '弹幕已关闭');
    };
    bindDmSettings();
    el.btnQuality.onclick = (e) => {
      e.stopPropagation();
      /* 还没选视频时清晰度列表是空的，先补上提示项，避免点了像没反应 */
      if (!el.qualityMenu.children.length) buildQualityMenu();
      if (!S.qualities.length) toast('还没有选择视频，先输入 BV 号或搜索番剧', true);
      toggleMenu(el.qualityMenu);
    };
    el.btnRate.onclick = (e) => {
      e.stopPropagation();
      toggleMenu(el.rateMenu);
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) {
        el.qualityMenu.hidden = true;
        el.rateMenu.hidden = true;
        el.srMenu.hidden = true;
      }
      if (!el.dmSet.hidden && !e.target.closest('#dm-set') && !e.target.closest('#btn-dm-set')) {
        el.dmSet.hidden = true;
      }
    });
    buildRateMenu();

    el.progress.addEventListener('keydown', (event) => {
      if (!player.ready) return;
      const targets = { ArrowLeft: player.time - 5, ArrowRight: player.time + 5,
        Home: 0, End: Math.max(0, player.duration - .15) };
      if (!(event.key in targets)) return;
      event.preventDefault();
      localSeek(Math.max(0, Math.min(player.duration - .15, targets[event.key])));
    });
    el.progress.addEventListener('pointerdown', (e) => {
      if (!player.ready) return;
      el.progress.setPointerCapture(e.pointerId);
      const move = (ev) => seekFromPointer(ev, false);
      const finish = () => {
        el.progress.removeEventListener('pointermove', move);
        el.progress.removeEventListener('pointerup', up);
        el.progress.removeEventListener('pointercancel', cancel);
        el.progress.removeEventListener('lostpointercapture', cancel);
        S.dragging = false;
        updateProgress();
      };
      const up = (ev) => { seekFromPointer(ev, true); finish(); };
      const cancel = () => finish();
      el.progress.addEventListener('pointermove', move);
      el.progress.addEventListener('pointerup', up);
      el.progress.addEventListener('pointercancel', cancel);
      el.progress.addEventListener('lostpointercapture', cancel);
      seekFromPointer(e, false);
    });

    el.btnLoad.onclick = () => loadVideo(el.bvInput.value);
    el.bvInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadVideo(el.bvInput.value);
    });
    el.btnSearch.onclick = (e) => {
      e.stopPropagation();
      const open = el.searchPanel.hidden;
      el.searchPanel.hidden = !open;
      el.btnSearch.classList.toggle('on', open);
      if (open) {
        el.searchInput.focus();
        el.searchInput.select();
      }
    };
    document.addEventListener('click', (e) => {
      if (el.searchPanel.hidden) return;
      if (el.searchPanel.contains(e.target) || el.btnSearch.contains(e.target)) return;
      closeSearch();
    });
    el.btnSearchGo.onclick = doAnimeSearch;
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doAnimeSearch();
      }
    });
    el.btnReload.onclick = () => {
      if (S.target) loadVideo(S.target, { keepPosition: true, page: S.page, ep: S.epId });
      else toast('还没有加载视频');
    };
    el.btnReconnect.onclick = () => {
      if (!S.room) return;
      toast('正在重新连接…');
      sync.join({ server: syncServer(), port: syncPort(), username: S.name, room: S.room,
                  avatar: '',
                  face: (S.selfUser && S.selfUser.logged_in && S.selfUser.face) || '' });
    };

    el.chatForm.onsubmit = (e) => {
      e.preventDefault();
      const text = el.chatInput.value.trim();
      if (!text) return;
      if (!S.joined) { toast('还没进入房间'); return; }
      sync.chat(text);
      el.chatInput.value = '';
    };

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        const isChat = tab.dataset.tab === 'chat';
        el.panelChat.hidden = !isChat;
        el.panelMembers.hidden = isChat;
      };
    });
    el.btnAutoplay.onclick = () => {
      el.autoplayMask.hidden = true;
      player.play();
    };
    el.autoplayMask.onclick = () => {
      el.autoplayMask.hidden = true;
      player.play();
    };

    window.addEventListener('resize', fitDanmaku);
    document.addEventListener('fullscreenchange', () => {
      setTimeout(fitDanmaku, 120);
      const fs = !!(window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement);
      el.btnFullIcon.innerHTML = '<use href="#' + (fs ? 'i-exitfull' : 'i-full') + '"/>';
      el.playerShell.classList.toggle('fs', fs);
      if (fs) armIdleTimer();
      else el.playerShell.classList.remove('hide-ui');
    });
    el.playerShell.addEventListener('mousemove', () => {
      if (!(window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement)) return;
      el.playerShell.classList.remove('hide-ui');
      armIdleTimer();
    });
    el.playerShell.addEventListener('mouseleave', () => {
      if ((window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement)) el.playerShell.classList.add('hide-ui');
    });

    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', () => { try { sync.leave(); } catch (e) {} });
  }

  function syncPort() {
    if (window.PhoneRoomMode && PhoneRoomMode.active) return PhoneRoomMode.endpoint.port;
    return (S.share && S.share.syncplay_port) || (S.config && S.config.syncplay_port) || 8999;
  }

  /* 默认走远程同步服务器（设置里可改），只有未启用时才退回本机内置服务 */
  function syncServer() {
    if (window.PhoneRoomMode && PhoneRoomMode.active && PhoneRoomMode.endpoint) return PhoneRoomMode.endpoint.server;
    return '127.0.0.1';
  }

  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (el.screenRoom.hidden) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); userToggle(); }
    else if (k === 'arrowright') { e.preventDefault(); localSeek(player.time + 5); }
    else if (k === 'arrowleft') { e.preventDefault(); localSeek(player.time - 5); }
    else if (k === 'f') { player.toggleFullscreen(); }
    else if (k === 'm') { player.setMuted(!player.muted); updateSoundUI(); }
    else if (k === 'd') { el.btnDm.click(); }
    else if (k === 'escape' && (window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement)) { window.WatchFullscreen?WatchFullscreen.exit():document.exitFullscreen().catch(() => {}); }
  }

  /* 用户主动播放/暂停：立刻广播，并在一小段时间内不被旧状态回滚 */
  function userToggle() {
    if (!player.ready) { toast('先输入 BV 号加载视频'); return; }
    const willPlay = player.paused;
    S.overrideUntil = Date.now() + 1500;
    S.roomPaused = !willPlay;
    player.toggle();
    sendState(!willPlay, false);
  }

  function localSeek(t) {
    if (!player.ready) return;
    clearTimeout(seekDebounce);
    S.overrideUntil = Date.now() + Math.max(2500, (S.ping || 0) * 2 + 1000);
    player.seek(t, true);
    sendState(player.paused, true);
    updateProgress();
  }

  function seekFromPointer(e, commit) {
    const r = el.progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t = ratio * player.duration;
    S.dragging = !commit;
    el.progressPlayed.style.width = (ratio * 100) + '%';
    el.progressKnob.style.left = (ratio * 100) + '%';
    el.timeLabel.textContent = fmtTime(t) + ' / ' + fmtTime(player.duration);
    if (commit) {
      localSeek(t);
      S.dragging = false;
      updateProgress();
    }
  }

  /* ---------------- 播放器事件 ---------------- */
  function bindPlayer() {
    player.on('ui', () => {
      const paused = player.paused;
      el.btnPlayIcon.innerHTML = '<use href="#' + (paused ? 'i-play' : 'i-pause') + '"/>';
      el.bigPlayIcon.innerHTML = '<use href="#' + (paused ? 'i-play' : 'i-pause') + '"/>';
      el.bigPlay.classList.toggle('playing-icon', !paused);
    });
    player.on('time', () => updateProgress());
    player.on('phase', phase => {
      if (S.loading) return;
      if (phase === 'buffering') setMediaStatus('正在缓冲，自动尝试可用视频线路…');
      else if (phase === 'seeking') setMediaStatus('正在载入目标位置…');
      else if (phase === 'playing' || phase === 'paused' || phase === 'idle') setMediaStatus('');
    });
    player.on('ready', (d) => {
      fitDanmaku();
      el.playerShell.classList.remove('idle');
      el.playerEmpty.hidden = true;
      updateProgress();
      if (sr && srMode !== 'off') sr.resize();
      if (S.pendingState) {
        const ps = S.pendingState;
        S.pendingState = null;
        applyRemote(Object.assign({}, ps, { doSeek: true }));
      }
    });
    player.on('blocked', () => { el.autoplayMask.hidden = false; });
    player.on('error', () => {
      setMediaStatus('视频连接中断。可重新载入，或选择较低画质。', true);
    });
    player.on('userplay', () => sendState(false, false));
    player.on('userpause', () => sendState(true, false));
    player.on('userseek', () => {
      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(() => sendState(player.paused, true), 120);
    });
    player.on('ended', () => {
      el.btnPlayIcon.innerHTML = '<use href="#i-play"/>';
    });
  }

  /* 弹幕只铺在视频画面上（不含黑边），和 B 站一致 */
  function fitDanmaku() {
    const v = el.video;
    if (!v.videoWidth || !v.videoHeight) return;
    const r = el.playerShell.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    el.dmLayer.style.left = ((r.width - w) / 2) + 'px';
    el.dmLayer.style.top = ((r.height - h) / 2) + 'px';
    el.dmLayer.style.width = w + 'px';
    el.dmLayer.style.height = h + 'px';
  }

  function updateProgress() {
    if (S.dragging) return;
    const d = player.duration || 0;
    const t = player.time || 0;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    el.progressPlayed.style.width = pct + '%';
    el.progressKnob.style.left = pct + '%';
    el.progressBuffer.style.width = player.bufferedPercent + '%';
    el.timeLabel.textContent = fmtTime(t) + ' / ' + fmtTime(d);
    el.progress.setAttribute('aria-valuemax', Math.round(d));
    el.progress.setAttribute('aria-valuenow', Math.round(t));
    el.progress.setAttribute('aria-valuetext', fmtTime(t) + ' / ' + fmtTime(d));
  }

  function updateSoundUI() {
    el.btnMuteIcon.innerHTML = '<use href="#' + (player.muted ? 'i-muted' : 'i-volume') + '"/>';
  }

  function updateDmUI() {
    el.btnDmIcon.innerHTML = '<use href="#' + (S.dmEnabled ? 'i-dm-on' : 'i-dm-off') + '"/>';
  }

  /* ---------------- 弹幕设置 ---------------- */
  const DM_SPEEDS = [
    { v: 0.6, label: '很慢' }, { v: 0.8, label: '慢' }, { v: 1, label: '适中' },
    { v: 1.3, label: '快' }, { v: 1.6, label: '很快' },
  ];

  function defaultDmOpt() {
    return {
      area: 100, opacity: 100, font: 100, speed: 3,
      scroll: true, fixed: true, color: true,
      screenScale: true, avoidSub: false, words: '',
    };
  }

  function loadDmOpt() {
    try {
      const raw = localStorage.getItem('wt.dm');
      if (raw) return Object.assign(defaultDmOpt(), JSON.parse(raw));
    } catch (e) {}
    return defaultDmOpt();
  }

  function saveDmOpt() {
    try { localStorage.setItem('wt.dm', JSON.stringify(dmOpt)); } catch (e) {}
  }

  function applyDmOpt() {
    if (!dmOpt || !dm) return;
    el.dmFScroll.checked = dmOpt.scroll;
    el.dmFFixed.checked = dmOpt.fixed;
    el.dmFColor.checked = dmOpt.color;
    el.dmScreenScale.checked = dmOpt.screenScale;
    el.dmAvoidSub.checked = dmOpt.avoidSub;
    el.dmBlock.value = dmOpt.words || '';
    el.dmArea.value = dmOpt.area;
    el.dmOpacity.value = dmOpt.opacity;
    el.dmFont.value = dmOpt.font;
    el.dmSpeed.value = dmOpt.speed;
    el.dmAreaV.textContent = dmOpt.area + '%';
    el.dmOpacityV.textContent = dmOpt.opacity + '%';
    el.dmFontV.textContent = dmOpt.font + '%';
    el.dmSpeedV.textContent = (DM_SPEEDS[dmOpt.speed - 1] || DM_SPEEDS[2]).label;
    dm.setOptions({
      area: dmOpt.area / 100,
      opacity: dmOpt.opacity / 100,
      fontScale: dmOpt.font / 100,
      speed: (DM_SPEEDS[dmOpt.speed - 1] || DM_SPEEDS[2]).v,
      showScroll: dmOpt.scroll,
      showFixed: dmOpt.fixed,
      showColor: dmOpt.color,
      screenScale: dmOpt.screenScale,
      avoidSub: dmOpt.avoidSub,
      words: dmOpt.words,
    });
  }

  function bindDmSettings() {
    el.btnDmSet.onclick = (e) => {
      e.stopPropagation();
      el.dmSet.hidden = !el.dmSet.hidden;
    };
    el.dmSet.addEventListener('click', (e) => e.stopPropagation());
    el.dmArea.oninput = () => { dmOpt.area = Number(el.dmArea.value); applyDmOpt(); saveDmOpt(); };
    el.dmOpacity.oninput = () => { dmOpt.opacity = Number(el.dmOpacity.value); applyDmOpt(); saveDmOpt(); };
    el.dmFont.oninput = () => { dmOpt.font = Number(el.dmFont.value); applyDmOpt(); saveDmOpt(); };
    el.dmSpeed.oninput = () => { dmOpt.speed = Number(el.dmSpeed.value); applyDmOpt(); saveDmOpt(); };
    el.dmFScroll.onchange = () => { dmOpt.scroll = el.dmFScroll.checked; applyDmOpt(); saveDmOpt(); };
    el.dmFFixed.onchange = () => { dmOpt.fixed = el.dmFFixed.checked; applyDmOpt(); saveDmOpt(); };
    el.dmFColor.onchange = () => { dmOpt.color = el.dmFColor.checked; applyDmOpt(); saveDmOpt(); };
    el.dmScreenScale.onchange = () => { dmOpt.screenScale = el.dmScreenScale.checked; applyDmOpt(); saveDmOpt(); };
    el.dmAvoidSub.onchange = () => { dmOpt.avoidSub = el.dmAvoidSub.checked; applyDmOpt(); saveDmOpt(); };
    el.dmBlock.onchange = () => { dmOpt.words = el.dmBlock.value; applyDmOpt(); saveDmOpt(); };
  }

  function toggleMenu(menu) {
    const show = menu.hidden;
    el.qualityMenu.hidden = true;
    el.rateMenu.hidden = true;
    if (show) {
      menu.hidden = false;
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) menu.style.right = '0px';
      if (r.left < 8) menu.style.left = '0px';
    }
  }

  function buildRateMenu() {
    el.rateMenu.innerHTML = '';
    for (const r of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const b = document.createElement('button');
      b.textContent = r.toFixed(2).replace(/0$/, '') + 'x';
      b.classList.toggle('active', r === 1);
      b.onclick = (e) => {
        e.stopPropagation();
        S.rate = r;
        player.setRate(r);
        el.btnRate.textContent = r === 1 ? '1.0x' : r + 'x';
        el.rateMenu.hidden = true;
        Array.from(el.rateMenu.children).forEach((c) => c.classList.toggle('active', c === b));
      };
      el.rateMenu.appendChild(b);
    }
  }

  /* ---------------- 房间 ---------------- */
  async function enterRoom(roomRaw, nameRaw, isHost, solo) {
    const soloMode = !!solo;
    window.RoomJoinNotice.prime();
    if(window.ChatAlerts)ChatAlerts.prime();
    let remote = false, room = '';
    if (!soloMode) {
      /* 先看「好友的电脑」：填了就连房主的服务器，链接里带的房间号优先 */
      remote = setRemoteServer(!isHost && el.serverInput ? el.serverInput.value : '');
      if (remote === false) return;
      if (window.PhoneRoomMode && (isHost || !remote)) {
        try { PhoneRoomMode.use(PhoneRoomMode.defaults()); }
        catch (error) { toast(error.message, true); return; }
      }
      let roomText = roomRaw;
      if (remote && remote.room) {
        roomText = remote.room;
        if (el.roomInput) el.roomInput.value = remote.room;
      }
      room = (roomText || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (room.length < 3 || room.length > 12) { toast('房间号至少 3 位', true); return; }
    } else {
      /* 单人观看必须回到本机服务，避免沿用上一次好友电脑的地址 */
      setRemoteServer('');
    }
    if (remote && !remote.phone) {
      /* 先确认能连上好友的电脑，顺便拿房主的登录态和画质配置 */
      try {
        const st = await API.get('/api/state');
        S.version=st.version||S.version;
        S.user = st.user || {};
        S.share = st.share || S.share;
        S.relay = st.relay || S.relay;
        S.config = st.config || S.config;
        S.qn = Number(S.config.quality) || S.qn;
        renderLogin();
        toast('已连接好友的电脑：' + remote.base.replace(/^https?:\/\//, ''));
      } catch (e) {
        toast('连不上好友的电脑：' + e.message, true);
        setRemoteServer('');
        return;
      }
    }
    // First-run profile setup may complete while the remote state request is pending.
    let name = ((el.nameInput && el.nameInput.value) || nameRaw || '').trim();
    if (!name) name = (S.config && S.config.username) || ('观众' + Math.floor(Math.random() * 90 + 10));
    S.room = soloMode ? '' : room;
    S.name = name;
    S.isHost = !!isHost && !soloMode;
    S.solo = soloMode;
    presence.stop();
    S.users = [];
    S.bvid = '';
    S.target = '';
    S.page = 1;
    S.epId = '';
    S.cid = '';
    S.info = null;
    el.episodeBar.hidden = true;
    el.epList.innerHTML = '';
    player.reset();
    el.playerEmpty.hidden = false;
    el.videoTitle.textContent = '还没有加载视频';
    el.videoSub.textContent = soloMode ? '粘贴视频链接、BV 号或番剧链接即可开始' : '房主输入 BV 号后，其他人会自动载入';
    el.ptTitle.textContent = '还没有视频';
    el.nameInput.value = name;
    if (isHost) API.post('/api/config', { username: name }).catch(() => {});

    el.screenHome.hidden = true;
    const entryPage=document.getElementById('screen-room-entry');
    if(entryPage)entryPage.hidden=true;
    document.body.classList.remove('entering-room');
    document.body.classList.add('in-room');
    document.body.classList.toggle('solo-watch', soloMode);
    el.screenRoom.hidden = false;
    el.btnBack.hidden = false;
    el.btnShare.hidden = soloMode;
    el.btnSearch.hidden = false;
    el.roomChip.hidden = false;
    el.connPill.hidden = false;
    el.roomChipCode.textContent = soloMode ? '单人' : room;
    el.ptRoom.textContent = soloMode ? '单人观看' : '房间 ' + room;
    el.footServer.textContent = soloMode ? '仅本机 · 不连接房间'
      : (remote ? remote.base.replace(/^https?:\/\//, '') : (window.PhoneRoomMode && PhoneRoomMode.active ? PhoneRoomMode.endpoint.server : '本机')) + ' · ' + syncPort();
    el.chatList.innerHTML = '';
    addSys(soloMode ? '已进入单人观看，粘贴视频链接即可开始'
      : window.PhoneRoomMode && PhoneRoomMode.active ? '正在连接异地房间 ' + room : remote ? ('已进入好友电脑上的房间 ' + room) : ('已进入房间 ' + room + '，把邀请链接发给朋友吧'));
    setConn(soloMode ? 'ok' : 'wait', soloMode ? '单人观看' : '连接中…');

    if (!soloMode) {
      try {
        await sync.join({ server: syncServer(), port: syncPort(), username: name, room,
                          avatar: '',
                          face: (S.selfUser && S.selfUser.logged_in && S.selfUser.face) || '' });
      } catch (e) {
        setConn('bad', '连接失败');
        toast(e.message, true);
      }
      startHeartbeat();
    }
    if (isHost) {
      window.scrollTo(0, 0);
      el.bvInput.focus({ preventScroll:true });
      setTimeout(() => {
        if (!S.bvid) toast('在上方粘贴视频链接，朋友会自动载入同一视频');
      }, 700);
      // Keep the source field ready; invitations have a permanent app-bar action.
    }
    window.dispatchEvent(new CustomEvent('wt-room-entered', {detail:{isHost:!!isHost}}));
  }

  function leaveRoom() {
    if (player.ready && !confirm('确定要退出房间吗？')) return;
    presence.stop();
    window.RoomJoinNotice.hide();
    if(window.ChatAlerts)ChatAlerts.reset();
    ++S.loadToken;
    if (S.loadController) S.loadController.abort();
    S.loading = false;
    S.target = '';
    S.pendingFile = null;
    S.retryRequest = null;
    el.btnLoad.disabled = false;
    el.btnLoad.textContent = '播放';
    setMediaStatus('');
    S.joined = false;
    sync.leave();
    stopHeartbeat();
    if(window.WatchFullscreen)WatchFullscreen.exit();
    player.reset();
    el.screenRoom.hidden = true;
    el.screenHome.hidden = false;
    document.body.classList.remove('in-room');
    document.body.classList.remove('solo-watch');
    el.btnBack.hidden = true;
    el.btnShare.hidden = true;
    el.btnSearch.hidden = true;
    closeSearch();
    el.roomChip.hidden = true;
    el.connPill.hidden = true;
    S.room = '';
    S.solo = false;
    S.joined = false;
    S.users = [];
    S.bvid = '';
    S.pendingState = null;
    el.roomInput.value = randomRoom();
    el.ptMembers.textContent = '1 人';
    el.videoTitle.textContent = '还没有加载视频';
    el.videoSub.textContent = '房主输入 BV 号后，其他人会自动载入';
    el.ptTitle.textContent = '还没有视频';
    el.playerEmpty.hidden = false;
    el.bvInput.value = '';
    dm.load([]);
    el.chatList.innerHTML = '';
    history.replaceState(null, '', location.pathname);
    window.scrollTo(0, 0);
  }

  function bindSync() {
    sync.on('connected', (ev) => {
      if ((ev.room || '').toUpperCase() !== S.room) return;
      const endpoint=window.PhoneRoomMode && PhoneRoomMode.active && PhoneRoomMode.endpoint;
      if(endpoint && ev.server && (ev.server.toLowerCase()!==endpoint.server.toLowerCase() || Number(ev.port)!==Number(endpoint.port))) return;
      S.joined = true;
      S.myName = ev.username || S.name;
      presence.start(S.myName);
      setConn('ok', '已连接');
      el.footConn.textContent = '已连接';
      el.footServer.textContent = (window.PhoneRoomMode && PhoneRoomMode.active
        ? PhoneRoomMode.endpoint.server + ':' + PhoneRoomMode.endpoint.port
        : (window.API && API.base) ? API.base.replace(/^https?:\/\//, '') : '本机') + ' · ' + ev.room;
      addSys('已连上房间 ' + ev.room);
      setTimeout(probeSpeed, 2500);
      if (S.target) {
        sync.file(fileName(), player.duration || (S.info && S.info.duration) || 0);
      }
      sync.send({ op: 'list' });
      updateShareLink();
    });
    sync.on('join_ack', (ev) => {
      if (!ev.ok) toast('加入房间失败', true);
    });
    sync.on('disconnected', (ev) => {
      presence.stop();
      S.joined = false;
      setConn('bad', '已断开');
      el.footConn.textContent = '已断开';
      addSys('与服务器断开：' + (ev.reason || '未知原因'));
    });
    sync.on('error', (ev) => {
      S.joined = false;
      presence.stop();
      setConn('bad', '连接异常');
      el.footConn.textContent = '连接异常';
      toast(ev.message || '同步服务出错', true);
      addSys(ev.message || '同步服务出错');
    });
    sync.on('users', (ev) => {
      const users = (ev.rooms && ev.rooms[S.room]) || [];
      presence.snapshot(users);
      S.users = users;
      refreshChatAvatars();
      renderMembers();
      const fileUser = users.find((u) => u.file && parseFileInfo(u.file.name));
      if (!S.target && fileUser) maybeFollowFile(fileUser.file);
    });
    sync.on('user_event', (ev) => {
      if (ev.event === 'joined') {
        addSys((ev.username || '有人') + ' 加入了房间');
        if (presence.joined(ev.username)) window.RoomJoinNotice.show(ev.username);
        if (!S.target && ev.file) maybeFollowFile(ev.file);
      } else if (ev.event === 'left') {
        presence.left(ev.username);
        addSys((ev.username || '有人') + ' 离开了房间');
      } else if (ev.file && ev.username !== (S.myName || S.name)) {
        maybeFollowFile(ev.file);
      }
      sync.send({ op: 'list' });
    });
    sync.on('state', (ev) => {
      ev._receivedAt = performance.now();
      if (ev.setBy && ev.setBy === (S.myName || S.name)) {
        S.lastRemoteAt = Date.now();
        return;
      }
      S.lastRemoteAt = Date.now();
      if (ev.rtt != null) {
        const ms = Math.max(0, Math.round(ev.rtt));
        el.ptRtt.hidden = false;
        el.ptRtt.textContent = ms + ' ms';
        el.footRtt.textContent = ms + ' ms';
      }
      applyRemote(ev);
    });
    if(window.ChatAlerts)ChatAlerts.configure(text=>{if(!S.joined){toast('请先连接房间',true);return false;}return sync.chat(text);});
    sync.on('chat',ev=>{addChat(ev.username,ev.message);if(S.joined&&ev.username!==(S.myName||S.name)&&window.ChatAlerts)ChatAlerts.notify(ev.username,ev.message,avatarNode(ev.username));});
    sync.on('pong', (ev) => {
      if (ev.t) smoothPing(performance.now() - ev.t);
    });
    sync.on('wsclose', () => {
      presence.stop();
      S.joined = false;
      setConn('bad', '连接中断');
    });
  }

  function fileName() {
    if(S.target.indexOf('anime:')===0)return S.target;
    return 'bilibili:' + S.target + ':' + (S.cid || '') + ':p' + (S.page || 1);
  }

  let pendingDownload = null;
  let pendingAnime=null;
  window.addEventListener('wt-anime-play',event=>{if(!S.joined&&!S.solo){pendingAnime=event.detail;window.WatchInterface.openEntry('create');}else loadVideo(event.detail);});
  window.addEventListener('wt-download-play', (event) => {
    const item=event.detail;
    if(!S.joined&&!S.solo){pendingDownload=item;window.WatchInterface.openEntry('create');return;}
    loadVideo(item.target,{page:item.page,retryDownload:!!item.retry});
  });
  window.addEventListener('wt-room-entered',()=>{
    if(pendingAnime){const target=pendingAnime;pendingAnime=null;loadVideo(target);}
    if(pendingDownload){const item=pendingDownload;pendingDownload=null;loadVideo(item.target,{page:item.page,retryDownload:!!item.retry});}
  });

  function parseTarget(text) {
    text = (text || '').trim();
    if(/^anime:(giri|mxdm|ezdmw|baimao|sefun|aki):[A-Za-z0-9_-]{1,40}:\d{1,6}:\d{1,10}$/.test(text))return {target:text,page:1};
    const bvid = parseBvid(text);
    if (bvid) return { target: bvid, page: 1 };
    const m = text.match(/(?:^|[^0-9A-Za-z])(ep|ss)(\d+)/i);
    if (m) return { target: m[1].toLowerCase() + m[2], page: 1 };
    return null;
  }

  function parseFileInfo(name) {
    if(/^anime:(giri|mxdm|ezdmw|baimao|sefun|aki):[A-Za-z0-9_-]{1,40}:\d{1,6}:\d{1,10}$/.test(name||''))return {target:name,page:1};
    if (!name || name.indexOf('bilibili:') !== 0) return null;
    const parts = name.slice('bilibili:'.length).split(':');
    const target = (parts[0] || '').trim();
    if (!target) return null;
    let page = 1;
    for (let i = 1; i < parts.length; i++) {
      const m = (parts[i] || '').match(/^p(\d+)$/i);
      if (m) page = Number(m[1]) || 1;
    }
    return { target: target, page: page };
  }

  function maybeFollowFile(file) {
    const info = parseFileInfo(file && file.name);
    if (!info) return;
    if (info.target === S.target && info.page === S.page) return;
    if (S.loading) { S.pendingFile = file; return; }
    addSys('正在载入房间视频…');
    loadVideo(info.target, { fromRemote: true, page: info.page });
  }

  function applyRemote(ev) {
    if (S.dragging || Date.now() < S.overrideUntil) return;
    if (!player.ready) { S.pendingState = ev; return; }
    S.roomPaused = !!ev.paused;
    const received = ev._receivedAt || performance.now();
    const pos = (ev.position || 0) + (ev.paused ? 0 :
      (ev.age || 0) + Math.max(0, performance.now() - received) / 1000 + (S.ping || 0) / 2000);
    /* 心跳位置的误差约为 RTT/2：延迟越高，同步阈值越要放宽，否则会反复追赶 */
    const ping = S.ping || 0;
    const tol = {
      nudge: Math.min(1.0, Math.max(0.4, ping / 1500)),
      seek: Math.min(2.5, Math.max(1.2, ping / 1000)),
    };
    player.applyRemote(pos, !!ev.paused, !!ev.doSeek, tol);
    if (!ev.paused && el.autoplayMask.hidden === false) el.autoplayMask.hidden = true;
  }

  function sendState(paused, doSeek) {
    if (!S.joined || !player.ready || S.loading) return;
    sync.state(player.time, paused, doSeek);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      // 只上报进度，不改变房间的播放/暂停状态（否则会互相暂停）
      if (S.joined && player.ready && !S.dragging && !player.video.seeking
          && player.video.readyState >= 3 && Date.now() >= S.overrideUntil)
        sync.state(player.time, S.roomPaused, false, true);
    }, 1500);
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function setConn(cls, text) {
    el.connPill.className = 'conn ' + cls;
    el.connText.textContent = text;
  }

  /* ---------------- 番剧搜索 ---------------- */
  function fmtCount(n) {
    n = Math.max(0, Math.floor(n || 0));
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }

  function renderSearchResults(items) {
    el.searchList.innerHTML = '';
    if (!items.length) {
      el.searchList.innerHTML = '<div class="search-empty">没找到番剧正片，换个关键词再试试</div>';
      return;
    }
    items.forEach((it) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-item ripple';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.pic ? ('/api/cover?u=' + encodeURIComponent(it.pic)) : '';
      img.alt = '';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      const info = document.createElement('div');
      info.className = 'search-info';
      const title = document.createElement('div');
      title.className = 'search-title';
      title.textContent = it.title;
      const sub = document.createElement('div');
      sub.className = 'search-sub';
      const bits = [];
      if (it.kind !== 'bangumi' && it.author) bits.push(it.author);
      if (it.duration_text) bits.push(it.duration_text);
      else if (it.duration) bits.push(fmtTime(it.duration));
      bits.push(fmtCount(it.play) + ' 播放');
      sub.textContent = bits.join(' · ');
      info.appendChild(title);
      info.appendChild(sub);
      const badge = document.createElement('span');
      badge.className = 'search-badge';
      badge.textContent = it.type || '动画';
      row.appendChild(img);
      row.appendChild(info);
      row.appendChild(badge);
      const target = it.target || it.bvid;
      row.onclick = () => {
        closeSearch();
        el.bvInput.value = target;
        loadVideo(target);
      };
      el.searchList.appendChild(row);
    });
  }

  function closeSearch() {
    el.searchPanel.hidden = true;
    el.btnSearch.classList.remove('on');
  }

  async function doAnimeSearch() {
    const kw = el.searchInput.value.trim();
    if (!kw) {
      el.searchInput.focus();
      return;
    }
    el.searchList.innerHTML = '<div class="search-empty">搜索中…</div>';
    if(window.AnimeSources && document.getElementById('search-provider').value!=='bilibili')return AnimeSources.search(kw);
    try {
      const r = await API.get('/api/search?kw=' + encodeURIComponent(kw));
      renderSearchResults(r.items || []);
    } catch (e) {
      el.searchList.innerHTML = '<div class="search-empty">搜索失败：'
        + escapeHtml(e.message || '请稍后再试') + '</div>';
    }
  }

  /* ---------------- 视频 ---------------- */
  /* 播放前先把整段音视频下到房主电脑的磁盘缓存，
     下完再开始播放，避免边播边卡、拖进度条时音画对不上。
     客户端不想等可以直接点播放跳过。 */
  function fmtMB(bytes) {
    return (Math.max(0, bytes) / 1048576).toFixed(1) + 'MB';
  }

  function setMediaStatus(message, failed) {
    const box = document.getElementById('media-status');
    if (!box) return;
    box.hidden = !message;
    box.classList.toggle('error', !!failed);
    document.getElementById('media-status-text').textContent = message || '';
    const retry = document.getElementById('btn-media-retry');
    retry.hidden = !failed;
    retry.onclick = () => {
      const request = S.retryRequest;
      if (request) loadVideo(request.input, request.opts);
      else if (S.target) loadVideo(S.target, { keepPosition: true, page: S.page, ep: S.epId });
    };
  }

  async function loadVideo(input, opts) {
    opts = opts || {};
    const t = parseTarget(input);
    if (!t) { toast('没有识别到 BV 号 / 番剧 ep、ss，例如 BV1GJ411x7h7 或 ep123456', true); return; }
    const target = t.target;
    const page = Number(opts.page) || 1;
    const keep = opts.keepPosition ? player.time : 0;
    if (S.loadController) S.loadController.abort();
    if (S.loading) player.reset();
    const controller = S.loadController = new AbortController();
    S.retryRequest = { input, opts: Object.assign({}, opts) };
    const token = ++S.loadToken;
    S.loading = true;
    el.btnLoad.disabled = true;
    el.btnLoad.textContent = '载入中';
    setMediaStatus('正在获取视频…');
    el.bvHint.textContent=target.indexOf('anime:')===0?'正在由本机解析片源…':'正在向 B 站请求播放地址…';
    try {
      let url = '/api/video?bv=' + encodeURIComponent(target) + '&qn=' + S.qn + '&p=' + page;
      if (opts.ep) url += '&ep=' + encodeURIComponent(opts.ep);
      if (opts.forceMode) url += '&mode=' + opts.forceMode;
      else if (S.qn >= 80) url += '&mode=dash';
      const offline = window.DeviceLibrary && !opts.retryDownload && await DeviceLibrary.resolve(target,page,S.qn);
      const r = offline || (target.indexOf('anime:')===0 && window.SourceEngine
        ? await SourceEngine.video(target,controller.signal)
        : await API.get(url, { signal: controller.signal }));
      if (token !== S.loadToken) return;
      S.info = r.info;
      S.target = r.target || target;
      S.bvid = r.info.bvid || '';
      S.page = r.page || page;
      S.epId = r.ep_id ? String(r.ep_id) : '';
      S.cid = r.cid;
      S.qualities = r.qualities || [];
      S.qn = r.qn || S.qn;
      el.videoTitle.textContent = r.info.title || '未命名视频';
      const owner = r.info.is_anime ? r.info.owner : r.info.is_bangumi ? '番剧' : 'UP 主：' + (r.info.owner || '未知');
      const qlabel = r.info.is_anime ? '默认线路' : (((S.qualities.find((q) => q.qn === S.qn) || {}).label) || ({80:'1080P',64:'720P',32:'480P',16:'360P',112:'1080P+',116:'1080P60',120:'4K'}[S.qn] || '所选画质'));
      el.videoSub.textContent = owner + (r.offline ? ' · 本机播放' : '') + ' · ' + fmtTime(r.info.duration) + ' · ' + qlabel +
        (r.info.is_bangumi ? '' : (S.page > 1 ? ' · P' + S.page : ''));
      el.ptTitle.textContent = r.info.title || '一起看';
      el.bvHint.textContent = '已加载 ' + (r.info.bvid || target) + '，其他人会自动同步';
      el.bvInput.value = '';
      buildQualityMenu();
      renderEpisodes();
      if(window.DeviceLibrary) DeviceLibrary.capture(r,fileName());
      if(!r.offline) r.source = MediaSourceRoute.local(r.source, window.WT_MEDIA_BASE);
      S.skipCache = false;
      // The local relay fills its cache while streaming; do not wait for the
      // entire high-quality video to download before attaching the player.
      if (token !== S.loadToken) return;
      setMediaStatus('正在加载所选画质的音视频…');
      try {
        await player.load(r.source, { position: keep, paused: true });
      } catch (loadErr) {
        if (r.source.mode === 'dash') {
          throw new Error('高清加载失败：' + loadErr.message + '。请点击重新载入，或手动选择较低画质。');
        }
        throw loadErr;
      }
      if (token !== S.loadToken) return;
      el.playerEmpty.hidden = true;
      // Keep the local host's file metadata available to guests that join later,
      // including when the host followed an already connected guest after restart.
      sync.file(fileName(), r.info.duration || 0);
      updateShareLink();
      if(S.cid)loadDanmaku(S.cid);
      if (keep) localSeek(keep);
      setMediaStatus('');
      toast('已载入：' + (r.info.title || target).slice(0, 26));
    } catch (e) {
      if (token === S.loadToken) {
        setMediaStatus(e.message, true);
        toast(e.message, true);
        el.bvHint.textContent = e.message;
      }
    } finally {
      if (token === S.loadToken) {
        S.loading = false;
        el.btnLoad.disabled = false;
        el.btnLoad.textContent = '播放';
        if (S.pendingFile) {
          const pending = S.pendingFile;
          S.pendingFile = null;
          maybeFollowFile(pending);
        }
      }
    }
  }

  /* 选集条：番剧显示剧集，普通视频显示分P；只有一集就隐藏 */
  function renderEpisodes() {
    const info = S.info || {};
    const eps = info.episodes || [];
    const pages = info.pages || [];
    el.epList.innerHTML = '';
    let count = 0;
    if (eps.length) {
      eps.forEach((e, i) => {
        if (!e.ep_id && !e.target) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ep-item ripple';
        const label = (e.title || ('第' + (i + 1) + '话')) +
          (e.long_title ? ' ' + e.long_title : '');
        b.textContent = label;
        b.title = label;
        b.classList.toggle('active', String(e.ep_id) === String(S.epId));
        b.onclick = () => {
          if (String(e.ep_id) === String(S.epId)) return;
          loadVideo(e.target || 'ep' + e.ep_id);
        };
        el.epList.appendChild(b);
        count++;
      });
    } else if (pages.length > 1) {
      pages.forEach((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ep-item ripple';
        const label = 'P' + p.page + (p.part ? ' ' + p.part : '');
        b.textContent = label;
        b.title = label;
        b.classList.toggle('active', Number(p.page) === Number(S.page));
        b.onclick = () => {
          if (Number(p.page) === Number(S.page)) return;
          loadVideo(S.target, { page: p.page });
        };
        el.epList.appendChild(b);
        count++;
      });
    }
    el.episodeBar.hidden = count <= 1;
    if (count <= 1) el.epList.innerHTML = '';
  }

  async function loadDanmaku(cid) {
    if (!cid) return;
    try {
      const r = await API.get('/api/danmaku?cid=' + encodeURIComponent(cid));
      dm.load(r.items || []);
      dm.setEnabled(S.dmEnabled);
    } catch (e) {
      console.warn('弹幕加载失败', e);
    }
  }

  /* 测一下到服务器的实际带宽，用来提示画质。
     外网访问走中转时经常只有一两百 KB/s，1080P 根本喂不动。 */
  const QN_LADDER = [
    { qn: 80, need: 800, label: '1080P' },
    { qn: 64, need: 400, label: '720P' },
    { qn: 32, need: 180, label: '480P' },
    { qn: 16, need: 0, label: '360P' },
  ];

  function qnForKbps(kbps) {
    for (const it of QN_LADDER) {
      if (kbps >= it.need) return it.qn;
    }
    return 16;
  }

  function suggestQuality(kbps) {
    const qn = qnForKbps(kbps);
    const hit = QN_LADDER.find((x) => x.qn === qn);
    return hit ? hit.label : '360P';
  }

  function labelOfQn(qn) {
    const q = (S.qualities || []).find((x) => x.qn === qn);
    return (q && q.label) || (qn + 'P');
  }

  async function probeSpeed() {
    const t = performance.now();
    try {
      /* 测「给我供流的那个服务器」的速度：本机/桌面朋友测本机 relay，
         网页版朋友测房主中转（他的视频确实走房主） */
      const base = '';
      const r = await fetch(base + '/api/speed?bytes=524288&t=' + Date.now(), { cache: 'no-store' });
      const buf = await r.arrayBuffer();
      const dt = (performance.now() - t) / 1000;
      if (!buf.byteLength || dt <= 0.05) return;
      S.kbps = Math.round(buf.byteLength / 1024 / dt);
      buildQualityMenu();
      /* 只做提示，不自动改画质：画质由用户自己决定 */
      if (S.kbps < 350) {
        toast('当前线路约 ' + S.kbps + ' KB/s，1080P 可能不够流畅（可在画质里手动调整）', true);
      }
    } catch (e) {
      /* 测速失败不影响正常使用 */
    }
  }

  function buildQualityMenu() {
    el.qualityMenu.innerHTML = '';
    if (!S.qualities.length) {
      const b = document.createElement('button');
      el.btnQuality.textContent=S.info&&S.info.is_anime?'源画质':'本机画质';
      b.textContent=S.info&&S.info.is_anime?'使用当前片源提供的画质':'播放已保存的本机画质';
      el.qualityMenu.appendChild(b);
      return;
    }
    /* 外网线路慢时给出画质建议，避免朋友端一直转圈 */
    if (S.kbps && S.kbps < 900) {
      const tip = document.createElement('div');
      tip.style.cssText = 'padding:6px 10px;font-size:12px;opacity:.65;line-height:1.5';
      tip.textContent = '当前线路约 ' + S.kbps + ' KB/s，建议选 ' + suggestQuality(S.kbps);
      el.qualityMenu.appendChild(tip);
    }
    for (const q of S.qualities) {
      const b = document.createElement('button');
      const lock = q.available === false;
      b.innerHTML = '<span>' + q.label + '</span>' +
        (lock ? '<span class="tag">需登录/大会员</span>'
              : (q.qn === S.qn ? '<span class="tag">当前</span>' : ''));
      b.classList.toggle('active', q.qn === S.qn);
      if (lock) b.classList.add('locked');
      b.onclick = (e) => {
        e.stopPropagation();
        el.qualityMenu.hidden = true;
        if (lock) { toast('这个画质需要先登录 B 站（1080P60 / 4K 还需要大会员）', true); return; }
        if (q.qn === S.qn) return;
        S.qn = q.qn;
        el.btnQuality.textContent = q.label;
        API.post('/api/config', { quality: q.qn }).catch(() => {});
        loadVideo(S.target, { keepPosition: true, page: S.page, ep: S.epId });
      };
      el.qualityMenu.appendChild(b);
    }
    const cur = S.qualities.find((q) => q.qn === S.qn);
    if (cur) el.btnQuality.textContent = cur.label;
  }

  /* ---------------- 成员 / 聊天 ---------------- */
  // B 站头像有防盗链，统一走 /api/cover 带 Referer 中转
  function faceUrl(src) {
    const u = (src || '').trim();
    if (!u) return '';
    if (u.indexOf('data:') === 0) return u;
    if (u.indexOf('/api/cover') === 0) return absUrl(u);
    return '/api/cover?u=' + encodeURIComponent(u);
  }

  function refreshChatAvatars(){document.querySelectorAll('.chat-msg[data-user]').forEach(node=>{const old=node.querySelector('.chat-avatar');if(old)old.replaceWith(avatarNode(node.dataset.user));});}
  window.addEventListener('wt-personal-account',event=>{S.selfUser=event.detail||{logged_in:false};if(!el.loginTitle)return;renderLogin();if(S.joined){sync.face(S.selfUser.logged_in?S.selfUser.face||'':'');sync.avatar('');}refreshChatAvatars();renderMembers();});

  function avatarNode(name, src, face) {
    const av = document.createElement('div');
    av.className = 'chat-avatar';
    const user = S.users.find((x) => x.name === name);
    const mine=name===(S.myName||S.name);
    const bili=mine ? (S.selfUser.logged_in ? S.selfUser.face : '') : face || (user && user.face) || '';
    const img=faceUrl(bili);
    if (img) {
      const node = document.createElement('img');
      node.src = img;
      node.alt = '';
      node.onerror = () => fallbackAvatar(av, name);
      av.appendChild(node);
      av.classList.add('has-img');
    } else {
      fallbackAvatar(av, name);
    }
    return av;
  }

  function fallbackAvatar(av, name) {
    av.classList.remove('has-img');
    av.innerHTML = '';
    av.innerHTML='<svg aria-hidden="true"><use href="#i-users"/></svg>';
    av.style.background='var(--surface-container-highest)';
    av.style.color='var(--on-surface-variant)';

  }

  function renderMembers() {
    const users = S.users.slice();
    el.memberCount.textContent = String(users.length);
    el.ptMembers.textContent = users.length + ' 人';
    el.memberList.innerHTML = '';
    if (!users.length) {
      el.memberList.innerHTML = '<div class="chat-sys">还没有其他人，把链接发给朋友吧</div>';
      return;
    }
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'member';
      const av = avatarNode(u.name, u.avatar, u.face);
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = u.name + (u.name === S.myName || u.name === S.name ? '（你）' : '');
      row.appendChild(av);
      row.appendChild(nm);
      const fu = u.file ? parseFileInfo(u.file.name) : null;
      const isHostUser = !!(fu && S.target && fu.target === S.target);
      if (isHostUser) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '房主';
        row.appendChild(tag);
      }
      el.memberList.appendChild(row);
    }
  }

  function addChat(name, text) {
    if (!name) return;
    const wrap = document.createElement('div');
    wrap.dataset.user=name;
    const mine = name === (S.myName || S.name);
    wrap.className = 'chat-msg' + (mine ? ' mine' : '');
    const av = avatarNode(name);
    const body = document.createElement('div');
    body.className = 'chat-body';
    const nm = document.createElement('div');
    nm.className = 'chat-name';
    nm.innerHTML = '<span class="' + (mine ? 'me' : '') + '">' + escapeHtml(name) + (mine ? '（你）' : '') + '</span>';
    const tx = document.createElement('div');
    tx.className = 'chat-text';
    tx.textContent = text;
    body.appendChild(nm);
    body.appendChild(tx);
    wrap.appendChild(av);
    wrap.appendChild(body);
    el.chatList.appendChild(wrap);
    el.chatList.scrollTop = el.chatList.scrollHeight;
    while (el.chatList.children.length > 300) el.chatList.firstChild.remove();
  }

  function addSys(text) {
    const d = document.createElement('div');
    d.className = 'chat-sys';
    d.textContent = text;
    el.chatList.appendChild(d);
    el.chatList.scrollTop = el.chatList.scrollHeight;
    while (el.chatList.children.length > 300) el.chatList.firstChild.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 登录 ---------------- */
  function renderLoginAvatar(u) {
    el.avatar.innerHTML = '';
    el.avatar.style.backgroundImage = '';
    const url = faceUrl(u.face);
    if (!url) {
      el.avatar.textContent = initials(u.uname || '我');
      return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.onerror = () => {
      el.avatar.innerHTML = '';
      el.avatar.textContent = initials(u.uname || '我');
    };
    el.avatar.appendChild(img);
  }

  function renderLogin() {
    el.btnLogin.hidden = false;
    const u = S.selfUser || {};
    if (u.logged_in) {
      renderLoginAvatar(u);
      el.loginTitle.textContent = u.uname || '已登录';
      el.loginSub.textContent = (u.vip ? '大会员 · ' : '') + '已登录，可以播放高画质';
      el.btnLogin.textContent = '已登录';
      el.btnLogin.classList.remove('outlined');
      el.btnLogin.classList.add('text');
    } else {
      el.avatar.innerHTML = '';
      el.avatar.style.backgroundImage = '';
      el.avatar.textContent = '?';
      el.loginTitle.textContent = '未登录 B 站';
      el.loginSub.textContent = S.isHost || S.solo ? '登录后使用账号可用的高清画质' : '房主登录后，你这边也能看高画质';
      el.btnLogin.textContent = '登录 B 站';
    }
    renderServerBadge();
    el.loginSub.textContent=u.logged_in?'聊天中显示你的 B 站头像':'登录后，聊天中显示你的 B 站头像';
    const logout=document.getElementById('btn-account-logout');if(logout)logout.hidden=!u.logged_in;

  }

  function openLogin() {
    clearTimeout(loginCloseTimer);
    el.dlgLogin.showModal();
    selectLoginMode('sms');
  }

  function stopSmsLogin() {
    ++smsGeneration;
    clearTimeout(smsTimer);
    if (smsActive) API.post('/api/login/sms/cancel').catch(() => {});
    smsActive = false;
    document.getElementById('btn-sms-login').disabled = false;
  }

  function stopLogin() {
    ++qrGeneration;
    qrKey = null;
    clearInterval(qrTimer);
    clearTimeout(loginCloseTimer);
    stopSmsLogin();
  }

  function selectLoginMode(mode) {
    ++qrGeneration;
    qrKey = null;
    clearInterval(qrTimer);
    stopSmsLogin();
    loginMode = mode;
    ['sms', 'qr'].forEach(name => {
      const tab = document.getElementById('login-tab-' + name);
      const selected = name === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('tonal', selected);
      tab.classList.toggle('text', !selected);
      document.getElementById('login-' + name + '-panel').hidden = !selected;
    });
    if (mode === 'qr') refreshQR();
  }

  function completeBiliLogin(user) {
    S.selfUser = user || {};
    if (window.PersonalAccount) PersonalAccount.user = S.selfUser;
    renderLogin();
    if (S.joined) sync.face((S.selfUser.logged_in && S.selfUser.face) || '');
    refreshChatAvatars();
    toast('已登录，你的头像已更新');
    loginCloseTimer = setTimeout(() => el.dlgLogin.close(), 900);
  }

  async function startSmsLogin() {
    if (smsActive) return;
    const generation = ++smsGeneration;
    const button = document.getElementById('btn-sms-login');
    const status = document.getElementById('sms-status');
    smsActive = true;
    button.disabled = true;
    status.className = 'qr-status';
    status.textContent = '正在打开 B 站官方手机登录页…';
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      await API.post('/api/login/sms/open');
      if (generation !== smsGeneration) return;
    } catch (error) {
      if (generation !== smsGeneration) return;
      stopSmsLogin();
      status.className = 'qr-status err';
      status.textContent = error.message + '，请重试';
      return;
    }
    async function poll() {
      if (generation !== smsGeneration || !el.dlgLogin.open || loginMode !== 'sms') return;
      if (Date.now() > deadline) {
        stopSmsLogin();
        status.textContent = '登录等待超时，请重新打开手机验证码登录。';
        return;
      }
      try {
        const result = await API.get('/api/login/sms/poll');
        if (generation !== smsGeneration) return;
        if (result.status === 'ok' && result.user && result.user.logged_in) {
          smsActive = false;
          button.disabled = false;
          status.className = 'qr-status ok';
          status.textContent = '登录成功：' + (result.user.uname || '');
          completeBiliLogin(result.user);
          return;
        }
        if (result.status === 'cancelled' || result.status === 'error') {
          smsActive = false;
          button.disabled = false;
          status.className = 'qr-status' + (result.status === 'error' ? ' err' : '');
          status.textContent = result.status === 'error' ? '登录页打开失败，请重试。' : '已取消登录，可以重新打开。';
          return;
        }
        status.textContent = result.message || '请在官方页面完成短信验证码登录，成功后会自动返回。';
      } catch (error) {
        if (generation !== smsGeneration) return;
        status.textContent = '暂未确认登录状态，正在重试…';
      }
      smsTimer = setTimeout(poll, 2200);
    }
    poll();
  }

  async function refreshQR() {
    if (loginMode !== 'qr' || !el.dlgLogin.open) return;
    const generation = ++qrGeneration;
    clearInterval(qrTimer);
    qrKey = null;
    el.qrBox.innerHTML = '<div class="qr-placeholder">正在获取二维码…</div>';
    setQRStatus('正在获取二维码…');
    try {
      const r = await API.post('/api/login/qr');
      if (generation !== qrGeneration) return;
      qrKey = r.key;
      const qr = qrcode(0, 'M');
      qr.addData(r.url);
      qr.make();
      el.qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 8, scalable: true });
      setQRStatus('打开 B 站手机客户端扫一扫');
      qrTimer = setInterval(pollQR, 2200);
    } catch (e) {
      if (generation !== qrGeneration) return;
      setQRStatus(e.message, 'err');
      el.qrBox.innerHTML = '<div class="qr-placeholder">获取失败</div>';
    }
  }

  async function pollQR() {
    if (!qrKey || qrPolling) return;
    const generation = qrGeneration;
    qrPolling = true;
    try {
      const r = await API.get('/api/login/poll?key=' + encodeURIComponent(qrKey));
      if (generation !== qrGeneration || loginMode !== 'qr' || !el.dlgLogin.open) return;
      if (r.status === 'ok') {
        clearInterval(qrTimer);
        qrKey = null;
        setQRStatus('登录成功：' + ((r.user && r.user.uname) || ''), 'ok');
        completeBiliLogin(r.user);
      } else if (r.status === 'scanned') {
        setQRStatus('已扫码，请在手机上点确认');
      } else if (r.status === 'expired') {
        clearInterval(qrTimer);
        setQRStatus('二维码已过期，请刷新', 'err');
      } else if (r.status === 'error') {
        setQRStatus(r.message || '登录失败', 'err');
      }
    } catch (e) {
      // Poll again after a transient network error.
    } finally {
      qrPolling = false;
    }
  }

  function setQRStatus(text, cls) {
    el.qrStatus.textContent = text;
    el.qrStatus.className = 'qr-status ' + (cls || '');
  }

  /* ---------------- 分享 ---------------- */
  function shareUrl() {
    if (window.PhoneRoomMode && PhoneRoomMode.active) {
      return PhoneRoomMode.invite(S.room);
    }
    const params = new URLSearchParams();
    if (S.relay && S.relay.status === 'running' && S.relay.token) params.set('k', S.relay.token);
    if (S.room) params.set('room', S.room);
    const q = params.toString();
    return baseUrl() + '/' + (q ? '?' + q : '');
  }

  function baseUrl() {
    if (S.relay && S.relay.status === 'running' && S.relay.url) return S.relay.url;
    if (S.tunnelUrl) return S.tunnelUrl;
    if (window.API && API.base) return API.base;
    if (location.hostname && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
      return location.origin;
    }
    return (S.share && S.share.primary) || location.origin;
  }

  function renderShareQR(url) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      el.shareQr.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 8, scalable: true });
    } catch (e) { /* 链接太长等情况忽略 */ }
  }

  function updateShareLink() {
    if (!S.room || !el.shareLink) return;
    const url = shareUrl();
    if (el.shareLink.value === url) return;
    el.shareLink.value = url;
    renderShareQR(url);
  }

  async function refreshExternal() {
    if (!el.dlgShare.open || window.PhoneRooms) return;
    try {
      const [relay, tunnel] = await Promise.all([
        API.get('/api/relay').catch(() => null),
        API.get('/api/tunnel').catch(() => null),
      ]);
      if (relay) S.relay = relay;
      if (tunnel) {
        S.tunnelStatus = tunnel.status;
        S.tunnelUrl = tunnel.status === 'running' ? (tunnel.url || '') : '';
        S.tunnelError = tunnel.error || '';
      }
    } catch (e) {
      return;
    }

    updateShareLink();
    const relayOn = S.relay && S.relay.status === 'running';
    const relayBusy = S.relay && S.relay.status === 'starting';
    const relayErr = S.relay && S.relay.status === 'error';
    const tunnelOn = S.tunnelStatus === 'running';
    const tunnelBusy = S.tunnelStatus === 'starting' || S.tunnelStatus === 'downloading';

    if (relayOn || tunnelOn) {
      const url = relayOn ? S.relay.url : S.tunnelUrl;
      const link = window.PhoneRoomMode ? PhoneRoomMode.webInvite(url,S.room,relayOn?S.relay.token:'') : url+'/?room='+encodeURIComponent(S.room);
      el.btnTunnel.textContent = '关闭';
      el.tunnelStatus.textContent = relayOn
        ? '网页邀请已通过连通检查，可复制下方链接给朋友用浏览器加入。'
        : '异地邀请已开启，使用备用连接。视频仍由各自设备加载。';
      el.tunnelRow.hidden = false;
      el.tunnelLink.value = link;
      updateShareLink();
      return;
    }

    el.tunnelRow.hidden = true;
    if (relayBusy) {
      el.btnTunnel.textContent = '取消';
      el.tunnelStatus.textContent = '正在连接自己的服务器…';
    } else if (relayErr && tunnelBusy) {
      el.btnTunnel.textContent = '取消';
      el.tunnelStatus.textContent = '服务器连不上，正在改用 Cloudflare 隧道…';
    } else if (relayErr && S.tunnelStatus === 'error') {
      el.btnTunnel.textContent = '重试';
      el.tunnelStatus.textContent = '开启失败：' + ((S.relay && S.relay.error) || '服务器连接失败')
        + '；Cloudflare 也失败了：' + (S.tunnelError || '未知错误');
    } else if (relayErr) {
      el.btnTunnel.textContent = '重试';
      el.tunnelStatus.textContent = '开启失败：' + ((S.relay && S.relay.error) || '服务器连接失败');
    } else if (tunnelBusy) {
      el.btnTunnel.textContent = '取消';
      el.tunnelStatus.textContent = S.tunnelStatus === 'downloading'
        ? '正在下载 Cloudflare 隧道工具（约 54MB，仅第一次需要）…'
        : (S.tunnelError || '正在建立 Cloudflare 隧道并验证公网连接，请稍候…');
    } else {
      el.btnTunnel.textContent = '开启';
      el.tunnelStatus.textContent = '朋友不在同一网络时点「开启」，程序会自动连上你的服务器并生成公网链接；连不上会自动改用 Cloudflare 备用线路。';
    }
  }

  async function toggleExternal() {
    clearInterval(window.__extTimer);
    const busy = (S.relay && (S.relay.status === 'running' || S.relay.status === 'starting'))
      || S.tunnelStatus === 'running' || S.tunnelStatus === 'starting' || S.tunnelStatus === 'downloading';
    if (busy) {
      window.__extFallback = false;
      await Promise.all([
        API.post('/api/relay/stop').catch(() => {}),
        API.post('/api/tunnel/stop').catch(() => {}),
      ]);
      await refreshExternal();
      return;
    }

    window.__extFallback = false;
    try {
      await API.post('/api/relay/start');
    } catch (e) {
      toast(e.message, true);
    }
    await refreshExternal();
    window.__extTimer = setInterval(async () => {
      await refreshExternal();
      const rs = S.relay && S.relay.status;
      if (rs === 'running' || S.tunnelStatus === 'running') {
        clearInterval(window.__extTimer);
      } else if (rs === 'error') {
        if (!window.__extFallback) {
          window.__extFallback = true;
          toast('自己的服务器连不上，改用 Cloudflare 隧道…', false);
          try { await API.post('/api/tunnel/start'); } catch (e) { toast(e.message, true); }
        } else if (S.tunnelStatus === 'error') {
          clearInterval(window.__extTimer);
        }
      } else if (rs === 'stopped' && S.tunnelStatus === 'stopped') {
        clearInterval(window.__extTimer);
      }
    }, 1500);
    setTimeout(() => clearInterval(window.__extTimer), 90000);
  }

  function openShare() {
    const url = shareUrl();
    el.shareLink.value = url;
    renderShareQR(url);
    refreshExternal();
    probeSpeed();
    const phone = window.PhoneRoomMode && PhoneRoomMode.active;
    el.dlgShare.querySelector('.tunnel').hidden = !!window.PhoneRooms;
    el.dlgShare.querySelector('label[for="share-link"]').textContent=phone?'客户端邀请链接':'完整邀请链接';
    document.getElementById('share-server-name').textContent=phone?PhoneRoomMode.endpoint.server+':'+PhoneRoomMode.endpoint.port:baseUrl();
    document.getElementById('share-room-code').textContent=S.room;
    document.getElementById('share-connection').textContent=S.joined?'本机已连接 · 等待好友加入':'本机尚未连接成功';
    document.getElementById('share-connection').dataset.connected=String(!!S.joined);
    el.shareHint.textContent=phone?(window.PhoneRooms?'客户端邀请请在好友的新版客户端中粘贴加入。':'客户端邀请可直接粘贴加入；好友要用浏览器时，请开启下方“外网访问”，再复制生成的网页链接。'):'异地好友请先开启外网访问，再复制公网邀请。';
    el.dlgShare.showModal();
    refreshExternal();
    clearInterval(window.__shareStatusTimer);
    window.__shareStatusTimer=setInterval(()=>{if(!el.dlgShare.open){clearInterval(window.__shareStatusTimer);return;}refreshExternal();},3000);
  }

  /* ---------------- 设置 ---------------- */
  function openSettings() {
    const endpoint=PhoneRoomMode.defaultServer();
    document.getElementById('set-default-sync').value=endpoint.server+':'+endpoint.port;
    el.setName.value = S.config.username || '';
    el.setQuality.value = String(S.qn || 80);
    el.setMode.value = S.config.prefer_mp4 === false ? 'dash' : 'mp4';
    el.setOpen.value = S.config.open_mode || 'app';
    el.setPublic.value = S.config.public_addr || '';
    el.setLocal.textContent = (S.share && S.share.local) || '-';
    el.setShare.textContent = (S.share && S.share.primary) || '-';
    el.setSync.textContent = syncPort() + ' 端口';
    el.setVersion.textContent = 'v' + (window.WT_APP_VERSION || S.version || '1.0.0');
    SettingsPage.open();
  }

  async function saveSettings() {
    let defaultSync;
    try{defaultSync=PhoneRoomMode.parseServer(document.getElementById('set-default-sync').value);}
    catch(error){toast(error.message,true);document.getElementById('set-default-sync').focus();return;}
    const body = {
      username: el.setName.value.trim(),
      quality: Number(el.setQuality.value),
      prefer_mp4: el.setMode.value === 'mp4',
      open_mode: el.setOpen.value,
      public_addr: el.setPublic.value.trim(),
    };
    try {
      const r = await API.post('/api/config', body);
      PhoneRoomMode.saveDefault(defaultSync.server+':'+defaultSync.port);
      document.getElementById('phone-sync-server').value=defaultSync.server+':'+defaultSync.port;
      S.config = r.config;
      S.qn = Number(S.config.quality) || 80;
      el.nameInput.value = S.config.username || '';
      SettingsPage.close();
      toast('设置已保存');
      const st = await API.get('/api/state');
      S.share = st.share;
      renderLogin();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function shutdown() {
    if (!confirm('确定要退出「一起看」吗？房间里的人会断开连接。')) return;
    try { await API.post('/api/shutdown'); } catch (e) {}
    toast('已退出，可以关闭窗口了');
    setTimeout(() => window.close(), 600);
  }

  /* ---------------- 全屏空闲隐藏 ---------------- */
  function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if ((window.WatchFullscreen ? WatchFullscreen.element() : document.fullscreenElement) && !player.paused) {
        el.playerShell.classList.add('hide-ui');
      }
    }, 2600);
  }
})();
