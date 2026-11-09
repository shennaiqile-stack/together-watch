/* Native phones can join the same public Syncplay room from different networks. */
(() => {
  'use strict';
  if (window.PhoneRooms) window.WT_APP_VERSION = '5.4';

  function server(value) {
    const match = String(value || '').trim().match(/^([a-zA-Z0-9.-]{1,253})(?::(\d{1,5}))?$/);
    if (!match || Number(match[2] || 8999) < 1 || Number(match[2] || 8999) > 65535) throw new Error('请输入有效的同步服务器，例如 syncplay.pl:8999');
    return {server:match[1],port:Number(match[2] || 8999)};
  }
  window.PhoneRoomMode = {
    active:false, endpoint:null,
    parseServer:server,
    defaultServer(){try{return server(localStorage.getItem('wt.sync.server') || 'syncplay.pl:8999');}catch(_){return server('syncplay.pl:8999');}},
    saveDefault(value){const endpoint=server(value);localStorage.setItem('wt.sync.server',endpoint.server+':'+endpoint.port);return endpoint;},
    defaults() {
      const input = document.getElementById('phone-sync-server');
      const saved=this.defaultServer();
      const value = input && input.value.trim() ? input.value : saved.server+':'+saved.port;
      const linked=typeof location!=='undefined'?this.fromHttp(location.href):null;
      const result = linked || server(value);
      return result;
    },
    fromHttp(text) {
      const url=new URL(text);
      if(!['http:','https:'].includes(url.protocol))throw new Error('邀请地址格式无效');
      const value=url.searchParams.get('sync');
      return value?server(value):null;
    },
    webInvite(base,room,key) {
      const url=new URL(base);url.pathname='/';url.search='';url.hash='';
      url.searchParams.set('room',room);
      if(key)url.searchParams.set('k',key);
      if(this.active)url.searchParams.set('sync',this.endpoint.server+':'+this.endpoint.port);
      return url.href;
    },
    parse(text) {
      if (!/^syncplay:\/\//i.test(text)) return null;
      const url = new URL(text);
      const endpoint = server(url.host);
      const room = decodeURIComponent(url.pathname.slice(1)).toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(room) || url.username || url.password) throw new Error('手机房间邀请无效，请重新复制完整链接');
      return {...endpoint,room,phone:true,base:'',key:''};
    },
    use(endpoint) { this.endpoint = endpoint; this.active = !!endpoint; },
    invite(room) { return 'syncplay://' + this.endpoint.server + ':' + this.endpoint.port + '/' + room; }
  };
  const OriginalSync = window.SyncClient;
  class PhoneSync extends OriginalSync {
    constructor() {
      super();
      this.native = false;
      this.nativeSerial = 0;
      window.PhoneSyncReceive = (id,type,data) => {
        if (!this.native || id !== this.nativeSerial) return;
        if (type === 'connected') {
          clearTimeout(this.joinTimer);
          this.open = true;
          this.ws = {readyState:1};
          this.retry = 0;
          if (this.nativeResolve) this.nativeResolve();
          this.nativeResolve = this.nativeReject = null;
        }
        if (type === 'error' && this.nativeReject) {
          clearTimeout(this.joinTimer);
          this.nativeReject(new Error(data.message || '房间连接失败'));
          this.nativeResolve = this.nativeReject = null;
        }
        if (type === 'disconnected') {
          clearTimeout(this.joinTimer);
          this.open = false; this.ws = null;
          if (this.nativeReject) this.nativeReject(new Error('房间连接已断开'));
          this.nativeResolve = this.nativeReject = null;
          if (!this.closedByUser && this.opts) {
            const options = this.opts;
            const serial = this.nativeSerial;
            const delay = Math.min(10000, 1200 * (this.retry + 1));
            this.retry++;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              if (this.native && serial === this.nativeSerial && !this.closedByUser && this.opts)
                this.join(options).catch(() => {});
            }, delay);
          }
        }
        this.emit(type,data);
      };
    }
    async join(options) {
      if (!PhoneRoomMode.active) {
        if (this.native) this.leave();
        this.native = false;
        return super.join(options);
      }
      const retries = this.retry;
      this.leave();
      this.retry = retries;
      this.native = true;
      this.closedByUser = false;
      this.opts = options;
      const serial = ++this.nativeSerial;
      return new Promise((resolve,reject) => {
        this.nativeResolve = resolve; this.nativeReject = reject;
        this.joinTimer = setTimeout(() => {
          if (serial !== this.nativeSerial || this.open) return;
          const error = new Error('连接同步服务器超时，请检查网络或更换服务器');
          this.leave();
          this.emit('error',{message:error.message});
          reject(error);
        },30000);
        PhoneRooms.connect(JSON.stringify({...options,...PhoneRoomMode.endpoint,serial}));
      });
    }
    send(command) {
      if (!this.native) return super.send(command);
      if (!this.open) return false;
      PhoneRooms.send(JSON.stringify(command));
      return true;
    }
    leave() {
      clearTimeout(this.reconnectTimer);
      clearTimeout(this.joinTimer);
      if (this.native) {
        this.nativeSerial++;
        PhoneRooms.close();
        this.closedByUser = true;
        this.opts = null;
        this.open = false;
        this.ws = null;
        if (this.nativeReject) this.nativeReject(new Error('已退出房间'));
        this.nativeResolve = this.nativeReject = null;
      } else super.leave();
    }
  }
  if (window.PhoneRooms) window.SyncClient = PhoneSync;
  document.addEventListener('DOMContentLoaded', () => {
    if (window.PhoneRooms) document.documentElement.classList.add('native-phone');
    const input = document.getElementById('phone-sync-server');
    const saved=PhoneRoomMode.defaultServer();input.value = saved.server+':'+saved.port;
    document.getElementById('phone-server-field').hidden = false;
    const description = document.querySelector('[data-settings-panel="network"] .settings-description');
    if (description) description.textContent = '默认同步服务器可在下方修改，保存后用于下一次开房或按房号加入。完整邀请中的服务器优先。';
    const help = document.querySelector('#dlg-help .help-item p');
    if (help) help.textContent = '创建房间后复制完整邀请，电脑与手机均可粘贴加入；只填房号时，两端服务器须一致。';
  });
})();
