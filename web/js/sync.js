/* 一起看 · 与本地 Python 服务之间的 WebSocket 通道
   服务端把 Syncplay 的 TCP 消息翻译成 JSON 事件，这里再分发给界面。 */
(function () {
  class SyncClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.opts = null;
      this.open = false;
      this.connecting = null;
      this.closedByUser = false;
      this.retry = 0;
    }

    on(name, fn) {
      (this.handlers[name] = this.handlers[name] || []).push(fn);
      return this;
    }

    emit(name, data) {
      for (const fn of this.handlers[name] || []) {
        try { fn(data); } catch (e) { console.error(e); }
      }
    }

    connect() {
        /* 朋友桌面端加入房主房间时，WS 要连房主的电脑而不是本机 */
        const remote = (window.API && API.base) || '';
        let url;
        if (remote) {
          url = remote.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/ws';
          if (API.key) url += '?k=' + encodeURIComponent(API.key);
        } else {
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          url = proto + '//' + location.host + '/ws';
        }
      if(this.endpoint!==url){
        this.serial=(this.serial||0)+1;
        const stale=this.socket || this.ws;
        if(this.rejectPending)this.rejectPending(new Error('已切换房间服务器'));
        this.rejectPending=null;this.connecting=null;this.ws=null;this.socket=null;this.open=false;this.endpoint=url;
        if(stale)try{stale.close();}catch(_){}
      }
      if (this.open) return Promise.resolve();
      if (this.connecting) return this.connecting;
      const serial=this.serial=(this.serial||0)+1;
      this.connecting = new Promise((resolve, reject) => {
        this.rejectPending=reject;
        const ws = new WebSocket(url);
        this.socket=ws;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; if(serial===this.serial){this.connecting=null;this.rejectPending=null;} try { ws.close(); } catch (e) {} reject(new Error('连接服务器超时')); }
        }, 6000);
        ws.onopen = () => {
          clearTimeout(timer);
          if(serial!==this.serial){try{ws.close();}catch(_){};return;}
          settled = true;
          this.ws = ws;
          this.open = true;
          this.retry = 0;
          this.connecting = null;
          this.rejectPending=null;
          resolve();
        };
        ws.onerror = () => {
          if(serial!==this.serial)return;
          if (!settled) { settled = true; clearTimeout(timer); this.connecting = null; reject(new Error('无法连接服务器')); }
        };
        ws.onclose = () => {
          clearTimeout(timer);
          if(serial!==this.serial)return;
          if(!settled){settled=true;reject(new Error('房间服务器已断开，请检查邀请链接'));}
          const wasOpen = this.open;
          this.open = false;
          this.ws = null;
          this.connecting = null;
          if (wasOpen) this.emit('wsclose');
          if (!this.closedByUser && this.opts) {
            this.retry = Math.min(this.retry + 1, 8);
            setTimeout(() => {
              if (serial===this.serial && !this.open && this.opts && !this.closedByUser) {
                this.connect().then(() => this.join(this.opts)).catch(() => {});
              }
            }, 700 * this.retry);
          }
        };
        ws.onmessage = (ev) => {
          if(serial!==this.serial)return;
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.op === 'sync' && msg.event) {
            this.emit(msg.event.type, msg.event);
          } else if (msg.op === 'join_ack') {
            this.emit('join_ack', msg);
          } else if (msg.op === 'hello') {
            this.emit('hello', msg);
          } else if (msg.op === 'pong') {
            this.emit('pong', msg);
          }
        };
      });
      return this.connecting;
    }

    async join(opts) {
      this.opts = opts;
      this.closedByUser = false;
      await this.connect();
      this.send({
        op: 'join',
        server: opts.server || '127.0.0.1',
        port: opts.port,
        username: opts.username,
        room: opts.room,
        avatar: opts.avatar || '',
        face: opts.face || '',
      });
    }

    leave() {
      this.closedByUser = true;
      this.opts = null;
      if (this.open) this.send({ op: 'leave' });
      this.serial=(this.serial||0)+1;
      if(this.rejectPending)this.rejectPending(new Error('已退出房间'));
      this.rejectPending=null;this.connecting=null;
      const socket=this.socket || this.ws;this.socket=null;this.ws=null;this.open=false;
      if(socket)try{socket.close();}catch(_){}
    }

    send(obj) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        return false;
      }
    }

    state(position, paused, doSeek, heartbeat = false) {
      return this.send({ op: 'state', position, paused, doSeek: !!doSeek, heartbeat: !!heartbeat });
    }

    file(name, duration) {
      return this.send({ op: 'file', name, duration });
    }

    chat(text) {
      return this.send({ op: 'chat', message: text });
    }

    avatar(dataUrl) {
      return this.send({ op: 'avatar', avatar: dataUrl || '' });
    }

    face(url) {
      return this.send({ op: 'face', face: url || '' });
    }
  }

  window.SyncClient = SyncClient;
})();
