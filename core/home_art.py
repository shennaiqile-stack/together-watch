"""Public bangumi ranking artwork, refreshed in the background and cached on disk."""
import concurrent.futures
import hashlib
import html
import json
import os
from pathlib import Path
import re
import ssl
import struct
import threading
import time
import urllib.parse
import urllib.request

RANK_API = 'https://api.bilibili.com/pgc/web/rank/list?day=3&season_type=1'
RANK_PAGE = 'https://www.bilibili.com/v/popular/rank/bangumi'
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/'}
FILE_NAME = re.compile(r'^[a-f0-9]{24}\.(?:jpg|png)$')


def image_size(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        return struct.unpack('>II', data[16:24])
    if data[:2] == b'\xff\xd8':
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 255:
                break
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(data):
                break
            size = int.from_bytes(data[offset:offset+2], 'big')
            if size < 2 or offset + size > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2) and size >= 7:
                height, width = struct.unpack('>HH', data[offset+3:offset+7])
                return width, height
            offset += size
    return 0, 0


def image_url(url):
    url = str(url or '').strip()
    if url.startswith('//'):
        url = 'https:' + url
    try:
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or '').lower()
        valid = parsed.scheme in ('https', 'http') and host.endswith('.hdslb.com') and not parsed.username and parsed.port in (None, 80, 443)
    except ValueError:
        return None
    if not valid:
        return None
    return urllib.parse.urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, ''))


class HomeArt:
    refresh_seconds = 12 * 3600
    retry_seconds = 30 * 60
    rank_page = RANK_PAGE
    image_prefix = '/api/home-art/image/'
    headers = HEADERS

    def __init__(self, cache_dir, bundled_dir, context=None):
        self.cache_dir, self.bundled_dir = Path(cache_dir), Path(bundled_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.context = context or ssl.create_default_context()
        self.lock = threading.Lock()
        self.refreshing = False
        self.next_attempt = 0
        self.manifest = self._read(self.cache_dir) or self._read(self.bundled_dir) or {'items': [], 'fetchedAt': 0}

    def _read(self, directory):
        try:
            data = json.loads((directory / 'index.json').read_text(encoding='utf-8'))
            items = [item for item in data['items'] if isinstance(item, dict) and FILE_NAME.fullmatch(item.get('file', ''))
                     and (directory / item['file']).is_file()]
            if items:
                return {**data, 'items': items}
        except (OSError, ValueError, TypeError, KeyError):
            pass
        return None

    def _get(self, url, limit):
        request = urllib.request.Request(url, headers=self.headers)
        with urllib.request.urlopen(request, context=self.context, timeout=7) as response:
            data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Artwork response too large')
        return data

    def _json(self, url):
        data = json.loads(self._get(url, 4 * 1024 * 1024))
        if data.get('code') != 0:
            raise ValueError('Bangumi source unavailable')
        return data.get('result') or data.get('data') or {}

    def _artwork(self, entry):
        try:
            sid = int(entry['season_id'])
            title = html.unescape(str(entry.get('title') or '')).strip()[:100]
            season = self._json('https://api.bilibili.com/pgc/view/web/season?season_id=' + str(sid))
            candidates = [(season.get('bkg_cover'), 'background'),
                          ((season.get('activity') or {}).get('head_bg_url'), 'background')]
            episodes = season.get('episodes') or []
            candidates += [(ep.get('cover'), 'episode') for ep in episodes[:2]]
            for raw_url, kind in candidates:
                url = image_url(raw_url)
                if not url:
                    continue
                try:
                    image = self._get(url, 4 * 1024 * 1024)
                    width, height = image_size(image)
                    if width < 640 or height < 320 or not 1.4 <= width / max(height, 1) <= 5:
                        continue
                    ext = '.png' if image.startswith(b'\x89PNG') else '.jpg'
                    file = hashlib.sha256(image).hexdigest()[:24] + ext
                    temporary = self.cache_dir / (file + '.tmp')
                    temporary.write_bytes(image)
                    os.replace(temporary, self.cache_dir / file)
                    return {'seasonId': sid, 'title': title, 'rank': entry['rank'], 'file': file,
                            'imageSource': url, 'source': 'https://www.bilibili.com/bangumi/play/ss' + str(sid),
                            'kind': kind, 'width': width, 'height': height}
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def refresh(self):
        try:
            listing = self._json(RANK_API).get('list') or []
            selected, titles = [], set()
            for rank, entry in enumerate(listing, 1):
                title = re.sub(r'（.*?）|\(.*?\)|\s+', '', str(entry.get('title') or ''))
                if not title or title in titles or not str(entry.get('season_id', '')).isdigit():
                    continue
                titles.add(title)
                selected.append({**entry, 'rank': rank})
                if len(selected) == 10:
                    break
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                items = [item for item in pool.map(self._artwork, selected) if item]
            if not items:
                raise ValueError('No landscape artwork returned')
            data = {'fetchedAt': int(time.time()), 'rankSource': RANK_PAGE, 'rankApi': RANK_API, 'items': items}
            temporary = self.cache_dir / 'index.json.tmp'
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, self.cache_dir / 'index.json')
            with self.lock:
                self.manifest = data
            return data
        finally:
            with self.lock:
                self.refreshing = False

    def _background_refresh(self):
        try:
            self.refresh()
        except Exception:
            pass  # Keep the complete previous snapshot on source or network failure.

    def snapshot(self):
        with self.lock:
            data = self.manifest
            if not self.refreshing and time.time() >= self.next_attempt and time.time() - data.get('fetchedAt', 0) >= self.refresh_seconds:
                self.refreshing = True
                self.next_attempt = time.time() + self.retry_seconds
                threading.Thread(target=self._background_refresh, name='home-art', daemon=True).start()
            return {'ok': True, 'fetchedAt': data.get('fetchedAt', 0), 'source': self.rank_page,
                    'refreshing': self.refreshing,
                    'items': [{**item, 'image': self.image_prefix + item['file']} for item in data['items']]}

    def image(self, file):
        if not FILE_NAME.fullmatch(file):
            return None
        for directory in (self.cache_dir, self.bundled_dir):
            path = directory / file
            if path.is_file():
                return path
        return None
