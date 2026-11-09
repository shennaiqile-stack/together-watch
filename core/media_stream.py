"""Byte-exact, demand-driven media streaming with CDN health and Range recovery."""
import http.client
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class MediaTransport:
    def __init__(self, context, connect_timeout=3, read_timeout=2.5):
        self.context = context
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self._health = {}
        self._lock = threading.Lock()

    def rank(self, candidates):
        now = time.monotonic()
        with self._lock:
            def score(url):
                failed, latency, updated = self._health.get(urllib.parse.urlsplit(url).netloc, (False, 1, 0))
                return (failed and now - updated < 60, latency if now - updated < 300 else 1)
            return sorted(dict.fromkeys(candidates), key=score)

    def note(self, url, failed, latency=1):
        host = urllib.parse.urlsplit(url).netloc
        with self._lock:
            if len(self._health) >= 128 and host not in self._health:
                self._health.pop(min(self._health, key=lambda k: self._health[k][2]))
            self._health[host] = (failed, latency, time.monotonic())

    def stream(self, candidates, headers, cancelled=lambda: False):
        return RangeStream(self, candidates, headers, cancelled)


class RangeStream:
    def __init__(self, transport, candidates, headers, cancelled):
        self.transport, self.candidates = transport, list(dict.fromkeys(candidates))
        self.headers, self.cancelled = dict(headers), cancelled
        self.response = None
        self.delivered = 0
        self.recoveries = 0
        self.closed = False
        self.url = None
        self._connect()

    @staticmethod
    def _info(response, request_range):
        if response.headers.get('Content-Encoding', 'identity').lower() not in ('', 'identity'):
            raise IOError('CDN returned encoded byte ranges')
        if response.status == 206:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
            if not match:
                raise IOError('Invalid CDN Content-Range')
            start, end, total = map(int, match.groups())
            if not 0 <= start <= end < total:
                raise IOError('Invalid CDN byte bounds')
            if request_range:
                spec = re.fullmatch(r'bytes=(\d*)-(\d*)', request_range)
                if not spec or not any(spec.groups()):
                    raise IOError('Unsupported byte range')
                first, last = spec.groups()
                expected_start = int(first) if first else max(0, total-int(last))
                expected_end = min(int(last), total-1) if first and last else total-1
                if (start, end) != (expected_start, expected_end):
                    raise IOError('CDN returned the wrong byte range')
            length = response.headers.get('Content-Length')
            if length is not None and int(length) != end-start+1:
                raise IOError('CDN range length mismatch')
            return start, end, total
        if response.status != 200:
            raise IOError('Unexpected CDN status %s' % response.status)
        if request_range and request_range != 'bytes=0-':
            raise IOError('CDN ignored the requested byte range')
        length = response.headers.get('Content-Length')
        if length is None or int(length) <= 0:
            raise IOError('CDN did not provide media length')
        return 0, int(length)-1, int(length)

    def _read(self, size):
        # read1 returns available bytes; read(size) can wait for a whole block
        # and delay the MP4 header or a seek even on a usable connection.
        return self.response.read1(size)

    def _connect(self, resume=False):
        deadline = time.monotonic() + 12
        candidates = self.transport.rank(self.candidates)
        if resume:
            candidates = [u for u in candidates if u != self.url] + [self.url]
        last_error = None
        for url in candidates:
            if self.closed or self.cancelled():
                raise ConnectionAbortedError('Media request cancelled')
            if time.monotonic() >= deadline:
                break
            response = None
            began = time.monotonic()
            headers = dict(self.headers)
            if resume:
                headers['Range'] = 'bytes=%d-%d' % (self.start+self.delivered, self.end)
            try:
                response = urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                    timeout=min(self.transport.connect_timeout, deadline-time.monotonic()), context=self.transport.context)
                start, end, total = self._info(response, headers.get('Range'))
                if resume and (start != self.start+self.delivered or end != self.end or total != self.total):
                    raise IOError('Backup CDN returned different media bytes')
                try:
                    response.fp.raw._sock.settimeout(self.transport.read_timeout)
                except (AttributeError, OSError):
                    pass
                self.response = response
                first = self._read(min(16384, end-start+1))
                if not first:
                    raise IOError('CDN returned no media data')
                self.transport.note(url, False, time.monotonic()-began)
                self.url, self.first = url, first
                if not resume:
                    self.start, self.end, self.total = start, end, total
                    self.status = response.status
                    self.content_type = response.headers.get('Content-Type', 'video/mp4')
                return
            except (OSError, urllib.error.URLError, http.client.HTTPException, ValueError) as error:
                if response is not None:
                    response.close()
                self.response = None
                if isinstance(error, urllib.error.HTTPError):
                    if error.code == 416:
                        raise
                    error.close()
                self.transport.note(url, True)
                last_error = error
        raise last_error or TimeoutError('No usable video CDN')

    def chunks(self):
        length = self.end-self.start+1
        while self.delivered < length:
            if self.closed or self.cancelled():
                return
            try:
                if self.first:
                    chunk, self.first = self.first, b''
                else:
                    chunk = self._read(min(65536, length-self.delivered))
                if not chunk:
                    raise IOError('CDN stream ended early')
            except (OSError, http.client.HTTPException) as error:
                if self.cancelled() or self.closed:
                    return
                self.transport.note(self.url, True)
                self.response.close()
                self.response = None
                self.recoveries += 1
                if self.recoveries > 6:
                    raise IOError('Video recovery limit exceeded') from error
                self._connect(resume=True)
                continue
            self.delivered += len(chunk)
            yield chunk

    def close(self):
        self.closed = True
        if self.response is not None:
            self.response.close()
            self.response = None
