# -*- coding: utf-8 -*-
"""B 站网页接口客户端。

只使用标准库：登录（扫码）、视频信息、播放地址（MP4 / DASH）、弹幕。
所有请求都带上网页版 UA 与 Referer，避免 CDN 防盗链。
"""
import gzip
import html
import json
import os
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
import zlib

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REFERER = "https://www.bilibili.com/"
API = "https://api.bilibili.com"
PASSPORT = "https://passport.bilibili.com"

# qn -> 中文名（接口没给 accept_description 时的兜底）
QN_NAMES = {
    127: "8K 超高清", 126: "杜比视界", 125: "HDR 真彩", 120: "4K 超清",
    116: "1080P60", 112: "1080P+", 80: "1080P 高清", 74: "720P60",
    64: "720P 高清", 32: "480P 清晰", 16: "360P 流畅", 6: "240P 极速",
}
# DASH 音轨里挑一条：优先 192K，其次 132K / 64K，避开杜比/无损
AUDIO_PREF = [30280, 30232, 30216, 30250, 30251]


# 只认番剧类分区，其它分区（影视剪辑/杂谈/搞笑/手书……）一律过滤
ANIME_TYPES = {"动画综合", "连载动画", "完结动画", "番剧"}
# 标题里出现这些词基本都不是番剧正文
BAD_WORDS = (
    "reaction", "解说", "杂谈", "吐槽", "一口气", "剪辑", "混剪",
    "网盘", "资源", "分享", "pv", "op", "ed", "ost", "原声", "手书", "mmd",
    "mad", "amv", "配音", "小说", "漫画", "动态漫", "预告", "资讯", "花絮",
    "采访", "直播回放", "录播",
)


# 正片标题特征：全12集 / 全集 / 第3话 / 1-12 / 剧场版 …
EPISODE_PATTERN = re.compile(
    r"全\s*\d+\s*[集话話]|全集|\d+\s*[-~]\s*\d+|第\s*\d+\s*[集话話]"
    r"|剧场版|劇場版|OVA|OAD|特别篇|特別篇", re.I)


class BiliError(Exception):
    pass


def parse_id(text):
    """从链接 / BV 号 / av 号里解析出视频标识。返回 (bvid, aid) 之一为 None。"""
    text = (text or "").strip()
    if not text:
        return None, None
    m = re.search(r"(BV[0-9A-Za-z]{10})", text)
    if m:
        return m.group(1), None
    m = re.search(r"(?:^|[^0-9])av(\d+)", text, re.I)
    if m:
        return None, m.group(1)
    # 纯数字当成 aid
    if re.fullmatch(r"\d{3,}", text):
        return None, text
    return None, None


def parse_bangumi(text):
    """从 ep123 / ss123 / 番剧链接里解析番剧编号。返回 (kind, id) 或 (None, None)。"""
    text = (text or "").strip()
    m = re.search(r"(?:^|[^0-9A-Za-z])(ep)(\d+)", text, re.I)
    if m:
        return "ep", m.group(2)
    m = re.search(r"(?:^|[^0-9A-Za-z])(ss)(\d+)", text, re.I)
    if m:
        return "ss", m.group(2)
    return None, None


def parse_bvid_from_file_name(name):
    """Syncplay 的 file.name 形如 bilibili:BV1xx:cid:title，取回 BV 号。"""
    if not name or not isinstance(name, str):
        return None
    if name.startswith("bilibili:"):
        rest = name[len("bilibili:"):]
        m = re.search(r"(BV[0-9A-Za-z]{10})", rest)
        if m:
            return m.group(1)
    return None


