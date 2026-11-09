"""Test-only browser host for the Android UI branch; does not emulate the Android OS."""
import os
from pathlib import Path
import sys
import urllib.parse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app

class PhoneUI(app.Handler):
    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path=='/api/fullscreen':return self._json({'ok':True})
        return super().do_GET()
    def _static(self,path):
        if path in ('/','/index.html'):
            data=(Path(app.WEB_DIR)/'index.html').read_text(encoding='utf8').replace('<head>',"<head><script>window.WT_MEDIA_BASE='http://127.0.0.1:8790';window.WT_APP_VERSION='5.1-preview';</script>").encode()
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data);return
        return super()._static(path)

cfg={'port':8790,'syncplay_port':9021,'username':'PhonePreview','quality':80,'open_mode':'app'}
application=app.App(cfg)
server=app.Server(('127.0.0.1',8790),PhoneUI,application)
application.httpd=server
server.serve_forever()
