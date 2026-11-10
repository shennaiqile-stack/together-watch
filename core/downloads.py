"""Explicit, device-local downloads. Completed bundles are never cache-evicted."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
import urllib.parse
from core.anime import unwrap_segment


class Downloads:
    def __init__(self, directory, resolve, opener, log=None):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.resolve, self.opener = resolve, opener
        self.log = log or (lambda _message: None)
        self.lock = threading.RLock()
        self.jobs, self.cancelled = {}, set()
        self.gate = threading.Semaphore(1)
        for path in self.root.glob('*/index.json'):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
                if job['id'] != path.parent.name or not re.fullmatch('[a-f0-9]{32}', job['id']):
                    continue
                if job['status'] != 'complete':
                    job.update(status='interrupted', error='下载已中断，可重新下载')
                elif not self._valid(job):
                    job.update(status='error', error='本机文件不完整，请重新下载')
                self.jobs[job['id']] = job
            except (OSError, ValueError, KeyError):
                pass

    def _valid(self, job):
        files = job.get('files') or {}
        return bool(files) and all(re.fullmatch('[a-f0-9]{24}\\.(?:mp4|m3u8|bin|key|ts)', name)
                                  and (self.root/job['id']/name).is_file()
                                  and (self.root/job['id']/name).stat().st_size == size
                                  for name, size in files.items())

    def _save(self, job):
        directory = self.root/job['id']
        directory.mkdir(exist_ok=True)
        temp = directory/'index.json.tmp'
        temp.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        os.replace(temp, directory/'index.json')

    def snapshot(self):
        with self.lock:
            return {'ok': True, 'items': [self._public(j) for j in sorted(self.jobs.values(), key=lambda x:x['createdAt'], reverse=True)]}

    def _public(self, job):
        return {k:copy.deepcopy(v) for k,v in job.items() if k not in ('files', 'request')}

    def start(self, request):
        content = str(request.get('content') or '')[:500]
        if not content or not isinstance(request.get('source'), dict):
            raise ValueError('请先载入需要下载的视频')
        # The content key is independent of expiring CDN URLs and local paths.
        key = hashlib.sha256((content+'|'+str(request.get('qn',80))).encode()).hexdigest()[:32]
        source = request['source']
        slots = ('video','audio') if source.get('mode') == 'dash' else ('url',)
        for slot in slots:
            self.resolve(source.get(slot,''))  # Validate before creating a job.
        with self.lock:
            old = self.jobs.get(key)
            if old and (old['status'] in ('queued','downloading') or old['status'] == 'complete' and self._valid(old)):
                return self._public(old)
            self.cancelled.discard(key)
            job = {'id':key,'content':content,'title':str(request.get('title') or '未命名视频')[:300],
                   'qn':request.get('qn',80),'createdAt':int(time.time()),'status':'queued','have':0,'size':0,
                   'error':'','files':{},'info':request.get('info') or {},'target':request.get('target',''),
                   'page':request.get('page',1),'cid':request.get('cid',''),'request':copy.deepcopy(request)}
            self.jobs[key] = job
            self._save(job)
        threading.Thread(target=self._work,args=(job,),name='video-download',daemon=True).start()
        return self._public(job)

    def cancel(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if job and job['status'] in ('queued','downloading'):
                self.cancelled.add(key)
        return self.snapshot()

    def remove(self, key):
        """删除任务；正在下载的先取消，等后台线程收尾后再清理已落地的文件。"""
        with self.lock:
            job = self.jobs.get(key)
            if not job:
                return self.snapshot()
            active = job['status'] in ('queued', 'downloading')
            self.cancelled.add(key)
            if not active:
                self.jobs.pop(key, None)
        if active:
            threading.Thread(target=self._purge_after, args=(key,), name='download-remove', daemon=True).start()
        else:
            self._purge(key)
        return self.snapshot()

    def _purge_after(self, key):
        deadline = time.time() + 60
        while time.time() < deadline:
            with self.lock:
                job = self.jobs.get(key)
                if not job or job['status'] not in ('queued', 'downloading'):
                    self.jobs.pop(key, None)
                    break
            time.sleep(0.2)
        self._purge(key)

    def _purge(self, key):
        directory = self.root/key
        for path in directory.glob('*'):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            directory.rmdir()
        except OSError:
            pass

    def find(self, content, qn=None):
        with self.lock:
            choices = [j for j in self.jobs.values() if j['content']==content and j['status']=='complete'
                       and (qn is None or str(j['qn'])==str(qn)) and self._valid(j)]
            return self._public(choices[0]) if choices else None

    def file(self, key, name):
        with self.lock:
            job = self.jobs.get(key)
            if not job or job['status'] != 'complete' or name not in job.get('files',{}):
                return None
            path = self.root/key/name
            return path if path.is_file() and path.stat().st_size == job['files'][name] else None

    def _check(self, job):
        if job['id'] in self.cancelled:
            raise InterruptedError('下载已取消')

    def _work(self, job):
        with self.gate:
            try:
                self._check(job)
                with self.lock: job['status']='downloading'
                request, seen = job['request'], {}
                source = request['source']
                local = {'mode': source.get('mode','mp4')}
                for slot in ('video','audio') if local['mode']=='dash' else ('url',):
                    url, headers = self.resolve(source[slot])
                    playlist = local['mode']=='hls' or urllib.parse.urlsplit(url).path.lower().endswith('.m3u8')
                    name = self._asset(job,url,headers,seen,playlist)
                    local[slot] = '/api/downloads/file/'+job['id']+'/'+name
                with self.lock:
                    job.update(source=local, status='complete', size=job['have'],error='')
                    self._save(job)
            except Exception as e:
                self.log('[downloads] %s 失败：%r' % (job.get('title'), e))
                with self.lock:
                    job.update(status='cancelled' if isinstance(e,InterruptedError) else 'error',
                               error='下载已取消' if isinstance(e,InterruptedError) else '下载未完成，请检查网络后重试')
                    self._save(job)

    def _asset(self, job, url, headers, seen, playlist=False, depth=0):
        self._check(job)
        if depth > 5 or len(seen)>20000:
            raise ValueError('播放清单过大')
        if url in seen:
            return seen[url]
        ext = '.m3u8' if playlist else '.mp4' if '.mp4' in urllib.parse.urlsplit(url).path.lower() else '.bin'
        name = hashlib.sha256(url.encode()).hexdigest()[:24]+ext
        seen[url] = name
        path = self.root/job['id']/name
        temp = path.with_suffix(path.suffix+'.part')
        with self.opener(url, headers) as response:
            expected = int(response.headers.get('Content-Length') or 0)
            if response.status == 206:
                # 部分片源 CDN 即使没请求 Range 也返回 206，用 Content-Range 换算总长
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if match and int(match.group(1)) != 0:
                    raise IOError('下载源返回了不完整的分段')
                if match:
                    expected = int(match.group(3))
            elif response.status != 200:
                raise IOError('下载源未返回完整文件')
            if playlist:
                data = response.read(4*1024*1024+1)
                if len(data)>4*1024*1024 or not data.lstrip().startswith(b'#EXTM3U'):
                    raise ValueError('无效的播放清单')
            else:
                with self.lock: job['size'] += expected
                count = 0
                with temp.open('wb') as out:
                    while True:
                        self._check(job)
                        data = response.read(256*1024)
                        if not data: break
                        out.write(unwrap_segment(data) if count==0 else data)
                        count += len(data)
                        with self.lock: job['have'] += len(data)
                if not count or expected and count != expected:
                    raise IOError('文件不完整')
        if playlist:
            text = data.decode('utf-8-sig')
            # Persist a single highest bandwidth variant and its optional audio group.
            lines = text.splitlines()
            variants = []
            for i,line in enumerate(lines[:-1]):
                if line.startswith('#EXT-X-STREAM-INF:'):
                    bw = re.search(r'BANDWIDTH=(\d+)',line)
                    variants.append((int(bw[1]) if bw else 0,i))
            if variants:
                index = max(variants)[1]
                group = re.search(r'AUDIO="([^"]+)"',lines[index])
                keep = [line for line in lines if line.startswith('#EXT-X-MEDIA:') and group and 'GROUP-ID="'+group[1]+'"' in line]
                lines = ['#EXTM3U']+keep+[lines[index],lines[index+1]]
            elif '#EXT-X-ENDLIST' not in text:
                raise ValueError('直播流不能完整下载')
            result=[]
            for line in lines:
                self._check(job)
                if line.startswith('#EXT-X-KEY:') and not re.search(r'METHOD=(NONE|AES-128)(?:,|$)',line):
                    raise ValueError('此加密格式不支持下载')
                def child(raw):
                    target=urllib.parse.urljoin(url,raw)
                    # The resolver validates every host, including nested playlists and keys.
                    target, child_headers=self.resolve(target)
                    return self._asset(job,target,child_headers,seen,'.m3u8' in urllib.parse.urlsplit(target).path.lower(),depth+1)
                if line and not line.startswith('#'):
                    line=child(line.strip())
                elif 'URI="' in line:
                    line=re.sub(r'URI="([^"]+)"',lambda m:'URI="'+child(m[1])+'"',line)
                result.append(line)
            temp.write_text('\n'.join(result)+'\n',encoding='utf-8')
        os.replace(temp,path)
        with self.lock: job['files'][name]=path.stat().st_size
        return name
