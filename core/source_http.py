"""Bounded, local-only HTTP access for the shared on-device source engine."""
import urllib.parse
from core.anime import allowed, open_public, referer, unwrap_segment

HOSTS=('girigirilove.com','dcc3.com','ezdmw.org','ezdmw.com','wdbed.vip','danmuzf.vip',
       'play-cdn19.com','7sefun.top','baimaodm.com','akianime.cc','lmm85.com','jxdunrui.top',
       'rrcdnbf5.com','raw.githubusercontent.com')
MEDIA_HOSTS=HOSTS[:-1]

def request(url,context,probe=False):
    url=allowed(url,HOSTS)
    parsed=urllib.parse.urlsplit(url)
    if parsed.hostname=='raw.githubusercontent.com' and not parsed.path.startswith('/Predidit/KazumiRules/main/'):
        raise ValueError('只支持已登记的源规则仓库')
    headers={'User-Agent':'Mozilla/5.0','Referer':referer(url),'Accept-Encoding':'identity'}
    if probe:headers['Range']='bytes=0-65535'
    with open_public(url,headers,context) as response:
        limit=65536 if probe else 4*1024*1024
        data=response.read(limit+(0 if probe else 1))
        if len(data)>limit:raise ValueError('片源响应过大')
        clean=unwrap_segment(data)
        kind='hls' if data.lstrip().startswith(b'#EXTM3U') else 'mp4' if len(clean)>8 and clean[4:8]==b'ftyp' else 'ts' if len(clean)>376 and clean[0]==clean[188]==clean[376]==71 else 'webm' if clean.startswith(b'\x1aE\xdf\xa3') else 'unknown'
        return {'ok':True,'status':response.status,'kind':kind,'bytes':len(data),
                'body':data.decode('utf-8-sig','replace') if not probe or kind=='hls' else ''}
