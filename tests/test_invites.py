import json
from pathlib import Path
import tempfile
import time
from unittest import TestCase
from core.invites import normalize, enqueue, take


class Invitations(TestCase):
    def test_valid_and_legacy_links_keep_exact_server_port_room(self):
        self.assertEqual(normalize('togetherwatch://154.64.252.247:8999/abc234'), 'togetherwatch://154.64.252.247:8999/ABC234')
        self.assertEqual(normalize('syncplay://example.net:12345/ABC234'), 'togetherwatch://example.net:12345/ABC234')

    def test_invalid_links_never_become_startup_commands(self):
        for url in ['https://example.net/ABC234', 'togetherwatch://user:pass@example.net/ABC234',
                    'togetherwatch://host:0/ABC234', 'togetherwatch://host:65536/ABC234',
                    'togetherwatch://host/../ABC234', 'togetherwatch://host/ABC234?x=1',
                    'togetherwatch://host/ABC234#fragment', 'togetherwatch://host/ABC234 --port 90',
                    'togetherwatch://host/%22', 'togetherwatch://-invalid/ABC234']:
            with self.subTest(url=url), self.assertRaises(ValueError):normalize(url)

    def test_startup_inbox_consumes_once_and_latest_click_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            enqueue(folder,'togetherwatch://host/FIRST1')
            enqueue(folder,'togetherwatch://host:9000/SECOND')
            self.assertEqual(take(folder),'togetherwatch://host:9000/SECOND')
            self.assertIsNone(take(folder))
            self.assertEqual(list(Path(folder).iterdir()),[])

    def test_expired_invitations_are_not_replayed_on_next_launch(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/'pending-invite.json').write_text(json.dumps({'url':'togetherwatch://host/ABC234','created':time.time()-600}))
            self.assertIsNone(take(folder))
