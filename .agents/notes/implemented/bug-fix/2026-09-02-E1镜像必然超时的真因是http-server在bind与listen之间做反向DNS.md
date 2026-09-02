---
Status: implemented
Date: 2026-09-02
---
# E1 的 uv 镜像在本机**必然**起不来，真因是 `http.server` 在 bind() 与 listen() 之间调 `getfqdn()`（本机耗时 128.8s）

## 决定了什么

**E1（`lib/uv-mirror.sh`）从落地那一刻起，在本机就是 100% 失效的** —— 而它的失效
形态被自己的兜底逻辑写成了一行温和的警告，于是「已实现 + 门禁 16 pass」与
「真实评测里从未生效」同时成立。

第一次真跑 E1 时（2026-09-02，第十五棒）日志是：

```
✅ 已缓存 uv 0.7.13（17791244 B）
✅ 已缓存 uv 0.9.7（21420448 B）
⛔ 服务起了但取不到 astral-sh/uv/releases/download/0.7.13/... —— 不放绿
⚠️ uv 镜像未起成 —— 退回直连 github（= 本轮之前的行为，不更坏）。
   但那正是基线 5 题假 0 的成因，本轮仍可能复发。
```

⇒ 脚本**自己判自己没起成**，然后**继续跑评测**。若不是跑前盯了这一行，
就会花 $8.5 拿回一份与上次同形的数据，并把「E1 修好了但还是失败」写进下一棒交接。

**根因在 CPython stdlib，不在本仓脚本。** `HTTPServer.server_bind()` 是：

```python
socketserver.TCPServer.server_bind(self)   # bind() 已完成
host, port = self.server_address[:2]
self.server_name = socket.getfqdn(host)    # ← 卡在这里
self.server_port = port
```

而 `listen()` 由 `TCPServer.server_activate()` 在 `server_bind()` **返回之后**才调。
本机实测：

| 调用 | 耗时 |
| --- | --- |
| `socket.getfqdn("0.0.0.0")` | **128.8s** |
| `socket.getfqdn("127.0.0.1")` | 0.0s |

⇒ 套接字在这 128.8 秒里**bind 完但没 listen**，任何 curl 只能超时。
而调用方给的是 `sleep 1.5` + `curl -m 5` —— 连门都没进。

🔴 **三个信号全部指向「服务没起来」，而进程是活着的**：

| 信号 | 观测值 | 会把人引向 |
| --- | --- | --- |
| `lsof -nP -iTCP:18077` | `TCP *:18077 (CLOSED)` ← **不是 LISTEN** | 「端口没绑上」 |
| `curl -m 5` | `curl: (28) timed out` | 「网络/防火墙」 |
| `$MIRROR_DIR/http.log` | **空文件**（0 字节） | 「python 起崩了」 |

三者都是假线索。`server_name` 只用于生成 Host 相关的默认值，**镜像服务完全不需要它**。

**改法**：新增 `lib/uv-mirror-server.py`（20 行），子类化 `ThreadingHTTPServer` 覆写
`server_bind()`，跳过 `getfqdn` 直接写死 `server_name = "localhost"`；
`uv-mirror.sh` 改为调它（并新增 `SCRIPT_DIR`，因为三条 runner 的 cwd 各不相同）。

## 放弃了什么（以及为什么不选）

