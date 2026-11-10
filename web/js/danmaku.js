/* 一起看 · 弹幕渲染
   位置完全由视频时间推导，所以暂停/拖动/倍速都自然跟随。 */
(function () {
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

  class Danmaku {
    constructor(layer, getTime) {
      this.layer = layer;
      this.getTime = getTime;
      this.items = [];
      this.idx = 0;
      this.active = [];
      this.enabled = true;
      this.lastT = -1;
      this.running = false;
      this.opt = {
        area: 1,            // 显示区域：占画面的比例
        opacity: 1,         // 不透明度
        fontScale: 1,       // 字号缩放
        speed: 1,           // 速度倍数
        showScroll: true,   // 滚动弹幕
        showFixed: true,    // 固定弹幕
        showColor: true,    // 彩色弹幕
        screenScale: true,  // 随屏幕缩放
        avoidSub: false,    // 防挡字幕
        words: [],          // 屏蔽词
      };
      this.lanes = 0;
      this.scrollLanes = [];
      this.topLanes = [];
      this.bottomLanes = [];
      this._measure = document.createElement('span');
      this._measure.className = 'dm-item';
      this._measure.style.visibility = 'hidden';
      layer.appendChild(this._measure);
      this._onResize = () => this.resize();
      this.resize();
      if (window.ResizeObserver) {
        new ResizeObserver(() => this.resize()).observe(layer);
      } else {
        window.addEventListener('resize', this._onResize);
      }
    }

    resize() {
      const h = this.layer.clientHeight || 0;
      const lineH = Math.max(22, Math.round(h / 14));
      this.lineH = lineH;
      // 显示区域最多占 78%（下面留给播放条），防挡字幕再压到 55%
      let ratio = 0.78 * Math.max(0.05, Math.min(1, this.opt.area));
      if (this.opt.avoidSub) ratio = Math.min(ratio, 0.55);
      const usable = Math.max(1, Math.floor((h * ratio) / lineH));
      this.scrollLanes = new Array(usable).fill(0);
      this.topLanes = new Array(Math.min(3, usable)).fill(0);
      this.bottomLanes = new Array(Math.min(3, usable)).fill(0);
    }

    setOptions(opts) {
      const o = opts || {};
      if (o.area != null) this.opt.area = Number(o.area);
      if (o.opacity != null) this.opt.opacity = Number(o.opacity);
      if (o.fontScale != null) this.opt.fontScale = Number(o.fontScale);
      if (o.speed != null) this.opt.speed = Number(o.speed);
      if (o.showScroll != null) this.opt.showScroll = !!o.showScroll;
      if (o.showFixed != null) this.opt.showFixed = !!o.showFixed;
      if (o.showColor != null) this.opt.showColor = !!o.showColor;
      if (o.screenScale != null) this.opt.screenScale = !!o.screenScale;
      if (o.avoidSub != null) this.opt.avoidSub = !!o.avoidSub;
      if (o.words != null) {
        this.opt.words = String(o.words).split(/[,，\s]+/).filter(Boolean).map((s) => s.toLowerCase());
      }
      this.resize();
      // 参数变化后重新排版当前弹幕
      this.clear();
      const t = this.getTime();
      this.lastT = t;
      this.idx = this._lowerBound(t);
    }

    load(items) {
      this.clear();
      this.items = (items || []).slice().sort((a, b) => a.t - b.t);
      this.idx = 0;
      this.lastT = this.getTime();
    }

    setEnabled(on) {
      this.enabled = !!on;
      this.layer.style.display = on ? '' : 'none';
      if (!on) this.clear();
    }

    clear() {
      for (const it of this.active) it.el.remove();
      this.active = [];
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        this.tick();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
    }

    tick() {
      if (!this.enabled || !this.items.length) return;
      const t = this.getTime();
      if (!Number.isFinite(t)) return;
      // 拖动（往前或往后）之后重建
      if (t < this.lastT - 0.4 || t > this.lastT + 1.5) {
        this.clear();
        this.idx = this._lowerBound(t);
      }
      this.lastT = t;
      const W = this.layer.clientWidth;
      const H = this.layer.clientHeight;

      while (this.idx < this.items.length && this.items[this.idx].t <= t) {
        const item = this.items[this.idx++];
        if (item.t < t - 0.8) continue; // 跳帧后不补发
        this._spawn(item, t, W, H);
      }

      for (let i = this.active.length - 1; i >= 0; i--) {
        const a = this.active[i];
        const p = (t - a.t0) / a.dur;
        if (p >= 1) {
          a.el.remove();
          this.active.splice(i, 1);
          continue;
        }
        if (a.mode === 4 || a.mode === 5) {
          if (p > 0.82) a.el.style.opacity = String(Math.max(0, (1 - p) / 0.18) * this.opt.opacity);
          continue;
        }
        const x = W - (W + a.w) * p;
        a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${a.y}px, 0)`;
      }
    }

    _lowerBound(t) {
      let lo = 0, hi = this.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.items[mid].t < t) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    _spawn(item, now, W, H) {
      if (!W || !H) return;
      const fixed = item.m === 4 || item.m === 5;
      if (fixed && !this.opt.showFixed) return;
      if (!fixed && !this.opt.showScroll) return;
      if (!this.opt.showColor && (item.c || 0xffffff) !== 0xffffff) return;
      const text = item.x || '';
      if (this.opt.words.length) {
        const low = text.toLowerCase();
        if (this.opt.words.some((w) => low.indexOf(w) >= 0)) return;
      }
      const screenK = this.opt.screenScale
        ? Math.max(0.55, Math.min(1.8, H / 720)) : 1.0;
      const fontSize = Math.round((item.s || 25) * screenK * this.opt.fontScale);
      const el = document.createElement('div');
      el.className = 'dm-item' + (fixed ? ' fixed' : '');
      el.textContent = text;
      el.dataset.text = text;
      el.style.fontSize = fontSize + 'px';
      el.style.color = '#' + (item.c || 0xffffff).toString(16).padStart(6, '0');
      el.style.opacity = String(this.opt.opacity);
      this.layer.appendChild(el);
      const w = el.offsetWidth || 80;
      const lineH = Math.max(20, Math.round(fontSize * 1.28));

      if (item.m === 4 || item.m === 5) {
        el.style.willChange = 'opacity';
        el.style.left = Math.max(0, (W - w) / 2) + 'px';
        const lanes = item.m === 5 ? this.topLanes : this.bottomLanes;
        let lane = lanes.findIndex((free) => now >= free);
        if (lane < 0) {
          el.remove();
          return;
        }
        lanes[lane] = now + 0.55;
        const y = item.m === 5
          ? H * 0.06 + lane * (lineH + 4)
          : H * 0.92 - (lane + 1) * (lineH + 4);
        el.style.top = Math.max(0, y) + 'px';
        el.style.opacity = '1';
        this.active.push({ el, t0: now, dur: 4.2, w, y, mode: item.m });
        return;
      }

      const lanes = this.scrollLanes;
      const dur = 8.0 / Math.max(0.3, this.opt.speed);   // B 站网页版：固定约 8 秒划过屏幕
      let lane = lanes.findIndex((free) => now >= free);
      if (lane < 0) {
        el.remove();
        return;
      }
      lanes[lane] = now + (w + 60) / Math.max(W, 1) * dur + 0.2;
      const y = H * 0.035 + lane * (lineH + 2);
      el.style.transform = `translate3d(${W}px, ${y}px, 0)`;
      el.style.top = '0px';
      this.active.push({ el, t0: now, dur, w, y, mode: item.m });
      // 限制同时显示数量
      if (this.active.length > 90) {
        const old = this.active.shift();
        if (old) old.el.remove();
      }
    }
  }

  window.Danmaku = Danmaku;
})();
