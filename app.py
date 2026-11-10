# -*- coding: utf-8 -*-
"""一起看 PC 版 —— 本地服务。

职责：
  * 提供网页界面（web/）
  * 代理 B 站播放地址（带 Referer / Cookie，解决防盗链）
  * 扫码登录、视频信息、弹幕
  * 内置 Syncplay 服务器（房间/进度/聊天/成员）
  * WebSocket 把浏览器的操作桥接到 Syncplay 客户端
"""
import argparse
import base64
import email.utils
import hashlib
import json
import mimetypes
import os
import random
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from core.media_transport import open_media
from core.media_stream import MediaTransport
from core.home_art import HomeArt
from core.discovery import Discovery
from core.downloads import Downloads
from core.source_http import request as source_http
from core.anime import Anime, allowed as anime_allowed, open_public, referer as anime_referer, media_route, unpack, unwrap_segment
import re
import select

ROOT = os.path.dirname(os.path.abspath(__file__))
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    # 单文件 exe：界面资源在临时解包目录，数据默认放 %LOCALAPPDATA%\TogetherWatch
    APP_ROOT = os.path.dirname(os.path.abspath(sys.executable))
    WEB_DIR = os.path.join(getattr(sys, "_MEIPASS", APP_ROOT), "web")
else:
    APP_ROOT = ROOT
    WEB_DIR = os.path.join(ROOT, "web")


def _pick_data_dir():
    """找一个能写的目录存 Cookie / 配置 / 日志。"""
    env = os.environ.get("WT_DATA_DIR")
    if env:
        try:
            os.makedirs(env, exist_ok=True)
            return os.path.abspath(env)
        except Exception:
            pass
    if FROZEN:
        base = os.path.join(os.environ.get("LOCALAPPDATA") or APP_ROOT, "TogetherWatch")
    else:
        base = os.path.join(APP_ROOT, "data")
    for cand in (base, os.path.join(APP_ROOT, "data")):
        try:
            os.makedirs(cand, exist_ok=True)
            probe = os.path.join(cand, ".w")
            with open(probe, "w") as f:
                f.write("1")
            os.remove(probe)
            return cand
        except Exception:
            continue
    return base


DATA_DIR = _pick_data_dir()
INSTALLATION_SCOPE = hashlib.sha256(os.path.normcase(os.path.realpath(DATA_DIR)).encode("utf-8")).hexdigest()
sys.path.insert(0, ROOT)

from core.bili import Bilibili, BiliError, parse_id, parse_bangumi  # noqa: E402
from core.syncplay import SyncplayClient, SyncplayServer       # noqa: E402

APP_NAME = "together-watch"
CLOUDFLARED_URL = ("https://github.com/cloudflare/cloudflared/releases/latest/download/"
                   "cloudflared-windows-amd64.exe")
CLOUDFLARED_MIRROR = ("https://ghproxy.net/https://github.com/cloudflare/cloudflared/"
                      "releases/latest/download/cloudflared-windows-amd64.exe")
APP_VERSION = "1.6.16"
_COVER_CACHE = {}                            # 封面中转缓存 {url: (bytes, content-type)}
MOCK = os.environ.get("WT_MOCK") == "1"      # 仅用于本机调试，正常使用不会开启
MOCK_BV = "BV1mockDEMO0"
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
IDLE_EXIT_SECONDS = 30 * 60                  # 30 分钟没人访问就自动退出

# pythonw 启动时没有控制台，stdout 可能是 None，给个兜底
if sys.stdout is None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        sys.stdout = open(os.path.join(DATA_DIR, "console.log"), "a", encoding="utf-8", buffering=1)
    except Exception:
        sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = sys.stdout

DEFAULT_CONFIG = {
    "port": 8770,
    "syncplay_port": 8999,
    "username": "",
    "quality": 80,
    "danmaku": True,
    "sr": False,
    "prefer_mp4": True,
    "open_mode": "app",
    "relay_host": "",
    "relay_port": 22,
    "relay_user": "Administrator",
    "relay_pass": "",
    # 0 表示由程序自动挑一个空闲的远端端口
    "relay_remote_port": 0,
    "relay_hostkey": "",
    "access_token": "",
    "public_addr": "",
}

# 内置外网访问服务器：默认走这台机器，账号密码随程序分发
BUILTIN_RELAY = {
    "host": "154.64.252.247",
    "port": 22,
    "user": "Administrator",
    "pass": "WS72zuScloySHpTm",
    "hostkey": "SHA256:7DhRs07ihFXPQAFpHD6MKM2G7OQGG2gnpAE5XT1DKQo",
    "remote": 0,
}

ALLOWED_HOST_SUFFIX = (
    "bilivideo.com", "bilivideo.cn", "bilivideo.cc", "hdslb.com",
    "bilibili.com", "akamaized.net", "szbdyd.com", "mountaintoys.cn",
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".mp4": "video/mp4",
    ".m4s": "video/mp4",
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            cfg.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
    except Exception:
        pass
    # 老版本把远端端口固定成 8770，多人共用内置服务器时会互相挤掉；改为自动分配
    if cfg.get("relay_remote_port") == 8770 and not cfg.get("relay_host"):
        cfg["relay_remote_port"] = 0
    return cfg


def save_config(cfg):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_FILE)
    except Exception:
        pass


def startup_log(msg):
    try:
        with open(os.path.join(DATA_DIR, "app.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return [ip for ip in ips if _is_private(ip)] or ips


def _is_private(ip):
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except Exception:
        return False
    return a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or a == 100 and 64 <= b <= 127


def b64e(text):
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad).decode("utf-8")


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# WebSocket（服务端实现，够用即可）
# ---------------------------------------------------------------------------

class WS(object):
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, rfile, wfile, sock):
        self.rfile = rfile
        self.wfile = wfile
        self.sock = sock
        self.alive = True
        self.lock = threading.Lock()

    def handshake(self, key):
        accept = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        self.wfile.write((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
        ).encode())
        self.wfile.flush()

    def _read_exact(self, n):
        data = b""
        while len(data) < n:
            chunk = self.rfile.read(n - len(data))
            if not chunk:
                return None
            data += chunk
        return data

    def recv(self):
        while True:
            head = self._read_exact(2)
            if not head:
                return None
            b1, b2 = head[0], head[1]
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                ext = self._read_exact(2)
                if not ext:
                    return None
                length = struct.unpack("!H", ext)[0]
            elif length == 127:
                ext = self._read_exact(8)
                if not ext:
                    return None
                length = struct.unpack("!Q", ext)[0]
            if length > 8 * 1024 * 1024:
                return None
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(length) if length else b""
            if payload is None:
                return None
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                return None
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                return payload

    def _send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header += struct.pack("!H", n)
        else:
            header.append(127)
            header += struct.pack("!Q", n)
        with self.lock:
            if not self.alive:
                return
            try:
                self.wfile.write(bytes(header) + payload)
                self.wfile.flush()
            except Exception:
                self.alive = False

    def send_json(self, obj):
        try:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        except Exception:
            return
        self._send_frame(0x1, data)

    def close(self):
        self.alive = False
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 每个浏览器标签页的 Syncplay 会话
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 演示模式：没有网络/B 站登录时，用本地素材把界面跑起来（仅调试用）
# ---------------------------------------------------------------------------

def _find_sample_video():
    import glob
    hits = glob.glob(r"C:\Windows\WinSxS\**\oobe-intro.mp4", recursive=True)
    return hits[0] if hits else None


class MockBilibili(object):
    def __init__(self):
        self.sample = _find_sample_video()
        self.cover = os.path.join(DATA_DIR, "mock_cover.jpg")
        self._make_cover()

    def _make_cover(self):
        try:
            from PIL import Image, ImageDraw, ImageFont
            img = Image.new("RGB", (1280, 720), "#1b1520")
            px = img.load()
            for y in range(720):
                for x in range(1280):
                    r = int(42 + 90 * (x / 1280) + 30 * (y / 720))
                    g = int(22 + 30 * (y / 720))
                    b = int(48 + 70 * (1 - x / 1280) + 20 * (y / 720))
                    px[x, y] = (min(255, r), min(255, g), min(255, b))
            d = ImageDraw.Draw(img)
            try:
                font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 92)
                small = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 34)
            except Exception:
                font = small = ImageFont.load_default()
            d.text((90, 250), "一起看 · 演示", font=font, fill=(255, 235, 244))
            d.text((94, 380), "房主输入 BV 号，所有人同步观看", font=small, fill=(255, 190, 210))
            img.save(self.cover, quality=88)
        except Exception:
            self.cover = None

    def cookie_header(self):
        return ""

    def logged_in(self):
        return True

    def nav(self):
        return {"logged_in": True, "uname": "演示账号", "face": "", "vip": True}

    def ensure_buvid(self):
        pass

    def logout(self):
        pass

    def qr_generate(self):
        return {"key": "demo", "url": "https://www.bilibili.com"}

    def qr_poll(self, key=None):
        return {"status": "waiting"}

    def view(self, bvid=None, aid=None):
        return {
            "bvid": MOCK_BV, "aid": 1, "cid": 123456,
            "title": "【一起看】演示视频 · 两个人的同步观影",
            "pic": "/mock/cover.jpg", "desc": "演示模式",
            "duration": 2727, "owner": "一起看", "owner_face": "",
            "pages": [{"cid": 123456, "page": 1, "part": "P1", "duration": 2727}],
        }

    def playurl(self, bvid=None, aid=None, cid=None, qn=80):
        return {
            "accept": [
                {"qn": 120, "label": "4K 超清"},
                {"qn": 80, "label": "1080P 高清"},
                {"qn": 64, "label": "720P 高清"},
                {"qn": 32, "label": "480P 清晰"},
            ],
            "mp4": [{"url": "/mock/video.mp4"}],
            "dash": None,
            "quality": qn,
        }

    def danmaku(self, cid):
        import random
        texts = ["这个画面太美了", "前面的等等我", "哈哈哈哈哈", "有一起看的吗", "4K 好评",
                 "第一次一起看", "戴耳机体验更好", "这段配乐绝了", "刷屏警告", "我也这么觉得",
                 "这才是青春啊", "已三连", "弹幕护体", "爷青回", "太真实了"]
        out = []
        t = 0.5
        random.seed(7)
        for i in range(160):
            t += random.uniform(0.4, 1.6)
            out.append({"t": round(t, 2), "m": random.choice([1, 1, 1, 5, 4]),
                        "s": 25, "c": random.choice([0xFFFFFF, 0xFFFFFF, 0xFFD166, 0x87D7FF, 0xFF9EC4]),
                        "x": random.choice(texts)})
        return out


# ---------------------------------------------------------------------------
# 每个浏览器标签页的 Syncplay 会话
# ---------------------------------------------------------------------------

