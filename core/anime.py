"""Three bounded public-source adapters, based on KazumiRules' published locations.
No source scripts are executed. Room messages contain stable episode identities.
"""
import base64
import html
from html.parser import HTMLParser
import ipaddress
import json
import re
import socket
import threading
import time
import urllib.parse as U
import urllib.request as R

SOURCES = {'giri':('giriGiriLove','https://ani.girigirilove.com'),
           'mxdm':('MX 动漫','https://www.dcc3.com'),
           'ezdmw':('e站弹幕网','https://m.ezdmw.org')}
MEDIA_HOSTS = ('girigirilove.com','play-cdn19.com','ezdmw.com','wdbed.vip','danmuzf.vip','jxdunrui.top','7sefun.top','baimaodm.com','akianime.cc','lmm85.com','rrcdnbf5.com')
PAGE_HOSTS = ('girigirilove.com','dcc3.com','ezdmw.org','ezdmw.com','danmuzf.vip')


def allowed(url, hosts=MEDIA_HOSTS):
    p=U.urlsplit(url)
    if p.scheme not in ('https','http') or p.username or p.port not in (None,80,443) or not any(p.hostname==h or (p.hostname or '').endswith('.'+h) for h in hosts):
        raise ValueError('该片源的媒体域名尚未验证，请切换片源')
    return U.quote(url,safe=':/?=&%+@,;$')


def public(url):
    p=U.urlsplit(url)
    if p.scheme not in ('https','http') or p.username or p.port not in (None,80,443):raise ValueError('媒体地址无效')
    addresses=socket.getaddrinfo(p.hostname,p.port or (443 if p.scheme=='https' else 80),type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):raise ValueError('媒体地址不是公网地址')
    return url


