/* One source engine on every device. HTTP always goes to that device's local bridge. */
(() => {
  'use strict';
  const configs=[],cache=new Map();
  const ready=fetch('/art/providers.json').then(r=>r.json()).then(rows=>{rows.forEach(row=>configs.push(row));return configs;});
  const doc=text=>new DOMParser().parseFromString(text,'text/html');
  const clean=node=>(node&&node.textContent||'').trim();
  const absolute=(url,base)=>new URL(url,base).href;
  const pack=text=>{const bytes=new TextEncoder().encode(text);let out='';bytes.forEach(b=>out+=String.fromCharCode(b));return btoa(out).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
  const safeTarget=/^anime:(giri|mxdm|ezdmw|baimao|sefun|aki):([A-Za-z0-9_-]{1,40}):(\d{1,6}):(\d{1,10})$/;
  async function http(url,options={}){
    const controller=new AbortController(),cancel=()=>controller.abort();
    if(options.signal){if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});}
    const timeout=setTimeout(cancel,8500);
    try{
      const response=await fetch('/api/source-http?u='+encodeURIComponent(url)+(options.probe?'&probe=1':''),{cache:'no-store',signal:controller.signal});
      const data=await response.json();if(!response.ok||!data.ok){let message=data.error||'片源暂时无法连接';if(/域名尚未验证|未登记/.test(message))message='当前线路暂不支持本机读取，请更换线路';else if(/服务器内部错误|SSL|urlopen|Socket|java\.|Failed|Illegal/.test(message))message='本机暂时无法连接此源，请稍后重试';throw new Error(message);}return data;
    }catch(e){if(e.name==='AbortError')throw new Error('片源探测超时');throw e;}
    finally{clearTimeout(timeout);if(options.signal)options.signal.removeEventListener('abort',cancel);}
  }
  async function config(id){await ready;const item=configs.find(x=>x.id===id);if(!item)throw new Error('未知动漫源');return item;}
  async function text(url,signal){return (await http(url,{signal})).body;}
  async function search(id,keyword,signal){
    const c=await config(id),q=encodeURIComponent(String(keyword).slice(0,100));let page;
    if(id==='giri'){
      const data=JSON.parse(await text('https://m3u8.girigirilove.com/api.php/Vod/get_list?vod_name='+q+'&offset=0&limit=24',signal));
      return ((data.info||{}).rows||[]).map(row=>({id:String(row.vod_id),title:row.vod_name,provider:id}));
    }
    const paths={mxdm:'/search/?wd=',ezdmw:'/Index/search.html?searchText=',baimao:'/s_all?ex=1&kw=',sefun:'/vodsearch/-------------.html?wd=',aki:'/bgmsearch/-------------.html?wd='};
    page=doc(await text(c.base+paths[id]+q,signal));
    const patterns={mxdm:/^\/detail\/(\d+)\/$/,ezdmw:/^\/Index\/bangumi\/(\d+)\.html$/,baimao:/^\/show\/(\d+)\.html$/,sefun:/^\/voddetail\/(\d+)\.html$/,aki:/^\/bgmdetail\/([A-Za-z0-9_-]+)\.html$/};
    const results=new Map();page.querySelectorAll('a[href]').forEach(a=>{
      const match=a.getAttribute('href').match(patterns[id]);if(!match)return;
      let title=a.getAttribute('title')||clean(a)||((a.querySelector('img')||{}).alt)||'';
      if(!title&&id==='ezdmw')title=clean(a.nextElementSibling);
      if(title&&!/^(查看详情|详情|立即播放|在线观看|观看)$/.test(title)&&!results.has(match[1]))results.set(match[1],{id:match[1],title,provider:id});
    });return Array.from(results.values()).slice(0,48);
  }
  async function details(id,series,signal){
    const c=await config(id);if(!/^[A-Za-z0-9_-]{1,40}$/.test(String(series)))throw new Error('番剧编号无效');
    const key=id+':'+series,old=cache.get(key);if(old&&Date.now()-old.at<300000)return old.value;
    const roads=new Map();let title='番剧';
    if(id==='giri'){
      const info=JSON.parse(await text('https://m3u8.girigirilove.com/api.php/Vod/get_detail?vod_id='+series,signal)).info||{};
      title=info.vod_name||title;const names=(info.vod_play_from||'').split('$$$');
      (info.vod_play_url||'').split('$$$').forEach((group,road)=>{
        const episodes=[];group.split('#').forEach((entry,index)=>{const at=entry.indexOf('$');if(at>0)episodes.push({name:entry.slice(0,at),url:entry.slice(at+1),index:index+1});});
        if(episodes.length)roads.set(road+1,{name:names[road]||'线路 '+(road+1),episodes});
      });
    }else{
      const paths={mxdm:'/detail/'+series+'/',ezdmw:'/Index/bangumi/'+series+'.html',baimao:'/show/'+series+'.html',sefun:'/voddetail/'+series+'.html',aki:'/bgmdetail/'+series+'.html'};
      const page=doc(await text(c.base+paths[id],signal));title=clean(page.querySelector('h1'))||clean(page.querySelector('title')).split('在线播放')[0].split(' - ')[0];
      const patterns={mxdm:new RegExp('^/play/'+series+'-(\\d+)-(\\d+)/$'),baimao:new RegExp('^/play/'+series+'-(\\d+)-(\\d+)\\.html$'),sefun:new RegExp('^/vodplay/'+series+'-(\\d+)-(\\d+)\\.html$'),aki:new RegExp('^/bgmplay/'+series+'-(\\d+)-(\\d+)\\.html$')};
      const seen=new Set();page.querySelectorAll('a[href]').forEach(a=>{
        const href=a.getAttribute('href');let road,index;
        if(id==='ezdmw'){const r=a.className.match(/circuit_switch(\d+)/),m=href.match(/^\/Index\/video\/(\d+)\.html$/);if(!r||!m)return;road=Number(r[1]);index=Number(m[1]);}
        else{const m=href.match(patterns[id]);if(!m)return;road=Number(m[1]);index=Number(m[2]);}
        const key=road+':'+index;if(seen.has(key))return;seen.add(key);
        if(!roads.has(road))roads.set(road,{name:'线路 '+(id==='baimao'?road+1:road),episodes:[]});
        roads.get(road).episodes.push({name:clean(a)||a.getAttribute('title')||String(index),index,url:absolute(href,c.base)});
      });
    }
    const result={provider:id,series,title,roads:[]};roads.forEach((road,key)=>{
      road.episodes.forEach(ep=>ep.target='anime:'+id+':'+series+':'+key+':'+ep.index);result.roads.push({...road,id:key});
    });if(!result.roads.length)throw new Error('没有找到剧集，请切换片源');cache.set(key,{at:Date.now(),value:result});return result;
  }
  function playerUrl(html){
    const page=doc(html),scripts=Array.from(page.querySelectorAll('script:not([src])'));
    const video=page.querySelector('video[src]');if(video&&video.getAttribute('src'))return video.getAttribute('src');
    for(const script of scripts){
      const source=script.textContent,match=source.match(/\bplayer_\w+\s*=\s*/);if(!match)continue;
      const start=source.indexOf('{',match.index+match[0].length);if(start<0)continue;
      let depth=0,string=false,escape=false,end=-1;
      for(let i=start;i<source.length;i++){const char=source[i];if(string){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')string=false;}else if(char==='"')string=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){end=i+1;break;}}
      if(end<0)continue;
      try{const data=JSON.parse(source.slice(start,end));let url=data.url||'';if(Number(data.encrypt)===2)url=atob(url);if(Number(data.encrypt)>0)url=decodeURIComponent(url);if(/^https?:\/\//.test(url))return url;}catch(_){}
    }
    const direct=html.match(/\burl\s*:\s*['"](https?:\/\/[^/'"\s]+[^'"]*)['"]/)||html.match(/<video[^>]+src=['"]([^'"]+)['"]/i);
    return direct?direct[1].replace(/&amp;/g,'&'):'';
  }
  async function video(target,signal){
    const match=String(target).match(safeTarget);if(!match)throw new Error('剧集编号无效');
    const [,id,series,roadId,index]=match,c=await config(id),info=await details(id,series,signal);
    const road=info.roads.find(r=>r.id===Number(roadId)),episode=road&&road.episodes.find(e=>e.index===Number(index));if(!episode)throw new Error('剧集已变更，请重新选集');
    let url=episode.url,mode='mp4';
    if(id==='ezdmw'){
      const html=await text(url,signal),match=html.match(/var danmuPlayer1\s*=\s*"([^"]+)"/);if(!match)throw new Error('播放线路暂不可用');
      url=absolute(playerUrl(await text(match[1].replace(/&amp;/g,'&'),signal)),'https://player.ezdmw.com/');mode='hls';
    }else if(id!=='giri'){
      let raw=await text(url,signal),next=playerUrl(raw);
      // Follow a bounded number of ordinary public player pages, without executing scripts.
      for(let i=0;i<2&&next&&!/\.(mp4|m3u8|webm)(?:\?|$)/i.test(next);i++){
        const value=await http(next,{probe:true,signal});if(['mp4','ts','webm','hls'].includes(value.kind))break;
        next=playerUrl(await text(next,signal));
      }
      if(!next)throw new Error('该线路需要额外解析，暂不支持直接播放');url=next;mode=/\.m3u8(?:\?|$)/i.test(url)?'hls':'mp4';
    }
    if(!/^https?:\/\//i.test(url))throw new Error('播放地址无效');
    return {ok:true,target,cid:'',page:1,qn:80,qualities:[],info:{title:info.title+' · '+episode.name,owner:c.name,provider:id,is_anime:true,duration:0,episodes:road.episodes.map(e=>({title:e.name,target:e.target})),roads:info.roads.map(r=>({title:r.name,target:r.episodes[0].target}))},source:{mode,url:'/anime-media?u='+pack(url)}};
  }
  async function probe(id,keyword,signal){
    const began=Date.now(),rows=await search(id,keyword,signal);if(!rows.length)return {status:'missing',label:'未找到该番',checkedAt:Date.now()};
    const normalized=s=>s.replace(/[\s\p{P}]/gu,'').toLowerCase();
    rows.sort((a,b)=>Number(normalized(b.title)===normalized(keyword))-Number(normalized(a.title)===normalized(keyword)));
    const detail=await details(id,rows[0].id,signal);let last='';
    for(const road of detail.roads.slice(0,6)){
      try{
        const episode=road.episodes[0],result=await video(episode.target,signal);
        let url=new TextDecoder().decode(Uint8Array.from(atob(result.source.url.split('u=')[1].replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0))),encrypted=false;
        for(let depth=0;depth<4;depth++){
          const response=await http(url,{probe:true,signal});
          if(response.kind==='hls'){
            const lines=response.body.split(/\r?\n/);encrypted=encrypted||/#EXT-X-KEY:.*METHOD=AES-128/.test(response.body);
            const child=lines.find(line=>line.trim()&&!line.startsWith('#'));if(!child)throw new Error('清单中没有媒体分段');url=absolute(child.trim(),url);continue;
          }
          if(!['mp4','ts','webm'].includes(response.kind)&&!encrypted)throw new Error('返回的不是可识别视频');
          if(!response.bytes)throw new Error('媒体为空');
          return {status:'playable',label:'可播放',checkedAt:Date.now(),latency:Date.now()-began,title:rows[0].title,episode:episode.name,target:episode.target,series:rows[0].id,road:road.id};
        }
      }catch(e){last=e.message;if(signal&&signal.aborted)throw e;}
    }
    return {status:'searchable',label:'有条目，媒体未确认',reason:last,checkedAt:Date.now(),title:rows[0].title};
  }
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.keys(value).sort().reduce((out,key)=>(out[key]=canonical(value[key]),out),{}):value;
  async function update(id){
    const c=await config(id),rule=JSON.parse(await text('https://raw.githubusercontent.com/Predidit/KazumiRules/main/'+c.rule+'.json'));
    const bytes=new TextEncoder().encode(JSON.stringify(canonical(rule))),digest=await crypto.subtle.digest('SHA-256',bytes);
    const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    return {changed:hash!==c.hash,current:c.version,latest:String(rule.version||''),checkedAt:Date.now()};
  }
  window.SourceEngine={ready,configs,search,details,video,probe,update,isTarget:value=>safeTarget.test(value),playerUrl};
})();
