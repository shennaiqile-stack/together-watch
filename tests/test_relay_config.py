import json
import ast
import os
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import patch
from core.relay_config import DEFAULT_RELAY, load_builtin_relay


class RelayConfiguration(TestCase):
    def test_public_defaults_use_owners_server_without_admin_credentials(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ,{'WT_RELAY_CLIENT_CONFIG':''}):
            config=load_builtin_relay(root)
            self.assertEqual(config['host'],'154.64.252.247')
            self.assertEqual(config['user'],'wt_relay')
            self.assertEqual(config['pass'],'')
            self.assertEqual(config['remote'],0)

    def test_restricted_credentials_are_loaded_without_altering_host_or_port_range(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ,{'WT_RELAY_CLIENT_CONFIG':''}):
            supplied={**DEFAULT_RELAY,'pass':'test-only-forwarding-password','port_min':1}
            (Path(root)/'relay-client.json').write_text(json.dumps(supplied))
            config=load_builtin_relay(root)
            self.assertEqual(config['pass'],supplied['pass'])
            self.assertEqual((config['port_min'],config['port_max']),(22000,22127))

    def test_admin_credentials_cannot_be_packaged_as_builtin_authentication(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ,{'WT_RELAY_CLIENT_CONFIG':''}):
            supplied={**DEFAULT_RELAY,'pass':'test-only-password','user':'Administrator'}
            (Path(root)/'relay-client.json').write_text(json.dumps(supplied))
            with self.assertRaises(ValueError):load_builtin_relay(root)

    def test_old_implicit_admin_default_does_not_override_restricted_account(self):
        source=ast.parse((Path(__file__).resolve().parents[1]/'app.py').read_text(encoding='utf-8'))
        function=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='load_config')
        with tempfile.TemporaryDirectory() as root:
            filename=Path(root)/'config.json'
            scope={'DEFAULT_CONFIG':{'relay_host':'','relay_user':'','relay_pass':'','relay_remote_port':0},'CONFIG_FILE':str(filename),'json':json}
            exec(compile(ast.Module(body=[function],type_ignores=[]),'load_config','exec'),scope)
            filename.write_text(json.dumps({'relay_user':'Administrator','relay_remote_port':8770}))
            loaded=scope['load_config']()
            self.assertEqual(loaded['relay_user'],'');self.assertEqual(loaded['relay_remote_port'],0)
            filename.write_text(json.dumps({'relay_host':'own.example','relay_user':'Administrator','relay_remote_port':8770}))
            loaded=scope['load_config']()
            self.assertEqual(loaded['relay_user'],'Administrator');self.assertEqual(loaded['relay_remote_port'],8770)
