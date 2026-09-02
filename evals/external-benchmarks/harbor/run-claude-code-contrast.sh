#!/usr/bin/env bash
# ①‴ claude-code 真跑对照：10 题，走**我们的 shim**（选项 A），`-n` 可调。
#
# ## 与安装闸（gate-claude-code-install.sh）的分界
#
# 那道闸是 `--install-only`（**$0**，不调模型），只答「装得上吗」。
# 本脚本**真调模型、真跑 verifier、真花钱**，答的是「同题同模型同容器下
# 我们 vs 参考实现」。⚠️ 先过那道闸再跑这个 —— 用 10 题去发现安装问题
# 等于花钱买一份废数据（§5.2.4.6 的形态）。
#
# ## 七项必控变量：本脚本负责哪几项、怎么负责
#
# | 变量 | 怎么对齐 | 判据 |
# | 模型 | `ANTHROPIC_BASE_URL` 指向我们的 shim（选项 A） | 闸 0 验 `/__stats` 结构 |
# | 网关 | 与 sid 侧**同一个 shim 实例**（同端口） | 同上 |
# | 容器 | 同 `-d terminal-bench-sample@2.0` 同镜像 | harbor 保证 |
# | verifier | 同 dataset 自带 verifier | harbor 保证 |
# | **轮数** | **必须显式 `--ak max_turns=40`** | 见下，这条会静默破 |
# | 权限档 | cc 侧 default 已是 `bypassPermissions`，与我们 skip 同档 | 闸 2 静态复核 |
# | 对照 agent 版本 | **必须钉** `--ak version=` | 同闸 2 |
#
# ⛔ **`max_turns` 这条是硬前置，且不报错**（第十棒核出）：
#   `claude_code.py` 的 max_turns **无 default**，而 `base.py:719` 是
#   `if value is None: continue` ⇒ **`--max-turns` 整个不出现**，
#   cc 用它自己的内部默认。不显式传，"轮数预算"这条变量就悄悄破了，
#   而两侧都以 `completed=10 / errored=0` 收尾 —— 与真对齐**逐字节一样**。
#
# ## 用法
#   bash run-claude-code-contrast.sh                       # 10 题，-n 6
#   SID_CC_N=1 bash run-claude-code-contrast.sh            # 串行（对照并发收益）
#   bash run-claude-code-contrast.sh regex-log             # 只跑指定题
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CC_VERSION="${SID_CC_VERSION:-2.1.252}"
MAX_TURNS="${SID_CC_MAX_TURNS:-40}"
N="${SID_CC_N:-6}"
GW_PORT="${SID_CC_GATEWAY_PORT:-4100}"
JOB="${SID_CC_JOB:-ccrun-n${N}}"

TASK_FILTER=()
for a in "$@"; do
  case "$a" in
    -*) echo "未知参数: $a"; exit 2 ;;
    *) TASK_FILTER+=(-i "$a") ;;
  esac
done

# `192.168.5.2` = colima host-gateway，**不是** 172.17.0.1。
export ANTHROPIC_BASE_URL="http://192.168.5.2:${GW_PORT}"
# ⛔ 占位 token：shim 只认 `no-auth-dummy`，真 key 从不进容器（不加重 B8）。
export ANTHROPIC_API_KEY="no-auth-dummy"
export HARBOR_TELEMETRY=0
export PYTHONPATH="$(pwd)"

echo "=== ①‴ claude-code 对照 | job=$JOB -n=$N 版本=$CC_VERSION max_turns=$MAX_TURNS ==="

# ── 闸 0：shim 在跑且是**我们的** shim（判结构，不判状态码）───────────────────
# 透传代理也会回 200，所以判据是 `/__stats` 的结构而不是「端口连得上」。
probe=$(curl -s -m 10 "http://127.0.0.1:${GW_PORT}/__stats" 2>/dev/null || true)
if ! printf '%s' "$probe" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if isinstance(d.get("stats"),dict) and "upstream_model" in d else 1)' 2>/dev/null; then
  echo "⛔ 闸 0 未过：${GW_PORT} 上不是我们的 shim"
  echo "   起它：python3 ~/.local/share/sid-harbor-gateway/gateway.py --port ${GW_PORT} --model-name claude-sonnet-5-ppchat"
  exit 1
