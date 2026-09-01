---
Status: implemented
Date: 2026-09-01
---
# claude-code 对照 agent：安装强制走 npm，而非 Harbor 官方的 bootstrap.sh

## 决定了什么

为 ①‴（第三个对照 agent = claude-code）加两个文件，**只解决"装得上"，不跑评测**：

- `evals/external-benchmarks/harbor/claude_code_agent.py` —— `ClaudeCodeNpm(ClaudeCode)`，
  **只覆盖 `install()`**，把安装从 `bootstrap.sh` 换成 `npm install -g`。
- `evals/external-benchmarks/harbor/gate-claude-code-install.sh` —— `--install-only` 的
  安装闸（**$0**，不跑 agent 也不跑 verifier），带 `--mutate` 变异自证。

**根因**：Harbor 官方 `claude_code.py:453` 的分支是 `if command -v apk`（Alpine）才走 npm，
**否则走 `bootstrap.sh`**。而 terminal-bench-sample 的镜像实测全是 Ubuntu/Debian
（`log-summary-date-ranges`=debian、`regex-log`/`polyglot-c-py`=ubuntu，三个都无 `apk`）
⇒ **官方路径在本机跑的是 `bootstrap.sh`，而那条路在这里装不出来**：

    apt(curl/bash/nodejs/npm/procps)      45s   ✅
    bootstrap.sh 抓取                      1s   ✅（9704 B）
    下载 claude-2.1.252-linux-x64        ~2min  ✅（214,371,672 B，约 7MB/s）
    → `claude ... install` 在 qemu-x86_64 下 100% CPU **跑满 20:22 仍无产出**

⚠️ **20:22 是我主动停掉的时刻，不是它失败的时刻** —— 所以结论是「20 分钟没装完」，
**不是「装不上」**。CPU 累计时间与墙钟 1:1 增长（300s→320s / 20s）⇒ 真在算，不是死锁。
成因大概率是架构：镜像 `amd64`、本机 `arm64`，`claude install` 要在 qemu 模拟下处理那个
214MB 原生二进制；npm 装的是 JS 包，不吃这份模拟解包开销。

**⚠️ 顺带纠正 05 号 §4.5.4 的一条假绿**：那里记「`NPM_OK=28s` ⇒ claude-code 装得上 ✅」，
但**那 28s 是手工跑 `npm install -g` 得到的，而 Harbor 一次都不会走那条路**。
形态与记忆里 `gate-probe-shape-must-match-real-traffic` 完全同源：
**探针形态 ≠ 真实流量，于是"源可达"被读成了"装得上"。**

## 放弃了什么（以及为什么不选）

| 放弃的做法 | 为什么不选 |
| --- | --- |
| **直接 `-a claude-code` 开跑 10 题** | 装不上的形态**不报错**，是「跑完了、分数低、只有轨迹知道真因」——与 §5.2.4.6 那次 402 被记进能力账同型。用 10 题去发现安装问题 = 花钱买废数据 |
| **只把 `--agent-setup-timeout-multiplier` 再调大** | 默认 360s×8=48min，看起来"可能够"。但这是**每题各装一次**（每 trial 新容器、无跨题缓存），10 题就是 10 次 214MB 下载 + 10 次模拟态 install。而且**没有任何证据表明它 48min 内会完成** —— 那是赌 |
| **改 Harbor 官方 `claude_code.py`** | 改的是 uv 工具目录里的第三方包，下次 `uv tool upgrade` 就没了，且不入库、别人复现不了 |
| **覆盖 `run()` / 权限 / 认证等运行时行为** | ⛔ ①‴ 要买的是「我们 vs 参考实现」。改了对方的行为就变成「我们 vs 被我们改过的它」，那个数字没有意义。**本类刻意只覆盖 `install()` 一个方法** |
| **走官方 `MODEL_CONNECTION`（选项 B）** | 模型不同源 ⇒ 第一必控变量当场破；且真 key 进容器、加重 B8。已按文档选**选项 A**（`ANTHROPIC_BASE_URL` 指向我们的 shim + 占位 token） |

## 拿什么证明它生效了

**(a) 正向：两个不同发行版的镜像都装成了**（`--install-only`，`-n 1`，TUN 开启）

| job | 镜像 / 系统 | 墙钟 | completed/errored | claude 落点 |
| --- | --- | --- | --- | --- |
| `ccinstall-npm` | log-summary-date-ranges:2.0 / debian | **3m21s** | **1 / 0** | `/usr/local/bin/claude` |
| `ccinstall-ubuntu` | polyglot-c-py:2.0 / ubuntu | **9m23s** | **1 / 0** | `/usr/local/bin/claude` |

`trial.log` 实证安装命令（判据读日志，不靠"我以为传了"）：

    Running command: set -euo pipefail; npm install -g @anthropic-ai/claude-code@2.1.252 && ...

**(b) 变异自证（这条比正向绿灯重要）**：钉 `99.99.99-does-not-exist` →

    npm ERR! code ETARGET  /  npm ERR! notarget
    → NonZeroAgentExitCodeError,  n_errored_trials=1

⇒ **这道闸真的在检查安装，不是恰好都通过**。闸脚本把 `ETARGET` 一起判，
是为了区分「红在安装上」与「红在别处」—— 后者证明的是"某处会失败"，不是"闸在守安装"。

**(c) 并行对照（同时刻、同镜像、同网络，唯一变量是装法）**：

    npm 路径:        apt 160s → npm install 19s → claude --version = 2.1.252 ✅
    bootstrap 路径:  下载完成 → install 100% CPU 20:22 无产出（我主动停）

**⚠️ 三条不许从本 Note 推出的结论**：

1. ⛔ **不许说「bootstrap.sh 装不上」** —— 只测到"20 分钟没装完"，我没等到它结束。
2. ⛔ **不许把 3m21s 与 9m23s 的 2.8× 差读成镜像质量差异** —— 差的全在 apt
   （ubuntu 侧 dpkg 配置期更长），npm 那步两侧都是 ~20s。**n=1，各一次。**
3. ⛔ **不许由此推出 ①‴ 可以开跑** —— 装得上只是第一必控变量之一。
   还差一条**已核出但未修**的：`max_turns` 两侧不对齐（见下）。

**🔴 交给下一棒的硬前置（本棒核出、刻意未动）**：
`sid_code_agent` 的 `max_turns` **default=40**，而官方 `claude_code.py` 的 `max_turns`
**default=(无)**；`base.py:718` 的 `build_cli_flags()` 对 `None` 直接 `continue`
⇒ `--max-turns` **整个不出现**，claude-code 用它自己的内部默认。
**必须显式 `--ak max_turns=40`，否则"轮数预算"这条必控变量静默破掉。**
✅ 权限档这次天然对齐：`claude_code` 的 `permission_mode` **default=`bypassPermissions`**，
与我们 `#141` 换档后的 skip 同为零摩擦 —— §17.3 那个「mswea yolo vs 我们 144 deny」
的同型风险**在这次不成立**。