class Bilibili(object):
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.lock = threading.RLock()
        self.cookies = {}
        self.cookie_file = os.path.join(data_dir, "cookies.json")
        self._nav_cache = None
        self._nav_time = 0
        self._qr = None
        self._ctx = ssl.create_default_context()
        self._load()

    # ---------------- cookie 持久化 ----------------
    def _load(self):
        try:
            with open(self.cookie_file, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                self.cookies = {str(k): str(v) for k, v in d.items()}
        except Exception:
            self.cookies = {}

    def _save(self):
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            tmp = self.cookie_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cookies, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.cookie_file)
        except Exception:
            pass

    def cookie_header(self):
        with self.lock:
            return "; ".join("%s=%s" % (k, v) for k, v in self.cookies.items())

    def logged_in(self):
        return bool(self.cookies.get("SESSDATA"))

    def set_cookies_from_headers(self, headers):
        """把 Set-Cookie 里的登录票据并入 cookie 表。"""
        got = {}
        for value in headers:
            first = value.split(";", 1)[0]
            if "=" in first:
                k, v = first.split("=", 1)
                k = k.strip()
                if k:
                    got[k] = v.strip()
        if not got:
            return
        with self.lock:
            self.cookies.update(got)
        self._save()

    def logout(self):
        with self.lock:
            self.cookies = {}
        self._save()
        self._nav_cache = None
        self._nav_time = 0

    # ---------------- 通用请求 ----------------
    def _request(self, url, headers=None, timeout=20):
        h = {
            "User-Agent": UA,
            "Referer": REFERER,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Origin": "https://www.bilibili.com",
        }
        ck = self.cookie_header()
        if ck:
            h["Cookie"] = ck
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, headers=h)
        resp = urllib.request.urlopen(req, timeout=timeout, context=self._ctx)
        return resp

    def _get_json(self, url, headers=None, timeout=20):
        resp = self._request(url, headers, timeout)
        try:
            raw = resp.read()
        finally:
            resp.close()
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            raise BiliError("接口返回的不是 JSON：%s" % url)

    def api(self, path, params=None, allow_codes=()):
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        obj = self._get_json(url)
        code = obj.get("code", -1)
        if code != 0 and code not in allow_codes:
            raise BiliError(_friendly(obj.get("message") or "接口错误", code))
        return obj

    # ---------------- 账号 ----------------
    def ensure_buvid(self):
        """拿一份 buvid3，降低播放接口的风控概率（失败也无所谓）。"""
        if self.cookies.get("buvid3"):
            return
        try:
            resp = self._request("https://www.bilibili.com/")
            raw = resp.headers.get_all("Set-Cookie") or []
            resp.close()
            self.set_cookies_from_headers(raw)
        except Exception:
            pass

    def nav(self, force=False):
        with self.lock:
            if not force and self._nav_cache and time.time() - self._nav_time < 30:
                return self._nav_cache
        if not self.logged_in():
            info = {"logged_in": False}
            with self.lock:
                self._nav_cache, self._nav_time = info, time.time()
            return info
        try:
            obj = self.api("/x/web-interface/nav", allow_codes=(-101,))
        except Exception as e:
            return {"logged_in": self.logged_in(), "error": str(e)}
        d = obj.get("data") or {}
        info = {
            "logged_in": bool(d.get("isLogin")),
            "uname": d.get("uname") or "",
            "face": d.get("face") or "",
            "mid": d.get("mid"),
            "level": (d.get("level_info") or {}).get("current_level"),
            "vip": (d.get("vipStatus") == 1),
            "vip_label": ((d.get("vip_label") or {}).get("text") or ""),
        }
        if not info["logged_in"]:
            info["error"] = obj.get("message") or "登录态已失效"
        with self.lock:
            self._nav_cache, self._nav_time = info, time.time()
        return info

    # ---------------- 扫码登录 ----------------
    def qr_generate(self):
        obj = self._get_json(PASSPORT + "/x/passport-login/web/qrcode/generate")
        if obj.get("code") != 0:
            raise BiliError(_friendly(obj.get("message") or "二维码生成失败", obj.get("code")))
        d = obj.get("data") or {}
        key, url = d.get("qrcode_key"), d.get("url")
        if not key or not url:
            raise BiliError("二维码接口返回异常")
        with self.lock:
            self._qr = {"key": key, "url": url, "time": time.time()}
        return {"key": key, "url": url}

    def qr_poll(self, key=None):
        """返回 {status: waiting|scanned|expired|ok|error, ...}"""
        with self.lock:
            if not key:
                key = (self._qr or {}).get("key")
        if not key:
            return {"status": "error", "message": "二维码不存在，请重新生成"}
        url = (PASSPORT + "/x/passport-login/web/qrcode/poll?qrcode_key="
               + urllib.parse.quote(key) + "&source=main-fe-header")
        headers = {"Referer": "https://passport.bilibili.com/login"}
        resp = self._request(url, headers)
        raw = resp.read()
        try:
            set_cookies = resp.headers.get_all("Set-Cookie") or []
        finally:
            resp.close()
        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return {"status": "error", "message": "轮询接口返回异常"}
        d = obj.get("data") or {}
        code = d.get("code")
        if code == 0:
            self.set_cookies_from_headers(set_cookies)
            info = self.nav(force=True)
            return {"status": "ok", "user": info}
        if code == 86101:
            return {"status": "waiting"}
        if code == 86090:
            return {"status": "scanned"}
        if code == 86038:
            return {"status": "expired"}
        return {"status": "error", "message": d.get("message") or ("登录失败 code=%s" % code)}

    # ---------------- 视频信息 ----------------
    def view(self, bvid=None, aid=None):
        params = {"bvid": bvid} if bvid else {"aid": aid}
        obj = self.api("/x/web-interface/view", params)
        d = obj.get("data") or {}
        pages = d.get("pages") or []
        cid = d.get("cid") or (pages[0].get("cid") if pages else None)
        if not cid:
            raise BiliError("拿不到 cid（视频可能已失效）")
        return {
            "bvid": d.get("bvid") or bvid,
            "aid": d.get("aid") or aid,
            "cid": cid,
            "title": d.get("title") or "",
            "pic": d.get("pic") or "",
            "desc": (d.get("desc") or "")[:200],
            "duration": float(d.get("duration") or 0),
            "pubdate": d.get("pubdate"),
            "owner": (d.get("owner") or {}).get("name") or "",
            "owner_face": (d.get("owner") or {}).get("face") or "",
            "pages": [{"cid": p.get("cid"), "page": p.get("page"), "part": p.get("part"),
                       "duration": p.get("duration")} for p in pages],
        }

    # ---------------- 番剧搜索 ----------------
    def search_bangumi(self, keyword, pages=2):
        """搜索真正的番剧（ss），拿到季编号后就能在房间里选集。"""
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        out, seen = [], set()
        for page in range(1, pages + 1):
            obj = self.api("/x/web-interface/search/type",
                           {"search_type": "media_bangumi", "keyword": keyword,
                            "page": page})
            for raw in (obj.get("data") or {}).get("result") or []:
                title = re.sub(r"<[^>]+>", "", raw.get("title") or "").strip()
                sid = str(raw.get("season_id") or raw.get("media_id") or "")
                if not title or not sid or sid in seen:
                    continue
                norm_title, norm_kw = _norm_cn(title), _norm_cn(keyword)
                if norm_kw and _common_len(norm_kw, norm_title) < min(3, len(norm_kw)):
                    continue
                seen.add(sid)
                pic = raw.get("cover") or ""
                if pic.startswith("//"):
                    pic = "https:" + pic
                out.append({
                    "kind": "bangumi",
                    "target": "ss" + sid,
                    "ss_id": sid,
                    "bvid": "",
                    "title": title,
                    "pic": pic,
                    "author": "",
                    "duration": 0,
                    "duration_text": raw.get("index_show") or "",
                    "play": raw.get("play") or 0,
                    "danmaku": 0,
                    "type": "番剧",
                })
            if len(out) >= 8:
                break
        return out[:8]

    def search_anime(self, keyword, pages=3):
        """按关键词搜投稿 + 番剧，只保留番剧/动画正片类结果。"""
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        out, seen, relaxed = [], set(), []
        for page in range(1, pages + 1):
            obj = self.api("/x/web-interface/search/type",
                           {"search_type": "video", "keyword": keyword,
                            "page": page, "order": "totalrank"})
            data = obj.get("data") or {}
            for raw in data.get("result") or []:
                item = self._anime_item(raw, keyword)
                if not item:
                    item = self._anime_item(raw, keyword, strict=False)
                    if item and item["bvid"] not in seen:
                        seen.add(item["bvid"])
                        relaxed.append(item)
                    continue
                if item["bvid"] in seen:
                    continue
                seen.add(item["bvid"])
                out.append(item)
            if len(out) >= 12:
                break
        return (self.search_bangumi(keyword) + (out or relaxed))[:18]

    @staticmethod
    def _anime_item(raw, keyword="", strict=True):
        typename = (raw.get("typename") or "").strip()
        if typename not in ANIME_TYPES:
            return None
        title = re.sub(r"<[^>]+>", "", raw.get("title") or "").strip()
        if not title:
            return None
        low = title.lower()
        if any(w in low for w in BAD_WORDS):
            return None
        secs = _duration_seconds(raw.get("duration"))
        if secs < 900:
            return None
        # 标题里必须真的出现搜索词，挡掉同分区但不相关的投稿
        norm_title = _norm_cn(title)
        norm_kw = _norm_cn(keyword)
        if norm_kw:
            if strict:
                if norm_kw not in norm_title:
                    return None
            else:
                # 宽松模式也只接受标题和关键词有 ≥3 个字重合的，避免推给用户别的番
                need = min(3, len(norm_kw))
                if _common_len(norm_kw, norm_title) < need:
                    return None
        # 必须是“正片”形态：全集 / 第 X 集 / 全 N 话 / 剧场版 之类
        if not re.search(EPISODE_PATTERN, title):
            return None
        pic = raw.get("pic") or ""
        if pic.startswith("//"):
            pic = "https:" + pic
        bvid = raw.get("bvid") or ""
        if not bvid:
            return None
        return {
            "bvid": bvid,
            "title": title,
            "pic": pic,
            "author": raw.get("author") or "",
            "duration": secs,
            "duration_text": raw.get("duration") or "",
            "play": raw.get("play") or 0,
            "danmaku": raw.get("video_review") or 0,
            "type": typename,
        }

    # ---------------- 番剧 ----------------
    def season(self, ep_id=None, season_id=None):
        """番剧季信息 + 剧集列表（ep_id / season_id 二选一）。"""
        params = {}
        if ep_id:
            params["ep_id"] = ep_id
        elif season_id:
            params["season_id"] = season_id
        else:
            raise BiliError("缺少番剧编号")
        obj = self.api("/pgc/view/web/season", params)
        d = obj.get("result") or obj.get("data") or {}
        eps = []
        for e in d.get("episodes") or []:
            dur = float(e.get("duration") or 0)
            if dur > 100000:          # 番剧接口给的是毫秒
                dur = dur / 1000.0
            eps.append({
                "ep_id": e.get("id"),
                "bvid": e.get("bvid") or "",
                "aid": e.get("aid"),
                "cid": e.get("cid"),
                "title": e.get("title") or "",
                "long_title": e.get("long_title") or "",
                "cover": e.get("cover") or "",
                "duration": dur,
            })
        return {
            "season_id": d.get("season_id"),
            "title": d.get("title") or "",
            "cover": d.get("cover") or "",
            "episodes": eps,
        }

    # ---------------- 播放地址 ----------------
    @staticmethod
    def _parse_play_payload(d, cid=None):
        accept = []
        qs = d.get("accept_quality") or []
        ds = d.get("accept_description") or []
        for i, q in enumerate(qs):
            label = ds[i] if i < len(ds) else QN_NAMES.get(q, str(q))
            accept.append({"qn": q, "label": label, "raw": ""})
        out = {
            "cid": d.get("cid") or cid, "quality": d.get("quality"),
            "accept": accept, "dash": None, "mp4": None,
            "duration_ms": d.get("timelength"),
        }
        dash = d.get("dash")
        if dash:
            videos = []
            for v in dash.get("video") or []:
                if not v.get("baseUrl") and not v.get("base_url"):
                    continue
                videos.append({
                    "id": v.get("id"),
                    "base": v.get("baseUrl") or v.get("base_url"),
                    "backup": v.get("backupUrl") or v.get("backup_url") or [],
                    "bandwidth": v.get("bandwidth") or 0,
                    "width": v.get("width"), "height": v.get("height"),
                    "codecid": v.get("codecid"),
                })
            audios = []
            for a in dash.get("audio") or []:
                if not a.get("baseUrl") and not a.get("base_url"):
                    continue
                audios.append({
                    "id": a.get("id"),
                    "base": a.get("baseUrl") or a.get("base_url"),
                    "backup": a.get("backupUrl") or a.get("backup_url") or [],
                    "bandwidth": a.get("bandwidth") or 0,
                })
            out["dash"] = {"video": videos, "audio": audios}
        durl = d.get("durl")
        if durl:
            out["mp4"] = [{"url": x.get("url"), "backup": x.get("backup_url") or [],
                           "size": x.get("size"), "length": x.get("length")} for x in durl]
        return out

    def playurl(self, bvid=None, aid=None, cid=None, qn=80):
        base = {"cid": cid, "qn": qn, "fnver": 0, "fourk": 1, "platform": "pc",
                "high_quality": 1}
        if bvid:
            base["bvid"] = bvid
        else:
            base["avid"] = aid
        d = self.api("/x/player/playurl", dict(base, fnval=4048)).get("data") or {}
        out = self._parse_play_payload(d, cid)
        # 没有 durl 时单独再要一份 MP4（兼容只给 DASH 的高画质）
        if not out["mp4"]:
            try:
                mp4_params = dict(base, fnval=1)
                if qn > 80:
                    mp4_params["qn"] = 80
                d2 = self.api("/x/player/playurl", mp4_params,
                              allow_codes=(-404,)).get("data") or {}
                if d2.get("durl"):
                    out["mp4"] = [{"url": x.get("url"), "backup": x.get("backup_url") or [],
                                   "size": x.get("size"), "length": x.get("length")}
                                  for x in d2["durl"]]
                    if d2.get("quality"):
                        out["mp4_quality"] = d2.get("quality")
            except Exception:
                pass
        return out

    def pgc_playurl(self, ep_id, cid, aid, qn=80):
        """番剧播放地址，走 pgc 接口（需要登录；大会员专享会返回错误）。"""
        base = {"ep_id": ep_id, "cid": cid, "avid": aid, "qn": qn, "fnver": 0,
                "fnval": 4048, "fourk": 1, "platform": "pc", "high_quality": 1}
        ref = "https://www.bilibili.com/bangumi/play/ep%s" % ep_id
        url = API + "/pgc/player/web/playurl?" + urllib.parse.urlencode(base)
        obj = self._get_json(url, headers={"Referer": ref})
        if obj.get("code") != 0:
            raise BiliError(_friendly(obj.get("message") or "播放地址获取失败", obj.get("code")))
        out = self._parse_play_payload(obj.get("result") or obj.get("data") or {}, cid)
        if not out["mp4"]:
            try:
                p2 = dict(base, fnval=1)
                if qn > 80:
                    p2["qn"] = 80
                o2 = self._get_json(API + "/pgc/player/web/playurl?"
                                    + urllib.parse.urlencode(p2), headers={"Referer": ref})
                d2 = o2.get("result") or o2.get("data") or {}
                if d2.get("durl"):
                    out["mp4"] = [{"url": x.get("url"), "backup": x.get("backup_url") or [],
                                   "size": x.get("size"), "length": x.get("length")}
                                  for x in d2["durl"]]
                    if d2.get("quality"):
                        out["mp4_quality"] = d2.get("quality")
            except Exception:
                pass
        return out

    # ---------------- 弹幕 ----------------
    def danmaku(self, cid):
        url = "%s/x/v1/dm/list.so?oid=%s" % (API, cid)
        resp = self._request(url)
        try:
            data = resp.read()
            enc = (resp.headers.get("Content-Encoding") or "").lower()
        finally:
            resp.close()
        text = _decompress(data, enc)
        items = []
        for m in re.finditer(r'<d p="([^"]*)"[^>]*>(.*?)</d>', text, re.S):
            p, content = m.group(1), m.group(2)
            parts = p.split(",")
            if len(parts) < 4:
                continue
            try:
                t = float(parts[0])
                mode = int(parts[1])
                size = int(parts[2])
                color = int(parts[3])
            except Exception:
                continue
            if mode not in (1, 2, 3, 4, 5):
                continue
            content = html.unescape(content).strip()
            if not content:
                continue
            items.append({"t": round(t, 3), "m": mode, "s": size, "c": color,
                          "x": content})
        items.sort(key=lambda i: i["t"])
        return items


