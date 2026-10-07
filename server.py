"""Local editor for the dataset. Run:  python3 server.py   then open http://localhost:8765"""

from __future__ import annotations

import base64
import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from granny import store
from granny.check import check

WEB = Path(__file__).resolve().parent / "web"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        if not path.is_file():
            return self._send(404, {"error": "not found"})
        self._send(200, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _parts(self):
        return [unquote(p) for p in urlparse(self.path).path.strip("/").split("/") if p]

    def _route(self, method):
        p = self._parts()
        try:
            if method == "GET" and not p:
                return self._file(WEB / "index.html")
            if method == "GET" and p[0] == "static" and len(p) == 2:
                return self._file(WEB / Path(p[1]).name)
            if method == "GET" and p[0] == "images" and len(p) == 3:
                return self._file(store.image_path(p[1], p[2]))
            if p[:2] != ["api", "patterns"] and p != ["api", "check"]:
                return self._send(404, {"error": "not found"})

            if p == ["api", "check"] and method == "POST":
                b = self._json()
                return self._send(200, check(b.get("human", ""), b.get("dsl", ""), b.get("terms", "US")))
            if len(p) == 2:
                if method == "GET":
                    out = []
                    for pid in store.list_ids():
                        d = store.load(pid)
                        r = check(d["human"], d["dsl"], d["meta"]["terms"])
                        out.append({**d["meta"], "rounds": len(r["rounds"]), "ok": r["ok"],
                                    "statuses": [x["status"] for x in r["rounds"]]})
                    return self._send(200, out)
                if method == "POST":
                    return self._send(201, {"id": store.create(self._json().get("title", "Untitled"))})
            pid = p[2]
            if len(p) == 3:
                if method == "GET":
                    return self._send(200, store.load(pid))
                if method == "PUT":
                    b = self._json()
                    store.save(pid, meta=b.get("meta"), human=b.get("human"), dsl=b.get("dsl"),
                               links=b.get("links"))
                    return self._send(200, store.load(pid))
            if len(p) >= 4 and p[3] == "images":
                if method == "POST" and len(p) == 4:
                    b = self._json()
                    name = store.add_image(pid, b["filename"], base64.b64decode(b["data"]))
                    return self._send(201, {"file": name, **store.load(pid)})
                if method == "DELETE" and len(p) == 5:
                    store.remove_image(pid, p[4])
                    return self._send(200, store.load(pid))
            return self._send(405, {"error": "method not allowed"})
        except FileNotFoundError:
            return self._send(404, {"error": "not found"})
        except (ValueError, KeyError) as e:
            return self._send(400, {"error": str(e)})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")


if __name__ == "__main__":
    print(f"Granny square editor on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
