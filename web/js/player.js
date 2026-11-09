/* 一起看 · 播放器
   支持两种源：
     mp4  —— 单文件，音画同轨
     dash —— B 站 DASH，音轨和视频轨分开，需要两个媒体元素对齐 */
(function () {
  const waitEvent = (el, name, timeout = 15000, job) => new Promise((resolve, reject) => {
    if (name === 'loadedmetadata' && el.readyState >= 1) return resolve();
    if (name === 'loadeddata' && el.readyState >= 2) return resolve();
    let done = false;
    const ok = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const bad = () => { if (!done) { done = true; cleanup(); reject(new Error('媒体加载失败')); } };
    const cancel = () => { if (!done) { done = true; cleanup(); const e = new Error('加载已取消'); e.name = 'AbortError'; reject(e); } };
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('媒体加载超时')); }
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener(name, ok);
      el.removeEventListener('error', bad);
      if (job) job.delete(cancel);
    }
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
    if (job) job.add(cancel);
  });

  class Player {
    constructor(opts) {
      this.video = opts.video;
      this.audio = opts.audio;
      this.shell = opts.shell;
      this.mode = null;
      this.volume = 0.8;
      this.muted = false;
      this.rate = 1;
      this.ready = false;
      this.phase = 'idle';
      this.listeners = {};
      this._silentUntil = 0;
      this._nudgeTimer = null;
      this._loading = false;
      this._bind();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    on(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
      return this;
    }

    emit(name, data) {
      for (const fn of this.listeners[name] || []) {
        try { fn(data); } catch (e) { console.error(e); }
      }
    }

    _phase(next) {
      if (this.phase === next) return;
      this.phase = next;
      this.emit('phase', next);
    }

    /* 程序化操作会在这段时间内屏蔽“用户操作”事件，避免回声 */
    _silence(ms = 400) { this._silentUntil = Date.now() + ms; }
    _isUser() { return Date.now() > this._silentUntil; }

    _bind() {
      const v = this.video;
      v.addEventListener('play', () => {
        this.shell.classList.remove('paused');
        this.emit('ui');
        if (this._isUser()) this.emit('userplay');
      });
      v.addEventListener('pause', () => {
        if (this.ready) this._phase('paused');
        this.shell.classList.add('paused');
        this.emit('ui');
        if (this._isUser()) this.emit('userpause');
      });
      v.addEventListener('seeking', () => {
        if (this.ready) this._phase('seeking');
        if (!this._programmaticSeek && this._isUser()) this.emit('userseek');
      });
      /* 拖完进度条：音轨如果没跟上，立刻补一次，否则会出现只有画面没声音 */
      v.addEventListener('seeked', () => {
        if (this.ready) this._phase(v.paused ? 'paused' : (v.readyState >= 3 ? 'playing' : 'buffering'));
        this._programmaticSeek = false;
        this._syncHoldUntil = Date.now() + 2500;
        if (this.mode !== 'dash' || !this.ready) return;
        const a = this.audio;
        if (a.readyState < 1) return;
        if (Math.abs(a.currentTime - v.currentTime) > 0.15) {
          try { a.currentTime = v.currentTime; } catch (e) {}
        }
        if (!v.paused && a.paused) a.play().catch(() => {});
      });
      v.addEventListener('waiting', () => {
        // Decoder hiccups can emit waiting/canplay within a single frame on WebView.
        // Only stop audio for a sustained video buffer stall.
        clearTimeout(this._bufferTimer);
        this._bufferTimer = setTimeout(() => {
          if (this.ready && !v.paused && v.readyState < 3) {
            this._phase('buffering');
            if (this.mode === 'dash') this.audio.pause();
          }
        }, 180);
      });
      v.addEventListener('canplay', () => {
        clearTimeout(this._bufferTimer);
        if (this.ready && !v.seeking) this._phase(v.paused ? 'paused' : 'playing');
      });
      v.addEventListener('playing', () => { if (this.ready) this._phase('playing'); });
      v.addEventListener('ended', () => this.emit('ended'));
      v.addEventListener('error', () => {
        if (!this._loading && v.error) {
          this.audio.pause();
          this._phase('error');
          this.emit('error', v.error);
        }
      });
      v.addEventListener('loadedmetadata', () => this.emit('meta'));
      v.addEventListener('timeupdate', () => this.emit('time', this.time));
      this.shell.addEventListener('click', (e) => {
        if (e.target.closest('.player-bottom, .player-top, .big-play, .menu')) return;
        this.emit('usertoggle');
      });
      this.shell.addEventListener('dblclick', (e) => {
        if (e.target.closest('.player-bottom, .player-top, .big-play, .menu')) return;
        this.toggleFullscreen();
      });
    }

    _loop() {
      const v = this.video;
      const now = Date.now();
      if (this.mode === 'dash' && this.ready && !v.seeking && v.readyState >= 3
          && now - (this._lastAvCheck || 0) >= 250) {
        this._lastAvCheck = now;
        const a = this.audio;
        if (!v.paused && a.paused) {
          a.play().catch(() => {});
        }
        /* 音画对齐：小幅偏差用微调速率慢慢追，不要硬跳。
           以前偏差超过 0.18s 就直接改 currentTime，缓冲一旦跟不上就会
           每秒跳好几次，表现为声音“两个字断一下”加爆音。 */
        if (!v.paused && !a.paused && !a.seeking && a.readyState >= 3 && !this._nudging
            && now >= (this._syncHoldUntil || 0)) {
          const drift = v.currentTime - a.currentTime;
          const ad = Math.abs(drift);
          if (ad > 1.0) {
            const now = Date.now();
            if (now - (this._lastSeekFix || 0) > 1000) {
              this._lastSeekFix = now;
              try { a.currentTime = v.currentTime; } catch (e) {}
            }
          } else if (ad > 0.05) {
            a.playbackRate = this.rate * (drift > 0 ? 1.02 : 0.98);
          } else if (a.playbackRate !== this.rate) {
            a.playbackRate = this.rate;
          }
        }
      }
      requestAnimationFrame(this._loop);
    }

    reset() {
      if(this._hls){this._hls.destroy();this._hls=null;}
      this._phase('idle');
      if (this._loadJob) for (const cancel of Array.from(this._loadJob)) cancel();
      this._loadJob = null;
      this._silence(900);
      clearTimeout(this._bufferTimer);
      clearTimeout(this._nudgeTimer);
      this._resetRate();
      this._programmaticSeek = false;
      this._driftSamples = 0;
      this.ready = false;
      this.mode = null;
      this._loading = false;
      try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch (e) {}
      try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch (e) {}
      this.shell.classList.add('idle', 'paused', 'no-video');
    }

    get time() { return this.video.currentTime || 0; }
    get duration() { return this.video.duration || 0; }
    get paused() { return this.video.paused; }

    async load(source, { position = 0, paused = true, autoplay = false } = {}) {
      if(this._hls){this._hls.destroy();this._hls=null;}
      if (this._loadJob) for (const cancel of Array.from(this._loadJob)) cancel();
      const job = this._loadJob = new Set();
      const v = this.video;
      const a = this.audio;
      clearTimeout(this._nudgeTimer);
      this._resetRate();
      this._programmaticSeek = false;
      this._driftSamples = 0;
      this._silence(2500);
      clearTimeout(this._bufferTimer);
      this._loading = true;
      this.ready = false;
      this._phase('loading');
      this.mode = source.mode;
      try { v.pause(); } catch (e) {}
      try { a.pause(); } catch (e) {}
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      try { a.removeAttribute('src'); a.load(); } catch (e) {}
      this.shell.classList.add('idle', 'paused');
      this.shell.classList.remove('no-video');

      if(source.mode==='hls' && window.Hls && Hls.isSupported()) {
        const hls=this._hls=new Hls({maxBufferLength:40,maxMaxBufferLength:80,enableWorker:true});
        hls.attachMedia(v);hls.loadSource(source.url);
        hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal && this._hls===hls){this._phase('error');this.emit('error',new Error('视频分段加载失败，请切换线路或重试'));}});
      } else {
        v.src = source.mode === 'dash' ? source.video : source.url;
        v.load();
      }
      if (source.mode === 'dash') {
        a.preload = 'auto';
        a.src = source.audio;
        a.load();
      }
      try {
        await Promise.all([
          waitEvent(v, 'loadeddata', 20000, job),
          source.mode === 'dash' ? waitEvent(a, 'loadeddata', 20000, job) : Promise.resolve(),
        ]);
        if (this._loadJob !== job) { const e = new Error('加载已取消'); e.name = 'AbortError'; throw e; }
      } catch (error) {
        for (const cancel of Array.from(job)) cancel();
        if (this._loadJob === job) {
          v.pause(); a.pause(); this.ready = false;
          this.shell.classList.add('paused');
          this._phase('error');
        }
        throw error;
      } finally {
        if (this._loadJob === job) this._loading = false;
      }
      const start = Math.min(Math.max(0, position || 0), Math.max(0, (v.duration || 0) - 0.2));
      this._syncHoldUntil = Date.now() + 5000;
      if (start > 0) {
        this._programmaticSeek = true;
        try { v.currentTime = start; } catch (e) { this._programmaticSeek = false; }
      }
      if (source.mode === 'dash') {
        try {
          if (Math.abs(a.currentTime - start) > 0.02) a.currentTime = start;
        } catch (e) { /* 音轨慢一点无所谓，播放时会追 */ }
      }
      this.applyVolume();
      v.playbackRate = this.rate;
      a.playbackRate = this.rate;
      this.ready = true;
      this._phase('paused');
      this.shell.classList.remove('idle');
      this.shell.classList.toggle('paused', v.paused);
      this.emit('ready', { duration: v.duration, mode: this.mode });
      this._silence(600);
      if (autoplay || !paused) this.play({ silent: true });
      return this;
    }

    play(opts) {
      const silent = opts && opts.silent;
      if (silent) this._silence(600);
      const p = this.video.play();
      if (this.mode === 'dash') {
        this.audio.play().catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            try { this.video.pause(); } catch (e) {}
            this.emit('blocked');
          }
        });
      }
      if (p && p.then) {
        p.catch((err) => {
          if (err && err.name === 'NotAllowedError') this.emit('blocked');
          else this.emit('playerror', err);
        });
      }
    }

    pause(opts) {
      if (opts && opts.silent) this._silence(600);
      try { this.video.pause(); } catch (e) {}
      if (this.mode === 'dash') { try { this.audio.pause(); } catch (e) {} }
    }

    toggle() {
      if (!this.ready) return;
      if (this.video.paused) this.play(); else this.pause();
    }

    seek(t, silent) {
      if (!this.ready) return;
      if (silent) this._silence(600);
      const target = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.15));
      clearTimeout(this._nudgeTimer);
      this._resetRate();
      this._syncHoldUntil = Date.now() + 5000;
      this._driftSamples = 0;
      if (Math.abs(this.time - target) > 0.02) {
        this._programmaticSeek = !!silent;
        try { this.video.currentTime = target; } catch (e) { this._programmaticSeek = false; }
      }
      if (this.mode === 'dash') {
        try { this.audio.currentTime = target; } catch (e) {}
      }
      this.emit('time', target);
    }

    seekSilent(t) {
      this._silence(600);
      this.seek(t, true);
    }

    /* 应用房间里的播放状态；tol 由 app.js 按链路延迟放宽阈值 */
    applyRemote(position, paused, doSeek, tol) {
      if (!this.ready || !Number.isFinite(position)) return;
      const diff = position - this.time;
      const drift = Math.abs(diff);
      this._silence(600);
      const tNudge = (tol && tol.nudge) || 0.4;
      const tSeek = (tol && tol.seek) || 1.2;
      const now = Date.now();
      // Explicit user seeks are immediate. Heartbeats must not interrupt loading a range.
      const canCorrect = !this.video.seeking && this.video.readyState >= 3
        && now >= (this._syncHoldUntil || 0);
      if (doSeek && drift > 0.25) {
        this.seek(position, true);
      } else if (!doSeek && canCorrect && drift > tSeek) {
        const direction = Math.sign(diff);
        this._driftSamples = this._driftDirection === direction ? (this._driftSamples || 0) + 1 : 1;
        this._driftDirection = direction;
        // Two consecutive samples reject transient network jitter after a seek.
        if (this._driftSamples >= 2) this.seek(position, true);
      } else if (canCorrect) {
        this._driftSamples = 0;
        if (!paused && drift > tNudge && !this._nudging
            && now > (this._nudgeCooldownUntil || 0)) {
          const rate = this.rate * (diff > 0 ? 1.03 : 0.97);
          this.video.playbackRate = rate;
          this.audio.playbackRate = rate;
          this._nudging = true;
          clearTimeout(this._nudgeTimer);
          this._nudgeTimer = setTimeout(() => this._resetRate(), 3000);
        }
      }
      if (paused && !this.video.paused) this.pause({ silent: true });
      if (!paused && this.video.paused) this.play({ silent: true });
    }

    _resetRate() {
      clearTimeout(this._nudgeTimer);
      this._nudging = false;
      /* 一次变速结束后歇 3 秒再允许下一次，高延迟链路上防振荡 */
      this._nudgeCooldownUntil = Date.now() + 3000;
      this.video.playbackRate = this.rate;
      this.audio.playbackRate = this.rate;
    }

    setRate(r) {
      this.rate = r;
      this._resetRate();
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      this.applyVolume();
    }

    setMuted(m) {
      this.muted = !!m;
      this.applyVolume();
    }

    applyVolume() {
      const v = this.video;
      const a = this.audio;
      if (this.mode === 'dash') {
        v.muted = true;
        v.volume = 0;
        a.muted = this.muted;
        a.volume = this.volume;
      } else {
        v.muted = this.muted;
        v.volume = this.volume;
        a.muted = true;
      }
    }

    get bufferedPercent() {
      const v = this.video;
      try {
        if (!v.buffered.length || !v.duration) return 0;
        return (v.buffered.end(v.buffered.length - 1) / v.duration) * 100;
      } catch (e) { return 0; }
    }

    toggleFullscreen() {
      if(window.WatchFullscreen){WatchFullscreen.toggle(this.shell);return;}
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (this.shell.requestFullscreen) {
        this.shell.requestFullscreen().catch(() => {});
      }
    }
  }

  window.Player = Player;
})();
