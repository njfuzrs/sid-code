"""①‴ 第三个对照 agent：claude-code，只改「怎么装」，不改它的任何行为。

## 为什么需要这个文件（不能直接 `-a claude-code`）

Harbor 官方 `claude_code.py:453` 的安装分支是 `if command -v apk`（Alpine）才走
npm，**否则走 `bootstrap.sh`**。而 terminal-bench-sample 的镜像实测全是
Ubuntu/Debian（`apk` 不存在）：

    regex-log:2.0               无 apk → bootstrap.sh 分支  (ubuntu)
    polyglot-c-py:2.0           无 apk → bootstrap.sh 分支  (ubuntu)
    log-summary-date-ranges:2.0 无 apk → bootstrap.sh 分支  (debian)

⇒ **官方路径在本机跑的是 `bootstrap.sh`，而那条路在这里装不出来。**
2026-09-01 实测（`--install-only`，`log-summary-date-ranges`）：

    apt(curl/bash/nodejs/npm/procps)      45s   ✅
    bootstrap.sh 抓取                      1s   ✅（9704 B）
    下载 claude-2.1.252-linux-x64        ~2min  ✅（214,371,672 B，约 7MB/s）
    → `claude ... install` 在 qemu-x86_64 下 100% CPU **跑满 20:22 仍无产出**
      （`~/.local/bin/claude` 与 `~/.claude/versions/` 全空；CPU 累计时间与
       墙钟 1:1 增长 ⇒ 是真在算，不是死锁）

同一时刻**并行**起一个独立容器走 npm 路径（同镜像、同网络）：

    apt(curl/nodejs/npm)                 160s   ✅ node v18.20.4 / npm 9.2.0
    npm install -g @anthropic-ai/claude-code
                                          19s   ✅ rc=0
    claude --version              2.1.252 (Claude Code)
    which                         /usr/local/bin/claude

⇒ **npm 19s 成功 vs bootstrap 20min+ 未产出。** 成因大概率是架构：镜像是
`amd64`、本机是 `arm64`，`claude install` 要在 qemu 模拟下处理那个 214MB 原生
二进制；npm 装的是 JS 包（27KB 主包 + 平台包），不吃这份模拟解包开销。

⚠️ **§4.5.4 记的「NPM_OK=28s ✅」是手工跑 npm 得到的，而 Harbor 一次都不走那条路。**
这正是「探针形态 ≠ 真实流量」那类假绿：源可达被读成了装得上。

## 本类只做一件事：把安装换成 npm 路径

⛔ **刻意不改 claude-code 的任何运行时行为** —— 不动 `run()`、不动
`_resolve_auth_env()`、不动 CLI flag 语义。①‴ 要买的是「我们 vs 参考实现」，
改了对方的行为就把对照变成了「我们 vs 被我们改过的它」，那个数字没有意义。

⚠️ **`--version` 仍由父类的 `_version` 机制决定**：不传就是 npm 上的 latest。
做正式对照时**必须钉版本**（`--ak version=2.1.252`），否则两次跑之间 npm
latest 变了，第八项变量（对照 agent 自身版本）就悄悄动了，而它不报任何错。
"""

from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment


class ClaudeCodeNpm(ClaudeCode):
    """claude-code，但安装强制走 npm（Debian/Ubuntu 镜像上 bootstrap.sh 装不出来）。"""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # 已经装好且版本符合就不重装（沿用父类判据，避免每题白装一次）。
        if await self._installed_claude_satisfies_version(environment):
            self.logger.debug("Claude Code 已在容器内且版本符合，跳过安装")
            return

        # 与父类同一组系统依赖：curl/bash 给 npm 与后续脚本用，procps 给 harbor
        # 自己的进程探测用（少 procps 的形态是 harbor 侧读不到进程而非报错）。
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "nodejs", "npm", "procps")
        )

        pkg = "@anthropic-ai/claude-code"
        if self._version:
            pkg = f"{pkg}@{self._version}"

        # ⚠️ 三条都不是洁癖：
        # 1. `set -euo pipefail` —— 少了它，npm 失败后 `claude --version` 的
        #    "not found" 会成为唯一线索，而那看起来像 PATH 问题（排查方向相反）。
        # 2. 结尾必须 `claude --version` —— 判据是**真的能跑起来**，不是
        #    "npm rc=0"。npm 装完但二进制跑不起来的形态实测存在（平台包不匹配）。
        # 3. 追加 PATH 到 ~/.bashrc 与父类一致：npm 全局装在 /usr/local/bin
        #    （实测），但父类的 `_INSTALL_CHECK_COMMAND` 会去看 ~/.local/bin，
        #    两处都覆盖才不会因为装法不同而漏判。
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"npm install -g {pkg} && "
                "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                "claude --version"
            ),
        )
