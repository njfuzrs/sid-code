#!/usr/bin/env bash
# scripts/pr-merge-chain.sh —— 把一批已就绪的 PR 按顺序合进 base 分支，人不用守着。
#
# 为什么必须串行：ruleset 开了 strict 必需检查（分支必须与 base 最新才能合），
# 前一个合入后后面的立刻又 BEHIND，需要再 update-branch + 重跑一轮 CI。
# 一次性全部 update 只会白跑 N-1 轮 CI。个人账户仓库用不了 merge queue
# （CONTRIBUTING.md「合并队列用不了」），所以由这个脚本代替队列做「逐个 update → 等绿 → 合」。
#
# 合并本身交给 GitHub 的 auto-merge：脚本只负责挂 auto-merge、update-branch、轮询。
# 这样必需检查的判定仍由 ruleset 做，脚本不自己判「能不能合」，不存在绕过分支保护的路径。
#
# ⚠️ 默认合并方式是 merge 而不是 squash：tag / bisect / changelog 的 --first-parent
#    都依赖它（CONTRIBUTING.md「合并」一节）。已挂了其它方式的 auto-merge 会被改成目标方式。
#
# 停止条件（任一满足即停，不跳过继续合后面的——后面的 PR 可能依赖前面的）：
#   - 某个检查失败 / 取消 / 超时
#   - 与 base 冲突（DIRTY），需要人解决
#   - 单个 PR 等待超时
#   - PR 已关闭或是 draft
#
# 不做的事：不改 PR 内容、不 force push、不关 PR、不删分支（delete_branch_on_merge 由仓库设置负责）。

set -euo pipefail

GH="${GH_BIN:-gh}"
INTERVAL="${PR_MERGE_CHAIN_INTERVAL:-30}"   # 轮询间隔（秒），测试里调小
METHOD="merge"
TIMEOUT_MIN=40
DRY_RUN=0
ALL=0
BASE="main"
PRS=()

usage() {
  cat >&2 <<'EOF'
用法: pr-merge-chain.sh [选项] [PR 号...]

不给 PR 号时等同 --all：处理 base 分支上全部 open 且非 draft 的 PR。

按顺序处理：挂 auto-merge → update branch → 等 CI 绿并自动合入 → 下一个。
任一 PR 的 CI 失败、出现冲突或超时，立即停止（后面的不再处理）。

选项:
  --all             处理 base 分支上全部 open 且非 draft 的 PR（按编号升序；不给 PR 号时的默认行为）
  --base <分支>     取全部 PR 时的 base 分支（默认 main）
  --method <方式>   merge | squash | rebase（默认 merge）
  --timeout <分钟>  单个 PR 最长等待时间（默认 40）
  --dry-run         只打印每个 PR 的当前状态和将要做的事，不做任何修改
  -h, --help        显示帮助

在目标仓库的任意目录下运行即可（仓库由 gh 按当前目录识别，也可设 GH_REPO=owner/repo）。

示例:
  bun run pr:merge-chain                  # 合 main 上全部就绪 PR
  bun run pr:merge-chain --dry-run        # 只看状态，不做修改
  bun run pr:merge-chain 214 215 218      # 只合指定的几个
EOF
}

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "✗ $*" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) ALL=1 ;;
    --base) BASE="${2:?--base 需要分支名}"; shift ;;
    --method) METHOD="${2:?--method 需要取值}"; shift ;;
    --timeout) TIMEOUT_MIN="${2:?--timeout 需要分钟数}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; die "未知选项: $1" ;;
    *)
      [[ "$1" =~ ^#?[0-9]+$ ]] || die "PR 号必须是数字: $1"
      PRS+=("${1#\#}") ;;
  esac
  shift
done

case "$METHOD" in merge|squash|rebase) ;; *) die "--method 只能是 merge / squash / rebase" ;; esac
[[ "$TIMEOUT_MIN" =~ ^[0-9]+$ && "$TIMEOUT_MIN" -gt 0 ]] || die "--timeout 必须是正整数"
command -v "$GH" >/dev/null 2>&1 || die "找不到 gh CLI（https://cli.github.com）"