| 候选 | 为什么不选 |
| --- | --- |
| **`--bind 127.0.0.1`** | `getfqdn("127.0.0.1")` 确实是 0.0s，看起来是一行改完。⛔ **但容器就取不到了** —— 容器走 `192.168.5.2` 进来，而 E1 唯一真正的判据就是「容器内 http=200」。这个改法会让宿主侧探针全绿、容器侧全 404，即**把一个响亮的失败换成一个安静的失败**。 |
| **把 `sleep 1.5` 调大到 130s+** | 每次起镜像等两分钟，且这是**赌本机 DNS 一直是 128.8s**。它没消灭根因，只是让门禁在超时边缘上摆动 —— 属本仓「超时类 flake 先问验的是不是超时本身」那一类。 |
| **修本机 DNS / 改 `/etc/hosts`** | 那是**宿主环境状态**，不入库、不随 PR 走、换机器就没了。同一个坑会在下一台机器上原样复发，而 `gateway.py` 不在版本库已经是本仓一个现成的教训。 |
| **不用 python，改 `nc` / `caddy` / `busybox httpd`** | 引入新依赖换掉 20 行 stdlib 代码；且 `python3` 已是本链路硬依赖（harbor 本身就是 python）。 |
| **只在文档里记一句「起不来就手动起服务」** | 把机械的事交给人记 = 在最需要它的那次忘掉。E1 的价值恰恰是「不依赖人记得」。 |

## 拿什么证明它生效了

**① 先证伪「是脚本逻辑写错了」**（否则会去改探针的超时值）：裸 socket 对照 ——

```
python3 listen-test.py 127.0.0.1 18077 → bind ok / listen ok / (LISTEN) / nc: open
python3 listen-test.py 0.0.0.0   18077 → bind ok / listen ok / (LISTEN) / nc: open
```

⇒ OS 与 `0.0.0.0` 都无罪，差异只能在 `http.server` 内部。

**② 直接计时坐实真因**（这一条是判据本身，不是机理推断）：

```
getfqdn('0.0.0.0')   = 'zhourushengdeMacBook-Pro.local'  用时 128.8s
getfqdn('127.0.0.1') = '1.0.0.127.in-addr.arpa'          用时 0.0s
```

**③ 修完跑真入口**（⚠️ 不是跑我手搓的等价副本 —— 本仓「测试绕过真实入口」那条教训）：

```
$ bash lib/uv-mirror.sh start
    ✅ 已缓存 uv 0.7.13（17791244 B）
    ✅ 已缓存 uv 0.9.7（21420448 B）
    ✅ 镜像服务已起（pid=39923，目录 /Users/zhourusheng/.cache/sid-uv-mirror）
    ✅ 容器内实测可达（http=200 @ 192.168.5.2:18077）
rc=0
lsof → TCP *:18077 (LISTEN)        ← 2s 内到位，不再是 CLOSED
```

**④ 真实 runner 里 E1 那行终于打出来了**（改之前是 `⚠️ 未起成`）：

```
✅ 端口 18077 上已有可用镜像服务，复用
✅ 容器内实测可达（http=200 @ 192.168.5.2:18077）
✅ 已注入 --ve UV_INSTALLER_GITHUB_BASE_URL=http://192.168.5.2:18077
```

**⑤ 闸 1（runner 自带、容器内实测下载速率）** ——
`✅ 5356093B/s ≥ 500000B/s`。对照原始失败成因：那 5 题死于 `curl` 打不通 github
（05 号文档另记过 uv 38KB/s 的时代）⇒ 本地镜像 **5.36MB/s**，且不出宿主。

**⑥ 门禁**：`bun test ./tests/eval/harbor-uv-mirror-parity.test.ts` → **16 pass / 0 fail**
（该门禁只锁三条 runner 的注入对称性，不约束服务怎么起 ⇒ 本次改动未削弱它）。

### ⚠️ 尚未证明的那一半（不许含糊过去）

**E1 在一次完整评测里把 `verifier_ran` 从 5/10 抬到 10/10 —— 这件事仍未验证。**
本次真跑在闸 2（上游错误率）处因**额度不足**被用户主动取消，
`runs/modelswitch-base-rerun/` **未创建**、实付 **$0**、无任何 trial 落盘。

⇒ 上面 ①–⑥ 只证明了「镜像服务真的起来了、容器真的取得到、注入真的发生了」。
唯一的终局判据仍是 05 号文档 §00 第 2 步那个 `verifier_ran()` 计数，
**它要等重跑之后才有值**。⛔ 在那之前不许说「E1 已验证生效」。
