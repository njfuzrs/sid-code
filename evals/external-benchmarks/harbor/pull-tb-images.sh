#!/usr/bin/env bash
# W3.0 先行闸：把 terminal-bench@2.0 的 89 个镜像拉全（当前差 78 个）。
#
# ## 为什么不是一行 `for t in ...; do docker pull; done`
#
# 2026-09-05 实测：第 1 张 8.7s 拉完，第 2 张 `bn-fit-modify` **卡死 >12 分钟**
# 且不返回、不报错、不写字节（`lsof -p` 看不到任何 socket）。
# ⇒ **拉镜像是概率性的，不是「通/不通」**。裸循环的形态是：整夜卡在第 2 张上，
# 早上起来看到「还在跑」，而实际一张都没进展 —— 无人值守时这与"正在努力"不可区分。
#
# 所以本脚本三件事都是必需的，不是防御性编程：
#   ① **停滞检测**（看门狗）：只在「一段时间内一个字节都没进来」时才杀。
#      ⛔ 不能用墙钟死线 —— 2026-09-06 实测踩到：`mteb-leaderboard` 压缩后 **8.5GB**
#      （7 层），600s 死线把它杀在下载途中，而那 606s 里磁盘实实在在掉了 8G ——
#      **它一直在正常下载**。同批里 `mteb-retrieve` 8.5GB、`pytorch-model-recovery`
#      6.1GB，其余 39 张全 < 0.6GB ⇒ 体积差 **14 倍**，一个死线不可能同时适配两端。
#      判据换成「有没有进展」：docker 数据盘用量在涨就是活的，多久都不算卡死。
#   ② **多轮重试**，失败的攒到本轮末尾再来（概率性故障重试即好）
#   ③ **每张记 OK/FAIL + 耗时**，末尾出汇总 —— 否则说不出"到底差哪几张"
#
# ## ⚠️ 本机没有 `timeout` / `gtimeout`（实测两个都 absent）
# 所以看门狗是手写的：后台起 docker pull，轮询，超时 kill。
# ⛔ 别改成 `timeout Ns docker pull` —— 在这台机器上那是 `command not found`，
#    而 `command not found` 的 rc=127 会被当成"拉失败"，于是 78 张全"失败"，
#    脚本却一路跑完并给出一份完全错误的汇总。
#
# ## 磁盘守卫一律 fail-closed
# 89 题外推 ≈56GB（UNIQUE 口径），VM 实测可用 102GB —— 够，但余量不宽裕。
# ⛔ 取数源只能是 **VM 内** `df /var/lib/docker`。容器里 `df /` 看到的是 VM root
#    （19G），拿它当判据会在还有 100G 时误报磁盘满。
# 守卫读不出数字时**必须停**，不许当成"没问题"继续 —— 本仓踩过 fail-open：
# `docker ps | wc -l` 在 docker 不可达时输出 0，被读成"没容器，可以放心重启"。
#
# 用法：
#   caffeinate -dimsu bash pull-tb-images.sh            # 正常跑（后台建议配 nohup）
#   SID_TB_ROUNDS=5 SID_TB_STALL_LIMIT=300 bash pull-tb-images.sh
#   bash pull-tb-images.sh --dry-run                    # 只看要拉哪些，不动网络
set -uo pipefail   # ⚠️ 刻意不加 -e：单张拉失败是预期事件，必须继续下一张

cd "$(dirname "$0")"

IMAGE_PREFIX="ghcr.io/laude-institute/terminal-bench"
VERSION="2.0"
ROUNDS="${SID_TB_ROUNDS:-4}"                 # 重试轮数
STALL_LIMIT="${SID_TB_STALL_LIMIT:-240}"   # 连续多少秒「零进展」才判卡死（不是单张总上限）
HARD_CAP="${SID_TB_HARD_CAP:-5400}"        # 兜底绝对上限（秒），防某种"缓慢但永不结束"的病态
MIN_FREE_GB="${SID_TB_MIN_FREE_GB:-25}"      # 低于此值停手（56GB 需求 + 缓冲）
LOG_DIR="${SID_TB_LOG_DIR:-$HOME/.cache/sid-tb-images}"
LOG="$LOG_DIR/pull.log"
mkdir -p "$LOG_DIR"

# ── ⚠️ bash 版本门禁：本脚本用 mapfile 的替代实现，但仍需数组 + $(...)。
# 实测本机有两个 bash：/opt/homebrew/bin/bash 是 5.3，**/bin/bash 是 3.2**。
# 3.2 没有 `mapfile`，且它的失败形态是 `command not found` 后接
# `unbound variable`（因为 set -u）—— rc=1，不会假绿，但报错完全指不出真因。
# ⇒ 与其让人对着 "TODO: unbound variable" 排查，不如在这里说清楚。
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "⛔ 需要 bash ≥ 4（当前 ${BASH_VERSION}）。本机 /bin/bash 是 3.2。" >&2
  echo "   用: /opt/homebrew/bin/bash $0 $*" >&2
  exit 5
