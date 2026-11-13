import hashlib
import io
from pathlib import Path
import tempfile
import time
from unittest import TestCase
from unittest.mock import patch
from core.app_updates import AppUpdates, valid_url

URL='https://github.com/shennaiqile-stack/together-watch/releases/download/v99.0/TogetherWatch-Windows-v99.0.exe'


class Response(io.BytesIO):
    status=200


class Downloads(TestCase):
    def run_download(self, directory, content, expected=None, size=None):
        app=AppUpdates(directory)
        opener=type('Opener',(),{'open':lambda self,*args,**kw:Response(content)})()
        with patch('core.app_updates.urllib.request.build_opener',return_value=opener):
            app.start({'url':URL,'size':len(content) if size is None else size,'sha256':expected or hashlib.sha256(content).hexdigest()})
            for _ in range(100):
                if app.snapshot()['stage']!='downloading':break
                time.sleep(.01)
        return app

    def test_download_is_verified_before_becoming_installable(self):
        with tempfile.TemporaryDirectory() as root:
            app=self.run_download(root,b'MZ test release')
            self.assertEqual(app.snapshot()['stage'],'ready')
            self.assertEqual((Path(root)/'updates/TogetherWatch-update.exe').read_bytes(),b'MZ test release')
            self.assertFalse((Path(root)/'updates/package.part').exists())

    def test_corrupt_or_truncated_download_does_not_replace_a_verified_package(self):
        for digest,size in [('0'*64,None),(None,500)]:
            with self.subTest(digest=digest,size=size),tempfile.TemporaryDirectory() as root:
                directory=Path(root)/'updates';directory.mkdir();(directory/'TogetherWatch-update.exe').write_bytes(b'old-verified-package')
                app=self.run_download(root,b'bad-data',digest,size)
                self.assertEqual(app.snapshot()['stage'],'error')
                self.assertEqual((directory/'TogetherWatch-update.exe').read_bytes(),b'old-verified-package')
                self.assertFalse((directory/'package.part').exists())

    def test_install_rechecks_integrity_after_download(self):
        with tempfile.TemporaryDirectory() as root:
            app=self.run_download(root,b'MZ package')
            (Path(root)/'updates/TogetherWatch-update.exe').write_bytes(b'tampered')
            with self.assertRaises(ValueError):app.install()

    def test_untrusted_urls_and_redirects_are_rejected(self):
        for value in ['http://github.com/file.exe','https://evil.test/file.exe',URL+'?token=x',URL.replace('shennaiqile-stack','attacker'),'https://user:pass@github.com/file.exe']:
            with self.subTest(value=value),self.assertRaises(ValueError):valid_url(value)
        with self.assertRaises(ValueError):valid_url('http://127.0.0.1/evil',False)
        self.assertEqual(valid_url('https://release-assets.githubusercontent.com/file?signature=example',False),'https://release-assets.githubusercontent.com/file?signature=example')

    def test_running_client_rejects_equal_or_older_release_before_downloading(self):
        with tempfile.TemporaryDirectory() as root:
            app=AppUpdates(root,'99.0')
            with self.assertRaises(ValueError):app.start({'url':URL,'size':4,'sha256':'a'*64})
            self.assertEqual(app.snapshot()['stage'],'idle')
