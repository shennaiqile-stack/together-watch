import ast,json,os,threading,urllib.request,urllib.parse,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase,main
from unittest.mock import Mock,patch

class Readiness(TestCase):
    def setUp(self):
        tree=ast.parse((Path(__file__).resolve().parents[1]/'app.py').read_text(encoding='utf-8'))
        nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in ('Relay','Tunnel')]
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.scope=dict(threading=threading,os=os,DATA_DIR=self.tmp.name,urllib=urllib,json=json,APP_NAME='TestApp')
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'external','exec'),self.scope)
        self.app=SimpleNamespace(cfg={},instance_id='own-instance',log=Mock())
        self.t=self.scope['Tunnel'](self.app)
        self.t._generation=1;self.t.status='starting';self.t.proc=Mock(poll=Mock(return_value=None))

    def test_url_in_log_is_not_readiness(self):
        self.t._probe=lambda url:False
        self.assertFalse(self.t._confirm(1,'https://test.trycloudflare.com'))
        self.assertEqual((self.t.status,self.t.url),('starting',''))

    def test_verified_url_is_published(self):
        self.t._probe=lambda url:True
        self.assertTrue(self.t._confirm(1,'https://test.trycloudflare.com'))
        self.assertEqual(self.t.info()['status'],'running')

    def test_stop_cannot_be_undone_by_late_probe(self):
        self.t.stop();self.t._probe=lambda url:True
        self.assertFalse(self.t._confirm(1,'https://test.trycloudflare.com'))
        self.assertEqual((self.t.status,self.t.url),('stopped',''))

    def test_dead_process_removes_public_link(self):
        self.t.status='running';self.t.url='https://test.trycloudflare.com'
        self.t.proc.poll.return_value=1
        self.assertEqual(self.t.info()['status'],'error');self.assertEqual(self.t.url,'')

    def test_other_application_instance_is_rejected(self):
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=response
        with patch.object(urllib.request,'build_opener',return_value=opener):
            response.read.return_value=json.dumps({'app':'TestApp','instance':'other-instance'}).encode()
            self.assertFalse(self.t._probe('https://test.trycloudflare.com'))
            response.read.return_value=json.dumps({'app':'TestApp','instance':'own-instance'}).encode()
            self.assertTrue(self.t._probe('https://test.trycloudflare.com'))

if __name__=='__main__':main()
