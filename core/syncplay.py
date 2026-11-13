# -*- coding: utf-8 -*-
"""Syncplay 协议（与官方 1.7.x 兼容的子集）。

协议要点（见 Syncplay 源码 syncplay/protocols.py）：
  * TCP + **按行分隔的 JSON**（不是长度前缀），一行一条 UTF-8 JSON
  * 连上先发 {"TLS":{"startTLS":"send"}}，服务器回 true/false；
    true 则就地升级 TLS，然后发 Hello；false 直接发 Hello
  * 主要消息：Hello / Set / List / State / Chat / Error / TLS
  * 服务器每秒向房间内客户端推一次 State；客户端收到后回一条自己的 State
  * 12.5 秒收不到某个客户端的状态就踢掉

本模块同时提供客户端和内置服务器，使「一起看」不依赖公网服务器。
"""
import json
import socket
import ssl
import threading
import time
from pathlib import Path

VERSION = "1.7.4"
CLIENT_VERSION = "1.2.255"   # 让老服务器也能工作
SERVER_STATE_INTERVAL = 1.0
PROTOCOL_TIMEOUT = 12.5
# 观众只是「在看」时可以完全不发消息（视频还没载入 / 一直暂停着），
# 所以断线判定要比协议超时宽松得多，否则观众会每十几秒被踢一次、反复重连。
# 前端每隔 20 秒会补一次保活，这里只用来清理真正掉线、收不到 TCP 关闭的连接。
WATCHER_IDLE_TIMEOUT = 300.0
MAX_USERNAME = 16
MAX_ROOM = 35
MAX_CHAT = 150
MAX_AVATAR = 300000      # 头像 dataURL 上限（约 300KB）
MAX_FACE = 400           # B 站头像 URL 上限

SERVER_FEATURES = {
    "watchTogetherIdentity": True,
    "sharedPlaylists": True,
    "chat": True,
    "featureList": True,
    "readiness": True,
    "managedRooms": True,
    "persistentRooms": False,
    "uiMode": "GUI",
    "maxChatMessageLength": MAX_CHAT,
    "maxUsernameLength": MAX_USERNAME,
    "maxRoomNameLength": MAX_ROOM,
    "maxFilenameLength": 250,
    "setOthersReadiness": True,
}

CLIENT_FEATURES = {
    "sharedPlaylists": True,
    "chat": True,
    "featureList": True,
    "readiness": True,
    "managedRooms": True,
    "persistentRooms": False,
    "uiMode": "GUI",
    "maxChatMessageLength": MAX_CHAT,
    "maxUsernameLength": MAX_USERNAME,
    "maxRoomNameLength": MAX_ROOM,
    "maxFilenameLength": 250,
}


