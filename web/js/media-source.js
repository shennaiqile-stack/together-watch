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
    let url = nativeBase + '/relay?u=' + encodeURIComponent(parsed.searchParams.get('u'));
    try {
      const packed = parsed.searchParams.get('b') || '';
      const backups = JSON.parse(atob(packed.replace(/-/g, '+').replace(/_/g, '/')));
      for (const backup of backups.slice(0, 6)) {
        const encoded = btoa(backup).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        url += '&backup=' + encodeURIComponent(encoded);
      }
    } catch (e) { /* A primary URL can be used without alternatives. */ }
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
