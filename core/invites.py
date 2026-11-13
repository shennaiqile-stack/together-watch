"""Validated OS invitations and an atomic, per-device startup inbox."""
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import uuid


def normalize(value):
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value):
        raise ValueError('邀请链接格式无效')
    try:
        url = urllib.parse.urlsplit(value)
        host, port = url.hostname, 8999 if url.port is None else url.port
    except ValueError as error:
        raise ValueError('邀请链接格式无效') from error
    room = urllib.parse.unquote(url.path[1:]).upper()
    label = r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
    if (url.scheme.lower() not in ('togetherwatch', 'syncplay') or not host
            or len(host) > 253 or not re.fullmatch(label + r'(?:\.' + label + ')*', host)
            or url.username is not None or url.password is not None or url.query or url.fragment
            or not 1 <= port <= 65535 or not re.fullmatch(r'[A-Z0-9]{3,12}', room)):
        raise ValueError('邀请链接格式无效')
    return 'togetherwatch://%s:%d/%s' % (host.lower(), port, room)


def enqueue(directory, value):
    value = normalize(value)
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / ('invite-' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps({'url': value, 'created': time.time()}), encoding='utf-8')
    os.replace(temporary, root / 'pending-invite.json')


def take(directory):
    root = Path(directory)
    claimed = root / ('invite-' + uuid.uuid4().hex + '.tmp')
    try:
        os.replace(root / 'pending-invite.json', claimed)
    except FileNotFoundError:
        return None
    try:
        data = json.loads(claimed.read_text(encoding='utf-8'))
        age = time.time() - float(data['created'])
        return normalize(data['url']) if 0 <= age < 300 else None
    except (ValueError, KeyError, TypeError):
        return None
    finally:
        claimed.unlink(missing_ok=True)
