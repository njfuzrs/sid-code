---
Status: implemented
Date: 2026-09-01
Class: testing
---
# claude-code 对照真跑：装得上、跑不起来 —— 真因是 **Bun 要 AVX，而 qemu 不给**

## 决定了什么

①‴ 从「装得上」推进到「真跑」，落两个文件（都在 `evals/external-benchmarks/harbor/`）：

| 文件 | 作用 |
| --- | --- |
| `run-claude-code-contrast.sh` | 真跑对照的入口。闸 0 shim → 闸 1 flag 对齐 → 闸 2 apt 预算，**全在花钱之前** |
| `concurrency-evidence.py` | 从 `result.json` 时间戳算**真实区间重叠**，判"是否真并发" |
| `preflight-apt-budget.sh` | 新增：**30 秒**答"apt 下得完吗"，替掉 48 分钟撞上限 |

两条设计决定：

1. **`--ak max_turns=40` 写进脚本，不靠人记得传。** 这是第十棒留下的硬前置：
   `claude_code.py` 的 `max_turns` **无 default**，而 `base.py:719` 是
   `if value is None: continue` ⇒ `--max-turns` **整个不出现**，cc 用它自己的内部默认。
   不传则「轮数预算」这条必控变量静默破掉，而两侧仍以 `completed / errored=0` 收尾。
   闸 1 用**渲染实证**（真的调 `build_cli_flags()` 看字符串）而不是"我以为传了"。

2. **并发判据是区间重叠，不是 `-n` 的入参值，也不是墙钟变短。**
   `-n 6` 只表示"请求并发"；Harbor 真并发起容器、还是被某处串行化了，
   `-n` 一个字都不告诉你，而两种形态在退出码上逐字节一样。

## 放弃了什么（以及为什么不选）

- **❌ 用墙钟变短当并发证据。** 本仓 W0 那次正是这个坑：nop 三档
  `-n 1/3/6` 墙钟 10.16→4.12→2.44 min，但那 4.17× **全部来自 verifier**
  （nop 的 `agent_execution` 恒为 0）⇒「墙钟短了」推不出「agent 真并发」。
  所以只认 `agent_execution` 的重叠。

- **❌ 给容器注入代理来救慢速 apt。** 实测容器内**没有** proxy env（靠 TUN 出网），
  而 sid 侧基线也是这样跑的 —— 给 cc 单独加代理就是**改被测环境**，
  第三项必控变量（容器）当场破掉。慢就如实记慢。

- **❌ 直接开跑 10 题省掉单题冒烟。** 安装闸是 `--install-only`，
  **cc 的 `run()` 从未被执行过**。用 10 题去发现 run 路径的问题
  等于花钱买废数据（§5.2.4.6 的形态）。

- **❌ 改 cc 的 `run()` / 认证 / flag 语义**（沿用第十棒的决定）。
  改了对方行为，对照就变成「我们 vs 被我们改过的它」。

## 拿什么证明它生效了

**1. `concurrency-evidence.py` 能测出并发（拿已有真数据反向验证，$0）**：

```
runs/modelswitch-base（sid 侧 -n 6，真 agent）
  agent_execution n=10 Σ耗时 154.7 min 峰值并发 6 ✅ 并发
  并发折扣 Σ耗时÷墙钟 = 1.82×      墙钟 85.0 min
```

**2. 变异自证 —— 拿真 `-n 1` 的 run，它必须报串行**（退出码，不经管道）：

```
recheck-nop-n1   rc=1   峰值并发 1 ⛔ 完全串行
modelswitch-smoke rc=1   峰值并发 1 ⛔ 完全串行
modelswitch-base  rc=0   峰值并发 6 ✅ 并发
```

⚠️ 第一次量退出码时我把 `rc` 读成了 0 —— 那是我自己的测法错：
`echo "$(basename $r) rc=$?"` 里的命令替换先跑，`$?` 被它覆盖。
**这条本身就是「代理判据骗人」的又一个样本**：判据错时它不报错，只给你一个绿。

**3. 闸 1 的变异自证（$0）**：不传 `max_turns` 时 cc 侧渲染出
`--permission-mode=bypassPermissions` 而**没有** `--max-turns`
⇒ 闸判红 = True。传了则两侧都是 `--max-turns 40`。

**4. 模型同源（选项 A）静态实证**：宿主导出 `ANTHROPIC_BASE_URL` 后
`ClaudeCodeNpm.model_connection` = `ResolvedModelConnection(provider='anthropic',
base_url='http://192.168.5.2:4100')` ⇒ 指向我们的 shim，不是 Anthropic 官方端点。

**5. 🔴 真跑没跑成 —— 被一道算术挡住，实付 $0（模型零调用）。**