fi

# read_list：把一条命令的输出逐行读进数组。
# ⛔ 不用 `mapfile`（3.2 无）也不用 `arr=($(cmd))`（会做 glob 展开与词拆分）。
# 返回 1 表示取数命令自己失败 —— 调用方必须判它，否则就是拿空数组当"已齐"。
read_list() {
  local __name="$1"; shift
  local __line __tmp=()
  while IFS= read -r __line; do
    [ -n "$__line" ] && __tmp+=("$__line")
  done < <("$@")
  eval "$__name=(\"\${__tmp[@]+\"\${__tmp[@]}\"}\")"
}

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }

# ── 磁盘守卫：读不出数字就停（fail-closed）───────────────────────────────
free_gb() {
  local raw avail
  raw=$(colima ssh -p swebench -- df -BG /var/lib/docker 2>/dev/null | tail -1)
  avail=$(printf '%s' "$raw" | awk '{gsub(/G/,"",$4); print $4}')
  case "$avail" in
    ''|*[!0-9]*) return 1 ;;      # 空 / 非纯数字 ⇒ 判据失效
    *) printf '%s' "$avail" ;;
  esac
}

# 进展探针：docker 数据盘已用 MB。取不到就回空（调用方按"有进展"处理）
disk_used_mb() {
  colima ssh -p swebench -- df -BM /var/lib/docker 2>/dev/null \
    | tail -1 | awk '{gsub(/M/,"",$3); print $3}' | grep -E '^[0-9]+$'
}

check_disk() {
  local gb
  if ! gb=$(free_gb); then
    log "⛔ 磁盘判据读不出数字（colima/df 不可达）—— 按 fail-closed 停手" >&2
    log "   手工核: colima ssh -p swebench -- df -BG /var/lib/docker" >&2
    exit 3
  fi
  if [ "$gb" -lt "$MIN_FREE_GB" ]; then
    log "⛔ VM 可用 ${gb}G < 阈值 ${MIN_FREE_GB}G —— 停手（⚠️ 别 prune -a，现有镜像是资产）" >&2
    exit 4
  fi
  printf '%s' "$gb"
}

# ── 单张拉取 + 手写看门狗 ────────────────────────────────────────────────
pull_one() {
  local task="$1" ref="$IMAGE_PREFIX/$1:$VERSION" start pid waited elapsed
  local used_now used_last stalled=0
  start=$(date +%s)
  docker pull "$ref" >/dev/null 2>&1 &
  pid=$!
  used_last=$(disk_used_mb)
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 10; waited=$((waited + 10))
    used_now=$(disk_used_mb)
    # 进展判据 = docker 数据盘用量在涨。取不到数时**当作有进展**（宁可多等，
    # 也不要因为判据本身失效就杀掉一个正常的下载）—— 与磁盘守卫的 fail-closed
    # 方向相反，因为这里"误杀"才是那个更贵的错。
    if [ -z "$used_now" ] || [ -z "$used_last" ]; then
      # 探针失效 ⇒ **fail-open**：判不出有没有进展时不许累加停滞计数。
      # ⚠️ 这里与磁盘守卫的 fail-closed 方向刻意相反：守卫误放行只是多拉几张，
      # 而这里误杀会打断一个正常的 8.5GB 下载并让它每轮重来。
      # 2026-09-06 变异③抓到过：原写法把「探针回空」归到 else 分支一起累加，
      # 于是 colima 一抽风就把每一张都杀掉，而日志只显示 STALLED（像是网络卡）。
      stalled=0
    elif [ "$used_now" -gt "$used_last" ]; then
      stalled=0
    else
      stalled=$((stalled + 10))
    fi
    used_last="$used_now"
    if [ "$stalled" -ge "$STALL_LIMIT" ]; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      printf 'STALLED %s' "$(( $(date +%s) - start ))"; return 1
    fi
    if [ "$waited" -ge "$HARD_CAP" ]; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      printf 'HARDCAP %s' "$(( $(date +%s) - start ))"; return 1
    fi
  done
  wait "$pid"; local rc=$?
  elapsed=$(( $(date +%s) - start ))
  if [ "$rc" -eq 0 ]; then printf 'OK %s' "$elapsed"; return 0
  else printf 'FAIL(rc=%s) %s' "$rc" "$elapsed"; return 1; fi
}


# ── 主流程 ──────────────────────────────────────────────────────────────
if ! python3 tb-image-list.py >/dev/null; then
  log "⛔ tb-image-list.py 失败（见上方报错），停手"; exit 2
fi
read_list TODO python3 tb-image-list.py

if [ "${1:-}" = "--dry-run" ]; then
  python3 tb-image-list.py --stats
  printf '待拉清单:\n%s\n' "$(printf '  %s\n' "${TODO[@]}")"
  exit 0
