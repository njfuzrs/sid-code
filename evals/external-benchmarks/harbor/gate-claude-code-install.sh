#!/usr/bin/env bash
# ①‴ 前置闸：claude-code 在容器内装得上吗？**$0（--install-only 不跑 agent 也不跑 verifier）**
#
# ## 为什么单独立一道闸，而不是直接开跑 10 题
#
# 装不上的形态**不是**报错，是「跑完了、分数低、且只有轨迹能告诉你真因」——
# 与 §5.2.4.6 那次 `qemu-alpine-ssh`（402 余额耗尽被记进能力账）同型。
# 用 10 题去发现安装问题，等于花钱买一份废数据。
#
# ## 判据（三条，缺一不可）
#
#   1. `n_completed_trials=1` 且 `n_errored_trials=0`
#   2. trial.log 里有 `npm install -g @anthropic-ai/claude-code@<钉住的版本>`
#   3. ⚠️ **变异自证**：钉一个不存在的版本时这道闸**必须红**（`--mutate`）
#      2026-09-01 实测：`99.99.99-does-not-exist` → `npm ERR! code ETARGET`
#      → `NonZeroAgentExitCodeError`，`n_errored_trials=1` ✅
#      没有这一条，「绿」可能只是它压根没检查安装（§4.3 §21.5 那个假绿变异）。
#
# ## 实测基线（2026-09-01，`-n 1`，TUN 开启）
#
#   | 镜像                          | 系统   | 墙钟   | claude 落点            |
#   | log-summary-date-ranges:2.0   | debian | 3m21s  | /usr/local/bin/claude  |
#   | polyglot-c-py:2.0             | ubuntu | 9m23s  | /usr/local/bin/claude  |
#
# ⚠️ **两个镜像差 2.8×，慢的全在 apt**（ubuntu 侧 apt 约 160s+dpkg 配置期更长），
# npm 那一步两侧都是 ~20s。⇒ 10 题的安装总开销按 **~9m/题** 估更安全，
# 而且**这是每题各装一次**（Harbor 每 trial 一个新容器，无跨题缓存）。
#
# 用法：
#   bash gate-claude-code-install.sh                    # 默认题目，正向闸
#   bash gate-claude-code-install.sh polyglot-c-py      # 指定题目
#   bash gate-claude-code-install.sh --mutate           # 变异自证（**期望红**）
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CC_VERSION="${CC_VERSION:-2.1.252}"
MUTATE=0
TASK="log-summary-date-ranges"
for a in "$@"; do
  case "$a" in
    --mutate) MUTATE=1 ;;
    -*) echo "未知参数: $a"; exit 2 ;;
    *) TASK="$a" ;;
  esac
done

if [ "$MUTATE" = 1 ]; then
  PIN="99.99.99-does-not-exist"; JOB="ccinstall-mutation"
  echo "=== 变异自证：钉一个不存在的版本，本闸**期望红** ==="
else
  PIN="$CC_VERSION"; JOB="ccinstall-${TASK}"
fi

# 网关：与 sid-code 侧同一个 shim 实例（选项 A —— 模型同源是第一必控变量）。
# `192.168.5.2` = colima host-gateway，**不是** 172.17.0.1。
GW_PORT="${SID_CC_GATEWAY_PORT:-4100}"
export ANTHROPIC_BASE_URL="http://192.168.5.2:${GW_PORT}"
# ⛔ 必须是占位 token：shim 只认 `no-auth-dummy`，真 key 从不进容器（也不加重 B8）。
export ANTHROPIC_API_KEY="no-auth-dummy"
export HARBOR_TELEMETRY=0
export PYTHONPATH="$(pwd)"

# ── 闸前置：shim 在跑且是我们的 shim（判据=/__stats 结构，不是端口连得上）──────
probe=$(curl -s -m 10 "http://127.0.0.1:${GW_PORT}/__stats" 2>/dev/null || true)
if ! printf '%s' "$probe" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if isinstance(d.get("stats"),dict) and "upstream_model" in d else 1)' 2>/dev/null; then
  echo "⛔ ${GW_PORT} 上不是我们的 shim（透传代理也会回 200，所以判结构不判状态码）"
  echo "   起它：python3 ~/.local/share/sid-harbor-gateway/gateway.py --port ${GW_PORT} --model-name claude-sonnet-5-ppchat"
  exit 1
fi
echo "✅ shim 在跑（上游=$(printf '%s' "$probe" | python3 -c 'import json,sys;print(json.load(sys.stdin)["upstream_model"])')）"

rm -rf "runs/$JOB"
echo "=== 启动 $(date '+%F %T')  题目=$TASK  钉版本=$PIN  job=$JOB ==="
caffeinate -dimsu harbor run --install-only \
  -a claude_code_agent:ClaudeCodeNpm -m anthropic/claude-sonnet-5 \
  -d terminal-bench-sample@2.0 -i "$TASK" \
  -n 1 -k 1 --registry-path registry.local.json --jobs-dir runs \
  --ak "version=$PIN" \
  --agent-setup-timeout-multiplier 8 --environment-build-timeout-multiplier 3 -y \
  --job-name "$JOB"
echo "=== 结束 $(date '+%F %T') ==="

# ── 判分 ──────────────────────────────────────────────────────────────────────
python3 - "$JOB" "$PIN" "$MUTATE" <<'PY'
import json, sys, glob, os
job, pin, mutate = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
p = f"runs/{job}/result.json"
if not os.path.exists(p):
    print("⛔ 没有 result.json —— harbor 压根没跑起来"); sys.exit(1)
d = json.load(open(p)); s = d["stats"]
done, err = s["n_completed_trials"], s["n_errored_trials"]
# 判据 2：安装命令真的用了 npm 且钉了版本。**读 trial.log，不靠"我以为传了"**。
cmd_ok = False
for t in glob.glob(f"runs/{job}/*/trial.log"):
    if f"npm install -g @anthropic-ai/claude-code@{pin}" in open(t, errors="replace").read():
        cmd_ok = True
print(f"    completed={done} errored={err} 安装命令含 npm+钉版本={'是' if cmd_ok else '否'}")
if mutate:
    # 变异期望：红，且**红在安装上**（ETARGET），不是红在别处 —— 否则这条自证
    # 证明的是"某处会失败"而不是"这道闸在检查安装"。
    etarget = any("ETARGET" in open(t, errors="replace").read()
                  for t in glob.glob(f"runs/{job}/*/trial.log"))
    if err >= 1 and etarget:
        print("✅ 变异自证通过：闸确实红了，且红在 npm ETARGET（安装）上"); sys.exit(0)
    print("⛔ 变异自证失败：钉了不存在的版本却没红在安装上 —— 这道闸是假绿"); sys.exit(1)
if done == 1 and err == 0 and cmd_ok:
    print("✅ 安装闸通过：claude-code 装得上，且走的是 npm 路径")
    sys.exit(0)
print("⛔ 安装闸未通过 —— 别拿 10 题去发现安装问题（那会买回一份废数据）")
sys.exit(1)
PY
