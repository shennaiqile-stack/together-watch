/* Local poster browsing; choosing an anime never pretends a playable source exists. */
(() => {
  'use strict';
  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    let items = [], featured = null, selected = null, order = 'heat', randomItems = [], snapshotTime = 0;
    let visible=48, revision='', busy=false, hasMore=true, pollTimer=null;
    let featureGeneration=0;
    const score = (item) => Number(item.score) > 0 ? Number(item.score).toFixed(1) : '—';
    const safeItem = (item) => item && Number(item.id) > 0 && typeof item.title === 'string'
      && /^[a-f0-9]{24}\.(jpg|png)$/.test(item.file || '')
      && item.source === 'https://bgm.tv/subject/' + Number(item.id);
    function tags(node, list, limit) {
      node.textContent = ''; 
      (list || []).slice(0,limit).forEach((tag) => {
        const span = document.createElement('span'); span.textContent = tag; node.appendChild(span);
      });
    }
    function attachImage(node, item, lazy) {
      let retried=false;
      node.classList.remove('ready');
      node.onload = () => node.classList.add('ready');
      node.onerror = () => {
        if(!retried && /^https:\/\/lain\.bgm\.tv\//.test(item.imageSource||'')){
          retried=true;node.src=item.imageSource;return;
        }
        node.classList.remove('ready');
      };
      node.alt = item.title;
      node.referrerPolicy='no-referrer';
      node.decoding = 'async';
      if (lazy) node.loading = 'lazy';
      node.src = item.image;
    }
    async function chooseFeature() {
      const generation=++featureGeneration, button=$('btn-feature-shuffle');
      if(!window.BannerArtwork)return;
      await BannerArtwork.ready;
      if(generation!==featureGeneration)return;
      let choices=items.filter(item=>BannerArtwork.lookup(item));
      const different=choices.filter(item=>!featured || item.id!==featured.id);
      if(different.length)choices=different;
      for(let i=choices.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[choices[i],choices[j]]=[choices[j],choices[i]];}
      button.disabled=true;
      try{
        for(const item of choices.slice(0,5)){
          const art=BannerArtwork.lookup(item);
          const urls=[...new Set([art.image,art.imageSource])];
          for(const url of urls){
            try{
              await new Promise((resolve,reject)=>{
                const image=new Image(),timer=setTimeout(()=>{image.onload=image.onerror=null;reject(new Error('banner timeout'));},5000);
                image.onload=()=>{clearTimeout(timer);BannerArtwork.dimensions(image.naturalWidth,image.naturalHeight)?resolve():reject(new Error('not landscape'));};
                image.onerror=()=>{clearTimeout(timer);reject(new Error('banner unavailable'));};
                image.referrerPolicy='no-referrer';image.src=url;
              });
              if(generation!==featureGeneration)return;
              featured=item;
              $('feature-title').textContent=item.title;
              $('feature-meta').textContent='Bangumi '+score(item)+' 分 · '+item.votes.toLocaleString('zh-CN')+' 人评价';
              tags($('feature-tags'),item.tags,3);
              const image=$('feature-banner');image.src=url;image.alt='';image.hidden=false;
              const source=$('feature-art-source');source.href=art.source;source.hidden=false;
              return;
            }catch(_){/* Preserve the current recommendation until a complete image is ready. */}
          }
        }
      }finally{if(generation===featureGeneration)button.disabled=false;}
    }
    window.addEventListener('wt-banner-ready',()=>{if(!featured && items.length)chooseFeature();});
    function openAnime(item) {
      selected = item;
      $('anime-title').textContent = item.title;
      $('anime-original').textContent = item.originalTitle === item.title ? '' : item.originalTitle;
      $('anime-score').textContent = score(item);
      $('anime-votes').textContent = item.votes.toLocaleString('zh-CN') + ' 人评价';
      tags($('anime-tags'), item.tags, 6);
      $('anime-facts').textContent = item.info || '更多番剧信息可查看 Bangumi 条目。';
      $('anime-source').href = item.source;
      attachImage($('anime-poster'), item, false);
      $('dlg-anime').showModal();
    }
    function render() {
      const query = $('catalogue-filter').value.trim().toLocaleLowerCase();
      let display = order === 'random' ? randomItems.slice() : items.slice();
      if (order === 'score') display.sort((a,b) => b.score - a.score || a.rank - b.rank);
      if (query) display = display.filter((item) => [item.title,item.originalTitle,...item.tags].join(' ').toLocaleLowerCase().includes(query));
      $('poster-grid').textContent = ''; 
      $('catalogue-empty').hidden = display.length > 0;
      display.slice(0,visible).forEach((item) => {
        const card = document.createElement('button');
        card.className = 'poster-card'; card.type = 'button';
        card.setAttribute('aria-label', item.title + '，评分 ' + score(item) + '，查看详情');
        const media = document.createElement('div'); media.className = 'poster-media';
        const placeholder = document.createElement('span'); placeholder.className = 'poster-placeholder';
        placeholder.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';
        const image = document.createElement('img'); attachImage(image,item,true);
        const rank = document.createElement('span'); rank.className = 'poster-rank'; rank.textContent = '#' + item.rank;
        const rating = document.createElement('span'); rating.className = 'poster-score'; rating.textContent = score(item);
        media.append(placeholder,image,rank,rating);
        const title = document.createElement('h3'); title.textContent = item.title;
        const caption = document.createElement('span'); caption.className = 'poster-caption'; caption.textContent = item.tags.slice(0,2).join(' · ') || '动画';
        card.append(media,title,caption); card.onclick = () => openAnime(item);
        $('poster-grid').appendChild(card);
      });
      $('btn-catalogue-more').hidden=visible>=display.length&&!hasMore;
      $('btn-catalogue-more').textContent=visible<display.length?'显示更多番剧':'获取更多番剧';
    }
    function setItems(list, fetchedAt) {
      const fresh = (list || []).filter(safeItem).map((item) => ({...item,score:Number(item.score)||0,votes:Number(item.votes)||0,tags:Array.isArray(item.tags)?item.tags:[]}));
      if (!fresh.length) return;
      items = fresh;
      snapshotTime = Number(fetchedAt) || 0;
      randomItems = fresh.slice();
      const date = fetchedAt ? new Date(fetchedAt * 1000).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}) : '';
      $('catalogue-status').textContent = items.length + ' 部动画 · Bangumi 热度' + (date ? ' · ' + date + ' 更新' : '');
      render();
      if (!featured) chooseFeature();
    }
    $('catalogue-filter').oninput = render;
    $('btn-clear-filter').onclick = () => { $('catalogue-filter').value = ''; render(); $('catalogue-filter').focus(); };
    document.querySelectorAll('[data-catalogue-sort]').forEach((button) => {
      button.onclick = () => {
        order = button.dataset.catalogueSort;
        if (order === 'random') {
          randomItems = items.slice();
          for (let i=randomItems.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [randomItems[i],randomItems[j]]=[randomItems[j],randomItems[i]]; }
        }
        document.querySelectorAll('[data-catalogue-sort]').forEach((node) => {node.classList.toggle('selected',node===button);node.setAttribute('aria-pressed',String(node===button));});
        render();
      };
    });
    $('btn-feature-shuffle').onclick = chooseFeature;
    $('btn-feature-details').onclick = () => { if(featured) openAnime(featured); };
    $('btn-anime-room').onclick = () => {
      if (!selected) return;
      $('dlg-anime').close();
      window.WatchInterface.openEntry('create',selected.title);
    };
    window.addEventListener('wt-room-entered',(event) => {
      const query = window.WatchInterface.pendingSearch;
      window.WatchInterface.pendingSearch = '';
      if (!query) return;
      if ($('search-panel').hidden) $('btn-search').click();
      $('search-input').value = query;
      $('btn-search-go').click();
    });
    (async () => {
      try {
        const response = await fetch('/art/discovery/index.json');
        const data = await response.json();
        setItems((data.items || []).map((item) => ({...item,image:'/api/discovery/image/'+item.file})),data.fetchedAt);
      } catch (_) { $('catalogue-status').textContent = '正在获取番剧信息…'; }
      async function refresh(action) {
        const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),9000);
        try {
          const response = await fetch('/api/discovery'+(action?'/'+action:''),{method:action&&!window.WT_MEDIA_BASE?'POST':'GET',signal:controller.signal,cache:'no-store'});
          if (!response.ok) return;
          const data = await response.json();
          busy=!!data.refreshing;hasMore=!!data.hasMore;
          $('btn-catalogue-refresh').disabled=busy;
          $('btn-catalogue-more').disabled=busy;
          if (!items.length || String(data.revision||data.fetchedAt)!==revision) {
            revision=String(data.revision||data.fetchedAt);
            setItems((data.items || []).filter((item)=>item.image==='/api/discovery/image/'+item.file),data.fetchedAt);
          }
          const stamp=data.checkedAt?new Date(data.checkedAt*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
          $('catalogue-status').textContent=items.length+' 部动画 · Bangumi 热度'+(stamp?' · '+stamp+' 更新':'')+(busy?' · '+(data.operation==='more'?'加载更多':'更新中')+(data.progressTotal?' '+data.progressDone+'/'+data.progressTotal:''):'')+(data.error?' · '+data.error:'');
          render();
          clearTimeout(pollTimer);pollTimer=setTimeout(()=>refresh(),busy?2000:60000);
        } catch (_) { if(!items.length) $('catalogue-status').textContent = '暂时无法加载番剧，仍可直接创建或加入房间。'; }
        finally {clearTimeout(timer);}
      }
      $('btn-catalogue-refresh').onclick=()=>refresh('update');
      $('btn-catalogue-more').onclick=()=>{if(busy)return;visible+=48;render();if(visible>items.length)refresh('more');};
      window.addEventListener('focus',()=>{clearTimeout(pollTimer);refresh();});
      refresh();
    })();
  });
})();
