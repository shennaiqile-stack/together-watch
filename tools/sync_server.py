"""Standalone TLS Syncplay server; deploy beside core/syncplay.py and its certificate."""
from pathlib import Path
import os
import ssl
import sys
import time

BASE = Path(__file__).resolve().parent
if (BASE.parent / 'core').is_dir():
    sys.path.insert(0, str(BASE.parent / 'core'))
from syncplay import SyncplayServer


def log(message):
    line = time.strftime('%Y-%m-%d %H:%M:%S ') + message
    print(line, flush=True)
    with (BASE / 'syncplay.log').open('a', encoding='utf-8') as output:
        output.write(line + '\n')


def main():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(os.environ.get('SYNCPLAY_TLS_CERT', str(BASE / 'server-cert.pem')),
                            os.environ.get('SYNCPLAY_TLS_KEY', str(BASE / 'server-key.pem')))
    server = SyncplayServer(port=int(os.environ.get('SYNCPLAY_PORT', '8999')), log=log)
    server.tls_context = context
    server.start()
    log('TLS Syncplay server ready')
    try:
        while True:
            time.sleep(3600)
    finally:
        server.stop()


if __name__ == '__main__':
    main()
