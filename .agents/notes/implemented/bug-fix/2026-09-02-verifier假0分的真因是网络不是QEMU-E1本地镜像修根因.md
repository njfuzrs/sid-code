---
Status: implemented
Date: 2026-09-02
---
# verifier「假 0 分」的真因是下 uv tarball 的网络抖动，不是 QEMU 判不出位宽；用宿主本地镜像（E1）修掉根因

## 决定了什么

**① 证伪了一个已写进交接文档的归因，并修掉真根因。**

`runs/modelswitch-base` 里 **5/10 题的 `reward=0` 是假 0** —— verifier 根本没判分。
05 号文档 §00 与 §5.2.7 行 `7c` 把真因写成「QEMU binfmt 下 `/proc/self/exe` 坏 →
uv 官方安装器判不出位宽 → 装不上」，并据此排出「先跑 1 题验证自愈，再决定花不花 $8.5」。

**三条独立证伪**：

| 判据 | 事实 |
| --- | --- |
| `unknown platform bitness` 的分布 | `modelswitch-base` **10/10 题都有**、`modelswitch-ds` **10/10 题都有** —— 含 verifier 正常判分的题 ⇒ **它不预测失败** |
| 同夜同 QEMU 的对照 | `modelswitch-ds`（早 8h、同样无 Rosetta）**verifier 10/10 真判分、uv 失败 0 题** ⇒ QEMU 不可能是原因 |
| stdout 里真正的致命行 | 一律是 curl：`(7) Failed to connect to github.com port 443 after 75015 ms` / `(56) Failure when receiving data` / `OpenSSL unexpected eof` |

位宽判定失败**不致命**：`get_bitness` 的 `err()` 虽 `exit 1`，但跑在 `$(...)` 子 shell 里
只杀子 shell —— 日志紧跟一行 `[: Illegal number:` 就继续，且**目标三元组仍选对**
（下一行就是 `downloading uv 0.7.13 x86_64-unknown-linux-gnu`）。

⇒ 真凶是**下 17.8MB tarball 时的网络抖动**。**两者风险形态相反**，这是归因错误的真实代价：
位宽是确定性的、修一次就好；网络抖动是**概率性**的 ⇒「重跑一次就好」没有保障，
而「先跑 1 题验证」**验不出概率性故障**（1 题绿推不出 10 题绿）。

**② 新增 `evals/external-benchmarks/lib/uv-mirror.sh`（E1）**：把 uv 下载指向宿主本地
HTTP，消灭那次外网下载。`warm` 幂等落盘 → 起 `http.server` → **两道闸**（宿主取到 +
容器内实测取到）→ 吐 `UV_MIRROR_BASE_URL`。

**③ 三条 runner 同时接入** `--ve UV_INSTALLER_GITHUB_BASE_URL=...`：
`run-model-switch.sh` / `run-claude-code-contrast.sh` / `run-permission-switch.sh`。
**必须同时接**：verifier 是两侧共用的一层，坏掉的样本与「没解出来」逐字节相同（都 reward=0）
⇒ 只接一侧 = 判分可靠性成为不受控变量，而分数会被并排进同一张表。

**④ 新增门禁** `tests/eval/harbor-uv-mirror-parity.test.ts`（16 pass），锁对称性 + 两个易错点。

**⑤ 更正 05 号文档四处**：§00 真因段、`-n 6` 禁令措辞、§5.2.7 行 `7c`、§5.0 第 3 条 E1 判据；
另修标题「三个已知但未做」而表里只有 2 行。

## 放弃了什么（以及为什么不选）

| 候选 | 否决理由 |
| --- | --- |
| **直接重跑 10 题赌它自愈**（文档原方案的下一步） | 真因是概率性网络故障 ⇒ 自愈**没有保障**。$8.5 买一份「这次恰好没断」的数据，下次照样复发 |
| **先跑 1 题验证再决定**（文档原方案） | **概率性故障验不出来**。1 题绿了推不出 10 题都绿；而这一步要花 ~$0.5 且给人「已验证」的错觉 —— 比不验更坏 |
| `INSTALLER_DOWNLOAD_URL`（§4.4.4 原文写的那个变量） | 它把**版本目录锁死在 URL 里**，而题目实测在用**两个** uv 版本（10 题 0.7.13 + hello-world 0.9.7）⇒ 得按题分别注入。改用 `UV_INSTALLER_GITHUB_BASE_URL`：替换 github 根，安装器自己拼版本路径，**一个镜像服务所有版本**，将来题目换版本也不用改 |
| `host.docker.internal` 作宿主地址 | **实测任务镜像里不解析**（`curl: (6) Could not resolve host`）。用 `192.168.5.2`（colima host-gateway，与 gateway shim 同址）。⚠️ 也不是 `172.17.0.1` |
| 把 uv 预装进被测镜像 | 改被测环境 = 破可比性，且 89 题要各改一遍。`--ve` 只注入 verifier 阶段，不碰 agent |
| 镜像起不来就**中止**评测 | 退回直连 = 本轮之前的行为，**不比原来更坏**，中止反而挡住能跑的场合。但**必须打出提示** —— 静默退化是本仓最贵的那类错 |
| 把 `gate-claude-code-install.sh` 也纳入门禁 | 它用 `--install-only`，**不跑 verifier** ⇒ E1 对它无意义。纳入只会逼出一个「为了让门禁绿」的空注入 |
| 顺手实测 `-n 8` | 收益方向错：`-n` 是必控变量，改了配对就没了。真要测该用 `nop`（$0），别拿 $8.5 真跑去赌 |

