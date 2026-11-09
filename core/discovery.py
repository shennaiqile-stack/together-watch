"""Bangumi metadata and poster cache for the discovery UI, independent of playback."""
import concurrent.futures
import hashlib
import json
import os
import time
import threading
import urllib.parse

from core.home_art import HomeArt, image_size
from core.home_art import FILE_NAME

PAGE_SIZE = 48
INITIAL_SIZE = 240
TREND_API = 'https://next.bgm.tv/p1/trending/subjects?type=2&limit=48&offset='


def poster_url(value):
    try:
        parsed = urllib.parse.urlsplit(str(value or ''))
        if parsed.scheme != 'https' or parsed.hostname != 'lain.bgm.tv' or parsed.username or parsed.port not in (None, 443):
            return None
        return urllib.parse.urlunsplit(parsed)
    except ValueError:
        return None


class Discovery(HomeArt):
    refresh_seconds = 10 * 60
    retry_seconds = 60
    rank_page = 'https://bgm.tv'
    image_prefix = '/api/discovery/image/'
    headers = {'User-Agent': 'TogetherWatch/1.3.0 (desktop anime discovery)', 'Accept': 'application/json,image/*'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        seed = self._read(self.bundled_dir)
        if seed and seed.get('fetchedAt', 0) > self.manifest.get('fetchedAt', 0) and len(seed['items']) > len(self.manifest['items']):
            self.manifest = seed
        self.operation = ''
        self.last_error = ''
        self.progress_done = self.progress_total = 0
        self._poster_cache = {}
        self._image_attempts = {}

    def _read(self, directory):
        try:
            data=json.loads((directory/'index.json').read_text(encoding='utf-8'))
            items=[x for x in data['items'] if isinstance(x,dict) and FILE_NAME.fullmatch(x.get('file',''))
                   and x.get('source')=='https://bgm.tv/subject/'+str(x.get('id')) and poster_url(x.get('imageSource'))]
            return {**data,'items':items} if items else None
        except (OSError,ValueError,KeyError,TypeError):
            return None

    def image(self, file):
        path=super().image(file)
        if path or not FILE_NAME.fullmatch(file):return path
        with self.lock:
            if time.time()<self._image_attempts.get(file,0):return None
            item=next((x for x in self.manifest['items'] if x['file']==file),None)
            if not item:return None
            self._image_attempts[file]=time.time()+60
        try:
            data=self._get(item['imageSource'],3*1024*1024)
            width,height=image_size(data)
            if width<100 or height<150 or not .35<=width/height<=1:return None
            path=self.cache_dir/file
            temp=self.cache_dir/(file+'.tmp')
            temp.write_bytes(data);os.replace(temp,path)
            return path
        except Exception:return None

    def _poster(self, entry):
        try:
            subject = entry['subject']
            sid = int(subject['id'])
            if sid <= 0 or subject.get('nsfw') or subject.get('type', 2) != 2:
                return None
            images = subject.get('images') or {}
            # 400px posters cover desktop cards at 2x scale without decoding 4K originals.
            url = poster_url(images.get('common') or images.get('large'))
            if not url:
                return None
            cached = self._poster_cache.get(url)
            # Metadata refresh is independent of image CDN availability. Posters are
            # loaded on demand and then retained on this device for offline browsing.
            path = super().image(cached['file']) if cached else None
            width,height=(cached.get('width',0),cached.get('height',0)) if cached else (0,0)
            file = cached['file'] if cached else hashlib.sha256(url.encode()).hexdigest()[:24]+'.jpg'
            rating = subject.get('rating') or {}
            score = max(0, min(10, float(rating.get('score') or 0)))
            return {'id': sid, 'title': str(subject.get('nameCN') or subject.get('name_cn') or subject.get('name') or '')[:120],
                    'originalTitle': str(subject.get('name') or '')[:120], 'rank': entry['rank'],
                    'score': round(score, 1), 'votes': max(0, int(rating.get('total') or 0)),
                    'info': str(subject.get('info') or '')[:500],
                    'tags': [str(tag)[:30] for tag in (subject.get('metaTags') or [])[:6]],
                    'file': file, 'imageSource': url, 'source': 'https://bgm.tv/subject/' + str(sid),
                    'width': width, 'height': height}
        except Exception:
            return None

    def refresh(self, target=None, append=False):
        try:
            with self.lock:
                previous = self.manifest
                self.operation = 'more' if append else 'refresh'
                self.last_error = ''
                self.progress_done = self.progress_total = 0
            self._poster_cache = {x.get('imageSource'):x for x in previous['items']}
            start = int(previous.get('nextOffset', len(previous['items']))) if append else 0
            target = start + PAGE_SIZE if append else max(INITIAL_SIZE, int(target or previous.get('nextOffset', 0)))
            rows, cursor, total = [], start, None
            while cursor < target:
                page = json.loads(self._get(TREND_API + str(cursor), 4 * 1024 * 1024))
                batch = page.get('data') or []
                total = max(0, int(page.get('total', cursor + len(batch))))
                if not batch:
                    if cursor == 0:
                        raise ValueError('Empty discovery response')
                    total = min(total, cursor)
                    break
                rows.extend({**row, 'rank':cursor+i+1} for i,row in enumerate(batch))
                cursor += len(batch)
                if cursor >= total:
                    break
            entries, ids = [], set()
            for entry in rows:
                sid = (entry.get('subject') or {}).get('id')
                if sid in ids:
                    continue
                ids.add(sid)
                entries.append(entry)
            with self.lock:
                self.progress_total = len(entries)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                fresh = []
                old_by_id = {x['id']:x for x in previous['items']}
                for entry,item in zip(entries,pool.map(self._poster, entries)):
                    if item:
                        fresh.append(item)
                    elif (entry.get('subject') or {}).get('id') in old_by_id:
                        fresh.append({**old_by_id[entry['subject']['id']], 'rank':entry['rank']})
                    with self.lock:
                        self.progress_done += 1
            items = previous['items'] + fresh if append else fresh
            unique = {}
            for item in items:
                unique[item['id']] = item
            items = sorted(unique.values(), key=lambda x:x['rank'])
            if not items:
                raise ValueError('No discovery posters available')
            now = int(time.time())
            result = {'schema':2,'fetchedAt':now,'checkedAt':previous.get('checkedAt',now) if append else now,
                      'revision':str(time.time_ns()),'nextOffset':cursor,'total':total or cursor,
                      'hasMore':cursor < (total or cursor),'source':self.rank_page,'api':TREND_API,'items':items}
            temporary = self.cache_dir / 'index.json.tmp'
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, self.cache_dir / 'index.json')
            with self.lock:
                self.manifest = result
            return result
        except Exception:
            with self.lock:
                self.last_error = '更新失败，已保留本机番剧列表，请稍后重试。'
            raise
        finally:
            with self.lock:
                self.refreshing = False

    def request_update(self, action='refresh'):
        with self.lock:
            if self.refreshing:
                return False
            if action == 'more' and self.manifest.get('hasMore') is False:
                return False
            self.refreshing = True
            self.operation = action
            self.last_error = ''
            self.next_attempt = time.time() + self.retry_seconds
        def work():
            try:
                self.refresh(append=action == 'more')
            except Exception:
                pass
        threading.Thread(target=work,name='discovery-update',daemon=True).start()
        return True

    def snapshot(self):
        with self.lock:
            stale = time.time() - self.manifest.get('checkedAt',self.manifest.get('fetchedAt',0)) >= self.refresh_seconds
            auto = stale and not self.refreshing and time.time() >= self.next_attempt
        if auto:
            self.request_update()
        with self.lock:
            data = self.manifest
            return {**{k:v for k,v in data.items() if k != 'items'},'ok':True,'refreshing':self.refreshing,
                    'operation':self.operation,'error':self.last_error,'progressDone':self.progress_done,
                    'progressTotal':self.progress_total,'hasMore':data.get('hasMore',True),
                    'nextOffset':data.get('nextOffset',len(data['items'])),
                    'items':[{**item,'image':self.image_prefix+item['file']} for item in data['items']]}
