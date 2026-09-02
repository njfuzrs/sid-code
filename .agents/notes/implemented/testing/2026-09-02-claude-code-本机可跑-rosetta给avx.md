---
Status: implemented
Date: 2026-09-02
Class: testing
---
# ①‴ 「本机跑不起来、必须上 x86 机器」被推翻 —— Rosetta 就给 AVX，本机可跑

推翻的是前一棒 `2026-09-01-claude-code-对照真跑-并发实证判据.md` §11 的结论
（那份 note 的其余部分仍然有效，**只有「必须换机器」这一条作废**）。

## 决定了什么

**判据：`docker run --platform linux/amd64 <镜像> grep -c avx /proc/cpuinfo`**

| VM 配置 | avx_count | 原版 amd64 claude-code |
| --- | --- | --- |
| `rosetta: false`（swebench 现状，binfmt→QEMU） | **0** | ⛔ 2.3s 后 SIGSEGV |
| `rosetta: true`（`--vz-rosetta`） | **2**（`avx avx2` 都在） | ✅ 全 agent 循环跑通 |

⇒ **AVX 缺失不是「arm64 Mac 的硬件属性」，是 colima 这一个 profile 的开关状态。**
本机 `/Library/Apple/usr/libexec/oah/RosettaLinux/rosetta` 早就装着，
`vmType: vz` 也满足前提 —— 只是 `swebench` profile 写着 `rosetta: false`。

**落地方式（一行，不改 harbor、不改 cc、不改镜像）**：

    colima stop swebench && colima start swebench --vz-rosetta

镜像**不丢**（实测 stop/start 后 debian:11 仍在）。改的是 VM 的 CPU 能力，
**两侧 agent 同时受益** ⇒ 不破任何必控变量。

## 放弃了什么（以及为什么不选）

- **❌ 上 x86_64 云主机**（前一棒的结论）。它确实能解，但代价是把整套评测环境
  搬到另一台机器上重建（镜像、shim、代理、飞鸟云），而**本机开个开关就够了**。
- **❌ 换 arm64-musl 版 claude-code 塞进 amd64 容器。** 这条**实测能跑通**
  （见下方证据 3，`num_turns:1`、无 panic、不需要 node），但**否决**：
  ① 它让 cc 跑 arm64 原生而 sid-code 跑 x64-baseline ⇒ **第一必控变量（同源可比）破了**；
  ② sid-code 侧要跟着编 arm64 才对称，而 `bun-linux-arm64-musl` 产物实测
  缺 `libstdc++.so.6`/`libgcc_s.so.1`（`Error relocating ... symbol not found`），
  且仓库没有 `rg-linux-arm64-musl` ⇒ 产物不含内嵌 rg，工具层能力静默变了。
  **留作 Rosetta 不可用时的兜底，不作首选。**
- **❌ `curl https://claude.ai/install.sh | bash`。** 本地区**返回的是 HTML**
  （`HTTP/2 302 → app-unavailable-in-region`，`file` 判定 `HTML document`），
  管道给 bash 只会静默失败；而且它装的就是那个 215MB 原生 ELF，
  与 npm 路径**装的是同一份字节**，解不了 AVX。**npm 路径仍是对的。**
- **❌ 预烘镜像作为本轮落点。** 它只解 node 版本那一条；且 Rosetta 打通后
  「装配开销差 91×」才是它真正要解的问题，属于下一棒。

## 拿什么证明它生效了

**1. Rosetta 下原版 amd64 claude-code 跑通全 agent 循环**（`default` profile，$0）：

    avx=2 arch=x86_64
    VER=2.1.258 (Claude Code)
    → {"num_turns":1,"terminal_reason":"api_error",
       "result":"API Error: Connection refused ..."}   ← 走到网络层
    ROSETTA_PROBE_COMPLETE

对照同一份二进制在 `rosetta: false` 下（**必须红**）：

    CPU: sse42 popcnt          ← 无 avx
    Features: ... no_avx2 no_avx
    Elapsed: 2293ms
    CPU lacks AVX support.
    panic(main thread): Segmentation fault  → ELAPSED=41s

⚠️ **`claude --version` 不是判据**：它在无 AVX 的 QEMU 下**照样 rc=0、0s 返回**
（我最早就是这么误判「能跑」的）。真判据必须走 `-p` 那条 JIT 路径 —— 崩溃发生在
启动后 ~2.3s。**这是本轮第二次踩「探针形态 ≠ 真实流量」。**

