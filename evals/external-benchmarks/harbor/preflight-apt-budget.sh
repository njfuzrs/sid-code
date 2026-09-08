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
# ⇒ 用 `timeout $WINDOW` 给探针封顶，**跑不完就是判据本身**（rc=124 ⇒ 慢 ⇒ 红），
# 全程封顶 ~40s。
#
# ## ⚠️ 第三个自踩的坑（2026-09-08）：判据挑错了信号，一次挑错两个
#
# 第三版（du 首尾差）在**网络变快时假红**：update 4~9s 就收尾（落在窗口内），
# 之后 apt 清理临时文件让 `du` 变小 ⇒ 首尾差为负 ⇒ 判成"源不可达"，
# 在链路健康（实测 2132 kB/s）时拦停开跑。
#
# 修它的时候我又连写了两条**不承重**的判据，都是反向变异抓出来的：
#   ✗ `ls /var/lib/apt/lists/*Release | wc -l > 0` 当"真拉到索引"
#     ⇒ **原始镜像自带 4 个**，`--network internal` 断网容器里**也是 4** ⇒ 永远为真。
#   ✗ `apt-get update` 的**退出码** = 0 当"成功收尾"
#     ⇒ 断网容器里 **rc 照样 0** —— apt 把取不到索引降级成 `W:` 警告，不进退出码。
#
# > **形态**：两条都"看着像多加了一层校验"，而在真故障下同样绿。
# > ⇒ **判据要挑「故障时会变」的信号，优先用被测系统自己报的数**，
# >   别用 `du`、文件存在性、宽松命令退出码这类**副产物代理指标**。
#
# ⇒ 现在速率直接取 apt 自己那行 `Fetched 10.7 MB in 5s (2132 kB/s)`，
#   并对三种成因分别给判据（每条都实测过能红，见下方三个 if）。
# ⛔ 别退回 du 方案，也别把闸删了：它在**慢**的时候结论是对的（12.8 KB/s 那次）。
#
# 用法：
#   bash preflight-apt-budget.sh                    # 默认题目
#   bash preflight-apt-budget.sh polyglot-c-py      # 指定题目
#   SID_CC_APT_BYTES=... 覆写下载量   SID_CC_RATE_WINDOW_SEC=... 覆写窗口
#
# 复跑变异自证（改本文件后**必须**重跑这三条，⚠️ 没有 CI 兜着）：
#   bash preflight-apt-budget.sh polyglot-c-py                        # 期望绿 rc=0
#   SID_CC_APT_BYTES=212676168000000 bash preflight-apt-budget.sh …   # 期望红（预算不够）
#   SID_CC_RATE_WINDOW_SEC=2 bash preflight-apt-budget.sh …           # 期望红 rc=124（慢）
#   # 不可达那条要断网容器：docker network create --internal apt-iso 后手工验 ERRS>0 而 rc=0
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