class SafeRedirect(R.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def open_public(url, headers, context):
    url=U.quote(url,safe=':/?=&%+@,;$')
    public(url)
    return R.build_opener(SafeRedirect(),R.HTTPSHandler(context=context)).open(R.Request(url,headers=headers),timeout=15)


def referer(url):
    host=U.urlsplit(url).hostname or ''
    if 'girigirilove.com' in host:return SOURCES['giri'][1]+'/'
    if 'play-cdn19.com' in host:return SOURCES['mxdm'][1]+'/'
    if any(x in host for x in ('7sefun.top','jxdunrui.top')):return 'https://www.7sefun.top/'
    if 'baimaodm.com' in host:return 'https://www.baimaodm.com/'
    if 'akianime.cc' in host or 'rrcdnbf5.com' in host:return 'https://www.akianime.cc/'
    if 'lmm85.com' in host:return 'https://www.lmm85.com/'
    return 'https://player.ezdmw.com/'


def pack(url):return base64.urlsafe_b64encode(url.encode()).decode().rstrip('=')
def unpack(value):return base64.urlsafe_b64decode(value+'='*(-len(value)%4)).decode()
def media_route(url):return '/anime-media?u='+pack(allowed(url))


def unwrap_segment(data):
    """Some public HLS CDNs prefix TS packets with an image header."""
    if data.startswith((b'\x89PNG',b'\xff\xd8',b'GIF8')):
        for offset in range(min(len(data)-376,65536)):
            if data[offset]==data[offset+188]==data[offset+376]==0x47:
                return data[offset:]
    return data


class Links(HTMLParser):
    def __init__(self,text):
        super().__init__();self.links=[];self.active=None;self.heading=0;self.feed(text)
    def handle_starttag(self,tag,attrs):
        if tag=='h3':self.heading+=1
        if tag=='a':self.active={**dict(attrs),'text':'','heading':self.heading}
        if tag=='img' and self.active and not self.active['text']:self.active['text']=dict(attrs).get('alt','')
    def handle_endtag(self,tag):
        if tag=='a' and self.active:self.links.append(self.active);self.active=None
        if tag=='h3':self.heading=max(0,self.heading-1)
    def handle_data(self,text):
        if self.active:self.active['text']+=text


class Anime:
    def __init__(self,context):self.context=context;self.cache={};self.lock=threading.Lock()
    def get(self,url):
        allowed(url,PAGE_HOSTS)
        url=U.quote(url,safe=':/?=&%+@,;$')
        with open_public(url,{'User-Agent':'Mozilla/5.0','Referer':referer(url)},self.context) as response:data=response.read(4*1024*1024+1)
        if len(data)>4*1024*1024:raise ValueError('片源响应过大')
        return data.decode('utf-8','replace')
    def search(self,provider,keyword):
        if provider not in SOURCES:raise ValueError('片源不存在')
        q=U.quote(keyword[:100]);base=SOURCES[provider][1]
        if provider=='giri':
            rows=json.loads(self.get('https://m3u8.girigirilove.com/api.php/Vod/get_list?vod_name='+q+'&offset=0&limit=24')).get('info',{}).get('rows',[])
            return [{'id':str(x['vod_id']),'title':x['vod_name'],'provider':provider} for x in rows[:24]]
        text=self.get(base+('/search/?wd='+q if provider=='mxdm' else '/Index/search.html?searchText='+q))
        results={}
        for link in Links(text).links:
            href=link.get('href','');pattern=r'/detail/(\d+)/' if provider=='mxdm' else r'/Index/bangumi/(\d+)\.html'
            m=re.fullmatch(pattern,href)
            if not m or provider=='mxdm' and not link['heading']:continue
            title=(link.get('title') or link.get('text') or '').strip()
            if title:results[m[1]]={'id':m[1],'title':title[:160],'provider':provider}
        if provider=='ezdmw':
            for match in re.finditer(r'<a\b[^>]*href=[\"\']/Index/bangumi/(\d+)\.html[\"\'][^>]*>.*?</a>\s*<p\b[^>]*>(.*?)</p>',text,re.S|re.I):
                caption=re.sub(r'<!--.*?-->','',match[2],flags=re.S)
                title=html.unescape(re.sub(r'<[^>]+>','',caption)).strip()
                if title:results[match[1]]={'id':match[1],'title':title[:160],'provider':provider}
        return list(results.values())[:48]
    def details(self,provider,series):
        if provider not in SOURCES or not re.fullmatch(r'\d{1,10}',str(series)):raise ValueError('番剧编号无效')
        key=(provider,str(series))
        with self.lock:cached=self.cache.get(key)
        if cached and time.time()-cached[0]<600:return cached[1]
        roads={};title='番剧';base=SOURCES[provider][1]
        if provider=='giri':
            info=json.loads(self.get('https://m3u8.girigirilove.com/api.php/Vod/get_detail?vod_id='+series))['info'];title=info.get('vod_name') or title
            names=info.get('vod_play_from','').split('$$$')
            for road,group in enumerate(info.get('vod_play_url','').split('$$$'),1):
                episodes=[]
                for index,entry in enumerate(group.split('#'),1):
                    if '$' not in entry:continue
                    name,url=entry.split('$',1)
                    episodes.append({'name':name,'url':url,'index':index})
                if episodes:roads[road]={'name':names[road-1] if road<=len(names) else '线路'+str(road),'episodes':episodes}
        else:
            page=base+('/detail/'+series+'/' if provider=='mxdm' else '/Index/bangumi/'+series+'.html')
            text=self.get(page);match=re.search(r'<title>(.*?)</title>',text,re.S)
            if match:title=html.unescape(match[1]).split('在线播放')[0].split(' - ')[0].strip()[:160]
            seen=set()
            for link in Links(text).links:
                href=link.get('href','')
                if provider=='mxdm':
                    m=re.fullmatch('/play/'+series+r'-(\d+)-(\d+)/',href)
                    if not m:continue
                    road,index=map(int,m.groups())
                else:
                    road_match=re.search(r'circuit_switch(\d+)',link.get('class',''))
                    m=re.fullmatch(r'/Index/video/(\d+)\.html',href)
                    if not road_match or not m:continue
                    road=int(road_match[1]);index=int(m[1])
                if (road,index) in seen:continue
                seen.add((road,index));roads.setdefault(road,{'name':'线路 '+str(road),'episodes':[]})['episodes'].append({'name':link['text'].strip() or str(index),'url':U.urljoin(base,href),'index':index})
        if not roads:raise ValueError('该片源暂无可用剧集，请切换片源')
        out={'provider':provider,'series':series,'title':title,'roads':[]}
        for road,data in roads.items():
            for episode in data['episodes']:episode['target']='anime:%s:%s:%s:%s'%(provider,series,road,episode['index'])
            out['roads'].append({**data,'id':road})
        with self.lock:self.cache[key]=(time.time(),out)
        return out
    def video(self,target):
        m=re.fullmatch(r'anime:(giri|mxdm|ezdmw):(\d{1,10}):(\d{1,6}):(\d{1,10})',target)
        if not m:raise ValueError('剧集编号无效')
        provider,series,road,index=m.groups();details=self.details(provider,series)
        group=next((x for x in details['roads'] if x['id']==int(road)),None)
        episode=next((x for x in group['episodes'] if x['index']==int(index)),None) if group else None
        if not episode:raise ValueError('剧集已变更，请重新选集')
        url=episode['url'];mode='mp4'
        if provider=='mxdm':
            text=self.get(url);match=re.search(r"\burl\s*:\s*['\"](https?[^'\"]+)['\"]",text)
            if not match:raise ValueError('播放线路暂时不可用，请切换片源')
            url=html.unescape(match[1]);mode='hls' if '.m3u8' in url else 'mp4'
        elif provider=='ezdmw':
            text=self.get(url);match=re.search(r'var danmuPlayer1\s*=\s*"([^"]+)"',text)
            if not match:raise ValueError('此线路暂不可用，请切换片源')
            text=self.get(html.unescape(match[1]));match=re.search(r'<video[^>]+src="([^"]+)"',text)
            if not match:raise ValueError('此线路暂不可用，请切换片源')
            url=U.urljoin('https://player.ezdmw.com/',html.unescape(match[1]));mode='hls'
        title=details['title']+' · '+episode['name']
        info={'title':title,'owner':SOURCES[provider][0],'provider':provider,'is_anime':True,'duration':0,'episodes':
              [{'title':x['name'],'target':x['target']} for x in group['episodes']], 'roads':
              [{'title':r['name'],'target':r['episodes'][0]['target']} for r in details['roads']]}
        return {'ok':True,'info':info,'target':target,'cid':'','page':1,'qn':80,'qualities':[],
                'source':{'mode':mode,'url':media_route(url)}}
