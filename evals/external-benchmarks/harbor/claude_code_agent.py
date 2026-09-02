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

    #: 上游 `@anthropic-ai/claude-code` 的 `engines.node`（2.1.252 实测 `>=22.0.0`）。
    #: 10 个 t-bench 镜像的 apt 一个都不够（v12 / v18），所以这个门槛必然触发兜底。
    _NODE_MIN_MAJOR = 22
    #: 钉死版本：兜底必须确定性。跟着 nodejs.org 的 latest 走 = 两次跑之间静默换 node。
    _NODE_VERSION = "22.20.0"

    @override
    def _resolved_model_name(self) -> str | None:
        """发往上游的 wire model：**剥掉 Harbor 的 `provider/` 前缀**。

        ⚠️ 2026-09-02 实测的第一必控变量破口，而且**两侧不对称是父类主动造成的**：
        `claude_code.py:1695` 在「配了自定义 base_url」时**原样返回**
        `anthropic/claude-sonnet-5`（只有没配 base_url 才 split），
        而 sid 侧 `sid_code_agent.py:518` 一直是显式映射
        `provider/model` → `modelId`，发出去的是裸 `claude-sonnet-5`。

        ⇒ 同一个 `-m anthropic/claude-sonnet-5`，两侧发往**同一个 shim**
        的 body 里 `model` 却不同名。上游（ppchat）对带前缀的那个没有通道：

            upstream 503: "Current group code has no available channels
                           for model anthropic/claude-sonnet-5"

        形态之所以要命：**cc 侧渲染成 `terminal_reason:api_error`，
        既不提 503 也不提模型名**，与「网络不通」「余额耗尽」逐字节同形；
        `-n 6` 下 6 题会同时静默空转，10 题跑完拿回全 0 分。
        真因只有 shim 的 `upstream_503` 计数键 + 日志原文能指出来
        （再次印证：判据用网关计数器，不是「再试一次看看」）。

        ⛔ **这不算改被测 agent 的行为**：只做命名空间映射，与 sid 侧那段
        「两套命名空间必须显式映射，不能假设同名」是同一条规则的两个实现。
        agent 循环 / 工具 / 权限 / 轮数一律没碰 —— 反而是不改才让
        「同模型」这条必控变量静默破掉。
        """
        resolved = super()._resolved_model_name()
        if resolved and "/" in resolved:
            return resolved.split("/")[-1]
        return resolved

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # 已经装好且版本符合就不重装（沿用父类判据，避免每题白装一次）。
        if await self._installed_claude_satisfies_version(environment):
            self.logger.debug("Claude Code 已在容器内且版本符合，跳过安装")
            return

        # 与父类同一组系统依赖：curl/bash 给 npm 与后续脚本用，procps 给 harbor
        # 自己的进程探测用（少 procps 的形态是 harbor 侧读不到进程而非报错）。
        # ⚠️ `xz` 是本子类**额外**要的：下面那条 node 兜底解的是 `.tar.xz`。
        #    少了它形态是 `tar: unrecognized option --xz` —— 看起来像 tar 用法错。
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "nodejs", "npm", "procps", "xz")
        )

        pkg = "@anthropic-ai/claude-code"
        if self._version:
            pkg = f"{pkg}@{self._version}"

        # ── node ≥22 兜底：这是 2026-09-02 实测补的，**不补则 2 题必装不上** ──
        #
        # 上游 `@anthropic-ai/claude-code@2.1.252` 声明 `engines: {"node": ">=22.0.0"}`，
        # 而 10 个 t-bench 镜像 **10/10 自带 `node=NONE`**，node 全由各自发行版 apt 决定：
        #
        #     bullseye (qemu-startup / qemu-alpine-ssh)  apt nodejs = **v12.22.12**
        #     bookworm / noble / trixie (其余 8 题)      apt nodejs = v18.19–18.20
        #
        # ⇒ **apt 一个都不够 22**。bullseye 那两题的失败形态尤其阴：
        # npm 在 node 12 下解析 `install.cjs` 直接
        # `SyntaxError: Unexpected token '.'`（可选链），于是**装不出 `claude`**，
        # 而那条流水线里 `npm ... | tail` 的退出码是 `tail` 的 ⇒ **rc=0 假绿**。
        # 判据只能是"`claude` 真的能跑"，不能是 "npm rc=0"（同本仓「探针形态」教训）。
        #
        # ⛔ 为什么不用 NodeSource 脚本：它是 `curl | bash` 装 apt 源，
        #    在 bullseye 上还要 gpg/apt-transport-https，失败面更大且不确定；
        #    官方 tarball 是**确定性**的（钉版本、31MB、实测 ~20s、零 apt 交互）。
        #
        # ⚠️ 这段刻意**不改 claude-code 的任何运行时行为** —— 它只保证"跑得起来"
        #    这个前提成立，与 ①‴ 要买的「我们 vs 参考实现」正交。node 版本在
        #    10 题上被统一钉成同一个，反而**少**了一个跨题变量。
        node_boot = (
            f'if command -v node >/dev/null 2>&1 && '
            f'[ "$(node -v | sed \'s/^v//\' | cut -d. -f1)" -ge {self._NODE_MIN_MAJOR} ] '
            f"2>/dev/null; then :; else "
            f'case "$(uname -m)" in '
            f"x86_64) _na=x64 ;; aarch64|arm64) _na=arm64 ;; "
            f'*) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; '
            f"esac; "
            f'curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v{self._NODE_VERSION}'
            f'/node-v{self._NODE_VERSION}-linux-${{_na}}.tar.xz"; '
            f"mkdir -p /opt/node; "
            f"tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; "
            f'for _b in node npm npx; do ln -sf "/opt/node/bin/$_b" "/usr/local/bin/$_b"; done; '
            f"fi"
        )

        # ⚠️ 三条都不是洁癖：
        # 1. `set -euo pipefail` —— 少了它，npm 失败后 `claude --version` 的
        #    "not found" 会成为唯一线索，而那看起来像 PATH 问题（排查方向相反）。
        # 2. 结尾必须 `claude --version` —— 判据是**真的能跑起来**，不是
        #    "npm rc=0"。npm 装完但二进制跑不起来的形态实测存在（平台包不匹配）。
        # 3. 追加 PATH 到 ~/.bashrc 与父类一致：npm 全局装在 /usr/local/bin
        #    （实测），但父类的 `_INSTALL_CHECK_COMMAND` 会去看 ~/.local/bin，
        #    两处都覆盖才不会因为装法不同而漏判。
        #
        # ⚠️ 第 4 条（2026-09-02 补）：**必须把 `claude` 软链进 `/usr/local/bin`**。
        # 走 tarball 兜底时 npm 全局前缀是 `/opt/node`，`claude` 落在
        # `/opt/node/bin/claude` —— 而父类 `run()`（`claude_code.py:1894`）只
        # `export PATH="$HOME/.local/bin:$PATH"` 后 `command -v claude`，
        # **`/opt/node/bin` 不在那条 PATH 上** ⇒ 装好了却 `not found`。
        # 实测判据：`env -i PATH=<系统默认>` 下解析到 `/usr/local/bin/claude`。
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{node_boot}; "
                f"npm install -g {pkg} && "
                "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                # ⚠️ 顺序很重要：`command -v claude` 在走 tarball 兜底时**必然为空**
                # （npm 全局前缀是 /opt/node，而 /opt/node/bin 不在 PATH 上），
                # 所以必须先用 `npm prefix -g` 把真实落点算出来。
                # 2026-09-02 实测：只靠 command -v 的版本在 bullseye 上
                # `exit 127: claude: command not found` —— npm 明明 `added 2 packages`。
                '_ccbin="$(npm prefix -g 2>/dev/null)/bin/claude"; '
                '_cc="$(command -v claude || true)"; '
                'if [ -z "$_cc" ] && [ -x "$_ccbin" ]; then _cc="$_ccbin"; fi && '
                'if [ -n "$_cc" ] && [ ! -e /usr/local/bin/claude ]; then '
                'ln -sf "$_cc" /usr/local/bin/claude; fi && '
                "claude --version"
            ),
        )