# ── 测速：直接用 **apt 自报的速率**，不再用 du 当代理指标 ────────────────────
#
# 🔴 2026-09-08 重写。原实现取 `/var/lib/apt/lists` 首尾两次 `du` 的差，
# **网络变快时会假红**：`apt-get update` 现在 4–7s 就收尾（落在 25s 窗口内），
# 之后 apt 清理临时文件 ⇒ `du` 变小 ⇒ 首尾差为**负**：
#     a=53969451 b=52924493 delta=-1044958 rate=-41798
# 而 `! [ "$RATE" -gt 0 ]` 把"非正增长"一律判成"不可达/慢到测不出"，
# 于是在**链路健康**（实测 2774 kB/s）时拦停开跑。出处见 08 号 §4.3 纠错第 2 条。
#
# 🔴 **修这个闸时我自己连踩两条假绿断言，都被反向变异抓出来 —— 记下来别重犯**：
#   ✗ 第一版用 `LISTS > 0`（`/var/lib/apt/lists/*Release` 文件数）当"真拉到了索引"
#     ⇒ **原始镜像本来就自带 4 个**，断网容器里照样是 4。**该条件永远为真。**
#   ✗ 第二版改用 `apt-get update` 的**退出码** ⇒ 断网容器里 **rc 照样是 0**
#     （apt 把"索引拉不到"降级成 `W:` 警告，不反映在退出码上）。
#   ⇒ 两个"看着像校验"的条件都不承重。**判据必须自己验证过能红。**
#
# ✅ 现在的判据来自 apt 自己的仪器（两条都实测过能区分）：
#   · 健康：`Fetched 10.7 MB in 4s (2774 kB/s)`  ← 速率直接取这里，不用代理指标
#   · 不可达：`W: Failed to fetch ...` / `Err:` 行出现（且**没有** Fetched 行）
#   · 慢：`timeout` 在窗口内没跑完 ⇒ rc=124 ⇒ 必然撞上限
# ⛔ 别退回 du 方案，也别把闸删了：它在**慢**的时候结论是对的
#    （2026-09-01 实测 12.8 KB/s 那次就是它拦下来的）。
PROBE=$(docker run --rm --platform "linux/$ARCH" "$IMAGE" sh -c "
  out=\$(timeout ${WINDOW} apt-get update 2>&1); rc=\$?
  # apt 自报速率行（可能不存在：索引全命中时无下载）
  fetched=\$(printf '%s\n' \"\$out\" | grep -E '^Fetched' | tail -1)
  # 取网 / DNS 失败的证据行数
  errs=\$(printf '%s\n' \"\$out\" | grep -cE '^(W: Failed to fetch|Err:|W: Some index files failed)')
  printf 'RC=%s ERRS=%s FETCHED=%s\n' \"\$rc\" \"\$errs\" \"\$fetched\"" 2>/dev/null | tail -1)

UPD_RC=$(printf '%s' "$PROBE" | sed -n 's/.*RC=\([0-9]*\).*/\1/p')
ERRS=$(printf '%s' "$PROBE" | sed -n 's/.*ERRS=\([0-9]*\).*/\1/p')
FETCHED=$(printf '%s' "$PROBE" | sed -n 's/.*FETCHED=//p')
echo "  探测: rc=${UPD_RC:-?}  失败行数=${ERRS:-?}  apt 自报: ${FETCHED:-（无 Fetched 行）}"

# ① 慢：窗口内没跑完（timeout 的 rc=124）⇒ 必然撞上限
if [ "${UPD_RC:-0}" = "124" ]; then
  echo "  ⛔ apt-get update 在 ${WINDOW}s 内未跑完 ⇒ **慢到必然撞 agent_setup 上限**，别开跑。"
  echo "     复核：docker run --rm --platform linux/$ARCH $IMAGE sh -c 'apt-get update'"
  exit 1
fi

# ② 不可达：出现取网失败行（⚠️ 判据是这些行，**不是**退出码 —— 断网时 rc 也是 0）
if [ "${ERRS:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ⛔ apt 报告索引取网失败（${ERRS} 行 W:/Err:）⇒ **源不可达**，别开跑。"
  echo "     ⚠️ 注意 rc=${UPD_RC:-?} —— apt 把这类失败降级成警告，**退出码不可信**。"
  echo "     下一步：查容器出网 / DNS / 代理（是故障，抬超时无用）。"
  echo "     复核：docker run --rm --platform linux/$ARCH $IMAGE sh -c 'apt-get update'"
  exit 1
fi

# ③ 无 Fetched 行且无失败 ⇒ 索引全命中，本来就没有下载量可测
if [ -z "${FETCHED:-}" ]; then
  echo "  ✅ 闸通过（旁路判据）：apt 无下载（索引全命中）、且零失败行。"
  echo "     ⚠️ 本轮**不做速率外推** —— 没有可信速率就不假装有一个。"
  exit 0
fi

# ④ 正常路径：从 apt 自报行取速率，单位 kB/s 或 MB/s
RATE=$(printf '%s' "$FETCHED" | sed -n 's/.*(\([0-9.]*\) \([kKmM]\)B\/s).*/\1 \2/p' \
  | awk '{ v=$1; if ($2 ~ /[mM]/) v=v*1024; printf "%d", v*1024 }')
if ! [ "${RATE:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ⛔ 解析不出速率（Fetched 行格式变了？）⇒ 停手，别猜。"
  echo "     原始行：$FETCHED"
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
