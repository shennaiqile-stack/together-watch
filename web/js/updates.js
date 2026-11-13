/* Public releases only. Versions are per platform, never inferred from a shared tag. */
(function (root) {
  'use strict';
  const repository = 'https://github.com/shennaiqile-stack/together-watch';
  const endpoint = 'https://api.github.com/repos/shennaiqile-stack/together-watch/releases/latest';
  const versions = {windows:'1.6.23', android:'5.10'};
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
      if(!result || newer(match[1],result.version))result={version:match[1],url,size:asset.size,sha256:String(asset.digest||'').replace(/^sha256:/,'')};
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
    let updateAsset=null,updateState=null,pollTimer=null;
    const progress=document.getElementById('app-update-progress'),progressText=document.getElementById('app-update-progress-text');
    async function nativeState(){
      if(root.PhoneUpdates&&root.PhoneUpdates.status)return JSON.parse(root.PhoneUpdates.status());
      const r=await fetch('/api/app-update/status',{cache:'no-store'});if(!r.ok)throw new Error('无法读取更新状态');return r.json();
    }
    function render(state){
      updateState=state;
      if(progress){progress.hidden=state.stage!=='downloading';progress.max=state.total||1;progress.value=state.downloaded||0;}
      const percent=state.total?Math.floor((state.downloaded||0)/state.total*100):0;
      let text='';
      if(state.stage==='downloading')text='正在下载 '+percent+'% · '+((state.downloaded||0)/1048576).toFixed(1)+' / '+((state.total||0)/1048576).toFixed(1)+' MB';
      if(state.stage==='ready')text=state.error||'下载完成，校验通过，可以覆盖安装';
      if(state.stage==='permission')text=state.error||'请允许安装更新后返回';
      if(state.stage==='installing')text='正在覆盖安装并重启…';
      if(state.stage==='error')text=state.error||'更新失败，请重试';
      if(progressText)progressText.textContent=text;
      if(text)status.textContent=text;
      download.disabled=['downloading','installing'].includes(state.stage);
      download.textContent=['ready','permission'].includes(state.stage)?(platform==='android'?'安装更新':'安装并重启'):state.stage==='error'?'重新下载':'下载更新';
    }
    async function refresh(){try{render(await nativeState());}catch(_){} }
    async function install(){
      if(root.PhoneUpdates&&root.PhoneUpdates.install){root.PhoneUpdates.install();await refresh();return;}
      const r=await fetch('/api/app-update/install',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||'安装失败');render(data);
      if(root.close)setTimeout(()=>root.close(),500);
    }
    async function downloadUpdate(event){
      event.preventDefault();
      try{
        if(updateState&&['ready','permission'].includes(updateState.stage)){await install();return;}
        if(!updateAsset||!/^[0-9a-f]{64}$/i.test(updateAsset.sha256))throw new Error('发布文件缺少 SHA256 校验信息，请前往发布页');
        if(root.PhoneUpdates&&root.PhoneUpdates.start){root.PhoneUpdates.start(JSON.stringify(updateAsset));}
        else{
          const r=await fetch('/api/app-update/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updateAsset)});
          const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||'下载失败');
        }
        await refresh();
        if(!pollTimer)pollTimer=setInterval(refresh,700);
      }catch(error){render({stage:'error',error:error.message});}
    }
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
        updateAsset=asset;updateState=null;
        download.onclick=downloadUpdate;download.textContent='下载更新';download.disabled=false;
        await refresh();
        if(updateState&&['downloading','ready','permission'].includes(updateState.stage)&&!pollTimer)pollTimer=setInterval(refresh,700);
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
