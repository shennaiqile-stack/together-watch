/* 一起看 · 通用工具 */
(function () {
  const API = {
    /* 朋友桌面端加入房主房间时，页面仍由本机服务器提供，
       房间 API / WS 指向房主；媒体通过本机直拉 */
    base: '',
    key: '',
    url(path) {
      if(/^\/api\/(account(?:\?|$)|login\/|logout(?:\?|$))/.test(path))return path;
      let u = (API.base || '') + path;
      if (API.key && path.charAt(0) === '/' && path.indexOf('/ws') !== 0) {
        u += (path.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(API.key);
      }
      return u;
    },
    async get(path, options) {
      const controller = new AbortController();
      const signal = options && options.signal;
      const cancel = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', cancel, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const r = await fetch(API.url(path), { cache: 'no-store', signal: controller.signal });
        return await API._parse(r);
      } catch (error) {
        if (error.name === 'AbortError' && !(signal && signal.aborted)) throw new Error('房间服务响应超时，请检查连接后重试');
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
      }
    },
    async post(path, body) {
      if (path === '/api/config' && (API.base || window.WT_MEDIA_BASE)) {
        const config = body || {};
        try { localStorage.setItem('wt.client.config', JSON.stringify(config)); } catch (_) {}
        return {ok:true, config};
      }
      /* 朋友的设置/登录/外网开关不能写到房主的电脑上 */
      if (API.base && (path === '/api/config'
          || path === '/api/relay' || path === '/api/tunnel')) {
        return { ok: true };
      }
      const r = await fetch(API.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return API._parse(r);
    },
    async _parse(r) {
      let j = null;
      try { j = await r.json(); } catch (e) { throw new Error('服务器返回异常（' + r.status + '）'); }
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || '请求失败（' + r.status + '）');
      return j;
    },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#snackbar');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4200 : 2600);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function initials(name) {
    const n = (name || '?').trim();
    return n ? n.slice(0, 1).toUpperCase() : '?';
  }

  function parseBvid(text) {
    text = (text || '').trim();
    let m = text.match(/BV[0-9A-Za-z]{10}/);
    if (m) return m[0];
    m = text.match(/(?:^|[^0-9])av(\d+)/i);
    if (m) return 'av' + m[1];
    return null;
  }

  function randomRoom() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) {}
      ta.remove();
      return ok;
    }
  }

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  window.API = API;
  window.$ = $;
  window.$$ = $$;
  window.toast = toast;
  window.fmtTime = fmtTime;
  window.initials = initials;
  window.parseBvid = parseBvid;
  window.randomRoom = randomRoom;
  window.copyText = copyText;
  window.hashCode = hashCode;
})();
