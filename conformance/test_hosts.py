"""DNS rebinding: a page of another site resolved to 127.0.0.1 is same-origin to the browser, so X-Aether no longer stops it.
The core answers only names nobody can rebind (an IP address, localhost) and the ones settings.json `hosts` / AETHER_HOSTS add."""

import json
import os
import socket
import tempfile
import unittest
from pathlib import Path

from conformance.helpers import Live
from aether import settings
from aether.server import allowed_host, hostname


class Names(unittest.TestCase):
    def test_hostname(self):
        self.assertEqual(hostname("127.0.0.1:8030"), "127.0.0.1")
        self.assertEqual(hostname("LocalHost:8030"), "localhost")
        self.assertEqual(hostname("[::1]:8030"), "::1")
        self.assertEqual(hostname("http://evil.example:8030", url=True), "evil.example")
        self.assertIsNone(hostname(""))
        self.assertIsNone(hostname("null", url=True))   # a sandboxed frame: the POST rules handle it

    def test_allowed(self):
        for ok in ("127.0.0.1", "::1", "192.168.1.5", "localhost"):
            self.assertTrue(allowed_host(ok), ok)
        for bad in ("evil.example", "localhost.evil.example", "127.0.0.1.evil.example"):
            self.assertFalse(allowed_host(bad), bad)
        self.assertTrue(allowed_host("proxy.example", {"proxy.example"}))
        self.assertTrue(allowed_host("8080-cs-1.cloudshell.dev", {".cloudshell.dev"}))   # a domain and the names under it
        self.assertTrue(allowed_host("cloudshell.dev", {".cloudshell.dev"}))
        self.assertFalse(allowed_host("evilcloudshell.dev", {".cloudshell.dev"}))

    def test_settings_hosts(self):
        s, bad = settings.parse({"hosts": ["Proxy.Example", "https://x.example", "a.example:443"]})
        self.assertEqual(s["hosts"], ["proxy.example"])
        self.assertEqual(len(bad), 2)


class Live_(unittest.TestCase):
    def setUp(self):
        self.live = Live(workspace=str(Path(tempfile.mkdtemp()).resolve()))
        self.addCleanup(self.live.close)

    def test_rebound_name_is_refused(self):   # V1
        h = {"Host": f"attacker.example:{self.live.port}", "Origin": f"http://attacker.example:{self.live.port}"}
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, h)[0], 403)
        self.assertEqual(self.live.call("api/info", None, {"Host": f"attacker.example:{self.live.port}"})[0], 403)
        self.assertEqual(self.live.call("api/read?path=a.txt", None, {"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.live.json("api/tasks")[1], [])   # nothing was added

    def test_foreign_origin_is_refused(self):   # an allowed Host with another site's Origin
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"Origin": "http://attacker.example"})[0], 403)

    def test_local_names_pass(self):
        for host in (f"127.0.0.1:{self.live.port}", f"localhost:{self.live.port}"):
            self.assertEqual(self.live.call("api/info", None, {"Host": host})[0], 200, host)
        self.assertEqual(self.live.call("api/tasks", {"title": "ok"}, {"Origin": f"http://localhost:{self.live.port}"})[0], 200)

    def test_csrf_and_sandbox_still_refused(self):   # V2, V3
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"X-Aether": "", "Origin": "http://127.0.0.1"})[0], 403)
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"Origin": "null"})[0], 403)

    def test_a_proxy_name_can_be_added(self):
        os.environ["AETHER_HOSTS"] = "proxy.example"
        self.addCleanup(os.environ.pop, "AETHER_HOSTS", None)
        self.assertEqual(self.live.call("api/info", None, {"Host": "proxy.example"})[0], 200)
        self.assertEqual(self.live.call("api/info", None, {"Host": "other.example"})[0], 403)

    def test_cloud_shell_web_preview(self):   # the proxy rewrites Host to 127.0.0.1 and keeps the page's Origin
        os.environ["WEB_HOST"] = "cs-1-default.cs-asia-east1-x.cloudshell.dev"
        self.addCleanup(os.environ.pop, "WEB_HOST", None)
        o = f"https://{self.live.port}-cs-1-default.cs-asia-east1-x.cloudshell.dev"
        self.assertEqual(self.live.call("api/tasks", {"title": "ok"}, {"Origin": o})[0], 200)
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"Origin": "https://8080-cs-2-default.cs-asia-east1-x.cloudshell.dev"})[0], 403)   # someone else's

    def test_settings_hosts_are_read(self):
        Path(os.environ["AETHER_SETTINGS"]).write_text(json.dumps({"hosts": ["relay.example"]}))
        self.addCleanup(Path(os.environ["AETHER_SETTINGS"]).unlink)
        self.assertEqual(self.live.call("api/info", None, {"Host": "relay.example"})[0], 200)

    def test_websocket_upgrade_with_a_rebound_name(self):
        s = socket.create_connection(("127.0.0.1", self.live.port), timeout=5)
        s.sendall(b"GET /api/jobs/x/audio?ticket=t HTTP/1.1\r\nHost: attacker.example\r\nUpgrade: websocket\r\n"
                  b"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.assertIn(b" 403 ", s.recv(200))
        s.close()


if __name__ == "__main__":
    unittest.main()
