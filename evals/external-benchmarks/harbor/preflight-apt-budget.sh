#!/usr/bin/env bash
# ①‴ 闸：**容器内 apt 下得完吗**（$0，不起评测、不调模型，**自身封顶 ~40s**）
#
# ## 为什么必须有这一闸
#
# 2026-09-01 实测：cc 的单题冒烟在 `agent_setup` 撞 **2880s（48min）上限**
# → `AgentSetupTimeoutError`，**连 npm 那步都没进到**，模型一次都没调。
# 失败形态是「跑了 48 分钟，然后告诉你超时」——**它不说为什么**，
# 而真因是一道纯算术题：
#
#     apt 需下载        203 MB   （`--print-uris` 实证：212,676,168 B）
#     被测容器实测速率   12.8 KB/s（amd64/qemu 下 60s 窗口实测）
#     ⇒ 需 270 min ≫ 48 min 上限   ⇒ **这一轮从一开始就不可能成功**
#
# ⇒ 与其花 48 分钟撞上限，先用 **30 秒** 把这道算术做掉。
#
# ## ⚠️ 判据必须在**目标架构**上测（这是我自己踩的坑，留着当样本）
#
# 我第一版用 `curlimages/curl` 测出「代理 137.7KB/s vs 直连 26.3KB/s，差 5.2×」，
# 据此判定"注入代理即可解"，并真的改了 `install()`。**但那个探针是 aarch64
# （本机原生），而被测镜像是 amd64 跑在 qemu 下**。装上代理后实测 apt 仍只有
# 12.8 KB/s —— 代理没带来那 5.2×，瓶颈不在代理，在 qemu 网络栈。
#
# > **形态**：探针与真实流量差一个变量（架构），于是"修复"验在了一条不存在的路径上。
# > 与 §4.5.4「NPM_OK=28s ✅ 是手工跑的，而 Harbor 一次都不走那条路」同源。
# > **所以本闸强制 `--platform` 跟随被测镜像。**
#
# ## ⚠️ 第二个自踩的坑：闸本身不许慢
#
# 第二版让探针等 `apt-get update` 跑完再取 `--print-uris`。
# 但**那正是本闸要提前预警的那个慢操作** —— 闸跑了 2 分钟还没出判决。
# ⇒ 现在只测**固定窗口内的字节增量**，下载量用上面那个实证常量（可覆写），
# 全程封顶 ~40s，绝不等 update 收尾。
#
# 用法：
#   bash preflight-apt-budget.sh                    # 默认题目
#   bash preflight-apt-budget.sh polyglot-c-py      # 指定题目
#   SID_CC_APT_BYTES=... 覆写下载量   SID_CC_RATE_WINDOW_SEC=... 覆写窗口
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TASK="${1:-log-summary-date-ranges}"
LIMIT_SEC="${SID_CC_SETUP_LIMIT_SEC:-2880}"       # 360s 基准 × 8 倍率（trial.py:93）
WINDOW="${SID_CC_RATE_WINDOW_SEC:-25}"
# 2026-09-01 `--print-uris` 实证值（curl bash nodejs npm procps 全依赖链）。
BYTES="${SID_CC_APT_BYTES:-212676168}"
IMAGE="ghcr.io/laude-institute/terminal-bench/${TASK}:2.0"

echo "=== ①‴ apt 预算闸 | 题目=$TASK 上限=$((LIMIT_SEC / 60))min ==="

ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null)
[ -n "$ARCH" ] || { echo "⛔ 本地无镜像 $IMAGE —— 先 docker pull 或跑一次评测"; exit 1; }
echo "  镜像架构=$ARCH  本机=$(uname -m)  需下载 $((BYTES / 1024 / 1024))MB"

# ── 测速：固定窗口内的字节增量，**不等 update 收尾** ────────────────────────
# `timeout` 封顶，避免闸自己变成那个慢操作。
RATE=$(docker run --rm --platform "linux/$ARCH" "$IMAGE" sh -c "
  (apt-get update -qq >/dev/null 2>&1 &) 
  sleep 2
  a=\$(du -sb /var/lib/apt/lists 2>/dev/null | cut -f1)
  sleep $WINDOW
  b=\$(du -sb /var/lib/apt/lists 2>/dev/null | cut -f1)
  echo \$(( (b - a) / $WINDOW ))" 2>/dev/null | tail -1)

if ! [ "${RATE:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ⛔ ${WINDOW}s 窗口内字节零增长。"
  echo "     两种成因下一步动作不同，**别合并**："
  echo "       · 源不可达 → 查容器出网/DNS/代理（是故障，抬超时无用）"
  echo "       · 慢到测不出 → 必然撞上限，同样别开跑"
  echo "     复核：docker run --rm --platform linux/$ARCH $IMAGE sh -c 'apt-get update'"
  exit 1
fi

NEED=$((BYTES / RATE))
echo "  实测 $((RATE / 1024)) KB/s ⇒ 预计 $((NEED / 60))min vs 上限 $((LIMIT_SEC / 60))min"

if [ "$NEED" -gt "$LIMIT_SEC" ]; then
  cat <<MSG
⛔ 闸未过：按当前速率**必然**撞 agent_setup 上限 —— 别开跑（会白烧 48min/题）。
   可选动作（按代价排）：
     1. 等链路恢复后重测本闸（最省 —— 本仓已实测该速率会阵发波动）
     2. ⭐ 预烘一个装好 node+npm+claude 的镜像 —— 与 sid 侧「上传预编译二进制」
        对称（那侧 setup 中位 8.7s、零外网），把 203MB 下载变成零外网
     3. 抬 --agent-setup-timeout-multiplier（⚠️ 只是把 48min 拖更久，没解决）
MSG
  exit 1
fi
echo "✅ 闸通过：预算够（余量 $(( (LIMIT_SEC - NEED) / 60 ))min）"