class LineSocket(object):
    """按行读写的 socket。逐字节读，保证 StartTLS 升级时不会多读。"""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.lock = threading.Lock()

    def send(self, obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\r\n"
        with self.lock:
            self.sock.sendall(data)

    def recv_line(self, timeout=None):
        if timeout is not None:
            self.sock.settimeout(timeout)
        while True:
            idx = self.buf.find(b"\n")
            if idx >= 0:
                line, self.buf = self.buf[:idx], self.buf[idx + 1:]
                return line.strip()
            try:
                chunk = self.sock.recv(1)
            except socket.timeout:
                raise
            except OSError:
                return None
            if not chunk:
                return None
            self.buf += chunk

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def parse_file(name, duration=None):
    """把 Syncplay 的 file 对象转成我们能用的信息。"""
    if not name or not isinstance(name, dict):
        return None
    fname = name.get("name") or ""
    return {"name": fname, "duration": name.get("duration") or duration or 0,
            "size": name.get("size"), "path": name.get("path")}


class SyncplayClient(object):
    def __init__(self, host, port, username, room, on_event, server_password=None,
                 avatar="", face=""):
        self.host = host
        self.port = int(port)
        self.username = (username or "匿名")[:MAX_USERNAME]
        self.avatar = avatar or ""
        self.face = face or ""
        self.room = (room or "room")[:MAX_ROOM]
        self.on_event = on_event or (lambda e: None)
        self.server_password = server_password
        self._stop = False
        self._sock = None
        self._line = None
        self._thread = None
        self._lock = threading.RLock()
        self._rtt = 0.0
        self._last_tx = 0.0
        self._users = {}
        self._connected = False
        self._extended = False
        self._closed_reason = None

    # ---------- 事件 ----------
    def _emit(self, ev):
        try:
            self.on_event(ev)
        except Exception:
            pass

    # ---------- 生命周期 ----------
    def start(self):
        self._thread = threading.Thread(target=self._run, name="syncplay-client", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop = True
        self._close_socket()

    def _close_socket(self):
        with self._lock:
            if self._line:
                try:
                    self._line.close()
                except Exception:
                    pass
            self._line = None
            self._sock = None
            self._connected = False

    def _run(self):
        backoff = 1.0
        while not self._stop:
            try:
                self._connect_once()
            except Exception as e:
                if self._stop:
                    break
                self._emit({"type": "error", "message": "连接失败：%s" % e})
            finally:
                was_connected = self._connected
                self._close_socket()
                if was_connected and not self._stop:
                    self._emit({"type": "disconnected", "reason": self._closed_reason or "连接已断开"})
            if self._stop:
                break
            time.sleep(backoff)
            backoff = min(backoff * 1.6, 8.0)

    def _connect_once(self):
        self._closed_reason = None
        sock = socket.create_connection((self.host, self.port), timeout=6)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(15)
        line = LineSocket(sock)
        with self._lock:
            self._sock, self._line = sock, line
        # 1) StartTLS 询问
        line.send({"TLS": {"startTLS": "send"}})
        first = line.recv_line(timeout=6)
        if first is None:
            raise OSError("服务器没有响应")
        msg = _loads(first)
        if msg is None:
            raise OSError("服务器返回了无法解析的数据")
        if "TLS" in msg:
            ans = str((msg["TLS"] or {}).get("startTLS", "")).lower()
            if ans == "true":
                sock = self._upgrade_tls(sock)
                line = LineSocket(sock)
                with self._lock:
                    self._sock, self._line = sock, line
            elif ans != "false":
                raise OSError("TLS 协商失败")
        elif "Hello" not in msg:
            raise OSError("服务器不是 Syncplay 服务器")
        # 2) Hello
        hello = {
            "username": self.username,
            "room": {"name": self.room},
            "version": CLIENT_VERSION,
            "realversion": VERSION,
            "features": dict(CLIENT_FEATURES, wtFace=self.face),
            "avatar": self.avatar,
            "face": self.face,
        }
        if self.server_password:
            hello["password"] = self.server_password
        line.send({"Hello": hello})
        # 3) 读 Hello 回包（忽略期间的其他消息）
        deadline = time.time() + 8
        while time.time() < deadline:
            data = line.recv_line(timeout=8)
            if data is None:
                raise OSError("服务器在握手时断开")
            m = _loads(data)
            if m is None:
                continue
            if "Hello" in m:
                h = m["Hello"] or {}
                self.username = h.get("username") or self.username
                self.room = ((h.get("room") or {}).get("name")) or self.room
                self._connected = True
                self._extended = bool((h.get("features") or {}).get("watchTogetherIdentity")) or (h.get("realversion") == VERSION)
                self._last_tx = time.time()
                self._emit({
                    "type": "connected",
                    "username": self.username,
                    "room": self.room,
                    "version": h.get("realversion") or h.get("version") or "?",
                    "motd": h.get("motd") or "",
                    "features": h.get("features") or {},
                })
                line.send({"List": None})
                self._read_loop(line)
                return
            if "Error" in m:
                err = (m["Error"] or {}).get("message") or "服务器拒绝连接"
                self._closed_reason = err
                raise OSError(err)
        raise OSError("握手超时")

    def _upgrade_tls(self, sock):
        host = self.host
        try:
            ctx = ssl.create_default_context()
            pinned = Path(__file__).resolve().parent.parent / 'certs' / 'sync-server-ca.pem'
            if host == '154.64.252.247' and pinned.is_file():
                ctx.load_verify_locations(cafile=str(pinned))
            return ctx.wrap_socket(sock, server_hostname=host)
        except ssl.SSLCertVerificationError:
            if host == '154.64.252.247' and pinned.is_file():
                raise
            # 自签证书的私服：降级重连
            try:
                sock.close()
            except Exception:
                pass
            self._emit({"type": "error", "message": "服务器证书无法校验，已改用不校验证书的方式连接"})
            sock = socket.create_connection((self.host, self.port), timeout=8)
            sock.settimeout(15)
            line = LineSocket(sock)
            line.send({"TLS": {"startTLS": "send"}})
            first = line.recv_line(timeout=6)
            msg = _loads(first) or {}
            if str(((msg.get("TLS") or {}).get("startTLS", ""))).lower() != "true":
                raise OSError("TLS 协商失败")
            ctx = ssl._create_unverified_context()
            return ctx.wrap_socket(sock, server_hostname=host)

    def _read_loop(self, line):
        while not self._stop:
            data = line.recv_line(timeout=PROTOCOL_TIMEOUT + 10)
            if data is None:
                self._closed_reason = "与服务器断开连接"
                return
            msg = _loads(data)
            if msg is None:
                continue
            self._dispatch(msg)

    def _dispatch(self, msg):
        if "State" in msg:
            st = msg["State"] or {}
            ps = st.get("playstate") or {}
            ping = st.get("ping") or {}
            now = time.time()
            if not self._extended and "latencyCalculation" in ping:
                reply={"ping":{"latencyCalculation":ping["latencyCalculation"],"clientLatencyCalculation":now,"clientRtt":self._rtt}}
                if (st.get("ignoringOnTheFly") or {}).get("server"):
                    reply["ignoringOnTheFly"]={"server":st["ignoringOnTheFly"]["server"]}
                self._send({"State":reply})
            age = 0.0
            lat = ping.get("latencyCalculation")
            if isinstance(lat, (int, float)) and lat > 0:
                age = max(0.0, min(now - lat, 3.0))
            clat = ping.get("clientLatencyCalculation")
            if isinstance(clat, (int, float)) and clat > 0:
                sender_rtt = ping.get("clientRtt") or 0
                measured = max(0.0, now - clat)
                self._rtt = measured if not sender_rtt else min(measured, sender_rtt)
            if "position" in ps:
                self._emit({
                    "type": "state",
                    "position": float(ps.get("position") or 0),
                    "paused": bool(ps.get("paused")),
                    "doSeek": bool(ps.get("doSeek")),
                    "setBy": ps.get("setBy"),
                    "age": round(age, 3),
                    "rtt": round(self._rtt * 1000),
                })
        elif "List" in msg:
            rooms = msg["List"] or {}
            out = {}
            for room_name, users in rooms.items():
                arr = []
                for uname, info in (users or {}).items():
                    if not uname.strip():
                        continue  # 服务器的占位用户
                    f = parse_file(info.get("file"))
                    arr.append({
                        "name": uname,
                        "position": info.get("position") or 0,
                        "file": f,
                        "isReady": info.get("isReady"),
                        "controller": info.get("controller") or False,
                        "avatar": info.get("avatar") or "",
                        "face": info.get("face") or (info.get("features") or {}).get("wtFace") or "",
                    })
                out[room_name] = arr
            self._emit({"type": "users", "rooms": out})
        elif "Set" in msg:
            self._handle_set(msg["Set"] or {})
        elif "Chat" in msg:
            ch = msg["Chat"] or {}
            self._emit({"type": "chat", "username": ch.get("username") or "?",
                        "message": ch.get("message") or ""})
        elif "Error" in msg:
            err = (msg["Error"] or {}).get("message") or "服务器错误"
            self._closed_reason = err
            self._emit({"type": "error", "message": err})
        elif "Hello" in msg:
            pass

    def _handle_set(self, s):
        if "user" in s:
            for uname, info in (s["user"] or {}).items():
                room = ((info.get("room") or {}).get("name")) or self.room
                ev = info.get("event")
                if ev and "left" in ev:
                    kind = "left"
                elif ev and "joined" in ev:
                    kind = "joined"
                else:
                    kind = "update"
                self._emit({"type": "user_event", "event": kind, "username": uname,
                            "room": room, "file": parse_file(info.get("file"))})
        if "room" in s:
            self.room = (s["room"] or {}).get("name") or self.room
        if "ready" in s:
            r = s["ready"] or {}
            self._emit({"type": "ready", "username": r.get("username"), "isReady": r.get("isReady")})
        if "features" in s:
            pass

    # ---------- 发送 ----------
    def _send(self, obj):
        with self._lock:
            line = self._line
        if not line:
            return False
        try:
            line.send(obj)
            self._last_tx = time.time()
            return True
        except Exception:
            return False

    def send_state(self, position, paused, do_seek=False, latency=None, heartbeat=False):
        st = {"playstate": {"position": round(float(position), 3),
                            "paused": bool(paused),
                            "doSeek": bool(do_seek), "heartbeat": bool(heartbeat)},
              "ping": {"clientLatencyCalculation": time.time(),
                       "clientRtt": self._rtt}}
        return self._send({"State": st})

    def send_file(self, file_obj):
        return self._send({"Set": {"file": file_obj}})

    def send_chat(self, text):
        text = (text or "").strip()[:MAX_CHAT]
        if not text:
            return False
        return self._send({"Chat": text})

    def send_avatar(self, avatar):
        self.avatar = avatar or ""
        return self._send({"Avatar": {"avatar": self.avatar}}) if self._extended else True

    def send_face(self, face):
        self.face = face or ""
        return self._send({"Face": {"face": self.face}}) if self._extended else self._send({"Set":{"features":dict(CLIENT_FEATURES,wtFace=self.face)}})

    def request_list(self):
        return self._send({"List": None})

    def alive(self):
        return self._connected


def _loads(data):
    try:
        return json.loads(data.decode("utf-8", "replace"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 内置 Syncplay 服务器
# ---------------------------------------------------------------------------

class _Watcher(object):
    def __init__(self, conn, name, room):
        self.conn = conn
        self.name = name
        self.room = room
        self.position = 0.0
        self.paused = True
        self.file = None
        self.avatar = ""
        self.face = ""
        self.last_update = time.time()
        self.state_time = time.time()
        self.ready = None


class _Room(object):
    def __init__(self, name):
        self.name = name
        self.watchers = {}
        self.position = 0.0
        self.paused = True
        self.set_by = None
        self.last_update = time.time()

    def current_position(self):
        if self.paused:
            return self.position
        return self.position + (time.time() - self.last_update)


class SyncplayServer(object):
    """够用的 Syncplay 服务器：房间 / 状态 / 聊天 / 成员。

    Kazumi 等官方协议客户端也可以直接连进来（局域网）。
    """

    def __init__(self, port=8999, host="0.0.0.0", log=print):
        self.port = int(port)
        self.host = host
        self.log = log or (lambda *a: None)
        self.rooms = {}
        self.lock = threading.RLock()
        self._srv = None
        self._stop = False
        self._timer = None

    def start(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.host, self.port))
        srv.listen(16)
        srv.settimeout(1.0)
        self._srv = srv
        threading.Thread(target=self._accept_loop, name="syncplay-server", daemon=True).start()
        self._timer = threading.Thread(target=self._tick_loop, name="syncplay-tick", daemon=True)
        self._timer.start()
        self.log("[syncplay] 服务器已启动 %s:%s" % (self.host, self.port))

    def stop(self):
        self._stop = True
        try:
            if self._srv:
                self._srv.close()
        except Exception:
            pass

    # ---------- 连接 ----------
    def _accept_loop(self):
        while not self._stop:
            try:
                sock, addr = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._client_loop, args=(sock, addr), daemon=True).start()

    def _client_loop(self, sock, addr):
        sock.settimeout(PROTOCOL_TIMEOUT + 5)
        line = LineSocket(sock)
        w = None
        try:
            first = line.recv_line(timeout=20)
            if first is None:
                return
            msg = _loads(first)
            if msg and "TLS" in msg:
                tls_context = getattr(self, 'tls_context', None)
                line.send({"TLS": {"startTLS": "true" if tls_context else "false"}})
                if tls_context:
                    sock = tls_context.wrap_socket(sock, server_side=True)
                    line = LineSocket(sock)
                raw = line.recv_line(timeout=20)
                msg = _loads(raw) if raw is not None else None
            if not msg or "Hello" not in msg:
                line.send({"Error": {"message": "需要先发送 Hello"}})
                return
            hello = msg["Hello"] or {}
            username = (hello.get("username") or "").strip()
            room_name = (((hello.get("room") or {}).get("name")) or "").strip()
            if not username or not room_name:
                line.send({"Error": {"message": "Hello 缺少用户名或房间名"}})
                return
            with self.lock:
                username = self._free_name(username)
                room = self.rooms.get(room_name) or _Room(room_name)
                self.rooms[room_name] = room
                w = _Watcher(line, username, room)
                w.avatar = (hello.get("avatar") or "")[:MAX_AVATAR]
                w.face = (hello.get("face") or "")[:MAX_FACE]
                room.watchers[username] = w
            line.send({"Hello": {
                "username": username,
                "room": {"name": room_name},
                "version": hello.get("version") or "1.2.255",
                "realversion": VERSION,
                "features": dict(SERVER_FEATURES),
                "motd": "一起看 · 内置 Syncplay 服务器",
            }})
            self._broadcast_user(w, joined=True)
            self._send_state(w, do_seek=True, forced=True)
            self._broadcast_list_hint(room_name)
            self.log("[syncplay] %s 加入房间 %s" % (username, room_name))
            while not self._stop:
                try:
                    raw = line.recv_line(timeout=PROTOCOL_TIMEOUT)
                except socket.timeout:
                    # 观众安静地看视频是正常现象，只有长时间完全没有消息才断开
                    if time.time() - w.last_update > WATCHER_IDLE_TIMEOUT:
                        break
                    continue
                if raw is None:
                    break
                m = _loads(raw)
                if m is None:
                    continue
                self._handle(w, m)
        except Exception as e:
            self.log("[syncplay] 连接异常：%s" % e)
        finally:
            if w:
                with self.lock:
                    room = w.room
                    room.watchers.pop(w.name, None)
                    if not room.watchers:
                        self.rooms.pop(room.name, None)
                self._broadcast_user(w, joined=False)
                self.log("[syncplay] %s 离开" % w.name)
            line.close()

    def _free_name(self, name):
        name = name[:MAX_USERNAME]
        existing = set()
        for room in self.rooms.values():
            for n in room.watchers:
                existing.add(n.lower())
        if name.lower() in existing and name.endswith("_"):
            name = name.rstrip("_") or "_"
        while name.lower() in existing:
            name += "_"
        return name

    def _handle(self, w, msg):
        w.last_update = time.time()
        if "State" in msg:
            st = msg["State"] or {}
            ps = st.get("playstate") or {}
            if "position" in ps:
                pos = float(ps.get("position") or 0)
                paused = bool(ps.get("paused"))
                do_seek = bool(ps.get("doSeek"))
                sent = (st.get("ping") or {}).get("clientLatencyCalculation")
                age = max(0.0, min(time.time() - sent, 3.0)) if isinstance(sent, (int, float)) else 0.0
                w.position = pos + (0.0 if paused else age)
                w.paused = paused
                w.state_time = time.time()
                room = w.room
                # A queued progress report must not undo a newer play/pause action.
                heartbeat = bool(ps.get("heartbeat"))
                pause_changed = (paused != room.paused) and not heartbeat
                if do_seek or pause_changed:
                    room.position = pos
                    room.paused = paused
                    room.set_by = w.name
                    room.last_update = time.time()
                    self._broadcast_state(room, do_seek=do_seek, forced=True)
                elif not room.paused:
                    # 以「最后操作的人（通常是房主）」为准，别人缓冲不会把大家拖回去
                    now = time.time()
                    lead = room.watchers.get(room.set_by) if room.set_by else None
                    if lead is not None and not lead.paused and lead.position:
                        pos = lead.position + (now - lead.state_time)
                        if pos > room.position - 2.0:
                            room.position = max(0.0, pos)
                        room.last_update = now
        elif "List" in msg:
            self._send_list(w)
        elif "Set" in msg:
            s = msg["Set"] or {}
            if "file" in s:
                w.file = s["file"] or None
                self._broadcast_file(w)
            if "room" in s:
                self._move_room(w, ((s["room"] or {}).get("name") or "").strip())
            if "features" in s:
                pass
        elif "Avatar" in msg:
            av = (msg["Avatar"] or {}).get("avatar") or ""
            w.avatar = av[:MAX_AVATAR]
            self._broadcast_list_hint(w.room.name)
        elif "Face" in msg:
            fc = (msg["Face"] or {}).get("face") or ""
            w.face = fc[:MAX_FACE]
            self._broadcast_list_hint(w.room.name)
        elif "Chat" in msg:
            ch = msg["Chat"] or {}
            text = (ch if isinstance(ch, str) else ch.get("message") or "").strip()[:MAX_CHAT]
            if text:
                self._broadcast_room(w.room, {"Chat": {"username": w.name, "message": text}})
        elif "Error" in msg:
            pass

    def _move_room(self, w, new_name):
        if not new_name or new_name == w.room.name:
            return
        since = w.room
        with self.lock:
            since.watchers.pop(w.name, None)
            if not since.watchers:
                self.rooms.pop(since.name, None)
            room = self.rooms.get(new_name) or _Room(new_name)
            self.rooms[new_name] = room
            room.watchers[w.name] = w
            w.room = room
        self._broadcast_room(since, {"Set": {"user": {w.name: {
            "room": {"name": since.name}, "event": {"left": True}}}}})
        self._broadcast_user(w, joined=True)
        self._send_state(w, do_seek=True, forced=True)

    # ---------- 广播 ----------
    def _broadcast_room(self, room, obj, exclude=None):
        for watcher in list(room.watchers.values()):
            if exclude is not None and watcher is exclude:
                continue
            try:
                watcher.conn.send(obj)
            except Exception:
                pass

    def _broadcast_all_rooms(self, obj):
        for room in list(self.rooms.values()):
            self._broadcast_room(room, obj)

    def _broadcast_user(self, w, joined):
        user = {"room": {"name": w.room.name}}
        if w.file:
            user["file"] = w.file
        if joined:
            user["event"] = {"joined": True, "version": CLIENT_VERSION,
                             "features": dict(CLIENT_FEATURES)}
        else:
            user["event"] = {"left": True}
        payload = {"user": {w.name: user}}
        self._broadcast_room(w.room, {"Set": payload}, exclude=w if joined else None)

    def _broadcast_file(self, w):
        user = {"room": {"name": w.room.name}}
        if w.file:
            user["file"] = w.file
        self._broadcast_room(w.room, {"Set": {"user": {w.name: user}}})

    def _broadcast_list_hint(self, room_name):
        # 让房间里其他人刷新成员列表
        room = self.rooms.get(room_name)
        if room:
            for watcher in list(room.watchers.values()):
                self._send_list(watcher)

    def _send_list(self, w):
        out = {}
        for room in list(self.rooms.values()):
            users = {}
            for watcher in list(room.watchers.values()):
                users[watcher.name] = {
                    "position": round(watcher.position, 3),
                    "file": watcher.file or {},
                    "controller": False,
                    "isReady": watcher.ready,
                    "avatar": watcher.avatar or "",
                    "face": watcher.face or "",
                    "features": dict(CLIENT_FEATURES),
                }
            out[room.name] = users
        try:
            w.conn.send({"List": out})
        except Exception:
            pass

    def _send_state(self, w, do_seek=False, forced=False):
        room = w.room
        self._send_state_to(w.conn, room, do_seek, forced)

    def _send_state_to(self, conn, room, do_seek=False, forced=False):
        state = {
            "playstate": {
                "position": round(room.current_position(), 3),
                "paused": room.paused,
                "doSeek": do_seek,
                "setBy": room.set_by,
            },
            "ping": {"latencyCalculation": time.time(), "serverRtt": 0},
        }
        if forced:
            state["ignoringOnTheFly"] = {"server": 1}
        try:
            conn.send({"State": state})
        except Exception:
            pass

    def _broadcast_state(self, room, do_seek=False, forced=False):
        for watcher in list(room.watchers.values()):
            self._send_state_to(watcher.conn, room, do_seek, forced)

    def _tick_loop(self):
        while not self._stop:
            time.sleep(SERVER_STATE_INTERVAL)
            try:
                for room in list(self.rooms.values()):
                    if not room.watchers:
                        continue
                    self._broadcast_state(room)
                    for watcher in list(room.watchers.values()):
                        if time.time() - watcher.last_update > WATCHER_IDLE_TIMEOUT:
                            try:
                                watcher.conn.close()
                            except Exception:
                                pass
            except Exception:
                pass
