#!/bin/bash
# 等待 PR #779 的 CI + auto-merge 结果（REST 轮询，不用 graphql）
set -u
REPO=njfuzrs/sid-code
PR=779
WT=/Users/zhourusheng/Code/person/sid-code/.sid-code/worktrees/deprecated-params-schema

for i in $(seq 1 60); do
  info=$(gh api "repos/$REPO/pulls/$PR" -q '[.merged, .state, .mergeable_state] | @tsv' 2>/dev/null) || info=""
  if [ -z "$info" ]; then
    echo "[$(date +%H:%M:%S)] API 失败，30s 后重试"
    sleep 30
    continue
  fi
  echo "[$(date +%H:%M:%S)] merged/state/mergeable: $info"
  case "$info" in
    true*)
      echo "MERGED_OK"
      exit 0
      ;;
  esac
  head=$(git -C "$WT" rev-parse HEAD 2>/dev/null)
  concl=$(gh api "repos/$REPO/commits/$head/check-runs" \
    -q '[.check_runs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out")] | length' 2>/dev/null) || concl=""
  if [ -n "$concl" ] && [ "$concl" != "0" ]; then
    echo "CHECKS_FAILED count=$concl"
    exit 1
  fi
  sleep 30
done
echo "TIMEOUT_WAITING"
exit 2