fi

# ⚠️ 空清单 ≠ 已齐。清单受 SID_TB_MAX_GB / denied 跳过过滤，
# 「没有活可干」和「89 张都在」是两件事 —— 同一个假绿在收尾处也犯过一次。
# ⇒ 这里只说"没有可拉的活"，齐不齐一律留给收尾的真账去判。
if [ "${#TODO[@]}" -eq 0 ]; then
  log "本次过滤后没有可拉的镜像 —— 跳到真账核对"
  t0=$(date +%s)
  SKIP_PULL=1
fi

# ⚠️ check_disk 必须在**命令替换之外**调用。写成 log "... $(check_disk) ..." 时它跑在
# 子 shell 里，`exit 3` 只结束那个子 shell —— 守卫看着在，实际拦不住父进程
# （2026-09-05 变异自证时抓到：注入故障后横幅照打、还往下走了一轮才被真正拦住）。
FREE0=$(check_disk) || exit $?
log "══ 开始：待拉 ${#TODO[@]} 张 | 轮数 $ROUNDS | 停滞上限 ${STALL_LIMIT}s | 兜底 ${HARD_CAP}s | 可用 ${FREE0}G ══"
t0=$(date +%s)

for round in $(seq 1 "$ROUNDS"); do
  [ -n "${SKIP_PULL:-}" ] && break   # 过滤后无活可干：直接去收尾真账
  # 每轮都从 docker 实测重新派生，所以断点续跑天然成立：
  # 已拉到的不会再来，无需自己维护"进度文件"（那东西会与真实状态漂移）。
  read_list TODO python3 tb-image-list.py
  [ "${#TODO[@]}" -eq 0 ] && { log "✅ 全部齐了"; break; }
  log "── 第 $round/$ROUNDS 轮：剩 ${#TODO[@]} 张 ──"
  i=0
  for task in "${TODO[@]}"; do
    i=$((i + 1))
    check_disk >/dev/null
    res=$(pull_one "$task")
    log "$(printf '[%d/%d r%d] %-46s %s' "$i" "${#TODO[@]}" "$round" "$task" "$res")"
  done
done

# ── 汇总 ────────────────────────────────────────────────────────────────
#
# 🔴 收尾判据必须**无视本次的过滤器**。2026-09-06 踩到过一次假绿：
# 本轮用 `SID_TB_MAX_GB=3` + 自动跳过 denied 跑，收尾时复用了同一个（被过滤的）
# 清单 ⇒ 清单为空 ⇒ 打出 **"✅ 89/89 齐"，而本地实际只有 71 张**。
# 「把工作清单当成完成判据」是本仓最贵的那类错：**它在最该报警时报绿**。
# ⇒ 判据换成三笔账，各自独立取数，且只有 local==89 才允许说齐。
mins=$(( ( $(date +%s) - t0 ) / 60 ))
log "══ 结束：墙钟 ${mins} min | 可用 $(free_gb || echo '?')G ══"

# 本次实际处理情况（受过滤器影响，仅作过程记录）
python3 tb-image-list.py --stats | tee -a "$LOG"

# 真账：无视过滤器，直接问「registry 89 张里本地有几张」
TOTAL=89
HAVE=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
       | grep -c "^${IMAGE_PREFIX}/.*:${VERSION}$")
read_list REAL_LEFT env -u SID_TB_MAX_GB -u SID_TB_INCLUDE_DENIED python3 tb-image-list.py
DENIED=$(awk '$2=="DENIED"' "$LOG_DIR/sizes.txt" 2>/dev/null | wc -l | tr -d ' ')

log "── 真账（不受本次过滤器影响）──"
log "   本地已有   : ${HAVE}/${TOTAL}"
log "   可拉待拉   : ${#REAL_LEFT[@]} 张"
log "   已知 denied: ${DENIED} 张（权限态，重试无用）"

if [ "$HAVE" -ge "$TOTAL" ]; then
  log "✅ ${TOTAL}/${TOTAL} 齐 —— W3.0 先行闸的镜像这一半过了"
  exit 0
fi

if [ "${#REAL_LEFT[@]}" -gt 0 ]; then
  log "⚠️ 还有 ${#REAL_LEFT[@]} 张可拉未拉（重跑本脚本即续；巨张需放宽 SID_TB_MAX_GB）:"
  printf '   %s\n' "${REAL_LEFT[@]}" | tee -a "$LOG"
fi
# ⚠️ 不许因为"能拉的都拉完了"就报成功 —— 分母是 89，缺的就是缺的。
# W3 的可跑题数 = HAVE，置信区间必须按它算，不是按 89。
log "⛔ 未达 ${TOTAL}/${TOTAL}（本地 ${HAVE}）—— W3 分母按 ${HAVE} 算，别写 89"
exit 1