fi
UPSTREAM=$(printf '%s' "$probe" | python3 -c 'import json,sys;print(json.load(sys.stdin)["upstream_model"])')
echo "✅ 闸 0：shim 在跑，上游=${UPSTREAM}"

# ── 闸 1：两侧 CLI flag 静态对齐（$0，**在花钱之前**）─────────────────────────
#
# 为什么必须在跑之前静态验：`--max-turns` 缺失**不报错**。跑完再看，
# 那笔钱已经花在一份变量没控住的数据上了。
# ⚠️ **不能用裸 `python3`** —— harbor 是 `uv tool install` 装进隔离环境的，
# 系统 python 看不到它，闸会以 `ModuleNotFoundError` **报红**。
# 那是"闸自己坏了"，但长得和"两侧没对齐"一模一样 ⇒ 会把人引向去改 flag。
# 探测顺序与 `tests/eval/harbor-agent-contract.test.ts:177` 的 findHarborPython 一致。
HARBOR_PY=""
for cand in "${SID_HARBOR_PYTHON:-}" "$HOME/.local/share/uv/tools/harbor/bin/python" python3; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import harbor' >/dev/null 2>&1; then
    HARBOR_PY="$cand"; break
  fi
done
if [ -z "$HARBOR_PY" ]; then
  echo "⛔ 找不到能 import harbor 的 python —— **这是闸自身的环境问题，不是两侧没对齐**"
  echo "   指定：SID_HARBOR_PYTHON=/path/to/python bash $0"
  exit 1
fi
echo "    判据解释器: $HARBOR_PY"

if ! PYTHONPATH="$(pwd)" "$HARBOR_PY" - "$MAX_TURNS" "$CC_VERSION" <<'PY'
import sys, tempfile, pathlib
turns, ver = int(sys.argv[1]), sys.argv[2]
from claude_code_agent import ClaudeCodeNpm
from sid_code_agent import SidCodeAgent
d = pathlib.Path(tempfile.mkdtemp())
cc = ClaudeCodeNpm(logs_dir=d, model_name="anthropic/claude-sonnet-5",
                   max_turns=turns, version=ver).build_cli_flags()
sid = SidCodeAgent(logs_dir=d, model_name="anthropic/claude-sonnet-5").build_cli_flags()
print(f"    cc  flags: {cc}")
print(f"    sid flags: {sid}")
ok = True
# 轮数：两侧都必须真的**渲染出**这个 flag（不是"我以为传了"）。
for side, flags in (("cc", cc), ("sid", sid)):
    if f"--max-turns {turns}" not in flags:
        print(f"    ⛔ {side} 侧 --max-turns {turns} 没渲染出来"); ok = False
# 权限档：两侧都必须是零摩擦档，否则重演 A10 那次「混了两个变量、整轮白跑」。
if "bypassPermissions" not in cc:
    print("    ⛔ cc 侧不是 bypassPermissions"); ok = False
if "--dangerously-skip-permissions" not in sid:
    print("    ⛔ sid 侧不是 skip"); ok = False
sys.exit(0 if ok else 1)
PY
then
  echo "⛔ 闸 1 未过：两侧 flag 没对齐 —— **别开跑**，这笔钱会买回一份变量没控住的数据"
  exit 1
fi
echo "✅ 闸 1：轮数与权限档两侧对齐（静态渲染实证）"

# ── 闸 2：apt 下载预算（$0，~30s）─────────────────────────────────────────────
#
# 2026-09-01 实测：不过这道闸就开跑的形态是**每题白烧 48min**
# （`AgentSetupTimeoutError`，连 npm 都没进到，模型零调用）。
# 10 题 × 48min = 8 小时换回零样本。所以这道闸放在花钱之前。
if [ "${SID_CC_SKIP_APT_GATE:-0}" != "1" ]; then
  FIRST_TASK="${TASK_FILTER[1]:-log-summary-date-ranges}"
  if ! bash preflight-apt-budget.sh "$FIRST_TASK"; then
    echo "⛔ 闸 2 未过 —— 别开跑。确实要跑：SID_CC_SKIP_APT_GATE=1"
    exit 1
  fi
