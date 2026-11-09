"""Cache real AniList landscape banners matched to the Bangumi catalogue by exact titles."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.home_art import image_size

def normalize(value):
    return ''.join(c for c in unicodedata.normalize('NFKC',value or '').casefold() if c.isalnum())

def main():
    target=ROOT/'web/art/banners';target.mkdir(parents=True,exist_ok=True)
    catalogue=json.loads((ROOT/'web/art/discovery/index.json').read_text(encoding='utf-8'))['items']
    fields='id type isAdult title { native romaji english } synonyms bannerImage siteUrl'
    query='query { '+ ' '.join('p%d: Page(page:%d,perPage:50) { media(type:ANIME,isAdult:false,sort:TRENDING_DESC) { %s } }'%(page,page,fields) for page in (1,2))+' }'
    request=urllib.request.Request('https://graphql.anilist.co',data=json.dumps({'query':query}).encode(),headers={'Content-Type':'application/json','User-Agent':'TogetherWatch/1.6.5'})
    with urllib.request.urlopen(request,timeout=25) as response:data=json.load(response)
    media=[row for page in data['data'].values() for row in page['media']]
    def fetch(row):
        if row.get('isAdult') or row.get('type')!='ANIME':return None
        names={normalize(t) for t in [*row['title'].values(),*row.get('synonyms',[])] if t}
        matches=[item for item in catalogue if {normalize(item['title']),normalize(item['originalTitle'])}&names]
        if len(matches)!=1:return None
        url=row.get('bannerImage') or '';parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!='https' or parsed.hostname not in ('s4.anilist.co','s5.anilist.co') or not parsed.path.startswith('/file/anilistcdn/media/anime/banner/'):return None
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'TogetherWatch/1.6.5'}),timeout=15) as response:image=response.read(4*1024*1024+1)
            width,height=image_size(image)
            if len(image)>4*1024*1024 or width<960 or height<240 or not 1.6<=width/max(height,1)<=5:return None
            name=hashlib.sha256(image).hexdigest()[:24]+('.png' if image.startswith(b'\x89PNG') else '.jpg')
            (target/name).write_bytes(image)
            item=matches[0]
            return {'bgmId':item['id'],'title':item['title'],'originalTitle':item['originalTitle'],'anilistId':row['id'],'file':name,'width':width,'height':height,'imageSource':url,'source':'https://anilist.co/anime/'+str(row['id'])}
        except (OSError,ValueError):return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=[row for row in pool.map(fetch,media) if row]
    rows=list({row['bgmId']:row for row in rows}.values())
    if not rows:raise RuntimeError('No verified banners; previous snapshot retained')
    manifest={'schema':1,'fetchedAt':int(time.time()),'source':'https://anilist.co','items':rows}
    (target/'index.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Cached verified landscape banners:',len(rows))
    for row in rows:print(row['title'],str(row['width'])+'x'+str(row['height']))

if __name__=='__main__':main()