单题冒烟 `ccrun-smoke` 撞 **2880s（48min）上限** → `AgentSetupTimeoutError`，
**连 npm 那步都没进到**（shim 计数器全程 39 不动 ⇒ 模型一次没调）。
真因是纯算术，`--print-uris` 实证：

    apt 需下载   212,676,168 B ≈ 203 MB
    容器实测速率  12.8 KB/s（60s 窗口，amd64/qemu）
    ⇒ 需 270 min ≫ 48 min 上限   ⇒ 这一轮从一开始就不可能成功

**6. 🔴 我归因错了一次，而且是用户看文档看出来的 —— 这条是本 note 的主体。**

我给出的诊断是「瓶颈在 qemu 网络栈」。**它是错的**，三步实证推翻：

| 实测 | 数值 | 推翻了什么 |
| --- | --- | --- |
| amd64/qemu 容器 apt | **56 KB/s** | — |
| arm64 原生 curl 同 URL | **60 KB/s** | ⇒ 两者**一样** ⇒ **架构不是瓶颈** |
| 开飞鸟云**全局**后 amd64 apt | **755 KB/s** | ⇒ **13.5×**，真因是路由 |

用户指出「文档记录 claude-code 已装成功过」，去读 §4.5.3 才发现前提写得很清楚：
**「飞鸟云全局 + TUN 开启后」** apt 从 533s → 9s（60×）。而我全程只核了 TUN
（`utun5` 确实开着），**没核 mode**——当时是 `rule`，兜底规则 `GeoIP cn -> DIRECT`
把 deb.debian.org 走了裸直连。

> **形态**：文档把成功前提写成了「全局 + TUN」两个条件，我只验了后一个，
> 于是把「前提没满足」误诊成了「环境本身不行」，还据此编了一个物理解释（qemu）。
> ⚠️ **一个自洽的机理解释，比没有解释更危险** —— 它让人停止找真因。
> 那个 5.2× 的代理对照（137.7 vs 26.3 KB/s）确有其事，但它测的是 arm64，
> 与被测容器差一个变量，于是"修复"验在了一条不存在的路径上。

**6b. 我那个 `install()` 代理补丁不但没用，而且是有害的 —— 已 revert。**

开全局后容器经 TUN 已有 755 KB/s，而我注入的 `http_proxy` 让 apt 报
`502 Bad Gateway [IP: 192.168.5.2 7881]`。**对照实证**：

    注入代理     → apt update 502，安装闸红
    纯 TUN 不注入 → apt update rc=0，**85s** 完成，安装闸 ✅ 绿

⇒ `git checkout` 回原版。教训：**在错误诊断上叠的"修复"，会变成下一个故障源。**

**6c. 第三个自踩的坑：闸本身不许慢。**
闸的第二版让探针等 `apt-get update` 跑完 —— **那正是它要提前预警的那个慢操作**，
闸自己跑了 2 分钟还没出判决。现在只测固定窗口字节增量，全程封顶 ~30s。

**7. 闸链端到端实证（$0，~30s，不进 `harbor run`）**：

```
✅ 闸 0：shim 在跑，上游=claude-sonnet-5-ppchat
    cc  flags: --max-turns 40 --permission-mode=bypassPermissions
    sid flags: --max-turns 40 --dangerously-skip-permissions
✅ 闸 1：轮数与权限档两侧对齐（静态渲染实证）
  镜像架构=amd64  本机=arm64  需下载 202MB
  实测 41 KB/s ⇒ 预计 84min vs 上限 48min
⛔ 闸 2 未过 —— 别开跑
```

变异自证：`SID_CC_APT_BYTES=1048576` ⇒ 闸翻绿 rc=0；真值 202MB ⇒ rc=1。
⚠️ 三次实测速率 12.8 / 35 / 41 / 86 KB/s **阵发波动**，
所以闸的第一条建议是"等链路恢复后重测"，而不是直接判定环境不可用。

**8. ✅ 修正后安装闸真的绿了（$0，模型零调用）**：

    completed=1 errored=0  安装命令含 npm+钉版本=是
    agent_setup = 794s (13.2 min)  vs 上限 2880s
    npm install -g @anthropic-ai/claude-code@2.1.252   ✅

**9. 运维前提（必须与速率读数一起引用，否则数字不可复算）**：

> ⛔ **飞鸟云必须是「全局模式 + TUN」两个条件都满足**，只开 TUN 不够。
> `rule` 模式下 deb.debian.org 命中 `GeoIP cn -> DIRECT` 走裸直连（56 KB/s），
> 全局模式下 755 KB/s。**判据是容器内实测速率，不是「TUN 图标亮着」。**
> 这正是 §4.5.3 已经写过的那条前提 —— 它被写下来了，是我没核。

