#!/usr/bin/env bash
# 性能探针：在 PTY 下启动真实 TUI，采样 CPU%/RSS 随时间变化。
# 用法: perf-probe.sh <label> <seconds> <binary> [args...]
set -u

LABEL="${1:?need label}"; DURATION="${2:?need seconds}"; BIN="${3:?need binary}"
shift 3

OUT="/tmp/perf-${LABEL}.log"
: > "$OUT"

# 用 script 给进程一个真实 PTY（TUI 需要 TTY 才进入交互渲染路径）。
# macOS 的 script 语法: script -q /dev/null <cmd> [args]
script -q /dev/null "$BIN" "$@" >/tmp/perf-${LABEL}.tty 2>&1 &
SCRIPT_PID=$!

sleep 1.5  # 等子进程 fork 出来

# 找到真正的 sid-code 进程（script 的子进程）
find_target() {
  # 找名字含 sid-code 且不是 script/grep 自己的进程
  pgrep -f "$BIN" | while read -r p; do
    [ "$p" = "$SCRIPT_PID" ] && continue
    echo "$p"
  done | head -1
}

TARGET=""
for _ in $(seq 1 10); do
  TARGET="$(find_target)"
  [ -n "$TARGET" ] && break
  sleep 0.3
done

if [ -z "$TARGET" ]; then
  echo "ERROR: 找不到目标进程" | tee -a "$OUT"
  kill "$SCRIPT_PID" 2>/dev/null
  exit 1
fi

echo "target_pid=$TARGET label=$LABEL duration=${DURATION}s" | tee -a "$OUT"
echo "t_sec  cpu%   rss_mb  threads" | tee -a "$OUT"

START=$(date +%s)
while :; do
  NOW=$(date +%s)
  T=$((NOW - START))
  [ "$T" -ge "$DURATION" ] && break
  # ps: %cpu 是自进程启动以来的平均值；用 -o 拿瞬时需靠 top。这里用 top 采一次瞬时 CPU。
  LINE=$(top -l 1 -pid "$TARGET" -stats pid,cpu,mem,th 2>/dev/null | tail -1)
  # LINE 形如: "12345  3.2  120M  25"
  PID_R=$(echo "$LINE" | awk '{print $1}')
  if [ "$PID_R" = "$TARGET" ]; then
    CPU=$(echo "$LINE" | awk '{print $2}')
    MEM=$(echo "$LINE" | awk '{print $3}')
    TH=$(echo "$LINE" | awk '{print $4}')
    printf "%-6s %-6s %-7s %s\n" "$T" "$CPU" "$MEM" "$TH" | tee -a "$OUT"
  fi
  sleep 1
done

kill "$TARGET" 2>/dev/null
kill "$SCRIPT_PID" 2>/dev/null
echo "done -> $OUT"
