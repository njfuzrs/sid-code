#!/bin/bash
# 等 PR #757 真正合并（或 CI 失败）。REST 轮询，容忍 head 被 auto-update 反复更新。
set -u
REPO=njfuzrs/sid-code
PR=757
DEADLINE=$(( $(date +%s) + 3000 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  json=$(gh api "repos/$REPO/pulls/$PR" 2>/dev/null)
  if [ -z "$json" ]; then echo "[$(date +%H:%M:%S)] 查询失败，30s 重试"; sleep 30; continue; fi
  state=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))')
  merged=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("merged",False))')
  head=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("head",{}).get("sha",""))')
  ms=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mergeable_state",""))')
  if [ "$state" = "closed" ]; then
    echo "PR closed merged=$merged head=${head:0:8}"
    if [ "$merged" = "True" ]; then echo "RESULT=MERGED"; exit 0; fi
    echo "RESULT=CLOSED_NOT_MERGED"; exit 1
  fi
  summary=$(gh api "repos/$REPO/commits/$head/check-runs" --jq '[.check_runs[] | {name:.name,status:.status,conclusion:.conclusion}] | @json' 2>/dev/null | python3 -c '
import json,sys
try: rs=json.load(sys.stdin)
except Exception: print("PARSE_FAIL"); raise SystemExit
bad=[r for r in rs if r["conclusion"] in ("failure","cancelled","timed_out","action_required")]
pend=[r for r in rs if r["status"]!="completed"]
print("bad=%d pending=%d total=%d" % (len(bad),len(pend),len(rs)))
for r in bad: print("BAD %s: %s" % (r["name"], r["conclusion"]))
' 2>/dev/null)
  echo "[$(date +%H:%M:%S)] head=${head:0:8} state=$ms $summary"
  if printf '%s' "$summary" | grep -q "bad=[1-9]"; then echo "RESULT=CI_FAILED"; exit 1; fi
  sleep 30
done
echo "RESULT=TIMEOUT"
exit 2