class Session(object):
    def __init__(self, ws, app):
        self.ws = ws
        self.app = app
        self.client = None
        self.lock = threading.Lock()
        self.generation = 0

    def _emit(self, ev, generation):
        with self.lock:
            if generation != self.generation or self.client is None or not self.ws.alive:
                return
            if ev.get("type") == "connected":
                ev = dict(ev, server=self.client.host, port=self.client.port)
            self.ws.send_json({"op": "sync", "event": ev})

    def join(self, server, port, username, room, password=None, avatar="", face=""):
        self.leave()
        host = (server or "127.0.0.1").strip()
        if host in ("localhost", "本机", ""):
            host = "127.0.0.1"
        with self.lock:
            generation = self.generation
            client = SyncplayClient(host, port, username, room,
                                    lambda event: self._emit(event, generation), password,
                                    avatar=avatar, face=face)
            self.client = client
        client.start()
        return True

    def leave(self):
        with self.lock:
            self.generation += 1
            old, self.client = self.client, None
        if old:
            old.stop()

    def call(self, method, *args):
        with self.lock:
            c = self.client
        if not c:
            return False
        fn = getattr(c, method, None)
        if not fn:
            return False
        try:
            return fn(*args)
        except Exception:
            return False


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class App(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.bili = MockBilibili() if MOCK else Bilibili(DATA_DIR)
        if MOCK:
            self.log("[mock] 演示模式已开启")
        self.sync_server = None
        self.httpd = None
        self.sessions = set()
        self.started_at = time.time()
        self.instance_id = "%032x" % random.getrandbits(128)
        self.tunnel = Tunnel(self)
        self.relay = Relay(self)
        self.last_activity = time.time()
        self.page_loads = 0
        self.last_page_load = 0.0
        self._stopping = False
        # 视频全量磁盘缓存：url md5 -> _VCacheEntry
        self.media_transport = MediaTransport(MEDIA_TLS_CONTEXT)
        self.home_art = HomeArt(os.path.join(DATA_DIR, 'home-art'), os.path.join(WEB_DIR, 'art', 'bangumi'), MEDIA_TLS_CONTEXT)
        self.discovery = Discovery(os.path.join(DATA_DIR, 'discovery'), os.path.join(WEB_DIR, 'art', 'discovery'), MEDIA_TLS_CONTEXT)
        self.anime = Anime(MEDIA_TLS_CONTEXT)
        self.downloads = Downloads(os.path.join(DATA_DIR, 'downloads'), self.download_target,
                                   lambda url, headers: open_public(url, headers, MEDIA_TLS_CONTEXT), self.log)
        self.vcache = {}
        self.vcache_lock = threading.Lock()
        self.vcache_dir = os.path.join(DATA_DIR, "vcache")
        try:
            os.makedirs(self.vcache_dir, exist_ok=True)
            # 清掉上次没下完的残片
            for name in os.listdir(self.vcache_dir):
                if name.endswith(".part"):
                    try:
                        os.remove(os.path.join(self.vcache_dir, name))
                    except Exception:
                        pass
        except Exception:
            pass
        # 站外片源 HLS 分段磁盘缓存：url md5 -> 条目
        self.acache = {}
        self.acache_lock = threading.Lock()
        self.acache_dir = os.path.join(DATA_DIR, "acache")
        self.hls_next = {}
        # 当前播放清单的分段顺序，用于空闲时整集预缓存
        self.hls_list = []
        self.hls_index = {}
        self.hls_at = 0
        self.hls_touch = time.time()
        self.hls_seq = 0
        self.hls_worker = 0
        self.hls_lock = threading.Lock()
        self.hls_manifest = {}
        # 预取队列：最多两条并发，避免十几个连接一起挤慢速片源
        self.pf_lock = threading.Lock()
        self.pf_queue = []
        self.pf_queued = set()
        self.pf_running = 0
        self.pf_max = 2
        try:
            os.makedirs(self.acache_dir, exist_ok=True)
        except Exception:
            pass
        self._start_sync_server()
        threading.Thread(target=self._idle_watch, name="idle-watch", daemon=True).start()

    def touch(self):
        self.last_activity = time.time()

    def download_target(self, value):
        parsed = urllib.parse.urlsplit(value)
        if parsed.path == '/relay' and not parsed.netloc:
            url = b64d(urllib.parse.parse_qs(parsed.query).get('u',[''])[0])
        elif parsed.path == '/anime-media' and not parsed.netloc:
            url = unpack(urllib.parse.parse_qs(parsed.query).get('u',[''])[0])
        else:
            url = value
        target = urllib.parse.urlsplit(url)
        if target.scheme not in ('https','http') or target.username or target.port not in (None,80,443):
            raise ValueError('下载地址无效')
        host = target.hostname or ''
        if not any(host == s or host.endswith('.'+s) for s in ALLOWED_HOST_SUFFIX):
            url=anime_allowed(url)
            return url, {'User-Agent':'Mozilla/5.0','Referer':anime_referer(url),'Accept-Encoding':'identity'}
        return url, {'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/', 'Accept-Encoding':'identity',
                     'Cookie':self.bili.cookie_header() or ''}

    def note_page_load(self):
        self.page_loads += 1
        self.last_page_load = time.time()

    def _idle_watch(self):
        while not self._stopping:
            time.sleep(30)
            if self._stopping:
                break
            try:
                if (time.time() - self.last_activity > IDLE_EXIT_SECONDS
                        and not self.sessions):
                    self.log("[app] 已经 %d 分钟没有人访问，自动退出" % (IDLE_EXIT_SECONDS // 60))
                    os._exit(0)
            except Exception:
                pass

    def _start_sync_server(self):
        if self.cfg.get("syncplay_port") == 0:
            return
        port = int(self.cfg.get("syncplay_port") or 8999)
        try:
            self.sync_server = SyncplayServer(port=port, log=self.log)
            self.sync_server.start()
        except OSError as e:
            self.log("[syncplay] 端口 %s 被占用：%s" % (port, e))
            self.sync_server = None

    def log(self, msg):
        line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
        try:
            print(line, flush=True)
        except Exception:
            pass
        try:
            with open(os.path.join(DATA_DIR, "app.log"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass

    def share(self):
        port = int(self.cfg.get("port") or 8770)
        external = ""
        try:
            # 外网隧道在跑时它才是真正可达的地址；public_addr 可能是过期的动态 IP。
            if self.relay.running():
                external = (self.relay.url or "").strip().rstrip("/")
        except Exception:
            external = ""
        public = (self.cfg.get("public_addr") or "").strip().rstrip("/")
        if public:
            if "://" not in public:
                public = "http://" + public
            if not public.endswith(":%d" % port) and ":" not in public.split("://", 1)[1]:
                public = public + ":%d" % port
        urls = []
        if external:
            urls.append(external)
        if public and public not in urls:
            urls.append(public)
        for ip in lan_ips():
            urls.append("http://%s:%d" % (ip, port))
        return {
            "urls": urls,
            "primary": urls[0] if urls else "http://127.0.0.1:%d" % port,
            "local": "http://127.0.0.1:%d" % port,
            "port": port,
            "syncplay_port": int(self.cfg.get("syncplay_port") or 8999),
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TogetherWatch/" + APP_VERSION
    # 关掉 Nagle：小包不再等待合并，高延迟线路上首字节更快
    disable_nagle_algorithm = True

    def setup(self):
        super().setup()
        # 加大发送缓冲：外网链路往返几百毫秒时，窗口太小会严重限制吞吐，
        # 这也是"码率喂不动"的常见原因之一。
        try:
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 2 * 1024 * 1024)
        except Exception:
            pass

    # 静默日志（只把错误写进 app.log）
    def log_message(self, fmt, *args):
        pass

    @property
    def app(self):
        return self.server.app

    # ---------------- 基础响应 ----------------
    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        # 朋友的桌面端页面来自他自己的本机服务器，跨域请求房主 API 需要这个头
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _err(self, message, status=400, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        self._json(payload, status)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0:
            return {}
        try:
            raw = self.rfile.read(n)
            return json.loads(raw.decode("utf-8", "replace")) or {}
        except Exception:
            return {}

    # ---------------- 路由 ----------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _allow(self):
        """开了公网访问后，非本机请求需要口令。"""
        app = self.app
        try:
            if not app.relay.running():
                return True
        except Exception:
            return True
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        if host in ("127.0.0.1", "localhost"):
            return True
        token = app.cfg.get("access_token") or ""
        if not token:
            return True
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if (qs.get("k") or [""])[0] == token:
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "wtk" and value == token:
                return True
        return False

    def _deny(self):
        if self.path.startswith("/api/"):
            return self._err("需要访问口令", 403)
        page = ("<meta charset='utf-8'><title>需要访问口令</title>"
                "<body style='font-family:sans-serif;background:#141218;color:#e7e0e8;"
                "display:grid;place-items:center;height:100vh;margin:0'>"
                "<div style='text-align:center'><h2>需要访问口令</h2>"
                "<p style='color:#cbc4cf'>请让房主发完整的分享链接给你（带 ?k= 口令）。</p></div>")
        data = page.encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def do_GET(self):
        self.app.touch()
        if not self._allow():
            return self._deny()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self.app.note_page_load()
        qs0 = urllib.parse.parse_qs(parsed.query)
        token = self.app.cfg.get("access_token") or ""
        if token and (qs0.get("k") or [""])[0] == token:
            keep = {k: v for k, v in qs0.items() if k != "k"}
            query = urllib.parse.urlencode(keep, doseq=True)
            target = path + (("?" + query) if query else "")
            if path in ("/", "/index.html"):
                self.send_response(302)
                self.send_header("Location", target)
                self.send_header("Set-Cookie", "wtk=%s; Path=/; Max-Age=86400; SameSite=Lax" % token)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/ws":
                return self._ws()
            if path == "/api/state":
                return self._api_state()
            if path=='/api/source-http':
                if not self._device_local():return self._err('片源由自己的客户端加载',403)
                return self._json(source_http((qs.get('u') or [''])[0],MEDIA_TLS_CONTEXT,(qs.get('probe') or [''])[0]=='1'))
            if path == '/api/account':
                if not self._device_local():return self._err('请在自己的客户端查看账号',403)
                return self._json({'ok':True,'user':self.app.bili.nav()})
            if path == "/api/share":
                return self._json({"ok": True, **self.app.share()})
            if path == "/api/video":
                return self._api_video(qs)
            if path.startswith('/api/downloads'):
                if not self._device_local():
                    return self._err('下载库只允许在本机访问',403)
                if path.startswith('/api/downloads/file/'):
                    return self._download_file(path)
                if path == '/api/downloads/find':
                    return self._json({'ok':True,'item':self.app.downloads.find((qs.get('content') or [''])[0], (qs.get('qn') or [None])[0])})
                return self._json(self.app.downloads.snapshot())
            if path == "/api/search":
                return self._api_search(qs)
            if path == '/api/anime/search':
                return self._json({'ok':True,'items':self.app.anime.search((qs.get('provider') or ['giri'])[0],(qs.get('kw') or [''])[0])})
            if path == '/api/anime/details':
                return self._json({'ok':True,**self.app.anime.details((qs.get('provider') or ['giri'])[0],(qs.get('id') or [''])[0])})
            if path == '/anime-media':
                return self._anime_media(qs)
            if path == "/api/home-art":
                return self._json(self.app.home_art.snapshot())
            if path == "/api/discovery":
                return self._json(self.app.discovery.snapshot())
            if path.startswith("/api/discovery/image/"):
                return self._home_art_image(path.rsplit('/', 1)[-1], self.app.discovery)
            if path.startswith("/api/home-art/image/"):
                return self._home_art_image(path.rsplit('/', 1)[-1])
            if path == "/api/cover":
                return self._api_cover(qs)
            if path == "/api/danmaku":
                return self._api_danmaku(qs)
            if path == "/api/cache":
                return self._api_cache(qs)
            if path == "/api/speed":
                return self._api_speed(qs)
            if path == "/api/login/poll":
                if not self._device_local():return self._err('请在自己的客户端登录',403)
                return self._api_login_poll(qs)
            if path == "/api/relay":
                return self._json({"ok": True, **self.app.relay.info()})
            if path == "/api/tunnel":
                return self._json({"ok": True, **self.app.tunnel.info()})
            if path == "/api/health":
                return self._json({"ok": True, "app": APP_NAME, "version": APP_VERSION, "instance": self.app.instance_id,
                                   "installation": INSTALLATION_SCOPE,
                                   "ui_ready": ui_ready(),
                                   "uptime": int(time.time() - self.app.started_at)})
            if path.startswith("/relay"):
                return self._relay(qs)
            if path == "/mock/video.mp4":
                return self._mock_video()
            if path == "/mock/cover.jpg":
                return self._mock_cover()
            if path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path.startswith("/api/"):
                return self._err("接口不存在", 404)
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:
            self.app.log("[http] %s %s\n%s" % (path, e, traceback.format_exc()))
            try:
                self._err("服务器内部错误：%s" % e, 500)
            except Exception:
                pass

    def do_POST(self):
        self.app.touch()
        if not self._allow():
            return self._deny()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if (path.startswith('/api/login/') or path=='/api/logout') and not self._device_local():
                return self._err('请在自己的客户端登录',403)
            if path.startswith('/api/downloads/'):
                if not self._device_local():
                    return self._err('下载只能由本机操作',403)
                body = self._body()
                if path == '/api/downloads/start':
                    return self._json({'ok':True,'item':self.app.downloads.start(body)})
                if path == '/api/downloads/cancel':
                    return self._json(self.app.downloads.cancel(str(body.get('id') or '')))
                if path == '/api/downloads/remove':
                    return self._json(self.app.downloads.remove(str(body.get('id') or '')))
                return self._err('下载操作不存在',404)
            if path in ('/api/discovery/update', '/api/discovery/more'):
                self.app.discovery.request_update('more' if path.endswith('/more') else 'refresh')
                return self._json(self.app.discovery.snapshot())
            if path == "/api/login/qr":
                data = self.app.bili.qr_generate()
                return self._json({"ok": True, **data})
            if path == "/api/logout":
                self.app.bili.logout()
                return self._json({"ok": True})
            if path == "/api/config":
                body = self._body()
                for k in ("username", "quality", "danmaku", "sr", "prefer_mp4", "open_mode", "public_addr",
                  "relay_host", "relay_port", "relay_user", "relay_pass", "relay_remote_port"):
                    if k in body:
                        self.app.cfg[k] = body[k]
                save_config(self.app.cfg)
                return self._json({"ok": True, "config": self.app.cfg})
            if path == "/api/sr-report":
                body = self._body()
                try:
                    with open(os.path.join(DATA_DIR, "sr-report.jsonl"), "a",
                              encoding="utf-8") as f:
                        f.write(json.dumps(body, ensure_ascii=False) + "\n")
                except Exception:
                    pass
                return self._json({"ok": True})
            if path == "/api/relay/start":
                body = self._body()
                for k in ("relay_host", "relay_user", "relay_pass", "relay_port",
                          "relay_remote_port"):
                    if k in body:
                        self.app.cfg[k] = body[k]
                save_config(self.app.cfg)
                self.app.relay.start()
                return self._json({"ok": True, **self.app.relay.info()})
            if path == "/api/relay/stop":
                self.app.relay.stop()
                return self._json({"ok": True, **self.app.relay.info()})
            if path == "/api/tunnel/start":
                ok = self.app.tunnel.start()
                return self._json({"ok": True, "started": ok, **self.app.tunnel.info()})
            if path == "/api/tunnel/stop":
                self.app.tunnel.stop()
                return self._json({"ok": True, **self.app.tunnel.info()})
            if path == "/api/shutdown":
                self._json({"ok": True})
                threading.Thread(target=self._shutdown, daemon=True).start()
                return
            return self._err("接口不存在", 404)
        except BiliError as e:
            return self._err(str(e))
        except Exception as e:
            self.app.log("[http] POST %s %s" % (path, e))
            return self._err("服务器内部错误：%s" % e, 500)

    def _shutdown(self):
        time.sleep(0.3)
        for service in (self.app.relay, self.app.tunnel):
            try:
                service.stop()
            except Exception:
                pass
        try:
            self.app.httpd.shutdown()
        except Exception:
            pass
        os._exit(0)

    # ---------------- 接口 ----------------
    def _device_local(self):
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        origin = self.headers.get('Origin') or ''
        return self.client_address[0] in ('127.0.0.1','::1') and host in ('127.0.0.1','localhost') and (not origin or urllib.parse.urlsplit(origin).netloc == self.headers.get('Host'))

    def _download_file(self, route):
        parts = route.split('/')
        if len(parts) != 6:
            return self._err('下载文件不存在',404)
        path = self.app.downloads.file(parts[4],parts[5])
        if not path:
            return self._err('视频尚未完整下载',404)
        size = path.stat().st_size
        start,end = 0,size-1
        rng = self.headers.get('Range') or ''
        if rng:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)',rng)
            if match and any(match.groups()):
                first,last = match.groups()
                start = int(first) if first else max(0,size-int(last))
                end = min(size-1,int(last)) if first and last else size-1
            else:
                start = size
        if start >= size or end < start:
            self.send_response(416)
            self.send_header('Content-Range','bytes */'+str(size))
            self.send_header('Content-Length','0')
            self.end_headers()
            return
        self.send_response(206 if rng else 200)
        self.send_header('Content-Type','application/vnd.apple.mpegurl' if path.suffix=='.m3u8' else 'video/mp4' if path.suffix=='.mp4' else 'application/octet-stream')
        self.send_header('Content-Length',str(end-start+1))
        self.send_header('Accept-Ranges','bytes')
        if rng:self.send_header('Content-Range','bytes %d-%d/%d'%(start,end,size))
        self.end_headers()
        with path.open('rb') as stream:
            stream.seek(start)
            left=end-start+1
            while left:
                chunk=stream.read(min(65536,left))
                if not chunk:break
                self.wfile.write(chunk)
                left-=len(chunk)

    def _api_state(self):
        nav = self.app.bili.nav()
        return self._json({
            "ok": True,
            "version": APP_VERSION,
            "user": nav,
            "config": self.app.cfg,
            "share": self.app.share(),
            "relay": self.app.relay.info(),
            "syncplay": {
                "running": self.app.sync_server is not None,
                "port": int(self.app.cfg.get("syncplay_port") or 8999),
            },
        })

    def _api_login_poll(self, qs):
        key = (qs.get("key") or [""])[0]
        return self._json({"ok": True, **self.app.bili.qr_poll(key)})

    def _home_art_image(self, file, store=None):
        path = (store or self.app.home_art).image(file)
        if path is None:
            return self._err("图片不存在", 404)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "image/png" if path.suffix == '.png' else "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=604800, immutable")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _api_cover(self, qs):
        """B 站封面有防盗链，浏览器直连会裂图，这里带 Referer 中转一下。"""
        u = (qs.get("u") or [""])[0].strip()
        if u.startswith("//"):
            u = "https:" + u
        if u.startswith("http://"):
            u = "https://" + u[7:]
        host = (urllib.parse.urlparse(u).hostname or "").lower()
        if not host or not (host.endswith("hdslb.com") or host.endswith("biliimg.com")):
            return self._err("不支持的图片地址", 400)
        cached = _COVER_CACHE.get(u)
        if not cached:
            try:
                req = urllib.request.Request(u, headers={
                    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                                   "Chrome/126.0 Safari/537.36"),
                    "Referer": "https://www.bilibili.com/",
                })
                with urllib.request.urlopen(req, timeout=12) as r:
                    data = r.read()
                    ctype = r.headers.get("Content-Type") or "image/jpeg"
                if len(_COVER_CACHE) > 120:
                    _COVER_CACHE.clear()
                cached = (data, ctype)
                _COVER_CACHE[u] = cached
            except Exception:
                return self._err("封面加载失败", 502)
        data, ctype = cached
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _api_search(self, qs):
        kw = (qs.get("kw") or [""])[0].strip()
        if not kw:
            return self._err("请输入番剧名")
        if MOCK:
            return self._json({"ok": True, "keyword": kw, "items": []})
        try:
            self.app.bili.ensure_buvid()
            items = self.app.bili.search_anime(kw)
        except BiliError as e:
            return self._err(str(e), 502)
        return self._json({"ok": True, "keyword": kw, "items": items})

    def _api_video(self, qs):
        raw = (qs.get("bv") or [""])[0]
        if raw.startswith('anime:'):
            return self._json(self.app.anime.video(raw))
        kind, num = parse_bangumi(raw)
        if kind:
            return self._api_bangumi(kind, num, qs)
        bvid, aid = parse_id(raw)
        if not bvid and not aid:
            return self._err("没有识别到 BV 号")
        page = int((qs.get("p") or ["1"])[0] or 1)
        qn = int((qs.get("qn") or [str(self.app.cfg.get("quality") or 80)])[0] or 80)
        if MOCK:
            info = self.app.bili.view(bvid=bvid, aid=aid)
            play = self.app.bili.playurl(cid=info["cid"], qn=qn)
            return self._json({
                "ok": True, "info": info, "cid": info["cid"], "qn": qn,
                "target": info["bvid"], "page": 1, "ep_id": "",
                "quality": qn, "qualities": play["accept"],
                "source": {"mode": "mp4", "url": "/mock/video.mp4"},
            })
        self.app.bili.ensure_buvid()
        info = self.app.bili.view(bvid=bvid, aid=aid)
        pages = info.get("pages") or []
        if page < 1:
            page = 1
        if pages and page > len(pages):
            page = len(pages)
        cid = info["cid"]
        if pages and page > 1:
            cid = pages[page - 1]["cid"]
        play = self.app.bili.playurl(bvid=info["bvid"], aid=info["aid"], cid=cid, qn=qn)
        prefer_mp4 = bool(self.app.cfg.get("prefer_mp4", True))
        mode = (qs.get("mode") or [""])[0]
        if mode == "mp4":
            prefer_mp4 = True
        elif mode == "dash":
            prefer_mp4 = False
        source, real_qn, qualities = _build_source(play, qn, prefer_mp4)
        if not source:
            return self._err("这个视频没有可用的播放地址（可能需要登录或大会员）", 502)
        self.app.log("[video] %s p%s qn=%s -> %s(实际 %s)"
                     % (info["bvid"], page, qn, source["mode"], real_qn))
        return self._json({
            "ok": True,
            "info": info,
            "cid": cid,
            "target": info["bvid"],
            "page": page,
            "ep_id": "",
            "qn": real_qn,
            "requestedQn": qn,
            "quality": play.get("quality"),
            "qualities": qualities,
            "source": source,
        })

    def _api_bangumi(self, kind, num, qs):
        """番剧：拿季信息 + 指定集（ep）的播放地址。"""
        qn = int((qs.get("qn") or [str(self.app.cfg.get("quality") or 80)])[0] or 80)
        want = (qs.get("ep") or [""])[0] or (num if kind == "ep" else "")
        self.app.bili.ensure_buvid()
        season = self.app.bili.season(ep_id=num if kind == "ep" else None,
                                      season_id=num if kind == "ss" else None)
        eps = season.get("episodes") or []
        if not eps:
            return self._err("这部番剧暂时没有可播放的剧集", 502)
        ep = None
        if want:
            ep = next((e for e in eps if str(e.get("ep_id")) == str(want)), None)
        ep = ep or eps[0]
        if not ep.get("cid") or not ep.get("aid"):
            return self._err("这一集缺少播放信息（可能是预告片）", 502)
        play = self.app.bili.pgc_playurl(ep["ep_id"], ep["cid"], ep["aid"], qn)
        prefer_mp4 = bool(self.app.cfg.get("prefer_mp4", True))
        mode = (qs.get("mode") or [""])[0]
        if mode == "mp4":
            prefer_mp4 = True
        elif mode == "dash":
            prefer_mp4 = False
        source, real_qn, qualities = _build_source(play, qn, prefer_mp4)
        if not source:
            return self._err("这一集没有可用的播放地址（可能是大会员专享，请先登录会员账号）", 502)
        name = " ".join(x for x in (ep.get("title"), ep.get("long_title")) if x)
        title = (season.get("title") or "") + ((" · " + name) if name else "")
        info = {
            "bvid": ep.get("bvid") or "",
            "aid": ep.get("aid"),
            "cid": ep.get("cid"),
            "title": title,
            "pic": ep.get("cover") or season.get("cover") or "",
            "desc": "",
            "duration": float(ep.get("duration") or 0),
            "owner": "番剧",
            "pages": [],
            "episodes": eps,
            "season_id": season.get("season_id"),
            "ep_id": ep.get("ep_id"),
            "is_bangumi": True,
        }
        self.app.log("[bangumi] ss=%s ep=%s -> %s(实际 %s)"
                     % (season.get("season_id"), ep.get("ep_id"), source["mode"], real_qn))
        return self._json({
            "ok": True,
            "info": info,
            "cid": ep.get("cid"),
            "target": "ep" + str(ep.get("ep_id")),
            "page": 1,
            "ep_id": ep.get("ep_id"),
            "qn": real_qn,
            "requestedQn": qn,
            "quality": play.get("quality"),
            "qualities": qualities,
            "source": source,
        })

    def _api_speed(self, qs):
        """测速：回一段固定大小的空数据，客户端据此估算线路带宽。

        外网访问走中转时带宽常常只有一两百 KB/s，
        1080P 根本喂不动，需要提示朋友降画质。"""
        try:
            n = int((qs.get("bytes") or ["524288"])[0])
        except Exception:
            n = 524288
        n = max(1024, min(n, 4 * 1024 * 1024))
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(n))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        chunk = b"\0" * 32768
        left = n
        try:
            while left > 0:
                w = min(len(chunk), left)
                self.wfile.write(chunk[:w])
                left -= w
        except Exception:
            pass

    def _api_cache(self, qs):
        """预缓冲：拿到播放地址后先把整段音视频下到本地磁盘。

        客户端轮询这个接口显示进度，下完再开始播放，避免边播边卡。"""
        out = []
        for raw in qs.get("u") or []:
            item = {"u": raw, "have": 0, "size": -1, "status": "error", "percent": 0}
            try:
                target = b64d(raw)
                host = urllib.parse.urlparse(target).hostname or ""
                if not any(host == s or host.endswith("." + s) for s in ALLOWED_HOST_SUFFIX):
                    raise ValueError("域名不允许")
                is_video_cdn = self._is_media_url(target)
                if not is_video_cdn:
                    item.update({"status": "skip", "percent": 100})
                else:
                    path_part = urllib.parse.urlparse(target).path or target
                    key = hashlib.md5(path_part.encode("utf-8")).hexdigest()
                    entry = self._vcache_get(key, target)
                    size, have = entry["size"], entry["have"]
                    if entry["status"] == "done":
                        pct = 100
                    elif size > 0:
                        pct = min(99, int(have * 100 / size))
                    else:
                        pct = 0
                    item.update({"have": have, "size": size,
                                 "status": entry["status"], "percent": pct})
            except Exception as e:
                item["error"] = str(e)
            out.append(item)
        return self._json({"ok": True, "items": out})

    def _api_danmaku(self, qs):
        cid = (qs.get("cid") or [""])[0]
        if not cid:
            return self._err("缺少 cid")
        items = self.app.bili.danmaku(cid)
        return self._json({"ok": True, "count": len(items), "items": items})

    # ---------------- 弹幕 / 视频中继 ----------------
    def _anime_media(self, qs):
        target=anime_allowed(unpack((qs.get('u') or [''])[0]))
        app=self.app
        with app.hls_lock:
            app.hls_touch=time.time()
            pos=app.hls_index.get(target)
            if pos is not None:app.hls_at=pos
        headers={'User-Agent':'Mozilla/5.0','Referer':anime_referer(target),'Accept-Encoding':'identity'}
        rng=self.headers.get('Range')
        if rng:headers['Range']=rng
        if not rng:
            # 点播清单（含 ENDLIST）短期复用，重新载入/重试不用再等 CDN
            hit=app.hls_manifest.get(target)
            if hit and time.time()-hit[0]<120:
                body=hit[1]
                with app.hls_lock:
                    if app.hls_list and target in app.hls_index:app.hls_touch=time.time()
                self.send_response(200);self.send_header('Content-Type','application/vnd.apple.mpegurl')
                self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store')
                self.end_headers();self.wfile.write(body)
                return
        cached=self._acache_lookup(target)
        if cached is not None and (not rng or cached['status']=='done'):
            if not rng:
                nxt=self.app.hls_next.get(target)
                if nxt:self._acache_prefetch(nxt,True)
            return self._acache_serve(cached,rng)
        with open_public(target,headers,MEDIA_TLS_CONTEXT) as response:
            first=response.read(65536)
            if first.lstrip().startswith(b'#EXTM3U'):
                data=first+response.read(4*1024*1024)
                if len(data)>4*1024*1024:return self._err('播放清单过大',502)
                lines=[];segments=[]
                for line in data.decode('utf-8-sig').splitlines():
                    if line and not line.startswith('#'):
                        seg=urllib.parse.urljoin(target,line.strip());segments.append(seg)
                        line=media_route(seg)
                    elif 'URI="' in line:line=re.sub(r'URI="([^"]+)"',lambda m:'URI="'+media_route(urllib.parse.urljoin(target,m[1]))+'"',line)
                    lines.append(line)
                body=('\n'.join(lines)+'\n').encode()
                self._hls_index(segments)
                if '#EXT-X-ENDLIST' in data.decode('utf-8-sig'):
                    app.hls_manifest[target]=(time.time(),body)
                    if len(app.hls_manifest)>8:app.hls_manifest.clear()
                self.send_response(200);self.send_header('Content-Type','application/vnd.apple.mpegurl')
                self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store')
                self.end_headers();self.wfile.write(body)
                return
            if rng:
                # 渐进式 mp4：本次透传，同时后台把整个文件落盘，下次直接命中磁盘
                entry,created=self._acache_entry(target)
                if created:
                    threading.Thread(target=self._acache_download,args=(entry,target),daemon=True).start()
                self.send_response(response.status)
                self.send_header('Content-Type',response.headers.get('Content-Type') or 'application/octet-stream')
                for name in ('Content-Length','Content-Range','Accept-Ranges'):
                    if response.headers.get(name):self.send_header(name,response.headers[name])
                self.end_headers();self.wfile.write(first)
                while True:
                    data=response.read(65536)
                    if not data:break
                    self.wfile.write(data)
                return
            entry,created=self._acache_entry(target)
            if not created:
                try:response.close()
                except Exception:pass
                return self._acache_serve(entry)
            nxt=self.app.hls_next.get(target)
            if nxt:self._acache_prefetch(nxt,True)
            return self._acache_tee(entry,response,first)

    # ---------------- 站外片源分段磁盘缓存 ----------------
    def _acache_lookup(self,url):
        """只查缓存、不联网；命中返回条目，未命中返回 None。"""
        key=hashlib.md5(url.encode('utf-8')).hexdigest()
        app=self.app
        with app.acache_lock:
            entry=app.acache.get(key)
            if entry is not None:
                if entry['status']=='error':
                    app.acache.pop(key,None)
                    return None
                return entry
            path=os.path.join(app.acache_dir,key+'.ts')
            okp=path[:-3]+'.ok'
            try:
                with open(okp,encoding='ascii') as f:
                    head=f.read().split('\n')
                size=int(head[0]);ctype=head[1] if len(head)>1 and head[1] else 'video/mp2t'
            except Exception:
                return None
            if size<=0 or not os.path.isfile(path) or os.path.getsize(path)!=size:
                return None
            entry={'path':path,'have':size,'size':size,'status':'done','err':'',
                   'ctype':ctype,'cond':threading.Condition(),'born':time.time()}
            app.acache[key]=entry
            return entry

    def _acache_entry(self,url):
        """拿条目；没有就创建，返回 (entry, 是否新建)。新建者负责写入缓存文件。"""
        key=hashlib.md5(url.encode('utf-8')).hexdigest()
        app=self.app
        with app.acache_lock:
            entry=app.acache.get(key)
            if entry is not None:
                if entry['status']=='error':
                    app.acache.pop(key,None)
                else:
                    return entry,False
            path=os.path.join(app.acache_dir,key+'.ts')
            entry={'path':path,'have':0,'size':-1,'status':'downloading','err':'',
                   'ctype':'video/mp2t','cond':threading.Condition(),'born':time.time()}
            app.acache[key]=entry
        self._acache_gc()
        return entry,True

    def _acache_tee(self,entry,response,first):
        """首个请求者：一边把分段写盘缓存，一边直接流给客户端。"""
        cleaned=unwrap_segment(first)
        removed=len(first)-len(cleaned)
        entry['ctype']=response.headers.get('Content-Type') or entry['ctype']
        self.send_response(200)
        self.send_header('Content-Type',entry['ctype'])
        for name in ('Content-Length','Accept-Ranges'):
            if response.headers.get(name):self.send_header(name,str(int(response.headers[name])-removed) if name=='Content-Length' else response.headers[name])
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers()
        try:
            f=open(entry['path'],'wb',buffering=0)
        except OSError:
            f=None
        try:
            data=cleaned
            while True:
                if data:
                    if f is not None:
                        try:f.write(data)
                        except OSError:f=None
                    self.wfile.write(data)
                    with entry['cond']:
                        entry['have']+=len(data);entry['cond'].notify_all()
                data=response.read(65536)
                if not data:break
        except (BrokenPipeError,ConnectionResetError):
            pass
        except Exception as e:
            entry['err']=str(e)
        finally:
            if f is not None:
                try:f.close()
                except Exception:pass
            try:response.close()
            except Exception:pass
            with entry['cond']:
                if entry['err']:
                    entry['status']='error'
                else:
                    entry['size']=entry['have'];entry['status']='done'
                    try:
                        with open(entry['path'][:-3]+'.ok','w',encoding='ascii') as mk:
                            mk.write('%d\n%s'%(entry['size'],entry['ctype']))
                    except Exception:pass
                entry['cond'].notify_all()
        if entry['err']:self.app.log('[acache] 缓存失败：%s'%entry['err'])

    def _acache_serve(self,entry,rng=None):
        """从磁盘缓存发内容；支持 Range；还在下载的部分等下载追上。"""
        size=entry['size']
        start,end=0,-1
        if rng and size>0:
            m=re.fullmatch(r'bytes=(\d*)-(\d*)',rng)
            if m and any(m.groups()):
                first,last=m.groups()
                if first:
                    start=int(first);end=min(int(last),size-1) if last else size-1
                else:
                    start=max(0,size-int(last));end=size-1
                if start>end or start>=size:
                    self.send_response(416)
                    self.send_header('Content-Range','bytes */%d'%size)
                    self.send_header('Content-Length','0')
                    self.send_header('Access-Control-Allow-Origin','*')
                    self.end_headers()
                    return
        if start or end>=0:
            self.send_response(206)
            self.send_header('Content-Range','bytes %d-%d/%d'%(start,end,size))
        else:
            self.send_response(200)
        self.send_header('Content-Type',entry['ctype'] or 'video/mp2t')
        if size>0:self.send_header('Content-Length',str((end-start+1) if end>=0 else size))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers()
        offset=start
        limit=end+1 if end>=0 else None
        try:
            f=open(entry['path'],'rb',buffering=0)
        except OSError:
            # 下载线程还没建文件：等它产出第一块数据再打开
            deadline=time.time()+30
            while True:
                with entry['cond']:
                    if entry['status']!='downloading' or entry['have']>0:
                        break
                    entry['cond'].wait(0.5)
                if time.time()>deadline:
                    break
            try:
                f=open(entry['path'],'rb',buffering=0)
            except OSError:
                return
        try:
            while True:
                with entry['cond']:
                    while entry['status']=='downloading' and offset>=entry['have']:
                        entry['cond'].wait(0.5)
                    if entry['status']!='downloading' and offset>=entry['have']:
                        break
                    avail=entry['have']
                if limit is not None:avail=min(avail,limit)
                if avail<=offset:
                    if limit is not None and offset>=limit:break
                    continue
                f.seek(offset)
                data=f.read(avail-offset)
                if data:
                    self.wfile.write(data);offset+=len(data)
                if limit is not None and offset>=limit:
                    break
        except (BrokenPipeError,ConnectionResetError):
            pass
        finally:
            f.close()

    def _acache_prefetch(self,urls,front=False):
        """把待缓存分段放进队列，最多 pf_max 条并发；front=True 时插到队首优先下。"""
        app=self.app
        urls=[u for u in urls if u not in app.pf_queued]
        if not urls:return
        spawn=0
        with app.pf_lock:
            if front:app.pf_queue=urls+app.pf_queue
            else:app.pf_queue.extend(urls)
            del app.pf_queue[200:]
            app.pf_queued=set(app.pf_queue)
            while app.pf_running<app.pf_max and app.pf_queue:
                app.pf_running+=1
                spawn+=1
        for _ in range(spawn):
            threading.Thread(target=self._acache_prefetch_worker,daemon=True).start()

    def _acache_prefetch_worker(self):
        app=self.app
        while True:
            with app.pf_lock:
                if not app.pf_queue:
                    app.pf_running-=1
                    return
                url=app.pf_queue.pop(0)
                app.pf_queued.discard(url)
            try:
                if self._acache_lookup(url) is None:
                    entry,created=self._acache_entry(url)
                    if created:self._acache_download(entry,url)
            except Exception:
                pass

    def _acache_download(self,entry,url):
        """后台预取分段：只写缓存文件，不流向任何客户端。"""
        try:
            headers={'User-Agent':'Mozilla/5.0','Referer':anime_referer(url),'Accept-Encoding':'identity'}
            with open_public(url,headers,MEDIA_TLS_CONTEXT) as response:
                entry['ctype']=response.headers.get('Content-Type') or entry['ctype']
                with open(entry['path'],'wb',buffering=0) as f:
                    data=unwrap_segment(response.read(65536))
                    while True:
                        if data:
                            f.write(data)
                            with entry['cond']:
                                entry['have']+=len(data);entry['cond'].notify_all()
                        data=response.read(65536)
                        if not data:break
            with entry['cond']:
                entry['size']=entry['have'];entry['status']='done';entry['cond'].notify_all()
            try:
                with open(entry['path'][:-3]+'.ok','w',encoding='ascii') as mk:
                    mk.write('%d\n%s'%(entry['size'],entry['ctype']))
            except Exception:pass
            self.app.log('[acache] 已缓存 %.1fMB'%(entry['have']/1048576.0))
        except Exception as e:
            with entry['cond']:
                entry['status']='error';entry['err']=str(e);entry['cond'].notify_all()
            self.app.log('[acache] 缓存失败：%s'%e)

    def _hls_index(self,segments):
        """记住分段顺序：播放清单来时预取前几个，命中分段时预取后续几个。"""
        app=self.app
        segments=list(segments)
        with app.hls_lock:
            nxt=app.hls_next
            for i,s in enumerate(segments):nxt[s]=segments[i+1:i+13]
            if len(nxt)>4000:nxt.clear()
            if segments==app.hls_list:
                # 同一份清单重复拉取：保留播放进度，也不再重复启动空闲预缓存
                app.hls_touch=time.time()
                return
            app.hls_list=segments
            app.hls_index={u:i for i,u in enumerate(segments)}
            app.hls_at=0
            app.hls_touch=time.time()
            app.hls_seq+=1
            seq=app.hls_seq
            spawn=app.hls_worker!=seq
            if spawn:app.hls_worker=seq
        self._acache_prefetch(segments[:6],True)
        if spawn:
            threading.Thread(target=self._hls_idle_worker,args=(seq,),name='acache-idle',daemon=True).start()

    def _hls_idle_worker(self,seq):
        """播放器空闲一段时间后，按顺序把整集剩余分段补齐，恢复播放即让路。"""
        app=self.app
        try:
            while not app._stopping:
                time.sleep(4)
                if app.hls_seq!=seq:return
                if time.time()-app.hls_touch<12:continue
                # 明确的下载任务或预取队列优先，避免空闲预缓存抢带宽
                if app.pf_running:continue
                downloads=getattr(app,'downloads',None)
                if downloads is not None:
                    with downloads.lock:
                        busy=any(j['status'] in ('queued','downloading') for j in downloads.jobs.values())
                    if busy:continue
                with app.hls_lock:
                    segments=list(app.hls_list)
                    start=app.hls_at
                count=len(segments)
                if not count:return
                added=resumed=False
                for i in range(count):
                    if app.hls_seq!=seq:return
                    if time.time()-app.hls_touch<12:resumed=True;break
                    url=segments[(start+1+i)%count]
                    if self._acache_lookup(url) is not None:continue
                    entry,created=self._acache_entry(url)
                    if not created:continue
                    self._acache_download(entry,url)
                    added=True
                    if entry['status']=='error':break
                if not added and not resumed:return
        finally:
            with app.hls_lock:
                if app.hls_worker==seq:app.hls_worker=0

    def _acache_gc(self):
        """缓存目录超过上限时，删最旧的分段（不动下载中的）。"""
        app=self.app
        max_bytes=3*1024*1024*1024
        try:
            files=[]
            total=0
            for name in os.listdir(app.acache_dir):
                if not name.endswith('.ts'):continue
                p=os.path.join(app.acache_dir,name)
                st=os.stat(p);files.append((st.st_mtime,st.st_size,p));total+=st.st_size
            files.sort()
            for mtime,size,p in files:
                if total<=max_bytes:break
                key=os.path.basename(p)[:-3]
                entry=app.acache.get(key)
                if entry and entry['status']=='downloading':continue
                try:
                    os.remove(p)
                    try:os.remove(p[:-3]+'.ok')
                    except Exception:pass
                    total-=size;app.acache.pop(key,None)
                    app.log('[acache] 清理旧缓存 %.1fMB'%(size/1048576.0))
                except Exception:pass
        except Exception:pass

    def _relay_headers(self):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
            "Accept-Encoding": "identity",
        }
        ck = self.app.bili.cookie_header()
        if ck:
            headers["Cookie"] = ck
        return headers

    def _relay(self, qs):
        raw = (qs.get("u") or [""])[0]
        if not raw:
            return self._err("缺少地址", 400)
        try:
            target = b64d(raw)
        except Exception:
            return self._err("地址无效", 400)
        host = urllib.parse.urlparse(target).hostname or ""
        if not any(host == s or host.endswith("." + s) for s in ALLOWED_HOST_SUFFIX):
            return self._err("不在允许的域名内", 403)
        self._relay_candidates = [target]
        try:
            backups = json.loads(b64d((qs.get("b") or [""])[0]))
            if isinstance(backups, list):
                for candidate in backups[:6]:
                    if not isinstance(candidate, str):
                        continue
                    p = urllib.parse.urlparse(candidate)
                    if (p.scheme == "https" and p.path == urllib.parse.urlparse(target).path
                            and any(p.hostname == s or (p.hostname or "").endswith("." + s)
                                    for s in ALLOWED_HOST_SUFFIX)
                            and candidate not in self._relay_candidates):
                        self._relay_candidates.append(candidate)
        except (ValueError, TypeError):
            pass
        rng = self.headers.get("Range")
        # 只有视频/音频大文件才落盘缓存；弹幕/封面等小资源直接透传
        if not self._is_media_url(target):
            return self._relay_passthrough(target, rng)
        return self._relay_cached(target, rng)

    def _open_media(self, target, headers, timeout=30):
        """Try the signed CDN alternatives without weakening HTTPS verification."""
        candidates = [target] + [u for u in getattr(self, "_relay_candidates", []) if u != target]
        return open_media(candidates, headers, MEDIA_TLS_CONTEXT, budget=min(timeout, 10))

    # ---------------- 视频全量磁盘缓存 ----------------
    @staticmethod
    def _is_media_url(target):
        """判断是不是视频/音频流。

        B 站现在会把一部分流分给第三方 PCDN（edge.xxx.cn 这类随机域名），
        按域名判断会漏掉，所以主要看路径特征。"""
        p = urllib.parse.urlparse(target)
        path = (p.path or "").lower()
        host = (p.hostname or "").lower()
        if "/upgcxcode/" in path:
            return True
        for ext in (".m4s", ".mp4", ".flv", ".ts"):
            if path.endswith(ext):
                return True
        return (("bilivideo.com" in host) or ("bilivideo.cn" in host)
                or ("upos-" in host) or ("mcdn" in host))

    def _vcache_get(self, key, target):
        """拿缓存条目；没有就创建并启动全量下载线程（只启一次）。"""
        app = self.app
        with app.vcache_lock:
            entry = app.vcache.get(key)
            if entry is not None:
                return entry
            path = os.path.join(app.vcache_dir, key + ".bin")
            ok = os.path.join(app.vcache_dir, key + ".ok")
            have = os.path.getsize(path) if os.path.isfile(path) else 0
            size = -1
            if have and os.path.isfile(ok):
                try:
                    with open(ok, "r", encoding="utf-8") as f:
                        size = int((f.read() or "0").strip() or 0)
                except Exception:
                    size = -1
            if have and size <= 0:
                # 没有完成标记（上次异常退出或旧版本残留），大小不可信，从头下
                try:
                    os.remove(path)
                except Exception:
                    pass
                have = 0
            if size > 0 and have == size:
                # 上次已经下完，直接用
                entry = {"path": path, "size": size, "have": size,
                         "status": "done", "err": "",
                         "cond": threading.Condition(), "born": time.time()}
                app.vcache[key] = entry
                return entry
            if have and size > 0 and have != size:
                # 残片和记录的完整大小不符，丢掉重下
                try:
                    os.remove(path)
                except Exception:
                    pass
                have = 0
            entry = {"path": path, "size": -1, "have": have,
                     "status": "downloading", "err": "",
                     "cond": threading.Condition(), "born": time.time()}
            app.vcache[key] = entry
            # 先把文件建出来，避免播放线程抢在下载线程前面打开时报错
            try:
                if not os.path.isfile(path):
                    with open(path, "ab"):
                        pass
            except Exception:
                pass
            self._vcache_gc()
            threading.Thread(target=self._vcache_download,
                             args=(entry, target), daemon=True).start()
            return entry

    def _vcache_download(self, entry, target):
        """把整个视频下载到磁盘，和客户端播放进度无关。

        直接写入最终文件（不改名：Windows 上文件被读取时改名会失败），
        下载完成后写 .ok 标记。CDN 节点偶发 SSL/超时故障，失败重试并不丢已下部分。
        """
        last_err = ""
        for attempt in range(4):
            try:
                if attempt:
                    time.sleep(1.0 * attempt)
                    self.app.log("[vcache] 第 %d 次重试（从 %d）" % (attempt + 1, entry["have"]))
                start_at = entry["have"]
                headers = self._relay_headers()
                headers["Range"] = "bytes=%d-" % start_at
                resp = self._open_media(target, headers)
                if start_at and resp.status == 200:
                    # 服务器不认 Range，只能从头写
                    start_at = 0
                cr = resp.headers.get("Content-Range") or ""
                if "/" in cr and cr.rsplit("/", 1)[-1].isdigit():
                    size = int(cr.rsplit("/", 1)[-1])
                else:
                    cl = resp.headers.get("Content-Length") or ""
                    size = (start_at + int(cl)) if cl.isdigit() else -1
                with entry["cond"]:
                    entry["size"] = size
                    entry["have"] = start_at
                    entry["cond"].notify_all()
                # buffering=0：写进去立刻能被播放线程读到，避免声音卡顿
                with open(entry["path"], "ab" if start_at else "wb", buffering=0) as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        with entry["cond"]:
                            entry["have"] += len(chunk)
                            entry["cond"].notify_all()
                try:
                    resp.close()
                except Exception:
                    pass
                if entry["size"] > 0 and entry["have"] < entry["size"]:
                    raise IOError("数据不完整 %d/%d" % (entry["have"], entry["size"]))
                try:
                    with open(entry["path"][:-4] + ".ok", "w", encoding="utf-8") as f:
                        f.write(str(entry["have"]))
                except Exception:
                    pass
                with entry["cond"]:
                    entry["status"] = "done"
                    entry["size"] = entry["have"]
                    entry["cond"].notify_all()
                self.app.log("[vcache] 已缓存 %.1fMB" % (entry["have"] / 1048576.0))
                return
            except Exception as e:
                last_err = str(e)
                self.app.log("[vcache] 下载中断：%s" % e)
                reason = getattr(e, "reason", e)
                if isinstance(reason, ssl.SSLCertVerificationError):
                    break
        with entry["cond"]:
            entry["status"] = "error"
            entry["err"] = last_err
            entry["cond"].notify_all()
        self.app.log("[vcache] 缓存失败：%s" % last_err)

    def _vcache_gc(self):
        """缓存目录超过上限时，删最旧的完整缓存（不动下载中的）。"""
        app = self.app
        max_bytes = 4 * 1024 * 1024 * 1024
        try:
            files = []
            total = 0
            for name in os.listdir(app.vcache_dir):
                if not name.endswith(".bin"):
                    continue
                p = os.path.join(app.vcache_dir, name)
                st = os.stat(p)
                files.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            files.sort()
            for mtime, size, p in files:
                if total <= max_bytes:
                    break
                key = os.path.basename(p)[:-4]
                entry = app.vcache.get(key)
                if entry and entry["status"] == "downloading":
                    continue
                try:
                    os.remove(p)
                    try:
                        os.remove(p[:-4] + ".ok")
                    except Exception:
                        pass
                    total -= size
                    app.vcache.pop(key, None)
                    app.log("[vcache] 清理旧缓存 %.1fMB" % (size / 1048576.0))
                except Exception:
                    pass
        except Exception:
            pass

    def _relay_cached(self, target, rng):
        """从磁盘缓存给客户端发视频；没下载到的部分等下载追上。"""
        # A playback request never creates or waits for a whole-file download.
        path_part = urllib.parse.urlparse(target).path or target
        key = hashlib.md5(path_part.encode("utf-8")).hexdigest()
        path = os.path.join(self.app.vcache_dir, key + ".bin")
        try:
            with open(path[:-4] + ".ok", encoding="ascii") as marker:
                size = int(marker.read().strip())
            if size <= 0 or os.path.getsize(path) != size:
                return self._relay_passthrough(target, rng)
            stream = open(path, "rb")
        except (OSError, ValueError):
            return self._relay_passthrough(target, rng)
        try:
            start, end = 0, size - 1
            if rng:
                import re
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", rng)
                if not match or not any(match.groups()):
                    return self._relay_passthrough(target, rng)
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:
                    start = max(0, size - int(last))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
            self.send_response(206 if rng else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            if rng:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            stream.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            stream.close()

    def _media_cancelled(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def _relay_passthrough(self, target, rng):
        if not self._is_media_url(target):
            return self._relay_small(target, rng)
        headers = self._relay_headers()
        if rng:
            headers["Range"] = rng
        transport = getattr(self.app, "media_transport", None)
        if transport is None:
            transport = self.app.media_transport = MediaTransport(MEDIA_TLS_CONTEXT)
        candidates = [target] + [u for u in getattr(self, "_relay_candidates", []) if u != target]
        stream = None
        try:
            stream = transport.stream(candidates, headers, self._media_cancelled)
        except urllib.error.HTTPError as error:
            self.send_response(error.code)
            self.send_header("Content-Length", "0")
            if error.headers.get("Content-Range"):
                self.send_header("Content-Range", error.headers["Content-Range"])
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            error.close()
            return
        except ConnectionAbortedError:
            return
        except Exception as error:
            self.app.log("[media] 无可用线路：%s" % type(error).__name__)
            return self._err("视频线路暂时不可用，请重试", 502)
        try:
            self.send_response(stream.status)
            self.send_header("Content-Type", stream.content_type)
            self.send_header("Content-Length", str(stream.end-stream.start+1))
            self.send_header("Accept-Ranges", "bytes")
            if stream.status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (stream.start, stream.end, stream.total))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            for chunk in stream.chunks():
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            self.close_connection = True
            self.app.log("[media] 数据恢复失败：%s" % type(error).__name__)
        finally:
            if stream.recoveries:
                self.app.log("[media] 已切换线路接续 %d 次，传输 %d 字节" % (stream.recoveries, stream.delivered))
            stream.close()

    def _relay_small(self, target, rng):
        headers = self._relay_headers()
        if rng:
            headers["Range"] = rng
        try:
            with self._open_media(target, headers) as response:
                self.send_response(response.status)
                for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                    if response.headers.get(name):
                        self.send_header(name, response.headers[name])
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception:
            self.close_connection = True

    # ---------------- 演示素材 ----------------
    def _mock_cover(self):
        path = os.path.join(DATA_DIR, "mock_cover.jpg")
        if not os.path.isfile(path):
            return self._err("没有封面", 404)
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _mock_video(self):
        path = self.app.bili.sample
        if not path or not os.path.isfile(path):
            return self._err("没有示例视频", 404)
        size = os.path.getsize(path)
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            part = rng[6:].split("-")
            try:
                if part[0]:
                    start = int(part[0])
                    end = int(part[1]) if len(part) > 1 and part[1] else size - 1
                else:
                    start = max(0, size - int(part[1]))
                end = min(end, size - 1)
                status = 206
            except Exception:
                start, end, status = 0, size - 1, 200
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(64 * 1024, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---------------- 静态文件 ----------------
    def _static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        rel = urllib.parse.unquote(path.lstrip("/"))
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not (full == WEB_DIR or full.startswith(WEB_DIR + os.sep)) or not os.path.isfile(full):
            return self._err("文件不存在", 404)
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            st = os.stat(full)
            mtime = email.utils.formatdate(st.st_mtime, usegmt=True)
        except Exception:
            mtime = None
        # html/js/css 是 no-cache，配合 Last-Modified 让浏览器回源验证时能拿 304，
        # 否则朋友每次打开都要全量重新下载页面
        if mtime and (self.headers.get("If-Modified-Since") or "") == mtime:
            self.send_response(304)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception:
            return self._err("读取失败", 500)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if mtime:
            self.send_header("Last-Modified", mtime)
        if ext in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    # ---------------- WebSocket ----------------
    def _ws(self):
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            return self._err("需要 WebSocket 升级", 400)
        ws = WS(self.rfile, self.wfile, self.connection)
        ws.handshake(key)
        self.app.touch()
        session = Session(ws, self.app)
        self.app.sessions.add(session)
        self.close_connection = True
        ws.send_json({"op": "hello", "version": APP_VERSION})
        try:
            while ws.alive:
                payload = ws.recv()
                if payload is None:
                    break
                self.app.touch()
                try:
                    msg = json.loads(payload.decode("utf-8", "replace"))
                except Exception:
                    continue
                self._ws_message(session, msg)
        except (ConnectionResetError, OSError):
            pass
        finally:
            session.leave()
            self.app.sessions.discard(session)
            ws.close()

    def _ws_message(self, session, msg):
        op = msg.get("op")
        if op == "ping":
            # 测延迟用：立即回显时间戳，不受视频中转影响
            try:
                session.ws.send_json({"op": "pong", "t": msg.get("t")})
            except Exception:
                pass
            return
        if op == "join":
            ok = session.join(
                msg.get("server") or "127.0.0.1",
                msg.get("port") or self.app.cfg.get("syncplay_port") or 8999,
                msg.get("username") or self.app.cfg.get("username") or "观众",
                msg.get("room") or "",
                msg.get("password"),
                msg.get("avatar") or "",
                msg.get("face") or "",
            )
            session.ws.send_json({"op": "join_ack", "ok": ok})
        elif op == "leave":
            session.leave()
        elif op == "avatar":
            session.call("send_avatar", msg.get("avatar") or "")
        elif op == "face":
            session.call("send_face", msg.get("face") or "")
        elif op == "state":
            session.call("send_state",
                         float(msg.get("position") or 0),
                         bool(msg.get("paused")),
                         bool(msg.get("doSeek")), None, bool(msg.get("heartbeat")))
        elif op == "file":
            name = msg.get("name") or ""
            session.call("send_file", {
                "name": name,
                "duration": float(msg.get("duration") or 0),
                "size": msg.get("size") or 0,
                "path": "",
            })
        elif op == "chat":
            session.call("send_chat", msg.get("message") or "")
        elif op == "list":
            session.call("request_list")


def _relay_url(url):
    if isinstance(url, dict):
        candidates = [url.get("base") or url.get("url")] + list(url.get("backup") or [])
        candidates = sorted(dict.fromkeys(u for u in candidates if u), key=_score_media_url, reverse=True)
        if not candidates:
            return ""
        result = "/relay?u=" + b64e(candidates[0])
        if len(candidates) > 1:
            result += "&b=" + b64e(json.dumps(candidates[1:]))
        return result
    return "/relay?u=" + b64e(url)


def _media_tls_context():
    context = ssl.create_default_context()
    bundle = os.path.join(ROOT, "certs", "cacert.pem")
    if os.path.isfile(bundle):
        context.load_verify_locations(cafile=bundle)
    return context


MEDIA_TLS_CONTEXT = _media_tls_context()


def _score_media_url(url):
    """给一条播放地址打分：优先正规 CDN，尽量避开 PCDN 节点。

    PCDN（mcdn、第三方随机域名）常常只有几十 KB/s，
    比音频码率还低，会直接导致声音断断续续。"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:
        return -999
    score = 0
    if "upos-" in host:
        score += 100
    if "mirror" in host:
        score += 30
    if host.endswith(("bilivideo.com", "bilivideo.cn", "bilibili.com")):
        score += 50
    else:
        score -= 40
    if "mcdn" in host:
        score -= 120
    if "szbdyd" in host:
        score -= 60
    return score


def _best_media_url(entry):
    """从 base + backup 里挑一条最好的地址。"""
    if not entry:
        return ""
    cands = [entry.get("base")] + list(entry.get("backup") or [])
    cands = [c for c in cands if c]
    if not cands:
        return ""
    return max(cands, key=_score_media_url)


def _pick_video(videos, qn):
    if not videos:
        return None
    same = [v for v in videos if v.get("id") == qn]
    if same:
        return max(same, key=lambda v: v.get("bandwidth") or 0)
    lower = [v for v in videos if (v.get("id") or 0) <= qn]
    if lower:
        return max(lower, key=lambda v: (v.get("id") or 0, v.get("bandwidth") or 0))
    return max(videos, key=lambda v: (v.get("id") or 0, v.get("bandwidth") or 0))


def _pick_audio(audios):
    if not audios:
        return None
    for pref in (30280, 30232, 30216, 30250, 30251):
        for a in audios:
            if a.get("id") == pref:
                return a
    return max(audios, key=lambda a: a.get("bandwidth") or 0)


def _build_source(play, qn, prefer_mp4):
    """从 playurl 结果里挑一路可用媒体源，返回 (source, 实际清晰度, 清晰度列表)。"""
    quality_ok = {q["qn"] for q in play.get("accept") or []}
    if qn not in quality_ok and quality_ok:
        qn = max((q for q in quality_ok if q <= qn), default=min(quality_ok))
    mp4 = play.get("mp4") or []
    dash = play.get("dash") or {}
    source = None
    real_qn = qn
    if prefer_mp4 and mp4:
        source = {"mode": "mp4", "url": _relay_url(mp4[0])}
        real_qn = play.get("mp4_quality") or play.get("quality") or qn
    elif dash.get("video") and dash.get("audio"):
        v = _pick_video(dash["video"], qn)
        a = _pick_audio(dash["audio"])
        if v and a:
            source = {
                "mode": "dash",
                "video": _relay_url(v),
                "audio": _relay_url(a),
                "width": v.get("width"), "height": v.get("height"),
            }
            real_qn = v.get("id") or qn
    if not source and mp4:
        source = {"mode": "mp4", "url": _relay_url(mp4[0])}
        real_qn = play.get("mp4_quality") or play.get("quality") or qn
    dash_ids = {x["id"] for x in (dash.get("video") or [])}
    mp4_qn = play.get("mp4_quality") or play.get("quality")
    qualities = [{"qn": q["qn"], "label": q["label"],
                  "available": q["qn"] in dash_ids or (bool(mp4) and q["qn"] == mp4_qn)}
                 for q in play.get("accept") or []]
    return source, real_qn, qualities




# ---------------------------------------------------------------------------
# 启动窗口 / 单实例
# ---------------------------------------------------------------------------

def find_browser():
    cands = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


def _hidden_startupinfo():
    """子进程不弹黑窗（Windows）。"""
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    return si


class Relay(object):
    """用用户自己的服务器做中转（SSH 反向隧道，Windows 自带 + 内置 plink）。"""

    def __init__(self, app):
        self.app = app
        self.proc = None
        self._logf = None
        self.status = "stopped"
        self.url = ""
        self.error = ""
        self.lock = threading.RLock()
        self._desired = False
        self._generation = 0
        # 自动分配远端端口时记录试过的端口，避免重连反复撞同一个
        self._tried = []

    def info(self):
        with self.lock:
            if self.status == "running" and (self.proc is None or self.proc.poll() is not None):
                self.status = "starting" if self._desired else "stopped"
                self.error = "连接已中断，正在恢复" if self._desired else ""
        return {"status": self.status, "url": self.url, "error": self.error,
                "token": self.app.cfg.get("access_token") or ""}

    def running(self):
        return self.info()["status"] == "running"

    def _plink(self):
        for p in (os.path.join(APP_ROOT, "plink.exe"),
                  os.path.join(getattr(sys, "_MEIPASS", APP_ROOT), "plink.exe")):
            if p and os.path.isfile(p):
                return p
        return None

    def _run_plink(self, args, timeout=20):
        """运行 plink 并把输出写到文件（避免管道问题）。"""
        out = os.path.join(DATA_DIR, "relay.tmp")
        try:
            os.remove(out)
        except Exception:
            pass
        with open(out, "wb") as f:
            subprocess.run(args, stdout=f, stderr=f, timeout=timeout,
                           startupinfo=_hidden_startupinfo())
        try:
            with open(out, "r", encoding="utf-8", errors="ignore") as f:
                return f.read()
        except Exception:
            return ""

    def start(self):
        cfg = self.app.cfg
        host = (cfg.get("relay_host") or BUILTIN_RELAY["host"]).strip()
        user = (cfg.get("relay_user") or BUILTIN_RELAY.get("user") or "").strip()
        pwd = cfg.get("relay_pass") or BUILTIN_RELAY.get("pass") or ""
        port = int(cfg.get("relay_port") or BUILTIN_RELAY["port"])
        remote = int(cfg.get("relay_remote_port") or 0)
        local = int(cfg.get("port") or 8770)
        with self.lock:
            if self.status in ("starting", "running"):
                return False
            if not host or not user or not pwd:
                self.error = "未配置中转服务器账号密码，改用备用线路"
                self.status = "error"
                return False
            self._tried = []
            self.status = "starting"
            self.error = ""
            self._desired = True
            self._generation += 1
            generation = self._generation
        threading.Thread(target=self._run, args=(host, port, user, pwd, remote, local, generation),
                         daemon=True).start()
        return True

    def _probe(self, url, token):
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            request = urllib.request.Request(url + "/api/health?k=" + urllib.parse.quote(token), headers={"Cache-Control":"no-cache"})
            with opener.open(request, timeout=4) as response:
                data = json.loads(response.read(16384))
            return data.get("app") == APP_NAME and data.get("instance") == self.app.instance_id
        except Exception:
            return False

    def _release(self, generation=None):
        with self.lock:
            if generation is not None and self._generation != generation:
                return
            proc, self.proc = self.proc, None
            logf, self._logf = self._logf, None
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                pass
        if logf:
            try: logf.close()
            except Exception: pass

    def _run(self, host, port, user, pwd, remote, local, generation):
        failures = 0
        while self._desired and self._generation == generation:
            self._connect_once(host, port, user, pwd, remote, local, generation)
            if not self._desired or self._generation != generation:
                return
            if self.status == "running":
                failures = 0
                while self._desired and self._generation == generation:
                    # Polling the process alone misses a live SSH session whose
                    # forwarded port is no longer reachable.
                    time.sleep(8)
                    if not self._desired or self._generation != generation:
                        return
                    if self.proc is None or self.proc.poll() is not None or not self._probe(self.url, self.app.cfg.get("access_token") or ""):
                        self.app.log("[relay] 外网连接中断，自动重新连接")
                        break
            with self.lock:
                if not self._desired or self._generation != generation:
                    return
                self._release(generation)
                failures += 1
                self.url = ""
                if failures >= 3:
                    self._desired = False
                    self.status = "error"
                    self.error = "服务器公网连接验证连续失败，请重试或使用备用连接"
                    return
                self.status = "starting"
                self.error = "正在恢复外网连接"
            time.sleep(min(2 ** min(failures, 4), 15))

    def _pick_remote(self):
        """自动选一个远端端口：随机取，并避开本次已经试过的值。"""
        for _ in range(40):
            candidate = random.randrange(20000, 30000)
            if candidate not in self._tried:
                self._tried.append(candidate)
                del self._tried[:-20]
                return candidate
        return random.randrange(20000, 30000)

    def _connect_once(self, host, port, user, pwd, remote, local, generation):
        plink = self._plink()
        if not plink:
            self.error = "程序里缺少 plink.exe"
            self.status = "error"
            return
        if not remote:
            remote = self._pick_remote()
        # 内置指纹只对内置服务器有效，换成自己的服务器时现场取
        key = (self.app.cfg.get("relay_hostkey") or "").strip()
        if not key and host == BUILTIN_RELAY["host"]:
            key = BUILTIN_RELAY.get("hostkey", "")
        base = [plink, "-ssh", "-l", user, "-pw", pwd, "-batch", "-noshare", "-P", str(port)]
        if not key:
            text = self._run_plink(base + [host, "echo ok"], timeout=25)
            import re
            m = re.search(r"SHA256:[A-Za-z0-9+/=]+", text)
            if not m:
                self.error = "连接服务器失败：" + (text.strip().splitlines()[-1] if text.strip() else "无响应")
                self.status = "error"
                return
            key = m.group(0)
            self.app.cfg["relay_hostkey"] = key
            save_config(self.app.cfg)
        args = base + ["-hostkey", key, "-N",
                       "-R", "0.0.0.0:%d:127.0.0.1:%d" % (remote, local), host]
        log_path = os.path.join(DATA_DIR, "relay.log")
        try:
            logf = open(log_path, "wb")
            proc = subprocess.Popen(args, stdout=logf, stderr=logf,
                                    startupinfo=_hidden_startupinfo())
        except Exception as e:
            self.error = "启动隧道失败：%s" % e
            self.status = "error"
            return
        with self.lock:
            if not self._desired or self._generation != generation:
                proc.terminate()
                logf.close()
                return
            self.proc = proc
            self._logf = logf
        time.sleep(3.5)
        with self.lock:
            if not self._desired or self._generation != generation:
                return
        if proc.poll() is not None:
            detail = ""
            try:
                logf.close()
                with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                    lines = [ln.strip() for ln in f if ln.strip()]
                if lines:
                    detail = "：" + lines[-1][:120]
            except Exception:
                pass
            self.error = "隧道进程退出了（服务器可能未开启 GatewayPorts 或端口被占用）" + detail
            self.status = "error"
            return
        token = self.app.cfg.get("access_token") or ""
        if not token:
            token = "".join(random.choice("23456789abcdefghjkmnpqrstuvwxyz") for _ in range(8))
            self.app.cfg["access_token"] = token
            save_config(self.app.cfg)
        url = "http://%s:%d" % (host, remote)
        if not self._probe(url, token):
            with self.lock:
                if self._desired and self._generation == generation:
                    self.status = "starting"
                    self.error = "外网端口尚不可达，正在重新连接"
            return
        with self.lock:
            if not self._desired or self._generation != generation:
                return
            self.url = url
            self.status = "running"
            self.error = ""
        self.app.log("[relay] 外网访问已开启 %s" % self.url)

    def stop(self):
        with self.lock:
            self._desired = False
            self._generation += 1
            self.status = "stopped"
            self.url = ""
            self.error = ""
            self._release()
        return True


class Tunnel(object):
    """Publish an address only after it reaches this exact application instance."""
    def __init__(self, app):
        self.app=app; self.lock=threading.RLock(); self.proc=None
        self.url=""; self.status="stopped"; self.error=""; self._generation=0
        self._log=os.path.join(DATA_DIR,"tunnel.log")

    def info(self):
        with self.lock:
            if self.status=="running" and (self.proc is None or self.proc.poll() is not None):
                self.status="error";self.url="";self.error="外网隧道已中断，请重试"
            return {"status":self.status,"url":self.url,"error":self.error,"downloaded":os.path.isfile(self._exe())}

    def _exe(self):return os.path.join(DATA_DIR,"cloudflared.exe")

    def _publish(self,generation,status,error="",url=""):
        with self.lock:
            if generation!=self._generation:return False
            self.status=status;self.error=error;self.url=url
            return True

    def _fail(self,generation,error):
        with self.lock:
            if not self._publish(generation,"error",error):return
            proc,self.proc=self.proc,None
        if proc:
            try:proc.terminate()
            except Exception:pass

    def start(self):
        with self.lock:
            if self.status in ("downloading","starting","running"):return False
            self._generation+=1;generation=self._generation
            self._publish(generation,"starting")
        threading.Thread(target=self._run,args=(generation,),daemon=True).start();return True

    def stop(self):
        with self.lock:
            self._generation+=1;self._publish(self._generation,"stopped")
            proc,self.proc=self.proc,None
        if proc:
            try:proc.terminate()
            except Exception:pass
        return True

    def _download(self,generation):
        path=self._exe()
        if os.path.isfile(path) and os.path.getsize(path)>20*1024*1024:return True
        if not self._publish(generation,"downloading"):return False
        tmp=path+".part";last=""
        for url in (CLOUDFLARED_URL,CLOUDFLARED_MIRROR):
            try:
                req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
                with urllib.request.urlopen(req,timeout=180) as response,open(tmp,"wb") as output:
                    while True:
                        if generation!=self._generation:return False
                        chunk=response.read(262144)
                        if not chunk:break
                        output.write(chunk)
                os.replace(tmp,path);return True
            except Exception as error:last=str(error)
        self._publish(generation,"error","下载 cloudflared 失败："+last);return False

    def _probe(self,url):return Relay._probe(self,url,self.app.cfg.get("access_token") or "")

    def _confirm(self,generation,url):
        if not self._probe(url):return False
        return self._publish(generation,"running",url=url)

    def _run(self,generation):
        if not self._download(generation):return
        if not self._publish(generation,"starting","正在验证公网连接"):return
        log_path=self._log+"."+str(generation)
        args=[self._exe(),"tunnel","--url","http://127.0.0.1:%d"%int(self.app.cfg.get("port") or 8770),"--no-autoupdate","--logfile",log_path]
        try:proc=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,startupinfo=_hidden_startupinfo())
        except Exception as error:self._fail(generation,"启动隧道失败："+str(error));return
        with self.lock:
            if generation!=self._generation:proc.terminate();return
            self.proc=proc
        deadline=time.monotonic()+90;candidate=""
        while generation==self._generation and time.monotonic()<deadline:
            if proc.poll() is not None:self._fail(generation,"隧道进程退出了");return
            try:
                import re
                if os.path.isfile(log_path):
                    with open(log_path,"r",encoding="utf-8",errors="ignore") as log:match=re.search(r"https://[a-z0-9-]+\.trycloudflare\.com",log.read())
                    if match:candidate=match.group(0)
                if candidate and self._confirm(generation,candidate):break
            except Exception:pass
            time.sleep(1)
        else:
            self._fail(generation,"公网连通验证超时，地址尚不可用，请重试或更换网络");return
        misses=0
        while generation==self._generation:
            time.sleep(8)
            if generation!=self._generation:return
            if proc.poll() is None and self._confirm(generation,candidate):misses=0;continue
            misses+=1
            self._publish(generation,"starting","公网连接已中断，正在重新验证")
            if misses>=3:self._fail(generation,"公网连接无法恢复，请重试");return

    def keep_alive(self):return self.info()["status"]=="running"


def open_url(url):
    """交给系统默认浏览器（走 ShellExecute，兼容性最好）。"""
    try:
        os.startfile(url)
        return True
    except Exception:
        pass
    try:
        webbrowser.open(url)
        return True
    except Exception:
        return False


def open_app_window(app, port):
    """Open one window; a successful launch must never open a second browser."""
    url = "http://127.0.0.1:%d/" % port
    cfg = app.cfg if app is not None else load_config()
    if (cfg.get("open_mode") or "app") == "browser":
        return open_url(url)
    browser = find_browser()
    if not browser:
        return open_url(url)
    profile = os.path.join(DATA_DIR, "browser")
    try:
        os.makedirs(profile, exist_ok=True)
    except Exception:
        pass
    args = [
        browser,
        "--app=" + url,
        "--user-data-dir=" + profile,
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,940",
        "--lang=zh-CN",
    ]
    before = app.page_loads if app is not None else 0
    started = time.time()
    try:
        proc = subprocess.Popen(args, creationflags=0x08000000,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return open_url(url)
    if app is not None:
        threading.Thread(target=_verify_app_window, args=(app, url, proc, before, started), daemon=True).start()
    return True


def _verify_app_window(app, url, proc, before, started):
    """Observe startup without launching another UI (Chromium may hand off and exit)."""
    for _ in range(80):
        if app.page_loads > before or app.last_page_load >= started:
            return
        code = proc.poll() if proc is not None else None
        if code not in (None, 0):
            app.log("[app] 独立窗口启动失败（退出码 %s），请重新打开客户端" % code)
            return
        time.sleep(0.5)
    app.log("[app] 独立窗口尚未报告加载完成；保留当前窗口，不再额外打开浏览器")


def ui_ready():
    required = ("index.html", "css/app.css", "js/app.js", "js/interface.js",
                "js/theme.js", "js/player.js", "js/sync.js", "js/media-source.js", "js/home-art.js", "art/bangumi/index.json",
                "css/discovery.css", "js/discovery.js", "js/room-notice.js", "art/discovery/index.json", "js/downloads.js", "js/anime-sources.js", "js/hls.min.js", "js/source-engine.js", "js/personal-account.js", "js/chat-alerts.js", "js/fullscreen.js", "art/providers.json")
    return all(os.path.isfile(os.path.join(WEB_DIR, part)) for part in required)


def running_info(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=0.6) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        if isinstance(data, dict) and data.get("app") == APP_NAME:
            return data
    except Exception:
        pass
    return None


def find_running(base_port):
    """Locate this installation, including legacy versions without a scope field."""
    for p in range(base_port, base_port + 10):
        data = running_info(p)
        if data and data.get("installation", INSTALLATION_SCOPE) == INSTALLATION_SCOPE:
            return p
    return None


def reuse_running(port):
    """Reuse a healthy current instance; gracefully hand off from an older one."""
    old = running_info(port)
    if not old:
        return False
    if old.get("installation", INSTALLATION_SCOPE) != INSTALLATION_SCOPE:
        raise RuntimeError("该端口属于另一份程序数据，未关闭它。")
    if old.get("version") == APP_VERSION and old.get("ui_ready", True):
        return True
    # Legacy shutdown exits immediately, so release its forwarding children first.
    if "installation" not in old:
        for route in ("relay", "tunnel"):
            stop = urllib.request.Request("http://127.0.0.1:%d/api/%s/stop" % (port, route),
                                          data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(stop, timeout=2) as response:
                    response.read()
            except Exception:
                pass
    request = urllib.request.Request("http://127.0.0.1:%d/api/shutdown" % port,
                                     data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 200:
            raise RuntimeError("旧版未完成退出，请关闭旧程序后重新打开。")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        current = running_info(port)
        if not current:
            return False
        if current.get("instance") != old.get("instance"):
            if current.get("version") == APP_VERSION and current.get("ui_ready", True):
                return True
            raise RuntimeError("程序正在切换，请稍后重新打开。")
        time.sleep(0.1)
    raise RuntimeError("旧版退出超时。已保留所有文件，请关闭旧程序后重新打开。")


def fatal(msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(msg), "一起看", 0x10)
    except Exception:
        pass
    try:
        print(msg, flush=True)
    except Exception:
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, app):
        self.app = app
        super().__init__(addr, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="一起看 PC 版")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--syncplay-port", type=int, default=None)
    parser.add_argument("--no-syncplay", action="store_true")
    parser.add_argument("--no-browser", action="store_true", help="不要自动打开窗口")
    parser.add_argument("--local-only", action="store_true", help="只提供本机客户端界面")
    args = parser.parse_args(argv)

    cfg = load_config()
    if args.port:
        cfg["port"] = args.port
    if args.syncplay_port:
        cfg["syncplay_port"] = args.syncplay_port
    if args.no_syncplay:
        cfg["syncplay_port"] = 0
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except Exception:
        pass
    save_config(cfg)
    startup_log("启动 v%s frozen=%s data=%s" % (APP_VERSION, FROZEN, DATA_DIR))

    if not ui_ready():
        fatal("找不到界面文件（web 目录），程序可能没有完整解压。")
        return 1

    # 已经在运行：直接把窗口打开，然后退出
    running = find_running(int(cfg.get("port") or 8770))
    if running:
        try:
            reuse = reuse_running(running)
        except Exception as exc:
            fatal("更新未完成：%s" % exc)
            return 1
        if reuse:
            if not args.no_browser:
                open_app_window(None, running)
            return 0

    app = App(cfg)
    if args.no_syncplay:
        app.sync_server = None

    port = int(cfg.get("port") or 8770)
    httpd = None
    for p in range(port, port + 10):
        try:
            httpd = Server(("127.0.0.1" if args.local_only else "0.0.0.0", p), Handler, app)
            cfg["port"] = p
            break
        except OSError:
            continue
    if not httpd:
        fatal("端口 %d-%d 都被占用了。\n请关掉占用端口的程序，或改配置文件里的 port。" % (port, port + 9))
        return 1
    app.httpd = httpd
    save_config(cfg)
    try:
        with open(os.path.join(DATA_DIR, "port.txt"), "w", encoding="ascii") as f:
            f.write(str(cfg["port"]))
    except Exception:
        pass

    share = app.share()
    print("=" * 56)
    print("  一起看 PC 版 v%s 已启动" % APP_VERSION)
    print("  本机打开：%s" % share["local"])
    for u in share["urls"]:
        print("  好友打开：%s" % u)
    print("  Syncplay：%s" % ("%s:%s" % ("0.0.0.0", share["syncplay_port"])
                              if app.sync_server else "未启用"))
    print("=" * 56)
    if FROZEN and not args.no_browser:
        threading.Thread(target=open_app_window, args=(app, cfg["port"]), daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("正在退出…")
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
        try:
            app.tunnel.stop()
        except Exception:
            pass
        try:
            app.relay.stop()
        except Exception:
            pass
        for s in list(app.sessions):
            s.leave()
        if app.sync_server:
            app.sync_server.stop()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        import traceback
        tb = traceback.format_exc()
        try:
            with open(os.path.join(DATA_DIR, "crash.log"), "a", encoding="utf-8") as f:
                f.write(tb + "\n")
        except Exception:
            pass
        fatal("程序启动失败：\n\n" + tb[-900:])
        sys.exit(1)
