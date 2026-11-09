/* Downloads always use this device, never the room host in API.base. */
(() => {
  'use strict';
  let current = null, timer = null;
  const $ = id => document.getElementById(id);
  async function local(path, body) {
    let options = {cache:'no-store'};
    if (body && window.WT_MEDIA_BASE) {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      let binary=''; bytes.forEach(b=>binary+=String.fromCharCode(b));
      path += '?data='+encodeURIComponent(btoa(binary));
    } else if (body) options = {...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    const response = await fetch(path,options), data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '本机下载库暂时不可用');
    return data;
  }
  function media(source) {
    const result={...source};
    for(const key of source.mode==='dash'?['video','audio']:['url']) {
      const path = source[key];
      if (!/^\/api\/downloads\/file\/[a-f0-9]{32}\/[a-f0-9]{24}\.(mp4|m3u8|bin|ts|key)$/.test(path)) throw new Error('本机文件地址无效');
      result[key]=(window.WT_MEDIA_BASE||'')+path;
    }
    return result;
  }
  const bytes = n => n>1073741824?(n/1073741824).toFixed(2)+' GB':(n/1048576).toFixed(1)+' MB';
  async function refresh() {
    try {
      const data=await local('/api/downloads');
      $('download-list').textContent=''; $('download-empty').hidden=!!data.items.length;
      data.items.forEach(item=>{
        const row=document.createElement('article'); row.className='download-card';
        const text=document.createElement('div'),title=document.createElement('h3'),sub=document.createElement('p');
        title.textContent=item.title;
        const states={queued:'等待下载',downloading:'正在下载',complete:'本机可播放',cancelled:'已取消',interrupted:'下载中断',error:'下载失败'};
        sub.textContent=(states[item.status]||item.status)+' · '+bytes(item.have||0)+(item.status==='downloading'&&item.size>0?' / '+bytes(item.size):'');
        text.append(title,sub);
        if(item.error){const err=document.createElement('p');err.className='download-error';err.textContent=item.error;text.appendChild(err);}
        const progress=document.createElement('progress');progress.max=100;
        if(item.status==='complete')progress.value=100;
        else if(item.size>0)progress.value=Math.min(99,100*item.have/item.size);
        if(item.status==='queued')progress.value=0;
        text.appendChild(progress); row.appendChild(text);
        const action=document.createElement('button');action.className='btn tonal';
        if(item.status==='complete'){
          action.textContent='同步播放'; action.onclick=()=>{ $('dlg-downloads').close(); window.dispatchEvent(new CustomEvent('wt-download-play',{detail:item})); };
        } else if(['queued','downloading'].includes(item.status)){
          action.textContent='取消';action.onclick=async()=>{try{await local('/api/downloads/cancel',{id:item.id});refresh();}catch(e){toast(e.message,true);}};
        } else {
          action.textContent='重新载入';action.onclick=()=>{ $('dlg-downloads').close();toast('重新载入视频后，点击“下载到本机”重试');window.dispatchEvent(new CustomEvent('wt-download-play',{detail:{...item,retry:true}})); };
        }
        row.appendChild(action);$('download-list').appendChild(row);
      });
      clearTimeout(timer); if($('dlg-downloads').open)timer=setTimeout(refresh,1500);
    }catch(e){$('download-empty').hidden=false;$('download-empty').textContent=e.message;}
  }
  window.DeviceLibrary={
    capture(response, content) {
      current={source:{...response.source},content,title:response.info.title,info:response.info,target:response.target,
        qn:response.qn,page:response.page||1,cid:response.cid};
      $('btn-download-current').disabled=!!response.offline;
      $('btn-download-current').textContent=response.offline?'本机已下载':'下载到本机';
    },
    async resolve(target,page,qn) {
      try {
        const data=await local('/api/downloads');
        const choices=data.items.filter(i=>i.status==='complete'&&i.target===target&&Number(i.page||1)===Number(page||1));
        choices.sort((a,b)=>(Number(b.qn)===Number(qn))-(Number(a.qn)===Number(qn))||Number(b.qn)-Number(a.qn));
        const item=choices[0]; if(!item)return null;
        return {ok:true,info:item.info,target:item.target,page:item.page,cid:item.cid,qn:item.qn,
          ep_id:item.info.ep_id,qualities:[],source:media(item.source),offline:true};
      }catch(_){return null;}
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    $('btn-download-current').onclick=async()=>{
      if(!current){toast('请先载入视频');return;}
      try{await local('/api/downloads/start',current);toast('已加入本机下载列表');$('dlg-downloads').showModal();refresh();}
      catch(e){toast(e.message,true);}
    };
    document.querySelectorAll('[data-download-library]').forEach(button=>button.onclick=()=>{$('dlg-downloads').showModal();refresh();});
    $('dlg-downloads').addEventListener('close',()=>clearTimeout(timer));
  });
})();
