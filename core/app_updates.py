"""Local-only, verified release downloads and Windows replacement handoff."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import urllib.parse
import urllib.request

REPOSITORY = 'https://github.com/shennaiqile-stack/together-watch/releases/download/'
REDIRECT_HOSTS = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}


def valid_url(url, initial=True):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in REDIRECT_HOSTS or parsed.username or parsed.password or parsed.port is not None:
        raise ValueError('更新地址无效')
    if initial and (not url.startswith(REPOSITORY) or parsed.query or parsed.fragment
                    or not re.fullmatch(r'/shennaiqile-stack/together-watch/releases/download/[^/]+/TogetherWatch-Windows-v\d+(?:\.\d+){1,3}\.exe', parsed.path)):
        raise ValueError('更新地址必须来自本项目的正式安装包')
    return url


class TrustedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        valid_url(newurl, False)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class AppUpdates:
    def __init__(self, directory, current_version=None):
        self.directory = Path(directory) / 'updates'
        self.lock = threading.RLock()
        self.state = {'stage': 'idle', 'downloaded': 0, 'total': 0, 'error': ''}
        self.asset = None
        self.current_version = current_version

    def snapshot(self):
        with self.lock:
            return {'ok': True, **self.state}

    def start(self, descriptor):
        url = valid_url(str(descriptor.get('url', '')))
        if self.current_version:
            candidate=re.search(r'Windows-v(\d+(?:\.\d+){1,3})\.exe$',url).group(1)
            parts=lambda value:tuple((list(map(int,value.split('.')))+[0]*4)[:4])
            if parts(candidate)<=parts(self.current_version):raise ValueError('安装包版本不高于当前版本')
        digest = str(descriptor.get('sha256', '')).lower().removeprefix('sha256:')
        size = descriptor.get('size')
        if not re.fullmatch('[0-9a-f]{64}', digest) or not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 300 * 1024 * 1024:
            raise ValueError('更新文件缺少有效的大小或 SHA256 校验信息')
        with self.lock:
            if self.state['stage'] in ('downloading', 'installing'):
                return self.snapshot()
            self.asset = {'url': url, 'sha256': digest, 'size': size}
            self.state = {'stage': 'downloading', 'downloaded': 0, 'total': size, 'error': ''}
            threading.Thread(target=self._download, args=(dict(self.asset),), daemon=True).start()
        return self.snapshot()

    def _download(self, asset):
        partial = self.directory / 'package.part'
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            downloaded = 0
            opener = urllib.request.build_opener(TrustedRedirect())
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'TogetherWatch-Updater', 'Accept-Encoding': 'identity'})
            with opener.open(request, timeout=30) as response, partial.open('wb') as output:
                if response.status != 200:
                    raise ValueError('更新下载失败：HTTP %s' % response.status)
                while True:
                    block = response.read(256 * 1024)
                    if not block:
                        break
                    downloaded += len(block)
                    if downloaded > asset['size']:
                        raise ValueError('更新文件大小异常')
                    output.write(block)
                    digest.update(block)
                    with self.lock:
                        self.state['downloaded'] = downloaded
            if downloaded != asset['size'] or digest.hexdigest() != asset['sha256']:
                raise ValueError('更新文件校验失败，请重新下载')
            destination = self.directory / 'TogetherWatch-update.exe'
            os.replace(partial, destination)
            with self.lock:
                self.state['stage'] = 'ready'
        except Exception as error:
            try:partial.unlink(missing_ok=True)
            except OSError:pass
            with self.lock:
                self.state.update(stage='error', error=str(error))

    def install(self):
        with self.lock:
            if self.state['stage'] != 'ready' or not self.asset:
                raise ValueError('请先完成更新下载')
            source = self.directory / 'TogetherWatch-update.exe'
            if hashlib.sha256(source.read_bytes()).hexdigest() != self.asset['sha256']:
                self.state.update(stage='error', error='安装包已改变，请重新下载')
                raise ValueError(self.state['error'])
            destination = os.environ.get('WT_LAUNCHER_PATH')
            home = os.environ.get('WT_LAUNCHER_HOME')
            if not destination or not home:
                raise ValueError('请从电脑端 EXE 启动后再安装更新')
            plan = {'source': str(source.resolve()), 'sha256': self.asset['sha256'], 'destination': destination,
                    'home': home, 'pid': os.getpid(), 'arguments': []}
            filename = self.directory / 'install-plan.json'
            filename.write_text(json.dumps(plan), encoding='utf-8')
            subprocess.Popen([str(source), '--apply-update', str(filename)], creationflags=0x08000000,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.state['stage'] = 'installing'
            return self.snapshot()