else
  echo "⚠️ 闸 2 被显式跳过（SID_CC_SKIP_APT_GATE=1）—— 撞 48min/题 的风险自负"
fi

# ── 闸 3：容器内**真的有 AVX 吗**（$0，~5s）───────────────────────────────────
#
# 2026-09-02 实测：缺 AVX 时 claude-code **一题都跑不到模型** —— cc 跑在 Bun 上，
# Bun 需要 AVX。形态是启动后约 2.3s `panic: Segmentation fault`（exit 139），
# 10 题里 4 题这个签名、另 4 题 100% CPU 空转 10-15min 后无输出。
# 一整轮买回零样本（实付 $0 只是因为模型一次没调到）。
#
# ⛔ **判据必须是容器内实测 avx 数，不能是「我开了 --vz-rosetta」**：
#   `colima.yaml` 里 `rosetta: true` 会**持久化**，下次不带 flag 启动仍是开的（实测）；
#   反之带了 flag 也可能因 profile 没重启而没生效。**只有 /proc/cpuinfo 说的算。**
#
# ⛔ **不许用 `claude --version` 代替这一闸**：它走快路径、不进 JIT，
#   在 `avx=0` 的 QEMU 下照样 `rc=0` 且 0s 返回 —— 这正是 2026-09-02 那次误判的成因
#   （「探针形态 ≠ 真实流量」，本仓第二次踩）。
if [ "${SID_CC_SKIP_AVX_GATE:-0}" != "1" ]; then
  AVX_IMG="${SID_CC_AVX_PROBE_IMAGE:-ghcr.io/laude-institute/terminal-bench/log-summary-date-ranges:2.0}"
  AVX_N="$(docker run --rm --platform linux/amd64 "$AVX_IMG" \
      sh -c 'grep -c avx /proc/cpuinfo' 2>/dev/null | tr -dc '0-9')"
  AVX_N="${AVX_N:-0}"
  if [ "$AVX_N" -lt 1 ]; then
    echo "⛔ 闸 3 未过：容器内 avx 标志数 = ${AVX_N}（需 ≥1）"
    echo "   ⇒ claude-code 会在启动后约 2.3s SIGSEGV，10 题全部跑不到模型。"
    echo "   修法（一行，镜像不丢，两侧 agent 同受益）："
    echo "     colima stop swebench && colima start swebench --vz-rosetta"
    echo "   复核：docker run --rm --platform linux/amd64 $AVX_IMG sh -c 'grep -c avx /proc/cpuinfo'"
    echo "         (期望 >=1;若仍是 0 就是没生效,别开跑)"
    echo "   确实要跑（会买回零样本）：SID_CC_SKIP_AVX_GATE=1"
    exit 1
  fi
  echo "✅ 闸 3：容器内有 AVX（avx 标志数=${AVX_N}）—— cc 的 Bun 运行时跑得起来"
else
  echo "⚠️ 闸 3 被显式跳过（SID_CC_SKIP_AVX_GATE=1）—— cc 侧 SIGSEGV 风险自负"
fi

# ── 内存采样：`-n 6` 下真 agent 合计峰值实测 9150MiB/15950MiB（57%）──────────
# ⚠️ OOMKill 会**伪装成能力失败**：容器被杀 → reward=0 → 看起来像"没解出来"。
# 所以留一份带时间戳的采样，事后能把「0 分」与「那一刻内存打满」对上。
MEM_LOG="runs/${JOB}.mem.log"
mkdir -p runs
( while :; do
    printf '%s ' "$(date +%FT%T)"
    docker stats --no-stream --format '{{.Name}}={{.MemUsage}}' 2>/dev/null | tr '\n' ' '
    echo
    sleep 15
  done ) > "$MEM_LOG" 2>&1 &
MEM_PID=$!
# shellcheck disable=SC2064  # 刻意现在展开 PID
trap "kill $MEM_PID 2>/dev/null || true" EXIT

