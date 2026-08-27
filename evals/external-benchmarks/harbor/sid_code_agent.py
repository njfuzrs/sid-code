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

from harbor.agents.capabilities import AgentCapabilities
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

    #: 首版**全部 False,这是刻意的**。
    #:
    #: - `resume`:sid-code 有 `--resume`,但恢复路径有实测缺口。声明 True 而实际不可靠,
    #:   会让 `--resume-trajectory` 的多步任务**静默走错分支**。
    #: - `atif` / `load_*_trajectory`:要写 sid-code 轨迹 ↔ ATIF 的双向转换器,独立一个 PR 的量。
    #: - `native_config`:声明 True 才能接 `--ak config=`;首版配置由 `install()` 全权生成。
    #: - `handoff`:很有用(调试评测失败样本的利器),但**依赖 resume 先可靠**。
    #: - `windows`:sid-code 没有 Windows 容器路径。
    #:
    #: ⚠️ 不要用旧的 `SUPPORTS_*` 类变量 —— 基类会发 DeprecationWarning 并说明
    #: 「Legacy flags will be removed in the next major release」。
    capabilities = AgentCapabilities()

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

    def _resolve_host_binary(self, container_arch: str) -> _HostBinary:
        """按三级优先级挑宿主二进制。**找不到就报错,绝不静默回落到别的包。**

        回落会让人以为跑的是他点名的那个包,而分数说不出对应哪个 commit 就没有意义 ——
        自建链路的 `exec-swebench.sh` 在同一处写了同一条教训。
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

        # ① 显式点名。点了却不存在 → 报错,不回落(见本方法 docstring)。
        explicit = _env(env_name)
        if explicit:
            path = Path(explicit).expanduser()
            if not path.is_file():
                raise RuntimeError(f"{env_name}={explicit} 指向的文件不存在")
            return _HostBinary(path=path, arch=arch, source=env_name)

        # ② 自动发现「当前 HEAD 的包」。目录名 `<branch-slug>-<commit12>` 只是人肉索引,
        #    判据仍然是产物字节里那 40 位 commit(见 `_read_artifact_identity`)。
        repo_root = self._repo_root()
        commit12 = self._host_head_commit()[:12]
        if repo_root and commit12:
            for candidate in sorted((repo_root / "dist" / "branch-builds").glob(f"*-{commit12}")):
                binary = candidate / "sid-code"
                if binary.is_file():
                    return _HostBinary(path=binary, arch=arch, source="branch-builds")

        # ③ 报错,并把构建命令直接打出来 —— 让人不用回去翻文档。
        target = f"bun-linux-{'arm64' if arch == 'arm64' else 'x64-baseline'}"
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

        commit = identity.get("artifact_commit")
        commit_source = "artifact-bytes"
        if not commit:
            commit = self._host_head_commit() or "unknown"
            commit_source = "host-head-fallback"

        self._build_info = {
            "version": self.version(),
            "commit": commit,
            "commit_source": commit_source,
            "binary_sha256": self._sha256(binary.path),
            "arch": binary.arch,
            "binary_source": binary.source,
            "binary_path": str(binary.path),
            "identity_source": identity.get("identity_source", "unknown"),
            "artifact_dirty": identity.get("artifact_dirty"),
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
            # ⚠️ **拿不到时绝不填 0。** 填 0 会让「没采到」伪装成「没花钱」,
            # 而这两件事在数据上不可区分。留 None + 显式标记,
            # 让下游能把这类样本单独摘出来(它是「被外部 kill」的判据输入之一)。
            metadata["sid_cost_source"] = "missing"
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
                "sid_is_error": result.get("is_error"),
                "cache_write_tokens": usage.get("cacheCreationInputTokens"),
            }
        )
        context.metadata = metadata

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
        """
        root = cls._repo_root()
        if root is None:
            return {}
        out = cls._run_host(
            ["bun", "run", "scripts/artifact-identity.ts", "read", str(binary)],
            cwd=root,
        )
        for line in out.splitlines():
            parsed = _loads(line)
            if parsed and "artifact_commit" in parsed:
                return parsed
        # 整份 JSON(非逐行)也试一次:脚本输出格式变了不该让 build.json 直接没身份。
        parsed = _loads(out.strip().replace("\n", ""))
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
