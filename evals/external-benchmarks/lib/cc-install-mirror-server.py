#!/usr/bin/env python3
"""D2：cc 安装镜像的 HTTP 服务端。**不要**换回 `python3 -m http.server`。

与 `uv-mirror-server.py` 同一条根因：stdlib `HTTPServer.server_bind()` 在
bind() 与 listen() 之间调 `socket.getfqdn(host)`，本机对 `0.0.0.0` 实测 128.8s。
必须 `0.0.0.0`（容器走 192.168.5.2）+ 跳过 getfqdn。

本服务比 uv 镜像多一件事：把缓存的 npm packument 里 `dist.tarball`
**当场改写成镜像 URL**。不改的形态是 packument 200、npm 仍去
registry.npmjs.org 拉 214MB 平台包 —— 宿主探针全绿，容器里还是
`claude native binary not installed`（08a §3.7）。
"""

from __future__ import annotations

import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class FastBindHTTPServer(ThreadingHTTPServer):
    """跳过 `getfqdn()`：见模块头。"""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def _send_file(handler: BaseHTTPRequestHandler, path: Path, content_type: str) -> None:
    if not path.is_file():
        handler.send_error(404, f"missing {path.name}")
        return
    data = path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "public, max-age=86400")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


def _send_json(handler: BaseHTTPRequestHandler, obj: object) -> None:
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


def rewrite_tarball(doc: dict, public_base: str, name: str) -> dict:
    """把 version document 的 dist.tarball 改成镜像 URL。

    不改的形态：packument 200、npm 仍打 registry.npmjs.org 拉 214MB 平台包。
    """
    tarball_name = str(doc["dist"]["tarball"]).rsplit("/", 1)[-1]
    rewritten = dict(doc)
    rewritten["dist"] = dict(doc["dist"])
    rewritten["dist"]["tarball"] = f"{public_base.rstrip('/')}/npm/{name}/-/{tarball_name}"
    return rewritten


def as_packument(doc: dict, public_base: str) -> dict:
    rewritten = rewrite_tarball(doc, public_base, doc["name"])
    return {
        "name": doc["name"],
        "dist-tags": {"latest": doc["version"]},
        "versions": {doc["version"]: rewritten},
    }


def make_handler(root: Path, public_base: str):
    """public_base 形如 http://192.168.5.2:18078 —— packument 里的 tarball 必须用它。"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

        def do_HEAD(self) -> None:
            self.do_GET()

        def do_GET(self) -> None:
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/-/ping", "/npm/-/ping"):
                _send_json(self, {})
                return
            if path.startswith("/node-") and path.endswith(".tar.xz"):
                _send_file(self, root / path.lstrip("/"), "application/x-xz")
                return
            if path.startswith("/npm/"):
                rest = path[len("/npm/") :].lstrip("/")
                if "/-/" in rest:
                    filename = rest.split("/-/")[-1]
                    _send_file(
                        self,
                        root / "tarballs" / filename,
                        "application/octet-stream",
                    )
                    return
                # packument（@scope/name）或 version document（@scope/name/1.2.3）
                parts = rest.split("/")
                version = None
                if len(parts) >= 3 and parts[0].startswith("@"):
                    name = f"{parts[0]}/{parts[1]}"
                    if len(parts) >= 3 and parts[2]:
                        version = parts[2]
                elif len(parts) >= 1:
                    name = parts[0]
                    if len(parts) >= 2 and parts[1]:
                        version = parts[1]
                else:
                    self.send_error(404, "empty npm path")
                    return
                meta = root / "meta" / f"{name}.json"
                if not meta.is_file():
                    self.send_error(404, f"no packument for {name}")
                    return
                doc = json.loads(meta.read_text(encoding="utf-8"))
                rewritten = rewrite_tarball(doc, public_base, name)
                if version:
                    if version != str(doc.get("version")):
                        self.send_error(404, f"{name}@{version} not cached")
                        return
                    _send_json(self, rewritten)
                    return
                _send_json(self, as_packument(doc, public_base))
                return
            self.send_error(404, path)

    return Handler


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "用法: cc-install-mirror-server.py <port> <directory> <public_base>",
            file=sys.stderr,
        )
        return 2
    port, directory, public_base = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    handler = make_handler(directory, public_base.rstrip("/"))
    with FastBindHTTPServer(("0.0.0.0", port), handler) as httpd:
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
