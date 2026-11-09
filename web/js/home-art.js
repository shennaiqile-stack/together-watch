/* The bundled ranking snapshot paints immediately; refreshes never block entry. */
(() => {
  'use strict';
  document.addEventListener('DOMContentLoaded', async () => {
    const image = document.getElementById('home-art-image');
    const button = document.getElementById('btn-home-art');
    const source = document.getElementById('home-art-source');
    const title = document.getElementById('home-art-title');
    const rank = document.getElementById('home-art-rank');
    const fallback = document.getElementById('home-art-fallback');
    let items = [], current = '', busy = false;
    try { current = localStorage.getItem('wt.home-art.last') || ''; } catch (_) {}

    const preload = (url) => new Promise((resolve, reject) => {
      const next = new Image();
      const timer = setTimeout(() => { next.onload = next.onerror = null; reject(new Error('image timeout')); }, 8000);
      next.onload = () => { clearTimeout(timer); resolve(next); };
      next.onerror = () => { clearTimeout(timer); reject(new Error('image unavailable')); };
      next.src = url;
    });
    async function nextArtwork() {
      if (busy || !items.length) return;
      busy = true;
      button.disabled = true;
      const choices = items.filter((item) => item.file !== current);
      if (!choices.length) choices.push(...items);
      // Randomize without retrying a failed item or immediately repeating the last one.
      for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [choices[i], choices[j]] = [choices[j], choices[i]];
      }
      for (const item of choices) {
        try {
          await preload(item.image);
          image.src = item.image;
          image.alt = item.title + ' · 动漫横图';
          image.hidden = false;
          fallback.hidden = true;
          title.textContent = item.title;
          rank.textContent = '番剧热榜 · 第 ' + item.rank + ' 名';
          source.href = item.source;
          source.hidden = false;
          current = item.file;
          try { localStorage.setItem('wt.home-art.last', current); } catch (_) {}
          break;
        } catch (_) { /* Keep the current picture and try another cached artwork. */ }
      }
      button.disabled = false;
      busy = false;
    }
    function valid(list) {
      return (list || []).filter((item) => /^[a-f0-9]{24}\.(jpg|png)$/.test(item.file || '')
        && /^https:\/\/www\.bilibili\.com\/bangumi\/play\/ss\d+$/.test(item.source || '')
        && typeof item.title === 'string' && Number(item.rank) > 0);
    }
    button.onclick = nextArtwork;
    try {
      const data = await (await fetch('/art/bangumi/index.json')).json();
      items = valid(data.items).map((item) => ({ ...item, image:'/art/bangumi/' + item.file }));
      await nextArtwork();
    } catch (_) { /* The API cache may still be available. */ }

    const remote = !!(window.WT_MEDIA_BASE && window.API && API.base);
    const endpoint = remote ? API.url('/api/home-art') : '/api/home-art';
    async function refresh(attempt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(endpoint, { signal:controller.signal, cache:'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        const fresh = valid(data.items).filter((item) => item.image === '/api/home-art/image/' + item.file)
          .map((item) => ({ ...item, image:remote ? API.url(item.image) : item.image }));
        if (fresh.length) {
          items = fresh;
          if (image.hidden) await nextArtwork();
        }
        if (data.refreshing && attempt < 4) setTimeout(() => refresh(attempt + 1), 8000);
      } catch (_) { /* Offline seed remains fully usable. */ }
      finally { clearTimeout(timer); }
    }
    refresh(0);
  });
})();
