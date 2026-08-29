"""在 Harbor 任务容器里运行 sid-code 的自定义 installed agent。

## 它为什么存在

`CLAUDE.md` 对「更准」的定义是「**同一个模型**，在 sid-code 里返工更少、一次做对的比例更高」,
并明确「准确的主语是 harness,不是模型」。这个定义要成立就需要一个**控制模型、只换 harness**
的对照实验 —— 换 scaffold 的分数摆动(15-25pp)远大于换模型(2-15pp),所以这是唯一可归因的形态。

Harbor 内置了 33 个对照 agent(claude-code / codex / mini-swe-agent / aider ...)。
接上这一个类之后,「sid-code vs claude-code vs mini-swe-agent,同题、同模型、同容器、同 verifier」
就是一条命令的事,而容器 / verifier / 超时 / 提示模板全部天然同源 ——
变量控制从「靠纪律」变成「靠底座」。

⚠️ **它不替代自建 SWE-bench 链路**(`../swe-bench/`,5850 行)。两条链路职责不同:
自建链路是**深度**(能取任意内部字段),Harbor 是**广度 + 可比性**(有对照 agent)。
**两条链路的分数永不互比** —— 子集不同、提示模板不同、超时不同、判分实现不同,
跨底座比分数是纯噪声。

## 三个固定的设计选择(改之前先读 .agents/notes/ 里那份 Note 的「放弃了什么」段)

1. **安装模式固定为 binary**:上传 `scripts/build-branch-artifact.sh` 交叉编译出的 linux
   自包含二进制。容器里不需要 bun/node/npm,install 阶段**零网络** ——
   于是 `no-network` 类任务能干净 setup,也不会因为基础镜像是 Alpine/musl 而失败。
2. **认证不进容器**:settings.json 的 baseURL 指向宿主网关
   (`http://host.docker.internal:PORT`),真实凭据由网关侧持有。容器里跑的是 benchmark
   的任意代码,key 进去就等于泄露。
3. **`--output-format stream-json`,不是 `json`**:两者在 sid-code 里是**分叉的两条实现**
   (`packages/cli/src/app.ts:5833` 的 early-return 是分界线),只有 stream-json 的 result
   事件带 `total_cost_usd` / `num_turns` / `subtype`。

Harbor 版本 pin 在 `>=0.22.0,<0.23`(见 pyproject.toml)。跑法与验收判据见 README.md。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# ─────────────────────────────────────────────────────────────────────────────
# 常量
# ─────────────────────────────────────────────────────────────────────────────

#: 容器内 sid-code 的 stdout+stderr 落点(相对 environment_logs_dir)。
#: `2>&1` 合并是刻意的:会话摘要走 stderr,与 stdout 的 NDJSON 混在一起,
#: 解析侧容忍非 JSON 行(见 `_loads`)。用管道 / stdbuf 分流不行 —— 最小镜像里没有这些工具。
OUTPUT_FILENAME = "sid-code.jsonl"

#: 构建身份落点。**这一条不是可选的**:一次评测跑出的分数如果说不出
#: 「这是哪个 commit 的 sid-code」,这个分数没有意义。
BUILD_INFO_FILENAME = "sid-code-build.json"

#: 容器内 SID_CONFIG_DIR 指向的子目录名(在 environment_logs_dir 下)。
#: 落在挂载目录里是为了把**完整轨迹**带回宿主 —— `AgentContext` 只有 5 个字段,
#: 而 TTFT / 缓存命中 / retry 白烧 / compaction 全在 `session.traj` 里。
SID_HOME_DIRNAME = "sid-home"

#: 占位 apiKey。⚠️ 不能长成 `__xxx__`:sid-code 的 schema 有
#: `TEMPLATE_PLACEHOLDER_PATTERN = /^__.+__$/` 校验,会报「apiKey 仍是模板占位符」。
PLACEHOLDER_API_KEY = "no-auth-dummy"

#: 网关地址默认值。⚠️ `host.docker.internal` 是 Docker Desktop 的特性,
#: **Linux 宿主上不存在** —— 那里要传 `SID_HARBOR_GATEWAY_URL=http://172.17.0.1:PORT`。
DEFAULT_GATEWAY_URL = "http://host.docker.internal:4000"

#: sid-code 的 provider 闭集(`packages/core/src/config/schema.ts` 的 `VALID_PROVIDERS`)。
#: 填闭集外的值 → 启动期 schema 校验直接报错。
VALID_PROVIDERS = ("anthropic", "openai", "ollama", "replay")


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value if value is not None and value != "" else default


def _loads(line: str) -> dict[str, Any] | None:
    """解析一行 NDJSON;不是 JSON 对象就返回 None。

    `2>&1` 把 stderr 的会话摘要混进了同一个流,所以**必须**能容忍非 JSON 行。
    不以 `{` 开头直接短路,避免对每行摘要都跑一次 json.loads。
    """
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


@dataclass
class _HostBinary:
    """宿主侧待上传的二进制,以及它是**怎么被挑中的**。

    `source` 字段不是日志装饰:它进 build.json,回答「这一轮跑的是哪个包、为什么是它」。
    自建链路踩过同型的坑 —— 一个字段在、有值、看起来正常,但值是废的。
    """

    path: Path
    arch: str
    source: str


class SidCodeAgent(BaseInstalledAgent):
    """在 Harbor 容器里跑 sid-code 的 installed agent。

    Harbor 侧用法:`harbor run -a sid_code_agent:SidCodeAgent`
    (需要 `PYTHONPATH` 指到本目录;`--agent-import-path` 已 deprecated 且 hidden,不要用)。
    """

    # ─────────────────────────────────────────────────────── 能力声明(全部关闭)
    #
    # 首版**全部 False,这是刻意的**:
    #
    # - `RESUME`:sid-code 有 `--resume`,但恢复路径有实测缺口。声明 True 而实际不可靠,
    #   会让 `--resume-trajectory` 的多步任务**静默走错分支**。
    # - `ATIF` / `LOAD_*_TRAJECTORY`:要写 sid-code 轨迹 ↔ ATIF 的双向转换器,独立一个 PR 的量。
    # - `CONFIG`:声明 True 才能接 `--ak config=`;首版配置由 `install()` 全权生成。
    # - `HANDOFF`:很有用(调试评测失败样本的利器),但**依赖 resume 先可靠**。
    # - `WINDOWS`:sid-code 没有 Windows 容器路径。
    #
    # ⚠️ **不显式赋值,靠基类默认。** 基类 `BaseAgent` 里这七个 ClassVar 全部默认 False
    # (`harbor/agents/base.py:52-70`),写一遍 `SUPPORTS_X = False` 只是把默认值抄一次,
    # 而抄来的常量会在基类改默认时静默失配。要打开某个能力才在这里显式写 True。
    #
    # ## ⚠️ 版本差异:不要改成 `capabilities = AgentCapabilities()`
    #
    # Harbor 主干在 **v0.22.0 发布之后**才引入结构化的 `AgentCapabilities`
    # (PR #2834,2026-08-24;而 v0.22.0 tag 是 2026-08-21)。
    # 我们 pin 的是 PyPI 上的 `harbor>=0.22.0,<0.23`,**那里没有
    # `harbor.agents.capabilities` 这个模块** —— 用它的形态是 harbor 启动即
    # `ValueError: Failed to import module 'sid_code_agent': No module named
    # 'harbor.agents.capabilities'`,一个 trial 都跑不起来(2026-08-27 实测踩到)。
    #
    # **教训**:那次是照着本地 harbor git checkout 的源码写的,而那个 checkout 的
    # `pyproject.toml` 里 `version = "0.22.0"` 却已经含有 v0.22.0 发布后的提交
    # (版本号还没 bump)。「回源码核对」核的必须是**真正会被装上的那份源码**,
    # 一个 git checkout 的 version 字段不等于它对应某个 PyPI 版本。
    # 等哪天把 pin 抬到含 #2834 的版本,再一起换成 `AgentCapabilities` ——
    # 那是「升级 harbor」那次独立改动的一部分,不是顺手做的事。

    #: 声明式旋钮。**用它而不是自定义环境变量**:`--ak key=value` 是 Harbor 使用者调 agent
    #: 的唯一标准入口,把 max_turns 藏进私有环境变量等于要求每个跑评测的人先读我们的源码。
    #:
    #: ⚠️ **`--output-format` 刻意不做成旋钮** —— 它是这个 agent 的实现细节,
    #: 改成 `json` 后 `populate_context_post_run` 就解析不了(两条输出路径是分叉的实现)。
    #: 把它做成可调是给自己埋坑。
    #: ⚠️ **`--dangerously-skip-permissions` 连旋钮都不给**:它会关掉我们想测的那层防线。
    CLI_FLAGS = [
        # 默认 40 与自建链路对齐(`../swe-bench/runner.ts`),便于两条链路的样本互相参照。
        CliFlag(
            "max_turns",
            cli="--max-turns",
            type="int",
            default=40,
            env_fallback="SID_HARBOR_MAX_TURNS",
        ),
        # acceptEdits **不是拍的**:自建链路实测在此模式下**仍有 113 次权限拒绝**,
        # 说明它不等于全放开 —— 评测里需要观察这层防线的触发情况。
        CliFlag(
            "permission_mode",
            cli="--permission-mode",
            type="enum",
            choices=["default", "acceptEdits", "plan"],
            default="acceptEdits",
        ),
        # per-trial 成本上限。超限以 `subtype: "error_max_budget_usd"` **干净终止**,
        # 比事后看 exception_stats 早一步 —— 这是「-k × -n 的乘法把成本打飞」的直接对策。
        CliFlag(
            "max_budget_usd",
            cli="--max-budget-usd",
            type="str",
            env_fallback="SID_HARBOR_MAX_BUDGET_USD",
        ),
    ]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._home: str = "/root"
        self._bin: str = ""
        self._host_binary: _HostBinary | None = None
        self._build_info: dict[str, Any] = {}
        self._gateway_url = _env("SID_HARBOR_GATEWAY_URL", DEFAULT_GATEWAY_URL)
        # 渠道别名:容器内 settings.json 的 `availableModels[].name` 与顶层 `model`。
        # 两者必须一致,否则 provider 回填落空(见 `_render_settings`)。
        self._model_alias = _env("SID_HARBOR_MODEL_ALIAS", "harbor-gateway")

    # ───────────────────────────────────────────────────────────── 身份 / 版本

    @staticmethod
    @override
    def name() -> str:
        return "sid-code"

    @override
    def get_version_command(self) -> str | None:
        """让基类 setup() 在 install() 之后自动探测版本。

        探不到时 `AgentInfo.version` 会是 unknown —— 那是冒烟第 1 步要显式看的判据之一。
        """
        if not self._bin:
            return None
        return f"{shlex.quote(self._bin)} --version"

    # ─────────────────────────────────────────────────────────────── install

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """上传二进制 + 写配置。**全程零网络**,一个包都不装。

        顺序是有依赖的:先探 HOME(root 与非 root 任务不同),再探 arch(决定上传哪个包),
        然后才能算出安装路径。
        """
        home = (
            await self.exec_as_agent(environment, command='printf %s "$HOME"')
        ).stdout
        self._home = (home or "/root").strip() or "/root"

        arch = (await self.exec_as_agent(environment, command="uname -m")).stdout or ""
        self._host_binary = self._resolve_host_binary(arch.strip())

        app_dir = f"{self._home}/.sid-bench"
        self._bin = f"{app_dir}/sid-code"
        staging = "/tmp/sid-code-bin"

        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(app_dir)}")
        await environment.upload_file(self._host_binary.path, staging)
        await self.exec_as_agent(
            environment,
            command=(
                f"cp {shlex.quote(staging)} {shlex.quote(self._bin)} && "
                f"chmod +x {shlex.quote(self._bin)}"
            ),
        )

        await self._write_settings(environment)
        await self._write_build_info(environment)

    #: ELF `e_machine` → 我们的架构名。判架构**只认产物字节**,不认目录名、不认文件名。
    #: (`x86-64` = 62 = 0x3E,`AArch64` = 183 = 0xB7)
    _ELF_MACHINE = {62: "x64", 183: "arm64"}

    @classmethod
    def _elf_arch(cls, binary: Path) -> str | None:
        """读 ELF 头判产物架构。不是 ELF / 读不出就返回 None(调用方按「未知」处理)。

        为什么必须有这个:见 `_resolve_host_binary` 里那条 arch 校验的注释。
        """
        try:
            with binary.open("rb") as fh:
                head = fh.read(20)
        except OSError:
            return None
        if len(head) < 20 or head[:4] != b"\x7fELF":
            return None
        little = head[5] == 1
        machine = int.from_bytes(head[18:20], "little" if little else "big")
        return cls._ELF_MACHINE.get(machine)

    def _resolve_host_binary(self, container_arch: str) -> _HostBinary:
        """按三级优先级挑宿主二进制。**找不到就报错,绝不静默回落到别的包。**

        回落会让人以为跑的是他点名的那个包,而分数说不出对应哪个 commit 就没有意义 ——
        自建链路的 `exec-swebench.sh` 在同一处写了同一条教训。

        ## ⚠️ 必须校验产物的**实际架构**(2026-08-27 实测缺陷)

        `build-branch-artifact.sh` 的输出目录名是 `<branch-slug>-<commit12>`,
        **不含架构** —— 同一个 commit 编 arm64 和 x64 会写进**同一个目录**,
        后编的覆盖前编的。于是「按 commit 匹配」拿到的是「上次编的那个架构」。

        实测形态:Terminal-Bench 的任务镜像**只发 amd64**(arm64 mac 上走 qemu),
        容器里 `uname -m` = `x86_64`,而 `dist/branch-builds/` 里躺着的是 arm64 包。
        代码照样上传了它,build.json 还写下 `arch: "x64"`(那是**期望值**不是实测值),
        然后容器里 `exit 127: not found` ——
        **报错完全不指向「你上传了错架构的包」**,它长得像「二进制没装上」。

        这正是本方法 docstring 第一行那句话的反面:说好「绝不静默回落到别的包」,
        实际静默上传了**错架构**的包。所以判架构一律读 ELF 字节,
        与 commit 一样 —— **目录名和期望值都不是判据**。
        """
        if container_arch in ("aarch64", "arm64"):
            arch, env_name = "arm64", "SID_HARBOR_BINARY_ARM64"
        elif container_arch in ("x86_64", "amd64"):
            arch, env_name = "x64", "SID_HARBOR_BINARY_X64"
        else:
            raise RuntimeError(
                f"binary 模式:不支持的容器架构 {container_arch!r}"
                "(只认 aarch64/arm64 与 x86_64/amd64)"
            )

        target = f"bun-linux-{'arm64' if arch == 'arm64' else 'x64-baseline'}"

        # ① 显式点名。点了却不存在 → 报错,不回落(见本方法 docstring)。
        explicit = _env(env_name)
        if explicit:
            path = Path(explicit).expanduser()
            if not path.is_file():
                raise RuntimeError(f"{env_name}={explicit} 指向的文件不存在")
            actual = self._elf_arch(path)
            if actual is not None and actual != arch:
                # 显式点名的更要报死:他点了名,说明他以为自己知道在跑什么。
                raise RuntimeError(
                    f"{env_name}={explicit} 是 {actual} 架构的产物,"
                    f"而容器是 {container_arch}(需要 {arch})。\n"
                    f"重编:scripts/build-branch-artifact.sh --target {target}"
                )
            return _HostBinary(path=path, arch=arch, source=env_name)

        # ② 自动发现「当前 HEAD 的包」。目录名 `<branch-slug>-<commit12>` 只是人肉索引,
        #    判据是产物字节:commit 见 `_read_artifact_identity`,架构见 `_elf_arch`。
        repo_root = self._repo_root()
        commit12 = self._host_head_commit()[:12]
        arch_mismatch: list[str] = []
        if repo_root and commit12:
            for candidate in sorted((repo_root / "dist" / "branch-builds").glob(f"*-{commit12}")):
                binary = candidate / "sid-code"
                if not binary.is_file():
                    continue
                actual = self._elf_arch(binary)
                if actual is not None and actual != arch:
                    # 记下来带进 ③ 的报错里 —— 「找不到」和「找到了但架构不对」
                    # 是两种完全不同的处境,给同一句报错会把人引向重编而不是查架构。
                    arch_mismatch.append(f"{binary}({actual})")
                    continue
                return _HostBinary(path=binary, arch=arch, source="branch-builds")

        # ③ 报错,并把构建命令直接打出来 —— 让人不用回去翻文档。
        if arch_mismatch:
            raise RuntimeError(
                f"容器架构是 {container_arch}(需要 {arch}),"
                f"但当前 commit 的包是别的架构:{', '.join(arch_mismatch)}。\n"
                f"⚠️ `build-branch-artifact.sh` 的输出目录名**不含架构**,"
                f"同一 commit 编两次会互相覆盖 —— 所以这不是「没编」,是「编的是另一个」。\n"
                f"  ① 重编成目标架构(会覆盖上面那个包):\n"
                f"       scripts/build-branch-artifact.sh --target {target}\n"
                f"  ② 或把两个架构分别存好,再显式点名:\n"
                f"       export {env_name}=/abs/path/to/sid-code-{arch}"
            )
        raise RuntimeError(
            f"找不到容器架构 {arch} 可用的 sid-code linux 二进制。两条出路:\n"
            f"  ① 编一个当前 commit 的包:\n"
            f"       scripts/build-branch-artifact.sh --target {target}\n"
            f"  ② 显式点名一个已有的包:\n"
            f"       export {env_name}=/abs/path/to/sid-code\n"
            f"(不静默回落到别的包是刻意的:分数必须能对应到确切 commit)"
        )

    async def _write_settings(self, environment: BaseEnvironment) -> None:
        """写 settings.json 到容器内 SID_CONFIG_DIR 指向的目录。

        **只给 BASE_URL + KEY 环境变量是不够的** —— sid-code 在 headless 下会硬 throw
        「未配置任何模型。请在 ~/.sid-code/settings.json 的 availableModels 数组中添加模型配置」。
        必须写文件。
        """
        sid_home = f"{self.environment_logs_dir}/{SID_HOME_DIRNAME}"
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(sid_home)}")
        await self._upload_config_text(
            environment,
            content=json.dumps(self._render_settings(), ensure_ascii=False, indent=2),
            remote_path=f"{sid_home}/settings.json",
            filename="settings.json",
        )

    def _render_settings(self) -> dict[str, Any]:
        """渲染容器内 settings.json。

        ⚠️ 两套命名空间**必须显式映射,不能假设同名**:Harbor 的 `model_name` 惯例是
        `provider/model`,而 sid-code 的 `availableModels[].name` 是**本地别名**
        —— 别名用于模型选择 / 计价 / 审计,`modelId` 才是发往厂商的 wire model。
        喂别名给厂商会 400/404;而喂别名给内置能力注册表会**静默 miss** 退化到兜底值。
        """
        provider = self._parsed_model_provider or "openai"
        if provider not in VALID_PROVIDERS:
            raise RuntimeError(
                f"provider {provider!r} 不在 sid-code 的闭集 {VALID_PROVIDERS} 内。"
                f"Harbor 的 -m 惯例是 provider/model,请用 SID_HARBOR_PROVIDER 覆盖,"
                f"或换一个能映射到闭集的 -m 取值"
            )
        provider = _env("SID_HARBOR_PROVIDER", provider)

        wire_model = self._parsed_model_name or self.model_name or ""
        if not wire_model:
            raise RuntimeError("未指定模型:请给 harbor run 传 -m <provider>/<model>")

        base_url = self._gateway_url.rstrip("/")
        # anthropic 族不带 /v1、openai 族带 —— 配错的形态是 404 后静默 fallback,
        # 而不是一个显眼的报错。所以这里按族决定,不让调用方自己拼。
        if provider == "openai" and not base_url.endswith("/v1"):
            base_url = f"{base_url}/v1"

        return {
            # 顶层 model **必须**能按 name 在 availableModels 里命中,
            # 否则 provider 回填落空、启动期校验报「模型未在 availableModels 中找到」。
            "model": self._model_alias,
            "availableModels": [
                {
                    "name": self._model_alias,
                    "modelId": wire_model,
                    "provider": provider,
                    "baseURL": base_url,
                    "apiKey": PLACEHOLDER_API_KEY,
                }
            ],
        }

    async def _write_build_info(self, environment: BaseEnvironment) -> None:
        """把构建身份写进挂载目录,随 trial 回传、永久留在 runs/。

        **这一条不是可选的**,是这个接入能不能产出可信数字的前提。
        commit 优先从**产物字节**读回;读不到才退化到宿主 HEAD,并如实标 `commit_source`
        —— 退化路径必须说明自己是弱判据,不冒充强判据。
        """
        assert self._host_binary is not None
        binary = self._host_binary
        identity = self._read_artifact_identity(binary.path)

        # ⚠️ **不能只判真假。** 脚本在**读不到身份时也返回一个完整的 JSON**,
        # 只是每个字段填字面量 `"unknown"`(实测:`identity_source: "none"` +
        # `commit: "unknown"`)。`if not commit` 对 `"unknown"` 是 False,
        # 于是退化路径永不触发,build.json 会写下
        # `commit="unknown", commit_source="artifact-bytes"` ——
        # **一个假的强判据**,而 `commit_source` 这层保护恰好在这时失效。
        # 所以判据是「40 位十六进制」这个形态,不是「非空」。
        commit = identity.get("commit")
        commit_source = "artifact-bytes"
        if not (isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit)):
            commit = self._host_head_commit() or "unknown"
            commit_source = "host-head-fallback"

        self._build_info = {
            # ⚠️ **这里一定是 None**,不是遗漏。基类 `setup()` 的顺序是
            # `install()` → 探版本(`installed/base.py:953,959`),而本方法在 install()
            # 里调 —— 此刻 `self._version` 还没被填。
            # 真实版本号在 `result.json` 的 `agent_info.version`(Harbor 自己写),
            # 那里才是版本的事实源,冒烟第 1 步的判据 1 看的也是它。
            # 留这个 None 字段而不删是刻意的:删掉会让人以为「build.json 不含版本」,
            # 而实际是「build.json 拿不到版本、版本在别处」——两者的排查方向不同。
            "version": self.version(),
            "commit": commit,
            "commit_source": commit_source,
            "binary_sha256": self._sha256(binary.path),
            # `arch` 是**容器要求的**架构(期望值),`arch_actual` 是从 ELF 字节读出的
            # **产物实际**架构。两个都记是因为 2026-08-27 那次踩到时,build.json 里
            # 只有前者 —— 它写着 `x64` 而上传的是 arm64 包,**这个字段本身在撒谎**。
            # 现在 `_resolve_host_binary` 已经拦住不匹配,但字段留着:
            # 一个只报期望值的字段,在期望与事实分叉时会掩盖分叉。
            "arch": binary.arch,
            "arch_actual": self._elf_arch(binary.path),
            "binary_source": binary.source,
            "binary_path": str(binary.path),
            "identity_source": identity.get("identity_source", "unknown"),
            # 同上一处的同型错误:脚本吐的键是 `dirty`,不是 `artifact_dirty`
            # (2026-08-27 实测 build.json 里这一格恒为 null)。
            # 这一格比 commit 更容易漏:它**本来就允许是 null**,所以「恒 null」
            # 看起来像正常的缺省值,而实际是键名根本没匹配上。
            "artifact_dirty": identity.get("dirty"),
            "gateway_url": self._gateway_url,
            "model_name": self.model_name,
        }
        await self._upload_config_text(
            environment,
            content=json.dumps(self._build_info, ensure_ascii=False, indent=2),
            remote_path=f"{self.environment_logs_dir}/{BUILD_INFO_FILENAME}",
            filename=BUILD_INFO_FILENAME,
        )

    # ─────────────────────────────────────────────────────────────────── run

    # ⚠️ **装饰器顺序:`@with_prompt_template` 必须在 `@override` 之上。**
    # 反了不会报错,只是 instruction 原样透传、提示模板**静默失效** ——
    # 而提示模板是跨 agent 对照的第一必控变量。
    # `tests/eval/harbor-agent-contract.test.ts` 的 L1 层机械地拦这个顺序。
    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        log_path = f"{self.environment_logs_dir}/{OUTPUT_FILENAME}"
        parts = [
            shlex.quote(self._bin),
            "--print",
            # **不是 `json`**:两者是分叉的两条实现,只有 stream-json 的 result 事件
            # 带 total_cost_usd / num_turns / subtype。不需要配 --input-format
            # (配对约束是单向的:input 要求 output,反向不要求)。
            "--output-format",
            "stream-json",
        ]
        flags = self.build_cli_flags()
        if flags:
            parts.append(flags)
        # POSIX 位置参数分隔符。**必须**:有些任务提示以 `-` 开头(markdown bullet),
        # 不加 `--` 会被 parseArgs 解析成未知 flag 并 exit 2。
        parts += ["--", shlex.quote(instruction)]

        # 不用管道 / stdbuf:最小镜像里没有这些工具。直接重定向到挂载的日志目录,
        # 由 populate_context_post_run 在宿主侧解析。
        command = " ".join(parts) + f" > {shlex.quote(log_path)} 2>&1"
        await self.exec_as_agent(
            environment,
            command=command,
            # 轨迹落到挂载目录 → 宿主侧当场可读。SID_CONFIG_DIR 是权威覆盖变量
            # (SID_CODE_HOME 只是兼容别名,新代码一律用前者)。
            env={"SID_CONFIG_DIR": f"{self.environment_logs_dir}/{SID_HOME_DIRNAME}"},
        )

    # ──────────────────────────────────────────── 宿主侧回填(日志同步之后)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """解析 NDJSON 取最后一个 result 事件,回填用量与成本。

        跑在**宿主**,且在日志同步回宿主之后,所以能直接读 `self.logs_dir/...`。
        """
        result = self._last_result_event(self.logs_dir / OUTPUT_FILENAME)
        metadata: dict[str, Any] = {
            **(context.metadata or {}),
            "sid_commit": self._build_info.get("commit"),
            "sid_commit_source": self._build_info.get("commit_source"),
            "sid_binary_sha256": self._build_info.get("binary_sha256"),
        }

        if result is None:
            # ── 兜底源:轨迹的 session.traj(2026-08-29 接入) ──
            #
            # 走到这里 = `result` 事件从未发出。**最常见的成因不是"没花钱",
            # 而是 trial 撞上 Harbor 的 agent 硬顶被 SIGKILL** —— 那一刻 sid-code
            # 已经跑了 1 小时、花掉了真金白银,但它没机会打印终止事件。
            #
            # 实测(A11 第五棒,`fix-code-vulnerability`):
            # `cost_usd: null` 而轨迹里有 3 次成功调用、75,732 prompt tokens、
            # `total_cost_usd: 0.0538` —— 这笔钱没进任何账。
            # 该题当次量级很小(全局 $7.18 → 真实 ≈ $7.26,低报 1.1%),
            # **但低报幅度与超时 trial 的比例成正比**:跑 500 题时超时比例一上去,
            # 成本口径就系统性偏低,而它**不报错**——`null` 被下游求和当成 0。
            #
            # `session.traj` 为什么可信:`collector.ts` 每轮 AfterModel 就把
            # `total_cost_usd` 增量累加进 metadata 并节流重写 traj(≤30s 一次),
            # **不依赖 SessionEnd 干净触发** —— 正是为进程被杀这一类场景准备的。
            #
            # ⚠️ **它仍然可能偏低**(最后 ≤30s 的调用没来得及落盘),所以口径标记
            # 必须与权威源**区分开**(`session-traj-fallback` ≠ `stream-json-result`)。
            # 混成同一个标签就等于宣称"补全了",而它只是"比 null 准"。
            traj = self._recover_usage_from_traj()
            if traj is not None:
                context.cost_usd = traj["cost_usd"]
                context.n_input_tokens = traj["n_input_tokens"]
                context.n_output_tokens = traj["n_output_tokens"]
                context.n_cache_tokens = traj["n_cache_tokens"]
                metadata["sid_cost_source"] = "session-traj-fallback"
                metadata["sid_session_id"] = traj["session_id"]
                metadata["sid_num_turns"] = traj["total_steps"]
                metadata["cache_write_tokens"] = traj["cache_write_tokens"]
                metadata["sid_traj_api_calls"] = traj["total_api_calls"]
                # 归因不能丢:这类样本**没有** subtype(事件没发出),
                # 与 `--max-turns` 耗尽是两类不同样本,下游不能混算(见下方 sid_subtype 注释)。
                metadata["sid_result_event_missing"] = True
                context.metadata = metadata
                return

            # ⚠️ **两个源都拿不到时绝不填 0。** 填 0 会让「没采到」伪装成「没花钱」,
            # 而这两件事在数据上不可区分。留 None + 显式标记,
            # 让下游能把这类样本单独摘出来(它是「被外部 kill」的判据输入之一)。
            metadata["sid_cost_source"] = "missing"
            metadata["sid_result_event_missing"] = True
            context.metadata = metadata
            return

        raw_usage = result.get("usage")
        usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
        context.n_input_tokens = usage.get("inputTokens")
        context.n_output_tokens = usage.get("outputTokens")
        context.n_cache_tokens = usage.get("cacheReadInputTokens")

        cost = result.get("total_cost_usd")
        if isinstance(cost, (int, float)):
            context.cost_usd = float(cost)
            metadata["sid_cost_source"] = "stream-json-result"
        else:
            metadata["sid_cost_source"] = "missing"

        metadata.update(
            {
                # 反查我们自己的完整轨迹用的接缝 —— 深度指标(TTFT / 缓存命中 / retry 白烧)
                # 一律回 sid-code 自己的 digest 取,**不在 Harbor 侧重算**(会造第二个事实源)。
                "sid_session_id": result.get("session_id"),
                # turns per task:「更省」的最大杠杆(2× 轮数 ≈ 3-4× 成本)。
                "sid_num_turns": result.get("num_turns"),
                # 归因判据:success / error_max_turns / error_max_budget_usd /
                # error_during_execution。缺失 + cost_source=missing → 判「被外部 kill」,
                # 与 --max-turns 耗尽是**两类不同样本,不能混算**。
                "sid_subtype": result.get("subtype"),
                "sid_stop_reason": result.get("stop_reason"),
                "sid_duration_ms": result.get("duration_ms"),
                "sid_duration_api_ms": result.get("duration_api_ms"),
                # ⚠️ **不能只读 `is_error`**(2026-08-27 实测)。sid-code 在**错误路径**的
                # result 事件里**根本不发这个字段**(成功路径才发 `is_error: false`) ——
                # 实测 `error_during_execution` 那条事件的键只有
                # {duration_ms, errors, num_turns, session_id, subtype, total_cost_usd,
                #  type, usage}。于是 `sid_is_error` 变成 `None`,
                # 而 `None` 在下游一律被当成「不是错误」——
                # **一个失败的 trial 会被记成正常的 0 分**,直接污染分子。
                #
                # 所以判据是 `subtype`:它在错误路径**一定有**
                # (error_during_execution / error_max_turns / error_max_budget_usd)。
                # `is_error` 有就用,没有就从 subtype 推,两者都没有才 None。
                "sid_is_error": self._derive_is_error(result),
                # 错误原文。少了它,「为什么 0 分」要回容器翻 jsonl ——
                # 而 R1 的分母铁律要求能区分「没解出来」与「链路/限流坏了」。
                # 实测价值:靠它当场定位到一题的 0 分其实是**上游 429 限流**,
                # 不是能力差距。这两类样本混进同一个分母就是虚低。
                "sid_errors": result.get("errors"),
                "cache_write_tokens": usage.get("cacheCreationInputTokens"),
            }
        )
        context.metadata = metadata

    @staticmethod
    def _derive_is_error(result: dict[str, Any]) -> bool | None:
        """判这一轮是否出错。**不能只信 `is_error` 字段** —— 见调用处那段注释。

        优先级:① 显式 `is_error` → ② 从 `subtype` 推 → ③ None(真的判不出)。

        ③ 保留 None 而不是兜底成 False 是刻意的:判不出时说「没出错」
        是在编造一个乐观结论,而 None 至少能在下游被识别成「这条不可用」。
        """
        explicit = result.get("is_error")
        if isinstance(explicit, bool):
            return explicit
        subtype = result.get("subtype")
        if isinstance(subtype, str) and subtype:
            # 约定:成功只有 "success" 一个取值,其余(error_during_execution /
            # error_max_turns / error_max_budget_usd ...)一律算错。
            # 用「!= success」而不是枚举 error_* 前缀:新增一种失败 subtype 时
            # 枚举法会把它静默判成成功,而这个方向的错更贵。
            return subtype != "success"
        return None

    @staticmethod
    def _last_result_event(path: Path) -> dict[str, Any] | None:
        """流式扫出最后一个 `type == "result"` 事件。

        逐行读、只留最后一个命中,**不整份 load** —— 跑飞的 transcript 不该 OOM 宿主。
        取最后一个而不是第一个:异常路径下引擎会**合成**一个终止 result 事件,
        它才是这一轮的最终结论。
        """
        if not path.exists():
            return None
        last: dict[str, Any] | None = None
        with path.open(errors="replace") as fh:
            for line in fh:
                event = _loads(line)
                if event and event.get("type") == "result":
                    last = event
        return last

    def _recover_usage_from_traj(self) -> dict[str, Any] | None:
        """`result` 事件缺失时,从 `session.traj` 兜底取用量与成本。

        只在 `populate_context_post_run` 的 `result is None` 分支调用 —— 它是
        「trial 被 SIGKILL,钱花了但终止事件没发出」那个成本低报缺陷的兜底源。

        ## 口径(每一项都指到源字段,不重算)

        | 回填字段 | traj 源字段 | 口径 |
        | --- | --- | --- |
        | `cost_usd` | `metadata.total_cost_usd` | flow,逐次累加 |
        | `n_input_tokens` | `metadata.total_cumulative_prompt_tokens` | **flow** |
        | `n_output_tokens` | `metadata.total_tokens_received` | flow |
        | `n_cache_tokens` | `metadata.total_cache_read_tokens` | flow |

        ⛔ **`n_input_tokens` 绝不能取 `total_tokens_sent`。** 那是**末次快照值**
        (stock,含全部历史),而 `total_cost_usd` 是逐次累加(flow)。
        stock ÷ flow 会算出一个**错的单价**,且它不报错 —— 只是让"每 token 花多少钱"
        整体偏移。`builder.ts` 那两个字段的注释把这条写死了,这里逐字遵守。
        (同源教训:§15.1 的静态前缀曾误用 `cache_write_tokens`,得到一个每跑一次
        变 2.5 倍的数,而它也不报错。)

        ## 为什么按 mtime 挑最新的那个目录

        `SID_CONFIG_DIR` 是 per-trial 独立挂载目录,正常只有一个会话;
        但 install 阶段的探活/自检**可能**留下第二个。取最新的那个 ——
        它才是 `run()` 那次。若挑错,`sid_session_id` 会与轨迹对不上,
        所以把 session_id 一并回填,让下游能自证挑对了没有。

        返回 None 的情形:目录不存在 / 没有 traj / traj 坏了 / cost 不是数
        —— 一律**不猜、不填 0**,交回上层落 `missing`。
        """
        sessions_dir = self.logs_dir / SID_HOME_DIRNAME / "trajectories" / "sessions"
        if not sessions_dir.is_dir():
            return None

        candidates = [d for d in sessions_dir.iterdir() if (d / "session.traj").is_file()]
        if not candidates:
            return None
        newest = max(candidates, key=lambda d: (d / "session.traj").stat().st_mtime)

        try:
            with (newest / "session.traj").open(errors="replace") as fh:
                traj = json.load(fh)
        except (OSError, json.JSONDecodeError, ValueError):
            return None
        if not isinstance(traj, dict):
            return None

        md = traj.get("metadata")
        if not isinstance(md, dict):
            return None

        cost = md.get("total_cost_usd")
        # cost 必须是**非零**数字才算兜底成功:0 与 None 在这里语义相同
        # (都代表"没采到"),而填 0 正是本缺陷要消灭的那种伪装。
        if not isinstance(cost, (int, float)) or cost <= 0:
            return None

        def _num(key: str) -> int | None:
            value = md.get(key)
            return int(value) if isinstance(value, (int, float)) else None

        return {
            "cost_usd": float(cost),
            # ⛔ flow 口径,不是 total_tokens_sent(见上方表格)。
            "n_input_tokens": _num("total_cumulative_prompt_tokens"),
            "n_output_tokens": _num("total_tokens_received"),
            "n_cache_tokens": _num("total_cache_read_tokens"),
            "cache_write_tokens": _num("total_cache_creation_tokens"),
            "total_api_calls": _num("total_api_calls"),
            "total_steps": _num("total_steps"),
            # 目录名即 session_id;用它自证挑对了哪个会话。
            "session_id": md.get("session_id") or newest.name,
        }

    # ─────────────────────────────────────────────────────────── 宿主侧小工具

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _repo_root() -> Path | None:
        """本文件在 `<repo>/evals/external-benchmarks/harbor/`,向上三级即仓库根。

        不用 `git rev-parse`:那会把 cwd 的仓库当答案,而 harbor 可能从任意目录启动。
        """
        root = Path(__file__).resolve().parents[3]
        return root if (root / ".git").exists() else None

    @classmethod
    def _host_head_commit(cls) -> str:
        root = cls._repo_root()
        if root is None:
            return ""
        out = cls._run_host(["git", "-C", str(root), "rev-parse", "HEAD"])
        return out.strip() if re.fullmatch(r"[0-9a-f]{40}", out.strip()) else ""

    @classmethod
    def _read_artifact_identity(cls, binary: Path) -> dict[str, Any]:
        """读回产物字节里内联的构建身份(40 位 commit 等)。

        走仓库既有的 `scripts/artifact-identity.ts` —— **不自己写一份嗅探正则**。
        自己重实现是「没用既有口径、自己另找源」那个错误的又一次,
        而两份正则一旦漂移,读出来的 commit 会静默变错。

        ## ⚠️ 字段名是 `commit`,不是 `artifact_commit`(2026-08-27 实测修正)

        初版按 `artifact_commit` 找,而脚本吐的是 `commit` —— 于是**永远匹配不上**,
        每次都退化到 `host-head-fallback`。这个缺陷**被 fallback 自己掩盖**:
        宿主 HEAD 通常就是构建那个 commit,所以 `sid_commit` 的**值完全正确**,
        只有 `commit_source` 这一个字段暴露它。
        这正是 build.json 为什么必须带 `commit_source`:一个退化路径若不自报身份,
        它就会冒充强判据 —— 而在别人机器上(HEAD 已经往前走了)读出的 commit 是错的,
        整轮评测的归因跟着错,且没有任何东西会报错。

        输出是**多行缩进 JSON**(不是 NDJSON),所以逐行 `_loads` 一行都解析不出来,
        必须整份 parse。这里两种都试:先整份,再逐行 —— 脚本哪天改成 NDJSON 也不会断。
        """
        root = cls._repo_root()
        if root is None:
            return {}
        out = cls._run_host(
            ["bun", "run", "scripts/artifact-identity.ts", "read", str(binary)],
            cwd=root,
        )
        # ① 整份 JSON(当前实际形态:多行缩进)
        parsed = _loads(out.strip().replace("\n", ""))
        if parsed and "commit" in parsed:
            return parsed
        # ② 逐行 NDJSON(向后兼容脚本改格式)
        for line in out.splitlines():
            candidate = _loads(line)
            if candidate and "commit" in candidate:
                return candidate
        return parsed or {}

    @staticmethod
    def _run_host(cmd: list[str], cwd: Path | None = None) -> str:
        """跑一条宿主命令,失败一律返回空串。

        这些命令全部只用于**填充 build.json 的辅助字段**,拿不到就退化标记
        (见 `_write_build_info` 的 commit_source),不该让整个 trial 挂掉。
        """
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(cwd) if cwd else None,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return proc.stdout if proc.returncode == 0 else ""
