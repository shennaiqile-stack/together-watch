"""Regression tests for the late fallback that used to open a second browser."""
import ast
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock


class WindowStartup(TestCase):
    def setUp(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8'))
        names = {'open_app_window', '_verify_app_window'}
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.clock = SimpleNamespace(now=100.0)
        self.time = SimpleNamespace(time=lambda: self.clock.now, sleep=self.sleep)
        self.thread = Mock()
        self.process = Mock(poll=Mock(return_value=0))
        self.scope = dict(time=self.time, os=SimpleNamespace(path=SimpleNamespace(join=lambda *x:'/'.join(x)), makedirs=Mock()),
                          DATA_DIR='test-data', find_browser=lambda:'msedge.exe', open_url=Mock(),
                          subprocess=SimpleNamespace(Popen=Mock(return_value=self.process), DEVNULL=-1),
                          threading=SimpleNamespace(Thread=self.thread))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'app_window', 'exec'), self.scope)
        self.app = SimpleNamespace(cfg={'open_mode':'app'}, page_loads=0, last_page_load=0, log=Mock())

    def sleep(self, seconds):
        self.clock.now += seconds

    def test_page_can_load_during_process_creation(self):
        def spawn(*args, **kwargs):
            self.app.page_loads=1; self.app.last_page_load=100.0
            return self.process
        self.scope['subprocess'].Popen.side_effect=spawn
        self.scope['open_app_window'](self.app, 8770)
        verifier=self.thread.call_args.kwargs['target']
        verifier(*self.thread.call_args.kwargs['args'])
        self.scope['open_url'].assert_not_called()
        self.app.log.assert_not_called()

    def test_handoff_process_exit_zero_does_not_open_another_browser(self):
        self.scope['_verify_app_window'](self.app,'http://localhost/',self.process,0,100.0)
        self.scope['open_url'].assert_not_called()
        self.assertEqual(self.clock.now,140)

    def test_slow_running_browser_does_not_spawn_a_second_window(self):
        self.process.poll.return_value=None
        self.scope['_verify_app_window'](self.app,'http://localhost/',self.process,0,100.0)
        self.scope['open_url'].assert_not_called()

    def test_failure_after_spawn_only_reports_failure(self):
        self.process.poll.return_value=1
        self.scope['_verify_app_window'](self.app,'http://localhost/',self.process,0,100.0)
        self.scope['open_url'].assert_not_called()
        self.app.log.assert_called_once()

    def test_fallback_only_when_spawn_itself_fails(self):
        self.scope['subprocess'].Popen.side_effect=OSError('cannot launch')
        self.scope['open_app_window'](self.app,8770)
        self.scope['open_url'].assert_called_once_with('http://127.0.0.1:8770/')
        self.thread.assert_not_called()

    def test_explicit_browser_preference_opens_only_one_browser(self):
        self.app.cfg['open_mode']='browser'
        self.scope['open_app_window'](self.app,8770)
        self.scope['open_url'].assert_called_once()
        self.scope['subprocess'].Popen.assert_not_called()


if __name__=='__main__':main()