## 拿什么证明它生效了

**① 因果实证（强判据）**：容器内把 `github.com` 写进 `/etc/hosts` 黑洞 ——
**装成了就只能是走镜像**：

```
github http=000                       ← 确认 github 已不可达
everything's installed!
uv 0.7.13                             ← ✅ 装上了
/root/.local/bin/env 存在              ← test.sh line12 靠它 source
```

**负对照（同样黑洞、不给镜像变量）** ⇒ 必须失败，且形态与基线那 5 题**逐字节同形**：

```
failed to download https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz
/usr/bin/sh: 6: uv: not found
```

`0.9.7` 同一镜像也通（`uv 0.9.7`）⇒ 一个镜像服务两个版本成立。

**② 门禁 16 pass + 7 条变异自证，逐条确认「红的是哪一条」**（不是「有东西红了」）：

| 变异 | 结果 |
| --- | --- |
| cc 侧摘掉 `--ve` | 1 fail，红在 `cc（run-claude-code-contrast.sh） 注入了 --ve` |
| sid 侧摘掉 `--ve` | 1 fail，红在 `sid（run-model-switch.sh） 注入了 --ve` |
| perm 侧摘掉 `--ve` | 1 fail，红在 `perm（run-permission-switch.sh） 注入了 --ve` |
| `HOST_ADDR` 改回 `host.docker.internal` | 1 fail，红在「宿主地址是 colima host-gateway」 |
| 容器闸不再取 `http_code` | 1 fail，红在「容器侧可达性是独立一闸」 |
| cc 侧跳过开关改名 | 1 fail，红在「跳过开关同名」 |
| 删掉退化提示 | 1 fail，红在「镜像起不来时不静默退化」 |

变异均在真源文件上做、`shasum -a 256 -c` 核复原（三文件全 OK，无残留 `.bak`）。

**③ 🔴 变异自证抓到了我自己门禁里的一个真 bug —— 这条最值得记**：

初版断言直接在**全文**上 `toContain("--ve")`。而我在两个 runner 里都写了解释性注释，
注释里恰好含 `--ve` 与 `UV_INSTALLER_GITHUB_BASE_URL` ⇒
**把真正的注入行整个摘掉，门禁照样 12 pass 全绿**。

形态与 `evals/CLAUDE.md` §4.4 那条**同源**：那次是「把源码里"不要用它"的警告注释
判成了违规」（假红），这次是「把注释里的关键词当成代码在生效」（**假绿**）——
同一个根因：**判据读了不该读的文本**。修法是加 `codeOf()` 剥掉 `#` 注释行，
并把判据从「两个词各自出现过」改成**注入形态** `/--ve\s+"UV_INSTALLER_GITHUB_BASE_URL=/`。

⚠️ **只跑 happy path 的话这个 bug 会一直躺在那里**，而它守的恰好是最贵的那个不变量。

**④ 仓库门禁**：`bun run affected-tests:run` + `make build`（见下方执行记录）。

## ⚠️ 没有证明的（不许当已验证）

- **没有重跑基线**。E1 消灭的是「下 uv 失败」这一类；`verifier_ran()` 是否真的
  从 5/10 转到 10/10，**只有真跑才知道**。
- `regex-log` 那题是 **`agent_ran=False` 且跑满 85.0 min**（= 整个 run 的墙钟，
  把并发折扣从 ds 的 4.67× 拖到 2.13×）⇒ 它**不是** uv 问题，**E1 修不掉它**，
  重跑仍可能再废一次。
- 「`-n 6` 是内存上限」是**外推**：四个 run 的 `job.log` 里
  `OOM` / `137` / `Killed` **全 0 命中**，从未真的撞墙。