# 不给 PR 号即取全部：日常用法就是「把就绪的都合了」，每次补 --all 是纯摩擦。
# 安全性不靠「必须显式 --all」兜：每个 PR 仍要过 ruleset 必需检查，失败即停。
if [[ $ALL -eq 1 ]]; then
  [[ ${#PRS[@]} -eq 0 ]] || die "--all 与显式 PR 号不能同时使用"
fi
if [[ ${#PRS[@]} -eq 0 ]]; then
  while IFS= read -r n; do [[ -n "$n" ]] && PRS+=("$n"); done < <(
    "$GH" pr list --base "$BASE" --state open --limit 100 \
      --json number,isDraft -q '[.[]|select(.isDraft|not)|.number]|sort|.[]'
  )
  [[ ${#PRS[@]} -gt 0 ]] || { log "base=$BASE 上没有 open 的非 draft PR"; exit 0; }
fi

# 方式名在 gh 命令行是小写，在 API 返回里是大写
METHOD_UPPER="$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')"

# 一次查询拿全部判据，输出一行 TSV：
#   state  isDraft  mergeStateStatus  autoMergeMethod  失败检查数  标题
# 检查有两类：CheckRun 看 conclusion，StatusContext 看 state。
# 失败判据是黑名单之外的「明确失败」集合；pending 不算失败，继续等。
pr_status() {
  "$GH" pr view "$1" --json state,isDraft,mergeStateStatus,autoMergeRequest,statusCheckRollup,title -q '
    [ .state,
      (.isDraft|tostring),
      .mergeStateStatus,
      (.autoMergeRequest.mergeMethod // "NONE"),
      ([.statusCheckRollup[]? | (.conclusion // .state // "")
        | select(. == "FAILURE" or . == "ERROR" or . == "CANCELLED"
                 or . == "TIMED_OUT" or . == "STARTUP_FAILURE" or . == "ACTION_REQUIRED")]
        | length | tostring),
      .title ] | @tsv'
}

ensure_auto_merge() {
  local n="$1" current="$2"
  [[ "$current" == "$METHOD_UPPER" ]] && return 0
  if [[ "$current" != "NONE" ]]; then
    log "  #$n 已挂 auto-merge（${current}），改为 $METHOD_UPPER"
    "$GH" pr merge "$n" --disable-auto >/dev/null
  fi
  # PR 已经 CLEAN 时 --auto 会直接合入，这正是想要的
  "$GH" pr merge "$n" --auto "--$METHOD" >/dev/null
  log "  #$n 已挂 auto-merge（${METHOD_UPPER}）"
}

update_branch() {
  local out
  out="$("$GH" pr update-branch "$1" 2>&1)" || { log "  #$1 update-branch 失败: $out"; return 1; }
  log "  #$1 ${out##*$'\n'}"
}

# ---- dry-run：只报告 ----
if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run，按顺序将处理 ${#PRS[@]} 个 PR（合并方式 ${METHOD_UPPER}）："
  for n in "${PRS[@]}"; do
    IFS=$'\t' read -r state draft mss auto failed title < <(pr_status "$n")
    plan="挂 auto-merge → 等 CI → 合入"
    [[ "$state" == "MERGED" ]] && plan="已合入，跳过"
    [[ "$state" == "CLOSED" ]] && plan="已关闭，会停在这里"
    [[ "$draft" == "true" ]] && plan="draft，会停在这里"
    [[ "$mss" == "DIRTY" ]] && plan="有冲突，会停在这里"
    [[ "$failed" != "0" ]] && plan="已有 $failed 个检查失败，会停在这里"
    log "  #$n [$state/$mss auto=$auto] $title —— $plan"
  done
  exit 0
fi

# ---- 正式执行 ----
[[ "$INTERVAL" =~ ^[0-9]+$ ]] || die "PR_MERGE_CHAIN_INTERVAL 必须是非负整数"
# 按轮询次数而不是墙钟计超时：间隔为 0（测试）时也能确定性地停下
deadline_polls=$(( TIMEOUT_MIN * 60 / (INTERVAL > 0 ? INTERVAL : 1) ))
merged=()

for n in "${PRS[@]}"; do
  IFS=$'\t' read -r state draft mss auto failed title < <(pr_status "$n")
  log "== #$n $title"
  [[ "$state" == "MERGED" ]] && { log "  已合入，跳过"; merged+=("$n"); continue; }
  [[ "$state" == "OPEN" ]] || die "#$n 状态是 ${state}，停止" 2
  [[ "$draft" == "false" ]] || die "#$n 是 draft，停止" 2

  ensure_auto_merge "$n" "$auto"
  last_mss=""
  for (( i = 0; i < deadline_polls; i++ )); do
    IFS=$'\t' read -r state draft mss auto failed title < <(pr_status "$n")
    [[ "$mss" != "$last_mss" ]] && log "  #$n 状态 $state / $mss"
    last_mss="$mss"

    if [[ "$state" == "MERGED" ]]; then merged+=("$n"); log "  ✓ #$n 已合入"; break; fi
    [[ "$state" == "OPEN" ]] || die "#$n 变成了 ${state}，停止" 2
    [[ "$failed" == "0" ]] || die "#$n 有 $failed 个检查失败，停止（gh pr checks $n 查看）" 3
    case "$mss" in
      DIRTY) die "#$n 与 base 冲突，需要手动解决后重跑" 3 ;;
      BEHIND) update_branch "$n" || die "#$n 无法更新分支，停止" 3 ;;
    esac
    # auto-merge 可能被别人取消，或在 PR 有新提交后被 GitHub 自动解除
    [[ "$auto" == "$METHOD_UPPER" ]] || ensure_auto_merge "$n" "$auto"
    sleep "$INTERVAL"
  done
  [[ "$state" == "MERGED" ]] || die "#$n 等待超过 ${TIMEOUT_MIN} 分钟仍未合入，停止" 4
done

log "全部完成，共合入 ${#merged[@]} 个：${merged[*]/#/#}"
