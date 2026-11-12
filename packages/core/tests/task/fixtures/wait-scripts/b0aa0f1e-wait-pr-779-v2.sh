#!/bin/bash
# 等待 PR #779 的 CI + auto-merge 结果（REST 轮询，不用 graphql）
# 注意：PR head 会被 auto-update-branch 改动，必须从 PR API 取 head 再查 check-runs
set -u
REPO=njfuzrs/sid-code
PR=779

for i in $(seq 1 80); do
  json=$(gh api "repos/$REPO/pulls/$PR" 2>/dev/null) || json=""
  if [ -z "$json" ]; then
    echo "[$(date +%H:%M:%S)] API 失败，30s 后重试"
    sleep 30
    continue
  fi
  merged=$(printf '%s' "$json" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("merged"))')
  state=$(printf '%s' "$json" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("state"))')
  mstate=$(printf '%s' "$json" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("mergeable_state"))')
  head=$(printf '%s' "$json" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["head"]["sha"])')
  echo "[$(date +%H:%M:%S)] merged=$merged state=$state mergeable=$mstate head=${head:0:8}"
  if [ "$merged" = "True" ]; then
    echo "MERGED_OK head=$head"
    exit 0
  fi
  if [ "$state" = "closed" ]; then
    echo "CLOSED_WITHOUT_MERGE"
    exit 1
  fi
  concl=$(gh api "repos/$REPO/commits/$head/check-runs" \
    -q '[.check_runs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out")] | length' 2>/dev/null) || concl=""
  if [ -n "$concl" ] && [ "$concl" != "0" ]; then
    echo "CHECKS_FAILED count=$concl head=$head"
    exit 1
  fi
  sleep 30
done
echo "TIMEOUT_WAITING"
exit 2
