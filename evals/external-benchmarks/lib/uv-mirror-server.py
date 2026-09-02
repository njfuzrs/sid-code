#!/usr/bin/env python3
"""E1 uv 镜像的 HTTP 服务端。**不要**换回 `python3 -m http.server`。

## 为什么必须自己写这 20 行（2026-09-02 实测，$0）

`python3 -m http.server --bind 0.0.0.0` 在**本机上必然超时**，而形态极具欺骗性：

    lsof -nP -iTCP:18077  →  TCP *:18077 (CLOSED)   ← 不是 LISTEN
    curl -m 5 ...         →  curl: (28) timed out
    http.log              →  **空的**（一个字节都没有）

⇒ 三个信号都指向"服务没起来"，而进程**活着**、端口**已 bind**。

根因在 stdlib：`HTTPServer.server_bind()` 是

    socketserver.TCPServer.server_bind(self)   # bind() 完成
    host, port = self.server_address[:2]
    self.server_name = socket.getfqdn(host)    # ← 卡在这里
    self.server_port = port

`listen()` 由 `TCPServer.server_activate()` 在 `server_bind()` **返回之后**才调。
而本机 `socket.getfqdn("0.0.0.0")` 实测要 **128.8 秒**（反向 DNS 查 `0.0.0.0`），
`getfqdn("127.0.0.1")` 只要 0.0s ⇒ 于是套接字在这 128.8s 里**卡在 bind 完但没 listen**，
任何 curl 都只能超时。调用方的 `sleep 1.5` + `-m 5` 探针连门都没进。

`server_name` 只用于生成 `Host` 相关的默认值，**镜像服务完全不需要它** ——
所以这里绕过 `getfqdn`、直接写死 `localhost`。

⚠️ 别用「把 `--bind` 改成 127.0.0.1」来绕：容器（`192.168.5.2`）就取不到了，
而那是 E1 唯一真正的判据。必须 `0.0.0.0` + 跳过 `getfqdn`。
"""

import socketserver
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class FastBindHTTPServer(ThreadingHTTPServer):
    """跳过 `getfqdn()`：见模块头注释，它在本机要 128.8s，且我们不需要它的返回值。"""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: uv-mirror-server.py <port> <directory>", file=sys.stderr)
        return 2
    port, directory = int(sys.argv[1]), sys.argv[2]
    handler = partial(SimpleHTTPRequestHandler, directory=directory)
    # 容器要走 192.168.5.2 进来，所以必须 0.0.0.0 —— 见模块头注释最后一段。
    with FastBindHTTPServer(("0.0.0.0", port), handler) as httpd:
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
