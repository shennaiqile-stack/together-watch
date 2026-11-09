/* Real landscape artwork only; title matching never guesses a different season. */
(function(root){
  'use strict';
  const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  function allowed(url){
    try{const value=new URL(url);return value.protocol==='https:' && ['s4.anilist.co','s5.anilist.co'].includes(value.hostname) && !value.username && !value.password && !value.port && !value.search && !value.hash && /^\/file\/anilistcdn\/media\/anime\/banner\/[A-Za-z0-9_.-]+$/.test(value.pathname);}catch(_){return false;}
  }
  function match(item,rows){
    const titles=[normalize(item.originalTitle),normalize(item.title)].filter(Boolean);
    const found=rows.filter(row=>row.type==='ANIME' && !row.isAdult && Number.isInteger(row.id) && allowed(row.bannerImage) && [...Object.values(row.title||{}),...(Array.isArray(row.synonyms)?row.synonyms:[])].some(name=>name && titles.includes(normalize(name))));
    const unique=new Map(found.map(row=>[row.id,row]));
    return unique.size===1?unique.values().next().value:null;
  }
  function dimensions(width,height){return width>=960 && height>=240 && width/height>=1.6 && width/height<=5;}
  const utils={normalize,allowed,match,dimensions};
  if(typeof module==='object' && module.exports){module.exports=utils;return;}
  const seed=new Map();let remote=[];
  const notify=()=>root.dispatchEvent(new Event('wt-banner-ready'));
  function lookup(item){
    const bundled=seed.get(item.id);
    if(bundled && normalize(bundled.originalTitle)===normalize(item.originalTitle))return {image:'/art/banners/'+bundled.file,imageSource:bundled.imageSource,source:bundled.source};
    const media=match(item,remote);
    return media?{image:media.bannerImage,imageSource:media.bannerImage,source:'https://anilist.co/anime/'+media.id}:null;
  }
  const ready=fetch('/art/banners/index.json').then(r=>{if(!r.ok)throw new Error('banner seed');return r.json();}).then(data=>{
    for(const row of data.items||[]){if(Number.isInteger(row.bgmId) && /^[a-f0-9]{24}\.(jpg|png)$/.test(row.file||'') && allowed(row.imageSource) && dimensions(row.width,row.height))seed.set(row.bgmId,row);}
    notify();
  }).catch(()=>{});
  async function refresh(force=false){
    const key='wt.banner.catalogue.v1';let cached;
    try{cached=JSON.parse(localStorage.getItem(key)||'null');if(Array.isArray(cached?.rows)){remote=cached.rows.slice(0,100);notify();if(!force && Date.now()-cached.at<24*3600000)return;}}catch(_){}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const fields='id type isAdult title { native romaji english } synonyms bannerImage';
      const query='query { '+[1,2].map(page=>`p${page}: Page(page:${page},perPage:50) { media(type:ANIME,isAdult:false,sort:TRENDING_DESC) { ${fields} } }`).join(' ')+' }';
      const response=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok)throw new Error('banner metadata');const data=await response.json();if(data.errors || !data.data)throw new Error('banner metadata');
      const rows=Object.values(data.data).flatMap(page=>page.media||[]).filter(row=>row.type==='ANIME'&&!row.isAdult&&allowed(row.bannerImage)).slice(0,100);
      if(rows.length){remote=rows;try{localStorage.setItem(key,JSON.stringify({at:Date.now(),rows}));}catch(_){}notify();}
    }catch(_){/* Keep bundled artwork and the last complete successful catalogue. */}finally{clearTimeout(timer);}
  }
  root.BannerArtwork={...utils,ready,lookup,refresh};
  ready.then(()=>refresh());
})(typeof window==='undefined'?globalThis:window);