def _common_len(a, b):
    """最长公共连续子串长度，用来判断两个标题是不是同一部番。"""
    best = 0
    for i in range(len(a)):
        for j in range(i + best + 1, len(a) + 1):
            if a[i:j] in b:
                best = j - i
            else:
                break
    return best


def _norm_cn(text):
    """只保留中日文字和数字，方便忽略空格、括号、连字符做包含判断。"""
    return re.sub(r"[^\u4e00-\u9fff0-9]", "", text or "")


def _duration_seconds(text):
    """B 站搜索结果里的 duration 形如 '463:41' 或 '12:34'，转成秒。"""
    parts = str(text or "").strip().split(":")
    try:
        nums = [int(p) for p in parts]
    except Exception:
        return 0
    secs = 0
    for n in nums:
        secs = secs * 60 + n
    return secs


def _decompress(data, enc):
    if not data:
        return ""
    if enc == "gzip":
        try:
            return gzip.decompress(data).decode("utf-8", "replace")
        except Exception:
            pass
    for fn in (zlib.decompress, lambda b: zlib.decompress(b, -15), gzip.decompress):
        try:
            return fn(data).decode("utf-8", "replace")
        except Exception:
            continue
    return data.decode("utf-8", "replace")


def _friendly(msg, code=None):
    table = {
        -400: "请求参数错误",
        -403: "没有权限访问（可能需要登录或大会员）",
        -404: "视频不存在或已失效",
        -352: "被 B 站风控拦截，请稍后再试",
        -101: "还没有登录",
        87007: "仅限大会员观看",
        87008: "仅限大会员观看",
        6001: "视频稿件不可见（可能已删除）",
    }
    if code in table:
        return "%s（%s）" % (table[code], msg)
    return "%s（code=%s）" % (msg, code) if code not in (None, 0) else str(msg)