**10. 下一棒落点：预烘镜像（缓存）**。Harbor **每 trial 一个新容器、无跨题缓存**，
203MB 要下 10 次（单题 setup 794s ⇒ 10 题约 132 min 纯装配）。
harbor 自带 prebuilt 通道（`docker-compose-prebuilt.yaml` + `PREBUILT_IMAGE_NAME`，
`definition.py:26` 的 `should_use_prebuilt_docker_image`：给了 `docker_image`
且非 `force_build` 即走它）⇒ 预烘可落在这条既有通道上，不必改 harbor。
这也顺带消掉一个此前没人记的**对照不对称**：sid 侧 `install()` 是上传预编译二进制
（setup 中位 **8.7s**、零外网），cc 侧要下 203MB ⇒ **装配开销差 91×**。


---

## 11. 🔴 真跑结论（2026-09-02，实付 **$0** —— 模型零调用）

开全局后安装闸绿了，10 题真跑也起来了（**6 容器并发实证**），
但**没有一题跑到模型**。shim 计数器全程 39 不动 ⇒ 这一轮买回零样本，也零成本。

### 逐题失败签名（10/10 全部归因，无「不明」）

| 题数 | 签名 | 取数源 |
| --- | --- | --- |
| **4** | `Bun panic: CPU lacks AVX support` → exit 139 (SIGSEGV) | `agent/claude-code.txt` |
| **2** | `npm EBADENGINE: required node>=22.0.0, current v12.22.12` → exit 1 | `trial.log` |
| **4** | `claude` 在 qemu 下 **100% CPU 空转 10-15min**，`claude-code.txt` **0 行** | `docker stats` + 落盘 |

### 两个根因（都不是「网络」，也不是「装不上」）

**① `claude-code` 跑在 Bun 上，而 Bun 需要 AVX 指令集 —— qemu 模拟的 x86 不提供。**

```
docker run <amd64 镜像> grep -c avx /proc/cpuinfo
→ 0
```

崩溃信息是 cc 自己打出来的：`CPU lacks AVX support. Please consider upgrading
to a newer CPU.` / `panic(main thread): Segmentation fault` / `oh no: Bun has crashed.`
⇒ 那 4 题空转很可能同源（Bun 在缺 AVX 下退化到软件路径），**但空转这 4 题我没拿到
崩溃日志，所以「同源」是推断而非实证** —— 别当结论用。

**② 部分镜像是 Debian 11 (bullseye)，`apt` 的 nodejs 候选版本是 12.22.12。**

```
apt-cache policy nodejs → Candidate: 12.22.12~dfsg-1~deb11u8   (qemu-startup)
```

10 个镜像**全都不自带 node**（实测），所以 node 版本完全由各自发行版的 apt 决定，
⇒ bullseye 那批必然装出 v12，而 cc 要 `>=22`。**npm 只 WARN 不 fail**，
真正的 exit 1 来自 v12 解析新语法时的 `SyntaxError: Unexpected token '.'`（可选链）。

> ⚠️ **这条把「安装闸绿了」的含义收窄了**：闸只验了
> `log-summary-date-ranges`（Ubuntu 24.04，node 够新）**一个镜像**，
> 于是「装得上」被读成了「10 题都装得上」。
> **单题闸的绿，覆盖不了 10 个异构镜像** —— 这是本轮最该记住的判据缺陷。

### ⇒ 下一棒的落点变了（不再是「预烘镜像」那么简单）

预烘镜像能解 ②（钉 node 22），**但解不了 ①** —— AVX 是 CPU 指令集，
镜像里装什么都不会长出 AVX。三条路，按可行性：

| 方案 | 能否解 ① AVX | 代价 / 实测结论 |
| --- | --- | --- |
| ~~换 arm64 原生镜像~~ | ✅ 理论可行 | ⛔ **已实测排除**：上游只发 amd64 |
| ⭐ **在 x86_64 机器上跑对照** | ✅ 真 AVX | 需一台 x86 机器/云主机 —— **这是唯一能解 ① 的路** |
| 预烘镜像 + 钉 node22 | ⛔ 只解 ② | 单独做无用，但**上了 x86 后仍需要它**（bullseye 那批 node v12） |

**arm64 那条路已实测排除**（$0，只查 manifest）：

```
docker manifest inspect .../regex-log:2.0     → 无 manifests[] 列表 ⇒ 单架构
docker image inspect --format '{{.Architecture}}/{{.Os}}'  → amd64/linux
试探 :2.0-arm64 / :2.0-aarch64 / :arm64       → 全部不存在
```

⇒ **terminal-bench 2.0 只发 amd64**，在 arm64 Mac 上必然走 qemu，必然缺 AVX。
**结论：①‴ 这个对照在本机做不了，不是配置问题，是硬件/指令集问题。**
这条与 §13.3 那条「本机不可解」性质相同 —— 但注意**作废的仍然是"装不上"那条**
（cc 确实装得上，安装闸绿了），**新增的是"装上也跑不起来"**。

⚠️ **本轮不许推出任何 reward 比较** —— 两侧变量还没对齐到可比，
而且 cc 侧 0 个有效样本。要报也只能报「本机 arm64 + qemu 下 cc 跑不起来」这个机理。
