"""Public relay defaults; only restricted forwarding credentials may be bundled."""
import json
import os
from pathlib import Path

DEFAULT_RELAY = {
    'host': '154.64.252.247', 'port': 22, 'user': 'wt_relay', 'pass': '',
    'hostkey': 'SHA256:7DhRs07ihFXPQAFpHD6MKM2G7OQGG2gnpAE5XT1DKQo',
    'remote': 0, 'port_min': 22000, 'port_max': 22127,
}


def load_builtin_relay(root):
    result = dict(DEFAULT_RELAY)
    filename = os.environ.get('WT_RELAY_CLIENT_CONFIG') or str(Path(root) / 'relay-client.json')
    try:
        supplied = json.loads(Path(filename).read_text(encoding='utf-8'))
        if (supplied.get('host') != result['host'] or supplied.get('user') != result['user']
                or supplied.get('hostkey') != result['hostkey']
                or not isinstance(supplied.get('pass'), str) or not supplied['pass']):
            raise ValueError('Only the restricted relay account may be bundled')
        result['pass'] = supplied['pass']
    except FileNotFoundError:
        pass
    return result
