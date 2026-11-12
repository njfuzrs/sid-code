#!/bin/bash
# 等待 PR #757 的 CI 结论（REST 轮询，避免 graphql EOF 与 gh run watch 的假完成）
set -u
REPO=njfuzrs/sid-code
PR=757
DEADLINE=$(( $(date +%s) + 2400 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  head=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha' 2>/dev/null)
  state=$(gh api "repos/$REPO/pulls/$PR" --jq '.state' 2>/dev/null)
  if [ -z "$head" ]; then
    echo "[$(date +%H:%M:%S)] 查询失败（网络），30s 后重试"
    sleep 30
    continue
  fi
  if [ "$state" = "closed" ]; then
    merged=$(gh api "repos/$REPO/pulls/$PR" --jq '.merged' 2>/dev/null)
    echo "[$(date +%H:%M:%S)] PR 已关闭，merged=$merged"
    if [ "$merged" = "true" ]; then echo "RESULT=MERGED"; exit 0; fi
    echo "RESULT=CLOSED_NOT_MERGED"; exit 1
  fi
  runs=$(gh api "repos/$REPO/commits/$head/check-runs" --jq '[.check_runs[] | {name: .name, status: .status, conclusion: .conclusion}] | @json' 2>/dev/null)
  summary=$(printf '%s' "$runs" | python3 -c '
import json,sys
try: rs=json.load(sys.stdin)
except Exception: print("PARSE_FAIL"); sys.exit(0)
bad=[r for r in rs if r["conclusion"] in ("failure","cancelled","timed_out","action_required")]
pend=[r for r in rs if r["status"] != "completed"]
print("bad=%d pending=%d total=%d" % (len(bad), len(pend), len(rs)))
if bad: print("BAD: " + ", ".join("%s:%s" % (r["name"], r["conclusion"]) for r in bad))
' 2>/dev/null)
  echo "[$(date +%H:%M:%S)] head=${head:0:8} $summary"
  if printf '%s' "$summary" | grep -q "bad=[1-9]"; then echo "RESULT=CI_FAILED"; printf '%s\n' "$summary" | grep "^BAD:"; exit 1; fi
  if printf '%s' "$summary" | grep -q "pending=0 total=[1-9]"; then
    # 检查是否已合并（绿了自动合，可能需几秒）
    sleep 10
    state2=$(gh api "repos/$REPO/pulls/$PR" --jq '.state' 2>/dev/null)
    if [ "$state2" = "closed" ]; then echo "RESULT=MERGED"; exit 0; fi
    echo "RESULT=CI_GREEN_NOT_MERGED（可能 BEHIND，等 auto-update）"
    exit 0
  fi
  sleep 30
done
echo "RESULT=TIMEOUT"
exit 2
