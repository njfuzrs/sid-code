#!/usr/bin/env bash
# 换档重测那 10 题(§17.5 第一优先)。除权限档外,所有变量与第五棒(§14.7/§15)一致。
#
# 用法:  caffeinate -dimsu bash run-permission-switch.sh [job-name] [题名...]
#
# 不给题名 = 跑全部 10 题。给题名 = 只跑这几题(每个都变成 harbor 的 `-i`,支持 glob):
#
#     bash run-permission-switch.sh permswitch-r3 polyglot-c-py regex-log
#
# **补跑存在的意义**:基础设施故障(上游额度耗尽 / 网关 502)会让某题
# `num_turns=0`、一次 API 调用都没发生,而它的 `reward=0.0` 与真的没解出来
# **逐字节一样**(判据见 `verifier_health.agent_ran`)。这种题必须补跑,
# 但为此重跑全部 10 题要花 ~$7 且把已经跑好的样本也一起换掉 ——
# 换掉就意味着**分母里混进两批不同时间、不同上游状态的数据**。
# 补跑只花 ~$1,且只补该补的那几题。
#
# ⚠️ 补跑结果**落在新 job 目录**,不覆盖原目录。复算时要么整体用新 job,
# 要么明确写清"某题取自哪个 job" —— 别让两批数据在同一张表里不加标注地混着。
#
# ⚠️ 跑之前必须过的两道闸(都踩过,都不报错):
#
# 1. **verifier 的 uv 下载速率 ≥500KB/s**。10 题的 test.sh 全部实时从 GitHub 下
#    17.8MB 的 uv;宿主链路劣化到 70KB/s 时,verifier 在 103/243/413 秒后放弃,
#    reward 全部写 0 —— 而 `sid_subtype` 照样是 `success`。
#    **那是一轮"绿着坏掉"的假数据**(2026-08-29 实测,烧掉 $3.12)。判据:
#      docker run --rm alpine:3 sh -c 'apk add -q curl; curl -sL -o /dev/null -m 30 \
#        -w "%{speed_download}B/s\n" \
#        https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz'
#    基线(能跑那次)verifier 全程 24-56s;降速那次是 103-413s 后放弃。
# 2. **上游掉流率**:curl http://127.0.0.1:4100/__stats(§15.6:单次故障烧 315s)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

JOB="${1:-permswitch-$(date +%m%d-%H%M)}"
shift || true
# 剩下的位置参数都是题名 → 每个拼成一个 `-i`。空数组时不加任何 -i,即跑全部。
TASK_FILTER=()
for t in "$@"; do TASK_FILTER+=(-i "$t"); done

export SID_HARBOR_GATEWAY_URL=http://192.168.5.2:4100   # colima host-gateway,⚠️ 不是 172.17.0.1
# ⚠️ 必须指向当前 HEAD 编出来的包。缺口 B 的教训:TS 改了不重编 = 改了等于没改,且不报错。
export SID_HARBOR_BINARY_ARM64=~/.local/share/sid-harbor-gateway/bins/sid-code-arm64-7f437eb84e7a
export SID_HARBOR_BINARY_X64=~/.local/share/sid-harbor-gateway/bins/sid-code-x64-7f437eb84e7a
export SID_HARBOR_PROVIDER=anthropic
export HARBOR_TELEMETRY=0
export PYTHONPATH="$(pwd)"
# 权限档:**不显式传** —— 默认已是 skip 布尔 flag。显式传会撞 __init__ 的互斥校验。

COMMON=(-d terminal-bench-sample@2.0 -m anthropic/claude-sonnet-5 -n 1 -k 1
        --registry-path registry.local.json
        --jobs-dir runs --agent-setup-timeout-multiplier 8
        --verifier-timeout-multiplier 6 --agent-timeout-multiplier 4
        --environment-build-timeout-multiplier 3 -y)

echo "=== 启动 $(date '+%F %T')  job=$JOB ${TASK_FILTER[*]:+(只跑 ${TASK_FILTER[*]})} ==="
harbor run "${COMMON[@]}" "${TASK_FILTER[@]+"${TASK_FILTER[@]}"}" \
  -a sid_code_agent:SidCodeAgent --job-name "$JOB"
echo "=== 结束 $(date '+%F %T') rc=$? ==="