**2. sid-code 侧在 Rosetta 下同样正常**（对称性，不能只验一侧）：

    avx=2 arch=x86_64
    sid-code v0.1.601 (TypeScript)   rc=0    ← x64-baseline 包，无需重编

**3. arm64-musl 兜底路径也实测跑通**（记录备用，**非首选**）：
真 t-bench 镜像 `log-summary-date-ranges:2.0`（debian12，`node=NONE npm=NONE`，
`avx=0`）内放 arm64-musl 的 `claude` + `ld-musl-aarch64.so.1` ⇒
`num_turns:1`、`RC=0`、无 panic。机理：VM 内核是 **aarch64**，容器的 amd64 只是
rootfs；且 binfmt 双向可用 —— 实测 aarch64 进程能 exec 容器里的 amd64 工具
（`AARCH64_EXEC_AMD64_OK`，`/bin/ls` = GNU coreutils 8.32）。

**4. 前一棒「10 镜像全不自带 node」这条复核为真**（10/10 `node=NONE`），
所以 node v12 那 2 题的归因不变；但它**不再是拦路虎** ——
Rosetta 路线下 npm 装的是原版包，node 版本问题只影响 bullseye 那 2 题，
用预烘镜像或 NodeSource 钉 22 即可，属下一棒。

**5. 已复原的环境改动（避免留坑）**：
- `default` profile：`rosetta` 已改回 `false` 并 stop（它是 2C/2G 空 profile，无资产）。
- `swebench` profile：**全程未动**（`rosetta: false`，52 镜像 / 10 个 t-bench 全在）。
- 我为验证编的 arm64-musl 包与当前 commit 同名目录，**已用 x64-baseline 覆盖回来**
  （`build-branch-artifact.sh` 输出目录名不含架构，同 commit 编两次会互相覆盖；
  留着它会让下一轮评测撞 `_resolve_host_binary` 的架构守卫）。

**6. 判据已机械化为闸 3（本轮唯一的代码改动）**

`run-claude-code-contrast.sh` 新增 **闸 3：容器内真的有 AVX 吗**（$0，~5s，排在花钱之前）。
**为什么必须是闸而不是文档一行字**：本仓有过「防线全在、调用全 0」的教训 ——
一条靠人记得跑的前提，在忘记跑的那一次恰好是最需要它的那一次。
而这次的代价是**整轮买回零样本**（10 题 × 空转，模型零调用）。

两条刻意写进注释的判据纪律：

- ⛔ **判据是容器内实测 avx 数，不是「我带了 `--vz-rosetta`」** ——
  `colima.yaml` 的 `rosetta: true` 会**持久化**（实测：不带 flag 启动仍是开的），
  反之带了 flag 也可能因没重启而没生效。只有 `/proc/cpuinfo` 说的算。
- ⛔ **不许用 `claude --version` 代替这一闸** —— 它在 `avx=0` 下照样 `rc=0`、0s 返回。

**三路自证（全 $0）**：

| 路径 | 环境 | 结果 |
| --- | --- | --- |
| 红（该拦住） | `swebench`（`rosetta:false`，avx=0） | `⛔ 闸 3 未过：avx 标志数 = 0` → **rc=1** |
| 绿（该放行） | `default --vz-rosetta`（avx=2） | `✅ 闸 3：容器内有 AVX（avx 标志数=2）` → **rc=0** |
| 逃逸阀 | `SID_CC_SKIP_AVX_GATE=1` | `⚠️ 闸 3 被显式跳过` → **rc=0** |

⚠️ 顺带修了一个自己写出来的 bug：报错文案里的 `\\` 续行被 shell 吃掉，
把「复核命令」那行拼成了乱码。**红路径的文案只有真的让它红一次才看得见** ——
这本身就是「防线要被触发过才算验收」的一个小样本。

## 下一棒（Rosetta 打通后才轮得到）

1. `colima start swebench --vz-rosetta` 后重跑 `run-claude-code-contrast.sh`
   —— 这一轮**会真花钱**（前 13 棒全是 $0，因为模型零调用）。
2. bullseye 那 2 题钉 node ≥22（预烘镜像走 harbor 既有 `PREBUILT_IMAGE_NAME` 通道）。
3. ⚠️ **`-n 6` 内存上限仍然有效**：真 agent 实测 9150MiB/15950MiB(57%)，
   Rosetta 不改变这条，别顺手提 `-n`。
