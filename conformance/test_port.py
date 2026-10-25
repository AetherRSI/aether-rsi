"""GET|POST api/port/<port>/…: the core fetches a server of an app on this machine for the shell, when the browser is on another host
(Google Cloud Shell's web preview) and cannot reach this machine's 127.0.0.1 itself. Only the ports the app's aether.json names."""

import json
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from conformance.helpers import NO_SAMPLES, SAMPLES, Live, free_port


class Echo(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _answer(self, body: bytes):
        self.send_response(201 if self.command == "POST" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._answer(json.dumps({"path": self.path}).encode())

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self._answer(json.dumps({"path": self.path, "body": self.rfile.read(n).decode(), "type": self.headers.get("Content-Type")}).encode())


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Port(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = Path(tempfile.mkdtemp(prefix="aether-port-"))
        shutil.copytree(SAMPLES, cls.ws, dirs_exist_ok=True)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Echo)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.up, cls.down = cls.srv.server_address[1], free_port()
        app = cls.ws / "apps/served"
        app.mkdir(parents=True)
        (app / "index.html").write_text("<p>x</p>")
        (app / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "app", "id": "served", "label": "Served", "entry": "index.html", "ports": [cls.up, cls.down]}))
        cls.core = Live(cls.ws)

    @classmethod
    def tearDownClass(cls):
        cls.core.close()
        cls.srv.shutdown()
        shutil.rmtree(cls.ws, True)

    def head(self, app="apps/served", **more):
        return {"X-Aether": "1", "X-Aether-App": app, **more}

    def test_get_and_post_reach_the_named_port(self):
        code, h, raw = self.core.call(f"api/port/{self.up}/sim/a%20b.json?x=1&y=%E3%81%82", headers=self.head())
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["path"], "/sim/a%20b.json?x=1&y=%E3%81%82")
        self.assertIn("application/json", h["Content-Type"])
        code, _, raw = self.core.call(f"api/port/{self.up}/api/vm", headers=self.head(**{"Content-Type": "text/plain"}))
        self.assertEqual(code, 200)
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{self.core.port}/api/port/{self.up}/api/vm", b'{"op":"stop"}', {**self.head(), "Content-Type": "text/plain"})
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.status, 201)
            d = json.loads(r.read())
        self.assertEqual((d["path"], d["body"], d["type"]), ("/api/vm", '{"op":"stop"}', "text/plain"))

    def test_gzip_when_the_browser_takes_it(self):
        import gzip
        code, h, raw = self.core.call(f"api/port/{self.up}/mesh.dae", headers=self.head(**{"Accept-Encoding": "gzip, br"}))
        self.assertEqual((code, h.get("Content-Encoding")), (200, "gzip"))
        self.assertEqual(int(h["Content-Length"]), len(raw))
        self.assertEqual(json.loads(gzip.decompress(raw))["path"], "/mesh.dae")
        code, h, raw = self.core.call(f"api/port/{self.up}/mesh.dae", headers=self.head())   # not asked: as it came
        self.assertEqual((code, h.get("Content-Encoding")), (200, None))
        self.assertEqual(json.loads(raw)["path"], "/mesh.dae")

    def test_refused(self):
        self.assertEqual(self.core.call(f"api/port/{self.up}/x", headers={"X-Aether-App": "apps/served"})[0], 403)   # not the shell
        self.assertEqual(self.core.call(f"api/port/{self.up}/x", headers=self.head(Origin="null"))[0], 403)   # a sandboxed frame
        self.assertEqual(self.core.call(f"api/port/{self.up}/x", headers=self.head("apps/hello-app"))[0], 403)   # that app names no ports
        self.assertEqual(self.core.call(f"api/port/{self.core.port}/api/info", headers=self.head())[0], 403)   # never the core itself
        self.assertEqual(self.core.call(f"api/port/{self.up}/x", headers=self.head("../.."))[0], 403)   # outside the workspace
        self.assertEqual(self.core.call(f"api/port/99999/x", headers=self.head())[0], 400)

    def test_nothing_listening(self):
        code, raw = self.core.json(f"api/port/{self.down}/x", headers=self.head())
        self.assertEqual(code, 502)
        self.assertIn(str(self.down), raw["error"])


if __name__ == "__main__":
    unittest.main()
