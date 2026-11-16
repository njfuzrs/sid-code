#!/bin/bash
# 监控 sid-code 的全部 open PR 合并进度。
# 只在「快照发生变化」时输出一行，避免刷屏；open PR 归零即成功退出。
#
# 出处：触发会话（20261116-goal 空转）里模型自己写的 /tmp/watch-prs.sh 原文，
# 按方案附录 A 的要求把 `cd /Users/zhourusheng/...` 换成 `cd "$REPO"`，其余逐字保持。
# 它正好覆盖三个识别点：`gh pr list`（P1）、`date +%H:%M`（P2）、
# 「monitor 的 command 是文件路径、对象在脚本正文里」（P3）。
cd "$REPO" || exit 1

prev=""
stall=0
while true; do
  raw=$(gh pr list --state open --limit 100 --json number,mergeStateStatus,autoMergeRequest \
    --jq '.[] | "\(.number):\(.mergeStateStatus):\(if .autoMergeRequest then "A" else "-" end)"' 2>/dev/null | sort -n | tr '\n' ' ')
  count=$(gh pr list --state open --limit 100 --json number --jq 'length' 2>/dev/null)
  [ -z "$count" ] && { sleep 60; continue; }

  if [ "$count" = "0" ]; then
    echo "ALL_MERGED: 所有 PR 已合并"
    exit 0
  fi

  if [ "$raw" != "$prev" ]; then
    echo "[$(date +%H:%M)] open=$count $raw"
    prev="$raw"
    stall=0
  else
    stall=$((stall + 1))
  fi

  # 连续 20 轮（约 60 分钟）无任何状态变化 → 报停滞，让我介入排查
  if [ "$stall" -ge 20 ]; then
    echo "STALLED: 连续 60 分钟无状态变化，open=$count $raw"
    stall=0
  fi

  sleep 180
done