# ── E1：verifier 的 uv 走宿主本地镜像（2026-09-02 接入）───────────────────────
#
# 🔴 **必须与 sid 侧同时启用**，否则它是一个不受控变量：verifier 的判分可靠性
# 两侧不同，而 verifier 坏掉的样本与"没解出来"**逐字节相同**（reward=0）。
# sid 侧接在 run-model-switch.sh 的 COMMON 里，判据与理由见那里和 lib/uv-mirror.sh 头注释。
#
# ⚠️ 本轮 cc 侧 verifier 恰好 10/10 都判成了（uv 全下成功）—— 那是**运气**，不是
# 结构性差异：同一批题在 sid 基线那晚 5 题栽在同一个下载上。别把"这次没坏"当成"不会坏"。
UV_MIRROR_ARGS=()
UV_MIRROR_PID=""
if [ "${SID_HARBOR_SKIP_UV_MIRROR:-0}" = "1" ]; then
  echo "--- E1：已显式跳过 uv 本地镜像（SID_HARBOR_SKIP_UV_MIRROR=1）——verifier 将直连 github"
else
  echo "--- E1：起 uv 本地镜像（消灭 verifier 的外网下载）"
  if _uv_mirror_env="$(bash ../lib/uv-mirror.sh start)"; then
    eval "$_uv_mirror_env"
    UV_MIRROR_ARGS=(--ve "UV_INSTALLER_GITHUB_BASE_URL=${UV_MIRROR_BASE_URL}")
    echo "    ✅ 已注入 --ve UV_INSTALLER_GITHUB_BASE_URL=${UV_MIRROR_BASE_URL}"
  else
    echo "    ⚠️ uv 镜像未起成 —— 退回直连 github（= 本轮之前的行为，不更坏）。"
    echo "       ⛔ 但若 sid 侧起成了而这边没起成，**两侧就不可比了**，别当无事发生。"
  fi
fi

rm -rf "runs/$JOB"
echo "=== 启动 $(date '+%F %T') ==="
caffeinate -dimsu harbor run \
  -a claude_code_agent:ClaudeCodeNpm -m anthropic/claude-sonnet-5 \
  -d terminal-bench-sample@2.0 "${TASK_FILTER[@]+"${TASK_FILTER[@]}"}" \
  -n "$N" -k 1 --registry-path registry.local.json --jobs-dir runs \
  --ak "version=$CC_VERSION" --ak "max_turns=$MAX_TURNS" \
  --agent-setup-timeout-multiplier 8 --environment-build-timeout-multiplier 3 \
  --verifier-timeout-multiplier 6 --agent-timeout-multiplier 4 -y \
  "${UV_MIRROR_ARGS[@]+"${UV_MIRROR_ARGS[@]}"}" \
  --job-name "$JOB"
RUN_RC=$?
echo "=== 结束 $(date '+%F %T') rc=$RUN_RC ==="

kill "$MEM_PID" 2>/dev/null || true
# E1 镜像服务收尾（tarball 已落盘，停进程不影响下次复用）。
bash ../lib/uv-mirror.sh stop "${UV_MIRROR_PID:-}" >/dev/null 2>&1 || true

# ── 收尾：并发实证 + 内存峰值 ────────────────────────────────────────────────
echo
python3 concurrency-evidence.py "runs/$JOB" || true

if [ -s "$MEM_LOG" ]; then
  echo "--- 内存峰值（容器合计；接近 15.58GiB 须复核 OOM）"
  python3 - "$MEM_LOG" <<'PYMEM' || true
import re, sys
peak, at = 0.0, ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    tot = 0.0
    for val, unit in re.findall(r"=\s*([\d.]+)(MiB|GiB|KiB)\s*/", line):
        v = float(val)
        tot += v * (1024 if unit == "GiB" else 1 / 1024 if unit == "KiB" else 1)
    if tot > peak:
        peak, at = tot, line.split()[0]
print(f"    峰值 {peak:.0f} MiB @ {at}（真 agent -n 6 实测基线 9150 MiB）")
PYMEM
fi

echo
echo "⚠️ 判据提醒：本轮**只报机理与并发**。reward 比较需要与 sid 侧核过"
echo "   七项必控变量后才能提，且 n=10 时 95%CI 半宽 ±28pp。"
exit "$RUN_RC"
