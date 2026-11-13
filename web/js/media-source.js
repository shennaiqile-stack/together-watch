/* Room metadata is remote; media requests belong to this device. */
(function () {
  function endpoint(value, nativeBase) {
    const parsed = new URL(value, location.href);
    if(parsed.pathname==='/anime-media' && parsed.searchParams.has('u'))return (nativeBase||'')+'/anime-media'+parsed.search;
    if (parsed.origin === location.origin && parsed.pathname === '/mock/video.mp4') return parsed.pathname;
    if (parsed.pathname !== '/relay' || !parsed.searchParams.has('u')) {
      throw new Error('播放地址无效，请重新载入视频');
    }
    if (!nativeBase) return '/relay' + parsed.search;
    let primary=parsed.searchParams.get('u');
    let backups=[];
    try {
      const packed = parsed.searchParams.get('b') || '';
      const values=JSON.parse(atob(packed.replace(/-/g, '+').replace(/_/g, '/')));
      if(Array.isArray(values))backups=values.filter(v=>typeof v==='string').slice(0,6);
    } catch (e) { /* A primary URL can be used without alternatives. */ }
    // The supplied native relay cannot read some PCDN hosts. Prefer a standard
    // Bilibili CDN supplied by the same play response, keeping all other routes.
    const decode=s=>atob(s.replace(/-/g,'+').replace(/_/g,'/'));
    const encode=s=>btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    try {
      const candidates=[decode(primary),...backups];
      const preferred=candidates.find(value=>{
        try{const u=new URL(value);return u.protocol==='https:' && (u.hostname==='bilivideo.com'||u.hostname.endsWith('.bilivideo.com'));}catch(_){return false;}
      });
      if(preferred){primary=encode(preferred);backups=[...new Set(candidates)].filter(value=>value!==preferred);}
    }catch(_){}
    let url=nativeBase+'/relay?u='+encodeURIComponent(primary);
    for(const backup of backups.slice(0,6)){
      try{url+='&backup='+encodeURIComponent(encode(backup));}catch(_){}
    }
    return url;
  }
  window.MediaSourceRoute = {
    local(source, nativeBase) {
      const result = Object.assign({}, source);
      for (const key of source.mode === 'dash' ? ['video', 'audio'] : ['url']) {
        result[key] = endpoint(source[key], nativeBase);
      }
      return result;
    }
  };
})();
