import ast
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main

class Client:
    def __init__(self,host,port,username,room,callback,*args,**kwargs):
        self.host=host;self.port=port;self.callback=callback
    def start(self):pass
    def stop(self):pass

class Sessions(TestCase):
    def setUp(self):
        tree=ast.parse((Path(__file__).resolve().parents[1]/'app.py').read_text(encoding='utf-8'))
        node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Session')
        scope={'threading':threading,'SyncplayClient':Client}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'Session','exec'),scope)
        self.messages=[];self.ws=SimpleNamespace(alive=True,send_json=self.messages.append)
        self.session=scope['Session'](self.ws,None)
    def test_switched_session_cannot_report_old_room_as_connected(self):
        self.session.join('old.test',8999,'a','OLD');old=self.session.client
        self.session.join('new.test',8995,'a','NEW');new=self.session.client
        old.callback({'type':'connected','room':'OLD'})
        self.assertEqual(self.messages,[])
        new.callback({'type':'connected','room':'NEW'})
        event=self.messages[0]['event']
        self.assertEqual((event['server'],event['port'],event['room']),('new.test',8995,'NEW'))
    def test_late_events_after_leave_are_ignored(self):
        self.session.join('host.test',8999,'a','ROOM');old=self.session.client
        self.session.leave();old.callback({'type':'connected','room':'ROOM'})
        old.callback({'type':'error','message':'late'})
        self.assertEqual(self.messages,[])

if __name__=='__main__':main()
