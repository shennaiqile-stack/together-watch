/* Source selection is gated by a fresh, device-local media probe. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),results=new Map(),checks=new Map();
  let selected=null,generation=0,controller=null,chosen='bilibili';
  const keyword=()=>($('source-probe-query').value.trim()||$('search-input').value.trim()||'葬送的芙莉莲');
  function updateCard(c,result){
    const card=$('probe-'+c.id);if(!card)return;
    card.dataset.status=result.status;card.querySelector('.probe-state').textContent=result.label;
    card.querySelector('.probe-detail').textContent=(result.title?result.title+(result.episode?' · '+result.episode:'')+' · ':'')+(result.checkedAt?new Date(result.checkedAt).toLocaleTimeString('zh-CN'):'')+(result.reason?' · '+result.reason:'');
    card.querySelector('button').disabled=result.status!=='playable';
    results.set(c.id,{...result,keyword:keyword()});
  }
  async function details(provider,id,preferredRoad){
    const data=await SourceEngine.details(provider,id);selected=data;$('source-anime-title').textContent=data.title;$('source-road').textContent='';
    data.roads.forEach((road,index)=>{const option=document.createElement('option');option.value=index;option.textContent=road.name;if(road.id===preferredRoad)option.selected=true;$('source-road').appendChild(option);});
    episodes();$('dlg-source-anime').showModal();
  }
  function episodes(){
    $('source-episodes').textContent='';const road=selected&&selected.roads[Number($('source-road').value)];if(!road)return;
    road.episodes.forEach(episode=>{const button=document.createElement('button');button.className='btn tonal';button.textContent=episode.name;button.onclick=()=>{$('dlg-source-anime').close();$('search-panel').hidden=true;window.dispatchEvent(new CustomEvent('wt-anime-play',{detail:episode.target}));};$('source-episodes').appendChild(button);});
  }
  async function probes(force){
    if(controller)controller.abort();controller=new AbortController();const serial=++generation,query=keyword();
    $('source-probe-query').value=query;$('probe-summary').textContent='正在由本机检测搜索、选集和媒体，结果会逐个显示…';
    const sources=await SourceEngine.ready;let cursor=0,done=0;
    async function worker(){while(cursor<sources.length){const c=sources[cursor++],old=checks.get(c.id+'|'+query);let result;
      if(!force&&old&&Date.now()-old.checkedAt<300000)result=old;
      else{updateCard(c,{status:'checking',label:'探测中'});const abort=new AbortController(),cancel=()=>abort.abort(),deadline=setTimeout(cancel,35000);controller.signal.addEventListener('abort',cancel,{once:true});
        try{result=await SourceEngine.probe(c.id,query,abort.signal);}catch(e){result={status:'unavailable',label:'暂不可用',reason:e.message,checkedAt:Date.now()};}finally{clearTimeout(deadline);}
        checks.set(c.id+'|'+query,result);
      }
      if(serial!==generation)return;updateCard(c,result);done++;$('probe-summary').textContent='已检测 '+done+'/'+sources.length+' · '+Array.from(results.values()).filter(x=>x.keyword===query&&x.status==='playable').length+' 个源媒体可读 · 抽测剧集，不代表全部线路';
    }}
    await Promise.all([worker(),worker(),worker()]);
  }
  async function updates(){
    const sources=await SourceEngine.ready;let cursor=0,done=0;
    $('btn-source-updates').disabled=true;
    async function worker(){while(cursor<sources.length){const c=sources[cursor++],node=$('probe-'+c.id).querySelector('.probe-version');node.textContent='正在检查规则更新…';
      try{const result=await SourceEngine.update(c.id);node.textContent=(result.changed?'有规则更新，待适配':'规则已是当前版本')+' · '+result.current+(result.changed?' → '+result.latest:'')+' · '+new Date(result.checkedAt).toLocaleTimeString('zh-CN');node.dataset.updated=String(result.changed);}catch(_){node.textContent='规则更新检查失败，可稍后重试 · 本机 '+c.version;}
      done++;
    }}
    await Promise.all([worker(),worker()]);$('btn-source-updates').disabled=false;
    try{localStorage.setItem('wt.source-update-check',String(Date.now()));}catch(_){}
  }
  async function open(){await SourceEngine.ready;if(!$('dlg-source-probe').open)$('dlg-source-probe').showModal();$('source-probe-query').value=$('search-input').value.trim()||'葬送的芙莉莲';probes(false);}
  window.AnimeSources={open,async search(query){
    const provider=$('search-provider').value;if(provider==='bilibili')return false;
    const verified=results.get(provider);
    if(!verified||verified.keyword!==query||Date.now()-verified.checkedAt>300000||verified.status!=='playable'){await open();return true;}
    $('search-list').textContent='正在由本机搜索…';
    try{const rows=await SourceEngine.search(provider,query);$('search-list').textContent='';if(!rows.length)$('search-list').textContent='没有找到匹配番剧，可重新探测其他源。';
      rows.forEach(item=>{const row=document.createElement('button');row.className='source-result';const title=document.createElement('strong'),label=document.createElement('span');title.textContent=item.title;label.textContent='本机加载 · 选择剧集';row.append(title,label);row.onclick=async()=>{row.disabled=true;try{await details(provider,item.id);}catch(e){toast(e.message,true);}finally{row.disabled=false;}};$('search-list').appendChild(row);});
    }catch(e){$('search-list').textContent=e.message;}
    return true;
  }};
  document.addEventListener('DOMContentLoaded',async()=>{
    const sources=await SourceEngine.ready;
    sources.forEach(c=>{const option=document.createElement('option');option.value=c.id;option.textContent=c.name;$('search-provider').appendChild(option);
      const card=document.createElement('article');card.id='probe-'+c.id;card.className='source-probe-card';card.dataset.status='unknown';
      card.innerHTML='<div><h3></h3><span class="probe-state">尚未检测</span></div><p class="probe-detail">选择前检测本机连接和媒体</p><p class="probe-version"></p><button class="btn tonal" disabled>选择此源</button>';
      card.querySelector('h3').textContent=c.name;card.querySelector('.probe-version').textContent='本机规则 '+c.version;
      card.querySelector('button').onclick=async()=>{const result=results.get(c.id);if(!result||result.keyword!==keyword()||Date.now()-result.checkedAt>300000){probes(true);return;}chosen=c.id;$('search-provider').value=c.id;$('search-input').value=result.keyword;$('dlg-source-probe').close();try{await details(c.id,result.series,result.road);}catch(e){toast(e.message,true);}};$('source-probe-list').appendChild(card);
    });
    $('source-road').onchange=episodes;$('btn-probe-sources').onclick=open;$('nav-sources').onclick=open;
    $('btn-probe-again').onclick=()=>probes(true);$('source-probe-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();probes(true);}};
    $('btn-source-updates').onclick=updates;
    $('search-provider').onchange=()=>{const value=$('search-provider').value;if(value==='bilibili'){chosen=value;if($('search-input').value.trim())$('btn-search-go').click();return;}$('search-provider').value=chosen;open();};
    $('dlg-source-probe').addEventListener('close',()=>{generation++;if(controller)controller.abort();});
    let last=0;try{last=Number(localStorage.getItem('wt.source-update-check'))||0;}catch(_){}if(Date.now()-last>86400000)updates();
  });
})();
