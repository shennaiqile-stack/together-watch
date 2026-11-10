/* Public releases only. Versions are per platform, never inferred from a shared tag. */
(function (root) {
  'use strict';
  const repository = 'https://github.com/shennaiqile-stack/together-watch';
  const endpoint = 'https://api.github.com/repos/shennaiqile-stack/together-watch/releases/latest';
  const versions = {windows:'1.6.15', android:'5.5'};
  function newer(candidate, current) {
    if (!/^\d+(?:\.\d+){1,3}$/.test(candidate) || !/^\d+(?:\.\d+){1,3}$/.test(current)) return false;
    const a=candidate.split('.').map(Number), b=current.split('.').map(Number);
    for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);}
    return false;
  }
  function select(release, platform) {
    if(!release || release.draft || release.prerelease || !Array.isArray(release.assets))return null;
    const pattern=platform==='android'?/^TogetherWatch-Android-v(\d+(?:\.\d+){1,3})\.apk$/:/^TogetherWatch-Windows-v(\d+(?:\.\d+){1,3})\.exe$/;
    let result=null;
    for(const asset of release.assets){
      const match=String(asset.name||'').match(pattern);
      if(!match || asset.state!=='uploaded' || !Number.isFinite(asset.size) || asset.size<=0)continue;
      const url=String(asset.browser_download_url||'');
      if(!url.startsWith(repository+'/releases/download/') || /[?#]/.test(url))continue;
      if(!result || newer(match[1],result.version))result={version:match[1],url};
    }
    return result;
  }
  const exported={newer,select,versions,endpoint};
  if(typeof module==='object' && module.exports){module.exports=exported;return;}
  root.AppUpdates=exported;
  let pending=false;
  document.addEventListener('DOMContentLoaded',()=>{
    const platform=root.PhoneRooms?'android':'windows', current=versions[platform];
    const button=document.getElementById('btn-check-app-update'), status=document.getElementById('app-update-status');
    const dialog=document.getElementById('dlg-app-update'), download=document.getElementById('app-update-download');
    document.getElementById('app-current-version').textContent='v'+current;
    async function check(manual){
      if(pending)return;
      pending=true;button.disabled=true;
      status.textContent='正在检查更新…';
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch(endpoint,{cache:'no-store',headers:{Accept:'application/vnd.github+json'},signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
        if(response.status===404){status.textContent='暂未发布安装包';return;}
        if(!response.ok)throw new Error('HTTP '+response.status);
        const release=await response.json(), asset=select(release,platform);
        if(!asset){status.textContent='当前发布尚无适用于此设备的安装包';return;}
        if(!newer(asset.version,current)){status.textContent='已是最新版本（v'+current+'）';return;}
        status.textContent='发现新版本 v'+asset.version;
        document.getElementById('app-update-title').textContent='发现新版本 v'+asset.version;
        document.getElementById('app-update-notes').textContent=String(release.body||'包含功能改进和问题修复。').slice(0,6000);
        download.href=asset.url;
        download.onclick=event=>{
          if(root.PhoneUpdates){event.preventDefault();root.PhoneUpdates.openDownload(asset.url);}
        };
        if(root.WatchFullscreen && root.WatchFullscreen.element())await root.WatchFullscreen.exit();
        if(!dialog.open)dialog.showModal();
      }catch(error){
        status.textContent='暂时无法连接 GitHub，请稍后重试或前往发布页';
        if(manual && root.toast)root.toast('更新检查失败，请检查网络后重试',true);
      }finally{clearTimeout(timer);pending=false;button.disabled=false;}
    }
    button.onclick=()=>check(true);
    const releases=document.getElementById('app-release-page');
    releases.onclick=event=>{if(root.PhoneUpdates){event.preventDefault();root.PhoneUpdates.openDownload(repository+'/releases/latest');}};
    // Run after startup work; no cached result may suppress a later launch's check.
    setTimeout(()=>check(false),1800);
  });
})(typeof window==='undefined'?globalThis:window);
