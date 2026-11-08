#!/usr/bin/env bash
# 逐项监控 PR 的 CI 检查：每个检查从 pending 变成终态时打一行，
# 全部终态后打 ALL_DONE 并退出（退出码 = 是否全部通过）。
#
# 用法：scripts/watch-pr-checks.sh <pr-number> [interval-seconds]
#
# 这是给 monitor 工具用的示例脚本（设计与用法见
# docs-research/sid-code/bugfixes/todo/20261108-等待外部状态-合法等待态与Monitor工具-设计方案.md §5.4.9）。
# 它是 **sid-code 仓库自己的**便利脚本，不是 monitor 正常工作的前提——
# 用户的项目里没有它，工具描述里给的是内联写法。
#
# 三条硬约束（模型现场写 monitor 脚本最容易错的地方，这里都规避了）：
# 1. **沉默不等于成功**：exit 分支覆盖其他终态（fail/cancel），不是只 grep pass；
# 2. **单次请求失败不让脚本退出**：`gh` 失败时 sleep 后重试（`|| { sleep; continue; }`）；
# 3. **逐行刷新**：每次循环的 echo 都是一行，父进程按行切成事件（不需要 flush 处理）。
set -u

pr="${1:?用法: $0 <pr-number> [interval-seconds]}"
interval="${2:-45}"
prev=""

while true; do
  # gh 失败（网络 / 未登录）不是终态：跳过这一轮，下一轮再试
  s=$(gh pr checks "$pr" --json name,bucket 2>/dev/null) || { sleep "$interval"; continue; }

  # 已到终态的检查（bucket != pending），排序后与上一轮做差集 → 本轮新完成的
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
  comm -13 <(printf '%s\n' "$prev") <(printf '%s\n' "$cur")
  prev="$cur"

  # 全部终态 → 打 ALL_DONE 并退出（退出码 0 = 全绿，1 = 有失败/取消）
  if jq -e 'length>0 and all(.bucket!="pending")' <<<"$s" >/dev/null; then
    if jq -e 'all(.bucket=="pass" or .bucket=="skipping")' <<<"$s" >/dev/null; then
      echo "ALL_DONE: pass"
      exit 0
    fi
    echo "ALL_DONE: fail"
    exit 1
  fi

  sleep "$interval"
done
