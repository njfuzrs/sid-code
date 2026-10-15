#!/usr/bin/env bash
# 流式渲染开销基准：mock SSE 端点 + 真实 TUI（PTY）+ bun --cpu-prof。
#
# 输出三个可复算的数：
#   ① 进程累计 CPU 秒数（user+sys，取自退出前最后一次 ps 采样）
#   ② 流式阶段平均 CPU%（每秒 ps 采样，只算 mock 流式窗口内）
#   ③ CPU profile（markdown，按 self time 排序，可 grep React/reconcile 帧）
#
# 用法: scripts/perf-stream-bench.sh <label> [tokPerSec=150] [thinkTokens=3000] [textTokens=600]
set -u
LABEL="${1:?need label}"
RATE="${2:-150}"
THINK="${3:-3000}"
TEXT="${4:-600}"
PORT=18765
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="/tmp/perf-stream-${LABEL}"
rm -rf "$OUT" && mkdir -p "$OUT/home" "$OUT/work"

STREAM_SECS=$(( (THINK + TEXT) / RATE + 4 ))

bun run "$ROOT/scripts/perf-mock-sse.ts" "$PORT" "$RATE" "$THINK" "$TEXT" >"$OUT/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1

export SID_CONFIG_DIR="$OUT/home"
export SID_CODE_LLM_PROVIDER=openai
export SID_CODE_LLM_BASE_URL="http://127.0.0.1:${PORT}/v1"
export SID_CODE_LLM_MODEL=mock-flash
# 长度要过 key 校验，否则启动弹「API Key 长度过短」挡住输入
export OPENAI_API_KEY=perf-probe-key-000000000000000000000000
# 与发布产物对齐：make build 内联 NODE_ENV=production。不设的话 bun run 加载 React
# development 构建，reconcile 开销被放大数倍，测出来的不是用户真实看到的数。
export NODE_ENV=production
export PERF_MARK="$OUT/stream.started"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

# 在空目录里启动：仓库根有项目级 skill / .mcp.json，会弹信任确认框挡住输入
cd "$OUT/work"
expect "$ROOT/scripts/perf-stream-drive.exp" "$STREAM_SECS" \
  bun --cpu-prof-md --cpu-prof-dir="$OUT" run "$ROOT/packages/cli/src/entrypoints/bootstrap.ts" ${PERF_EXTRA_ARGS:-} \
  >"$OUT/tty.log" 2>&1 &
DRIVER=$!

# 找 bun 主进程（expect 的子进程）
TARGET=""
for _ in $(seq 1 40); do
  # 取 expect 的子进程：expect 自己的 argv 也含 cpu-prof-dir，按 -f 匹配会抓错
  TARGET=$(pgrep -P "$DRIVER" 2>/dev/null | head -1)
  [ -n "$TARGET" ] && break
  sleep 0.25
done
[ -z "$TARGET" ] && { echo "找不到目标进程"; exit 1; }

# 等驱动脚本报告「首个思考 token 已到」，只采流式窗口
for _ in $(seq 1 240); do [ -f "$OUT/stream.started" ] && break; sleep 0.25; done
[ -f "$OUT/stream.started" ] || { echo "流式未开始"; exit 1; }
START_TIME=$(ps -o time= -p "$TARGET" | tr -d ' ')
: >"$OUT/cpu.log"
for _ in $(seq 1 $((STREAM_SECS - 4))); do
  ps -o %cpu=,time= -p "$TARGET" >>"$OUT/cpu.log" 2>/dev/null || break
  sleep 1
done
LAST_TIME=$(tail -1 "$OUT/cpu.log" | awk '{print $2}')
wait $DRIVER

AVG=$(awk '{s+=$1;n++} END{printf "%.1f", (n?s/n:0)}' "$OUT/cpu.log")
echo "label=$LABEL rate=${RATE}tok/s think=$THINK text=$TEXT"
echo "流式窗口平均 CPU%: $AVG   采样数: $(wc -l <"$OUT/cpu.log" | tr -d ' ')"
echo "进程 CPU 时间: 流式开始 $START_TIME → 流式结束 $LAST_TIME"
ls "$OUT"/*.md 2>/dev/null | head -1
