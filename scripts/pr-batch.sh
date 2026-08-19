#!/usr/bin/env bash
# scripts/pr-batch.sh —— 一份方案拆多个 PR 时的并行编排调度器。
#
# 设计原则：**它不理解代码，只做机械调度 + 守卫**。
# 冲突判定不在这里（那是分层阶段的事），这里只负责建环境、查状态、清现场。
#
# 方法论出处：docs-research/sid-code/bugfixes/todo/一个方案多个PR的并行编排方法论.md
#   §5.2 脚本设计 / §5.4 执行序列 / §11 首次试跑指南
#
# ⚠️ 核心设计：**状态派生，不维护**。
#    这个脚本不存任何「当前状态」——PR 开没开、合没合、CI 绿不绿、能不能清理，
#    全部每次现查（gh + git）。status/*.json 只存不可派生的东西（id / layer / dir）。
#    理由：PR 状态在 GitHub 上变化，**不经过这个脚本**，没有任何时机可以挂钩去更新。
#    存了快照就必须回答「谁更新、何时更新、两处不一致听谁的」—— 那三个问题无解。
#    上一版存了 state:"ready"，结果 PR 合并后 list 还显示 ready，直接误导用户。
#    同源教训：CLAUDE.md「区分 stock 与 flow」——末次快照值回答不了「现在怎样」。
#
# ⛔ 铁律：这个脚本**永不**执行 rm -rf / git clean / git reset --hard / git checkout --。
#    仓库随时有多个任务并行，删错一个文件的代价是别人几小时的工作凭空消失
#    （CLAUDE.md，2026-07-28 真实事故）。cleanup 只用 git worktree remove，
#    且要三条证据同时成立才判「可删」，默认还只报告、--force 才真删。

set -euo pipefail

usage() {
  echo "用法: pr-batch.sh <子命令> ..." >&2
  echo "  prepare <layer> <id>:<branch>...  建 worktree + bun install + 下发权限" >&2
  echo "  list                             ⭐ 各路当前状态 + 建议的下一步（全部现查）" >&2
  echo "  open [--yolo|--fresh] <路>        开会话（脚本替你 cd + 喂 prompt）" >&2
  echo "  derived                          ⭐ 派生问题（分叉）核算：撞不撞未做的 PR、方案文档回流" >&2
  echo "  reflow <issue> [--synced]        生成方案文档修正块 / 标记已回流" >&2
  echo "  cleanup [--force]                清理已合并的 worktree（默认只报告）" >&2
  echo "  reperm [路...]                   重新下发权限模板到已存在的 worktree" >&2
  echo "  unlock <路>                      清掉陈旧锁（会话崩了但锁还在时）" >&2
  echo "  check-gen                        在 worktree 里跑：判是否改到生成物" >&2
  echo >&2
  echo "「路」可以写 id（PR11）、完整目录名、或唯一片段（catalog）。" >&2
  echo >&2
  echo "open 的开关:" >&2
  echo "  --yolo    全免确认（bypassPermissions）。⚠️ agent 可能自己 merge PR" >&2
  echo "  --fresh   忽略历史会话，从零开始（默认会 -c 续上次）" >&2
  echo >&2
  echo "在仓库根目录跑，不需要手动 cd 到 worktree。" >&2
  echo "状态一律现查（gh + git），不存快照 —— 所以 list 永远不会显示过期状态。" >&2
}

# slug 的模糊匹配：允许只敲一个能唯一确定的片段。
# ⚠️ 匹配到多个时报错而不是猜 —— 猜错的后果是「在错误的 worktree 里开了会话」，
#    而那会让两路改到同一份文件，整套隔离白做。
resolve_slug() {
  local q="$1" hits=()
  shopt -s nullglob
  for d in "$WT_BASE"/*; do
    [[ -d "$d" ]] || continue
    local name; name="$(basename "$d")"
    # 只在本次编排登记过的目录里找（.pr-batch/status/ 是登记表），
    # 否则会匹配到 agent-xxx 那些历史残留 worktree。
    [[ -f "$STATUS_DIR/${name}.json" ]] || continue

    # 允许用 id（PR11）指代 —— 那是跨系统唯一不变的锚点，人也更愿意敲它。
    # ⚠️ id 精确匹配优先于目录名模糊匹配：`PR1` 不应该模糊命中 `PR11`。
    local rid; rid="$(jq -r '.id // ""' "$STATUS_DIR/${name}.json" 2>/dev/null || true)"
    if [[ -n "$rid" ]] && [[ "$(printf '%s' "$q" | tr 'a-z' 'A-Z')" == "$(printf '%s' "$rid" | tr 'a-z' 'A-Z')" ]]; then
      echo "$name"; return 0
    fi

    [[ "$name" == "$q" ]] && { echo "$name"; return 0; }
    [[ "$name" == *"$q"* ]] && hits+=("$name")
  done
  shopt -u nullglob

  case ${#hits[@]} in
    1) echo "${hits[0]}"; return 0 ;;
    0) echo "找不到匹配 '$q' 的 worktree。先跑 prepare，或用 list 看可选项。" >&2; return 1 ;;
    *) echo "'$q' 匹配到多个，请写得更具体：" >&2
       printf '  %s\n' "${hits[@]}" >&2; return 1 ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════
# 状态派生（不维护，每次现算）
#
# ⚠️ 设计决定：**一个字节的状态都不存**。
#    前一版把 state:"ready" 写进 status/*.json，于是必须回答「谁更新、何时更新、
#    更新失败怎么办、两处不一致听谁的」—— 这四个问题都无解，因为 PR 状态
#    在 GitHub 上变化，**不经过这个脚本**，没有任何时机可以挂钩。
#    所以真值一律现查。status/*.json 只存**不可派生**的东西（layer / id / branch）。
#    同源教训：CLAUDE.md「区分 stock 与 flow」——
#    末次快照值回答不了「当前怎样」这个问题。
# ═══════════════════════════════════════════════════════════════════

# 读一个 worktree 的真实分支名。
# ⚠️ 必须现读，不能从目录名推、也不信 plan.json 里存的那份。实测本机：
#    目录 ci-pr-base-change-trigger 的分支是 docs/contributing-eval-pr-smoke-trigger-drift
#    —— 毫无关系。而 PR#63 的分支也已被 agent 改成了与方案文档不同的名字。
wt_branch() { git -C "$1" branch --show-current 2>/dev/null || true; }

# 查一个分支对应的 PR，输出制表符分隔：number, state, mergeCommitOid, ciRollup
# 查不到输出空行。⚠️ gh 不可用时也输出空行，由调用方降级（不是静默当成"无 PR"）。
pr_for_branch() {
  local br="$1"
  [[ -n "$br" ]] || { echo; return; }
  # ⚠️ `.[0] | ...` 在无匹配时 .[0] 是 null，会输出 "null<TAB><TAB><TAB>PENDING"
  #    —— 那会被下游当成一个真实存在的 PR。用 `if . == null then empty` 先挡掉。
  gh pr list --state all --head "$br" --limit 1 \
     --json number,state,mergeCommit,statusCheckRollup \
     --jq 'if (.|length) == 0 then empty else .[0] | [
             (.number|tostring),
             .state,
             (.mergeCommit.oid // ""),
             # ⚠️ 未完成的检查 conclusion 是**空字符串**而不是 null（实测 PR#63：
             #    {"conclusion":"","status":"QUEUED"}）。只判 `!= null` 会把排队中的
             #    检查当成结论，一律算成 FAILING —— 实测踩过，PR#63 明明 pending 却报红。
             ([.statusCheckRollup[]? | select((.conclusion // "") != "") | .conclusion]
               as $done
               | ([.statusCheckRollup[]?] | length) as $total
               | if $total == 0 then "NO-CI"
                 elif ($done | map(select(. != "SUCCESS" and . != "NEUTRAL" and . != "SKIPPED")) | length) > 0
                   then "FAILING"
                 elif ($done | length) < $total then "PENDING"
                 else "SUCCESS" end)
           ] | @tsv end' 2>/dev/null || echo
}

# 把制表符分隔的一行拆进指定变量，**保留空字段**。
# ⚠️ 不能用 `IFS=$'\t' read -r a b c d` —— 它把连续制表符当一个分隔符，
#    于是 "63\tOPEN\t\tPENDING"（mergeCommit 为空）会被读成 c=PENDING d=空，
#    整行右移一列。实测踩过：list 里 CI 列显示 "-" 而不是 PENDING。
split_tsv() {
  local line="$1"; shift
  local -a vals=()
  while IFS= read -r part; do vals+=("$part"); done < <(printf '%s\n' "$line" | tr '\t' '\n')
  local i=0 name
  for name in "$@"; do
    # printf -v 在 bash 3.2（macOS 自带）上不支持，用 read -r 赋值到 nameref 也不支持，
    # 所以这里用 eval —— 变量名来自本脚本内部的字面量，不是外部输入。
    eval "$name=\"\${vals[$i]:-}\""
    i=$((i + 1))
  done
}

# ── 派生问题（分叉）────────────────────────────────────────────
#
# 交付过程中会派生新问题（首次试跑：PR#63 派生 #64/#65）。这一层解决三件事：
#   ① 它们进不进编排视野（原来只活在 GitHub 上，不翻 issue 列表就看不见）
#   ② 它们会不会让**已算好的分层失效**（#64 改 gateway-pricing.ts，方案 PR12 也改它）
#   ③ 推翻方案文档描述的发现有没有回流（否则错描述一直骗下一个人）
#
# ⚠️ 同样是**状态派生不维护**：issue 现查 gh、PR 足迹现读方案文档、
#    「已回流」用 GitHub 标签（权威在 GitHub，不在本地 JSON）。

DERIVED_LIB="scripts/lib/pr-batch-derived.ts"
SYNCED_LABEL="plan-doc-synced"

# 现查本批 PR 派生出的 issue。
# ⚠️ 靠「issue 正文里指回本批的 PR 号」搜，而不是靠标签 —— 标签要人记得打，
#    而指回 PR 是 fork-protocol 强制的必填项，且 review 时肉眼就能核。
#    多个 PR 号用 OR 拼一次查询，避免 N 次 gh 调用（每次约 1s）。
derived_issues_json() {
  local nums=("$@") q=""
  [[ ${#nums[@]} -ge 1 ]] || { echo '[]'; return; }
  for n in "${nums[@]}"; do
    [[ -n "$n" ]] || continue
    q+="\"PR #${n}\" OR "
  done
  q="${q% OR }"
  [[ -n "$q" ]] || { echo '[]'; return; }
  # in:body 限定只搜正文 —— 标题里出现 "PR #63" 的多半是别的东西。
  gh issue list --state all --limit 100 --search "${q} in:body" \
     --json number,title,body,state,labels \
     --jq '[.[] | {number, title, body, state, labels: [.labels[].name]}]' 2>/dev/null \
    || echo '[]'
}

# 组装 derived 核算的输入。抽成函数是因为 derived 与 list 都要用。
derived_payload() {
  local plan_json=".pr-batch/plan.json"
  local plan_doc_path="" plan_doc_json="null"

  # 方案文档路径来自 plan.json 的 _plan（相对 docs-research 仓库根，也可能是绝对路径）
  if [[ -f "$plan_json" ]]; then
    plan_doc_path="$(jq -r '._plan // ""' "$plan_json" 2>/dev/null || true)"
  fi
  # _plan 通常写成相对路径（docs-research/sid-code/...），试几个候选前缀。
  # ⚠️ 找不到时**不静默跳过** —— 传 planDoc=null，核算层会显式告警说「没算过」。
  local resolved=""
  resolved="$(resolve_plan_doc "$plan_doc_path")"
  [[ -n "$resolved" ]] && plan_doc_json="$(jq -Rs . < "$resolved")"

  # 本批的 id 与 PR 号/状态
  local ids='[]' batch_prs='[]' pr_nums=()
  shopt -s nullglob
  local f
  for f in "$STATUS_DIR"/*.json; do
    local dir id br
    dir="$(basename "$f" .json)"
    id="$(jq -r '.id // ""' "$f")"
    [[ -n "$id" ]] || continue
    ids="$(jq -c --arg i "$id" '. + [$i]' <<<"$ids")"
    br="$(wt_branch "$WT_BASE/$dir")"
    # worktree 已删时分支读不到，回落到登记值 —— 这里只用于查 PR 号，不做判定
    [[ -n "$br" ]] || br="$(jq -r '.branch_at_prepare // ""' "$f")"
    local pn ps mo ci
    split_tsv "$(pr_for_branch "$br")" pn ps mo ci
    batch_prs="$(jq -c --arg i "$id" --arg n "${pn:-}" --arg s "${ps:-}" \
      '. + [{id: $i, number: (if $n == "" then null else ($n|tonumber) end), state: (if $s == "" then null else $s end)}]' \
      <<<"$batch_prs")"
    [[ -n "${pn:-}" ]] && pr_nums+=("$pn")
  done
  shopt -u nullglob

  local issues merged repo_files
  issues="$(derived_issues_json "${pr_nums[@]+"${pr_nums[@]}"}")"
  # 一次拿全部已合并分支，避免逐个 PR 查
  merged="$(gh pr list --state merged --limit 200 --json headRefName \
              --jq '[.[].headRefName]' 2>/dev/null || echo '[]')"
  repo_files="$(git ls-files '*.ts' | jq -Rsc 'split("\n") | map(select(length > 0))')"

  jq -nc \
    --argjson issues "$issues" \
    --argjson planDoc "$plan_doc_json" \
    --arg planDocPath "${resolved:-$plan_doc_path}" \
    --argjson batchPrIds "$ids" \
    --argjson batchPrs "$batch_prs" \
    --argjson mergedBranches "$merged" \
    --argjson repoFiles "$repo_files" \
    '{issues: $issues, planDoc: $planDoc, planDocPath: $planDocPath,
      batchPrIds: $batchPrIds, batchPrs: $batchPrs,
      mergedBranches: $mergedBranches, repoFiles: $repoFiles}'
}

# 判「这一路可以清理了吗」，回显 判定<TAB>理由。
# 三条证据必须同时成立 —— 少任何一条都可能删掉真的工作。
cleanable() {
  local dir="$1" br="$2" pr_state="$3" merge_oid="$4" pr_num_for_cleanable="${5:-}"
  local wt="$WT_BASE/$dir"

  # 证据 1：PR 已 MERGED，且 mergeCommit 确实在 main 上。
  # ⚠️ 不能用 `git merge-base --is-ancestor origin/<branch> origin/main` ——
  #    本仓用 squash merge，squash 后**分支 SHA 不在 main 的祖先链里**，
  #    那条判据会永远返回「未合入」。实测：PR#34 四天前就合了，
  #    旧 cleanup 至今说它「有未合入提交」→ worktree 永不被清理。
  #    那 3.9G 不是「人忘了清」，是判据本身错了。
  [[ "$pr_state" == "MERGED" ]] || { printf 'NO\tPR 未合并（%s）\n' "${pr_state:-无 PR}"; return; }
  [[ -n "$merge_oid" ]] || { printf 'NO\t%s\n' "PR 标记 MERGED 但拿不到 mergeCommit"; return; }
  git merge-base --is-ancestor "$merge_oid" origin/main 2>/dev/null \
    || { printf 'NO\tmergeCommit %s 不在 origin/main 上\n' "${merge_oid:0:8}"; return; }

  # 证据 2：工作区干净。
  # ⚠️ -unormal 而不是 -uno：untracked 文件同样是别人的在途工作。
  #    本仓 worktree GC 曾用 -uno 跳过 untracked，误删了未 git add 的工作。
  local dirty; dirty="$(git -C "$wt" status --porcelain -unormal 2>/dev/null | head -1 || true)"
  [[ -z "$dirty" ]] && : || { printf 'NO\t有未提交改动: %s\n' "$dirty"; return; }

  # 证据 3：没有「不在这个 PR 里」的提交。
  # 场景：PR 合并后你又在 worktree 里改了东西并 commit（比如 review 反馈），
  # 那部分不在 mergeCommit 里，删了就真丢了。
  #
  # ⚠️ 做法是「本地提交 SHA 集合 − PR 的提交 SHA 集合」，**不能用 git cherry**。
  #    cherry 按 patch-id 比较，能识别 rebase（1→1 映射），但**识别不了 squash**：
  #    squash 把 N 个提交压成 1 个，N 个原始 patch-id 在 main 上都找不到对应，
  #    于是全部被标成 `+`（未合入）。
  #    实测：PR#19 的 3 个提交明明都在 PR 里且已合并，cherry 却报 3 个 `+` ——
  #    那是**假阴性**，会让已完成的 worktree 永远无法清理（3.9G 的另一半来源）。
  #    而 gh 给的 .commits[].oid 就是这个 PR 收录的原始提交 SHA，比对它才准。
  local pr_shas local_shas extra
  pr_shas="$(gh pr view "$pr_num_for_cleanable" --json commits --jq '.commits[].oid' 2>/dev/null | sort || true)"
  local_shas="$(git -C "$wt" rev-list origin/main.. 2>/dev/null | sort || true)"
  if [[ -z "$pr_shas" ]]; then
    printf 'NO\t%s\n' "拿不到 PR 的提交列表，无法确认本地提交都进了 PR"; return
  fi
  extra="$(comm -23 <(printf '%s\n' "$local_shas") <(printf '%s\n' "$pr_shas") | grep -v '^$' | head -1 || true)"
  [[ -z "$extra" ]] || { printf 'NO\t有未进 PR 的提交: %s\n' "${extra:0:12}"; return; }

  printf 'YES\tPR 已合入 main，工作区干净，无 PR 外提交\n'
}

# ⚠️ 不用 ${1:?...} 带默认提示语 —— 提示语里的 } 会提前终止参数展开，
#    实测症状是 "未知子命令: status ...}"（提示语的尾部被当成了 $1 的一部分）。
[[ $# -ge 1 ]] || { usage; exit 1; }
CMD="$1"
shift

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

WT_BASE=".claude/worktrees"
STATUS_DIR=".pr-batch/status"
SETTINGS_TEMPLATE=".pr-batch/worktree-settings.template.json"

# ── 需求文档仓库（docs-research）的位置 ────────────────────────────
# ⚠️ 这三个变量存在的唯一理由：**入库的文件里不许出现任何人的家目录**。
#    模板与 prompt 都要进 git（见 .gitignore 的 .pr-batch 段），
#    而它们原先写死了作者的家目录绝对路径 —— 换台机器不报错，
#    只是权限模板整个失效、变成一直问你确认，属于「绿了但没生效」那一类
#    （同源：记忆里 explicit-undefined-punches-through-defaults）。
#    所以入库文件里一律写 $DOCS_ROOT / $REPO_ROOT / $HOME 占位符，喂给
#    claude / 写进 worktree 之前才由本脚本展开成绝对路径。
# 覆盖方式：export PR_BATCH_DOCS_ROOT=/path/to/docs-research
DOCS_ROOT="${PR_BATCH_DOCS_ROOT:-}"
if [[ -z "$DOCS_ROOT" ]]; then
  # 两个候选，与 derived_payload 的候选链同源：先找 sid-code 的兄弟目录
  #（clone 到任何位置都成立），再退回作者本机的固定布局。
  for cand in "$(dirname "$REPO_ROOT")/docs-research" "$HOME/Code/person/docs-research"; do
    [[ -d "$cand" ]] && { DOCS_ROOT="$cand"; break; }
  done
fi

# 把入库文件里的占位符展开成本机绝对路径。
# ⚠️ 只展开这三个，且用 | 作分隔符 —— 路径里必然含 /，用 / 当分隔符会当场炸。
# ⚠️ DOCS_ROOT 为空时**不替换**，让占位符原样留在输出里。理由：一个显眼的
#    `$DOCS_ROOT/...` 路径会让 agent 立刻报「读不到这个文件」，而替换成空串
#    得到的 `/sid-code/bugfixes/...` 是个看着像绝对路径的死路 —— 那是静默失败。
expand_paths() {
  local s
  s="$(cat)"
  s="${s//\$REPO_ROOT/$REPO_ROOT}"
  s="${s//\$HOME/$HOME}"
  [[ -n "$DOCS_ROOT" ]] && s="${s//\$DOCS_ROOT/$DOCS_ROOT}"
  printf '%s' "$s"
}

# 把 plan.json 的 _plan 字段解析成本机可读的绝对/相对路径；找不到时输出空串。
# ⚠️ 抽成函数是因为 derived 与 reflow 各有一份候选链拷贝，改一处漏一处。
# ⚠️ 找不到时**不报错、不猜** —— 调用方各自决定怎么降级（derived 传 null 让核算层
#    显式告警「没算过」，reflow 打印手工路径）。静默编一个路径出来更糟。
resolve_plan_doc() {
  local p="$1" cand
  [[ -n "$p" ]] || return 0
  # _plan 有两种写法：带 docs-research/ 前缀的仓库相对路径，或裸的仓内路径，
  # 所以每个根都要试两种拼法。$DOCS_ROOT 优先（可由 PR_BATCH_DOCS_ROOT 覆盖）。
  for cand in "$p" \
              "${DOCS_ROOT:+$DOCS_ROOT/${p#docs-research/}}" \
              "${DOCS_ROOT:+$DOCS_ROOT/$p}" \
              "../docs-research/$p" \
              "$(dirname "$REPO_ROOT")/docs-research/${p#docs-research/}"; do
    [[ -n "$cand" && -f "$cand" ]] && { printf '%s' "$cand"; return 0; }
  done
}

case "$CMD" in

prepare) # prepare <layer> <slug>...
  [[ $# -ge 2 ]] || { echo "用法: prepare <layer> <slug>..." >&2; exit 1; }
  layer="$1"
  shift

  # ⚠️ 层内路数守卫：落地清单第 11 项（合并队列 + all-ci-passed 汇聚门）没做之前，
  #    G1（判据管不到语义冲突）的唯一对策是「合并后在 main 上跑门禁 + revert」。
  #    路数越多暴露面越大。3 路以上要显式确认。
  if [[ $# -gt 2 ]]; then
    echo "⚠️ 层内 $# 路。方法论 §8.1 建议：合并队列未启用前限制在 2 路。" >&2
    echo "   继续请设 PR_BATCH_ALLOW_WIDE=1（并确保你会跑 §5.4 步骤 6）。" >&2
    [[ "${PR_BATCH_ALLOW_WIDE:-}" == "1" ]] || exit 1
  fi

  # 分层依据的 base 必须是最新的 origin/main —— 行号是在它上面取的（§3.3 末尾）
  git fetch origin main --quiet

  # ── 派生问题守卫：本批要开的 PR，有没有被之前派生的 issue 撞上 ──────
  #
  # ⚠️ 这一条是这次补齐里**唯一真正机制性**的东西，其余都只是「让人看得见」。
  #    首次试跑踩到的真实情形：#64 要改 gateway-pricing.ts，而方案的 PR12 也改它 ——
  #    这对冲突**诞生在分层之后**，所以判据从没算过它。
  #    只靠 list 提示是不够的：提示可以被忽略，而这里是 hard-stop。
  #
  # ⚠️ 为什么 hard-stop 而不是打印警告后继续：派生问题是**在分层之后**出现的输入，
  #    带着它开工等于拿一份已知过期的分层结果去并行改文件 ——
  #    而这套方法论的全部安全性都建立在分层结果正确之上（方法论 §3.3）。
  #    降级成警告就会被当成噪声跳过，防线自己变成死功能（本仓已有先例）。
  if [[ -f "$DERIVED_LIB" ]]; then
    _guard_ids=""
    for spec in "$@"; do
      [[ "$spec" == *:* ]] && _guard_ids+="${spec%%:*} " || true
    done
    if [[ -n "$_guard_ids" ]]; then
      _guard_json="$(derived_payload | bun run "$DERIVED_LIB" --json 2>/dev/null || true)"
      if [[ -n "$_guard_json" ]]; then
        # 只看还开着的 issue（关掉的说明已处置），且只在「本次要开的 id」上撞才拦。
        _hits="$(jq -r --arg ids "$_guard_ids" '
          ($ids | split(" ") | map(select(length > 0))) as $want
          | [ .verdicts[]
              | select(.state == "OPEN")
              | . as $v
              | .reLayer[]
              | select(.prId as $p | $want | index($p))
              | "  · #\($v.number) 会改 \(.file)，而本次要开的 \(.prId) 也改它（证据: \($v.fileEvidence)）"
            ] | .[]' <<<"$_guard_json" 2>/dev/null || true)"
        if [[ -n "$_hits" ]]; then
          echo "⛔ 拒绝 prepare：本次要开的 PR 与**已派生但未处置**的 issue 撞在同一文件上。" >&2
          echo >&2
          printf '%s\n' "$_hits" >&2
          echo >&2
          echo "   为什么拦：这对冲突诞生在**上一次分层之后**，所以现有 plan.json 的判据" >&2
          echo "   从没算过它。带着过期的分层结果并行改同一个文件，正是这套方法论要防的事。" >&2
          echo >&2
          echo "   三条出路（选一条，都是显式决定，不是绕过）：" >&2
          echo "     ① 重算分层：把该 issue 与这个 PR 一起取 grep -n 行号足迹，按 §3.3 判 C1/C2/C3，" >&2
          echo "        结论写回 .pr-batch/plan.json 的 derived_issues 与 layers" >&2
          echo "     ② 先做该 issue：它可能本来就该排在前面（#64 那种「方案写错方向」的尤其如此）" >&2
          echo "     ③ 判定不冲突：若你核实过两者足迹其实不重叠（正文 grep 是弱证据，会误报），" >&2
          echo "        把 issue 正文的 pr-batch 标记里 files= 改准，再跑一次 prepare" >&2
          echo >&2
          echo "   明细: bun run pr-batch derived" >&2
          echo "   确认无碍要强行继续: PR_BATCH_IGNORE_DERIVED=1（**会留在你的 shell 历史里**，" >&2
          echo "   请在 PR 正文说明为什么忽略 —— 否决也要留痕，方法论 §7.3）" >&2
          [[ "${PR_BATCH_IGNORE_DERIVED:-}" == "1" ]] || exit 1
          echo "⚠️ PR_BATCH_IGNORE_DERIVED=1，已跳过守卫。请在 PR 正文写明理由。" >&2
        fi
      fi
    fi
  fi

  mkdir -p "$STATUS_DIR"

  for spec in "$@"; do
    # ⚠️ 三个标识符必须显式分开（G13，首次试跑实测踩到）。
    #    入参格式: <id>:<branch>   例: PR11:fix/catalog-concurrent-write-merge
    #    省略 id 时退化为旧行为（把整串当分支），但会警告 —— 没有 id 就没有稳定锚点。
    #
    #    为什么要三个：
    #      id     PR11                              ← 跨系统的稳定锚点，永不变
    #      branch fix/catalog-concurrent-write-merge ← git 分支 / gh --head 查询用
    #      dir    fix-catalog-concurrent-write-merge ← worktree 目录名，无语义
    #    上一版一个 slug 兼任三职，于是带 / 的分支名被改成 -，
    #    结果 `gh pr list --head <方案文档里的分支名>` 查出 0 条 —— 对应不上。
    if [[ "$spec" == *:* ]]; then
      id="${spec%%:*}"; branch="${spec#*:}"
    else
      id=""; branch="$spec"
      echo "⚠️ '$spec' 没带 id。建议写 <id>:<branch>（如 PR11:fix/xxx）——" >&2
      echo "   id 是方案文档、plan.json、PR 正文之间唯一不变的锚点。" >&2
    fi
    # 目录名由分支名派生（/ → -），只为避免嵌套目录。**它不承载任何语义**：
    # 实测本机 worktree `ci-pr-base-change-trigger` 的分支是
    # `docs/contributing-eval-pr-smoke-trigger-drift` —— 目录名和分支名毫无关系。
    # 所以下游一律用 wt_branch() 现读分支，绝不从目录名推。
    dir="${branch//\//-}"
    wt="$WT_BASE/${dir}"

    if [[ -d "$wt" ]]; then
      echo "exists ${wt}（跳过创建；如需重建请人工确认后 git worktree remove）"
    else
      git worktree add -b "$branch" "$wt" origin/main
    fi

    # ⚠️ bun install 不能省，且失败要 hard-stop 而不是降级（抄 DSH，方法论 §7.1 第 2 条）。
    #    worktree 默认没有自己的 node_modules，@sid-code/core 会向上解析到主仓 checkout，
    #    那里没有你新增的导出 → make build 打 "<新函数> will always be undefined"
    #    **却仍然 exit 0**。「没装成功」的后果恰恰是一个 exit 0 的假成功，所以必须停。
    if ! ( cd "$wt" && bun install ); then
      echo "FATAL: $wt 的 bun install 失败。不要在这个 worktree 里开会话 ——" >&2
      echo "       make build 会 exit 0 但产物里新函数是 undefined。" >&2
      exit 1
    fi
    [[ -d "$wt/node_modules" ]] || {
      echo "FATAL: $wt/node_modules 不存在，install 静默失败" >&2
      exit 1
    }

    # ⚠️ 权限配置必须显式拷进 worktree（首次试跑实测，G9）。
    #    .claude/* 是 gitignored，worktree 从 origin/main 切出 → **一份权限配置都不继承**，
    #    于是每个 Read/Edit/Bash 都要人点一次确认。2 路并行时这就不叫自动化了。
    #    与 G7（worktree 里没有 pr-batch.sh）同一类自举缺口：
    #    凡是主仓里未入库的东西，worktree 都没有。
    if [[ -f "$SETTINGS_TEMPLATE" ]]; then
      mkdir -p "$wt/.claude"
      # 剥掉 _ 前缀的说明性键（它们是给人看的文档，不是 schema 字段）。
      # 模板里那些 _why / _deliberately_not_allowed 是这份配置最重要的部分 ——
      # 它们记着「为什么 push 和 gh pr create 刻意不放行」，别删模板本身。
      # ⚠️ 必须过一道 expand_paths：模板入库时路径写成 $REPO_ROOT / $DOCS_ROOT /
      #    $HOME 占位符（不许写死家目录），而落到 worktree 的 settings.local.json
      #    必须是绝对路径 —— 权限匹配器不做变量展开，留着 $ 等于这条规则永不命中，
      #    且**不报错**，只是整套自动化静默退化成逐条问你确认。
      jq 'walk(if type == "object"
               then with_entries(select(.key | startswith("_") | not))
               else . end)' \
        "$SETTINGS_TEMPLATE" | expand_paths > "$wt/.claude/settings.local.json"
      echo "       权限已配（acceptEdits + Bash 白名单；push / gh pr create 仍需确认）"
    else
      echo "       ⚠️ 缺 $SETTINGS_TEMPLATE，该 worktree 会逐步询问权限" >&2
    fi

    # ⚠️ **刻意不再写 state 字段**。
    #    这里只存「不可派生」的东西：id（方案文档给的锚点）、layer（我们算出的分层）、
    #    branch（登记值，仅作参照 —— 真值现读，见 wt_branch）。
    #    PR 状态 / CI / 是否可清理一律现查（list 子命令），一个字节都不缓存。
    #    存快照就必须回答「谁更新、何时更新、不一致听谁的」，而 PR 状态在 GitHub 上变化、
    #    不经过这个脚本 —— 那三个问题无解。上一版存了 state:"ready"，
    #    结果 PR 合并后 list 还显示 ready，直接误导用户。
    jq -n --arg id "$id" --arg layer "$layer" --arg branch "$branch" --arg dir "$dir" \
      '{id: $id, layer: $layer, branch_at_prepare: $branch, dir: $dir}' \
      > "$STATUS_DIR/${dir}.json"
    echo "ready  $wt   [${id:-无id}] 分支 $branch"
  done

  echo
  echo "→ 开 $# 个终端，每个终端在**仓库根目录**跑一条（不用手动 cd）："
  for spec in "$@"; do
    d="${spec#*:}"; d="${d//\//-}"
    echo "     bun run pr-batch open $d"
  done
  echo "  （可只写唯一片段；查看各路当前状态: bun run pr-batch list）"
  # ⚠️ 刻意不建议「错开启动」：CI 并发组是 ci-\${github.ref}（.github/workflows/ci.yml:51），
  #    按 ref 分组 → 不同分支本来就不排队。错开只确定地拖长总耗时，收益为零。
  #    详见方法论 §5.4b（这条建议已被实测撤回）。
  echo "→ 两路**同时开**即可，不用错开（CI 按分支分组，本来就不互相排队）"
  echo "→ ⚠️ 磁盘：每路 275-413M（实测），$# 路约 $(( $# * 350 ))M。收工跑 cleanup。"
  echo "→ ⚠️ worktree 里有一例可预期假失败：plan-mode-write-plan-file.test.ts"
  echo "     （cwd 含 .claude/ → 命中敏感路径守卫）。**结论以 CI 为准**。"
  ;;

open) # open [--yolo] [--fresh] <slug>
  # 在仓库根目录跑，脚本替你 cd 并开会话、自动喂 prompt。
  # ⚠️ 为什么必须 cd 而不能在仓库根目录直接开会话：
  #    会话的 cwd 决定它改哪份文件。在根目录开会话 = 改主仓 main 的工作区，
  #    层内两路会真的互相覆盖，worktree 隔离整个失效。
  #    所以正确的简化是「让脚本替人 cd」，不是「不 cd」。
  yolo=0 fresh=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yolo)  yolo=1;  shift ;;
      --fresh) fresh=1; shift ;;
      --)      shift; break ;;
      -*)      break ;;   # 其余 flag 透传给 claude
      *)       break ;;
    esac
  done
  [[ $# -ge 1 ]] || { echo "用法: open [--yolo] [--fresh] <slug>" >&2; exit 1; }
  slug="$(resolve_slug "$1")" || exit 1
  shift

  wt="$REPO_ROOT/$WT_BASE/$slug"
  prompt_file="$REPO_ROOT/.pr-batch/prompts/${slug}.md"
  fork_protocol="$REPO_ROOT/scripts/pr-batch/fork-protocol.md"

  [[ -d "$wt" ]] || { echo "FATAL: $wt 不存在，先跑 prepare" >&2; exit 1; }
  [[ -f "$prompt_file" ]] || {
    echo "FATAL: 缺 prompt 文件 $prompt_file" >&2
    echo "       没有 prompt 的会话不知道自己的文件领地，会跟层内另一路撞车。" >&2
    exit 1
  }

  # 再断言一次依赖装好了 —— prepare 已经查过，但 worktree 可能被手工动过。
  # 这条不能省的理由见 prepare 里的注释（make build 会 exit 0 但产物里函数是 undefined）。
  [[ -d "$wt/node_modules" ]] || {
    echo "FATAL: $wt/node_modules 不存在。先跑: (cd '$wt' && bun install)" >&2
    exit 1
  }

  # ⚠️ 分叉处置协议**机械附加**，不靠写 prompt 的人记得。
  #    首次试跑的教训：prompt 只说「记下来告诉我」—— 那是个死路（「告诉我」之后
  #    没有任何下一步）。agent 自己补齐了开 issue 的流程，那是它的判断力，
  #    不是我们设计的 —— 换个模型/换次会话就不一定还有。
  #    协议本体在 scripts/pr-batch/fork-protocol.md（入库，所以人能 review 它）。
  [[ -f "$fork_protocol" ]] || {
    echo "FATAL: 缺 $fork_protocol" >&2
    echo "       没有分叉协议的会话，派生问题会只留在对话里，会话一关就没了。" >&2
    exit 1
  }

  echo "→ 进入 $wt"
  echo "→ 分支 $(git -C "$wt" branch --show-current)"
  echo "→ 喂 prompt: .pr-batch/prompts/${slug}.md ＋ 分叉协议（机械附加）"
  echo "→ ⚠️ 层内还有其他路在并行改同一批文件，prompt 里已列出你的文件领地，请严格遵守。"
  echo

  # ── 单实例锁：防同一个 worktree 被开两个会话 ──────────────────
  # ⚠️ 这不是洁癖。两个会话同一个 cwd = 同一份文件，它们会互相覆盖 ——
  #    正是 worktree 隔离要消灭的那个问题，只不过从「层内两路」变成了「同一路开两次」。
  #    本仓已有的 conflict-detector 拦不住这种情况（它按绝对路径比，
  #    而这两个会话的绝对路径完全相同、sessionId 不同 —— 那是它能拦的形态，
  #    但它是 Edit 前的**询问式**拦截，不阻止会话启动，且默认只在 Read 过的文件上生效）。
  # 用 mkdir 做锁：它是原子的（实测第二次 mkdir 必失败），且不依赖 macOS 缺失的 flock。
  lock_dir="$REPO_ROOT/.pr-batch/locks/${slug}.lock"
  mkdir -p "$REPO_ROOT/.pr-batch/locks"

  if ! mkdir "$lock_dir" 2>/dev/null; then
    holder_pid="$(cat "$lock_dir/pid" 2>/dev/null || echo '')"
    holder_at="$(cat "$lock_dir/started_at" 2>/dev/null || echo '?')"
    # PID 探活：会话崩了/被 kill 会留下陈旧锁，不能让它永久堵死这一路。
    # 同一套路见 packages/core/src/session/file-intent.ts 的死进程过滤。
    if [[ -n "$holder_pid" ]] && kill -0 "$holder_pid" 2>/dev/null; then
      echo "⛔ ${slug} 已经有一个会话在跑（PID ${holder_pid}，启动于 ${holder_at}）。" >&2
      echo "   两个会话共用同一个 worktree 会互相覆盖文件 —— 这正是 worktree 要防的事。" >&2
      echo >&2
      echo "   你大概想做的是：" >&2
      echo "     · 回到那个终端继续（推荐）" >&2
      echo "     · 开层内另一路:  bun run pr-batch list  看还有哪个没开" >&2
      echo "     · 那个会话确实死了但锁没清:  bun run pr-batch unlock $slug" >&2
      exit 1
    fi
    echo "⚠️ 发现陈旧锁（PID ${holder_pid:-未知} 已不在），自动接管。"
    rm -f "$lock_dir"/pid "$lock_dir"/started_at 2>/dev/null || true
  fi

  echo "$$"                        > "$lock_dir/pid"
  date '+%Y-%m-%d %H:%M:%S'        > "$lock_dir/started_at"
  # 会话退出（正常/Ctrl-C/被 kill）都要释放锁。
  # ⚠️ 只删这个锁目录里的东西，绝不递归删 worktree（CLAUDE.md 铁律）。
  trap 'rm -f "$lock_dir/pid" "$lock_dir/started_at" 2>/dev/null; rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

  # ── 权限模式 ───────────────────────────────────────────────
  if [[ $yolo -eq 1 ]]; then
    echo "→ 权限: ⚠️⚠️ **--yolo / bypassPermissions —— 全部免确认** ⚠️⚠️"
    echo "     包括 git push、gh pr create、**以及 gh pr merge**。"
    echo "     ⛔ agent 可能自己把 PR merge 掉，而 review 是这套流程唯一的质量闸门（§1）。"
    echo "     ⛔ deny 名单（rm -rf / reset --hard / clean -f / 读 API key）**也一并失效**。"
    echo "     只在你能盯着屏幕、且这一路改动可回滚时用。"
    perm_args=(--dangerously-skip-permissions)
  elif [[ -f "$wt/.claude/settings.local.json" ]]; then
    echo "→ 权限: acceptEdits + Bash 白名单（编辑/测试/构建/git 只读+commit 免确认）"
    echo "→ ⚠️ git push 与 gh pr create **仍会问你** —— 刻意保留，它们有外部副作用"
    echo "     嫌这 2 次也多就加 --yolo，但先读上面那段警告。"
    perm_args=(--permission-mode acceptEdits)
  else
    echo "→ ⚠️ 该 worktree 没有权限配置，你会被逐步询问。先跑: bun run pr-batch reperm $slug" >&2
    perm_args=(--permission-mode acceptEdits)
  fi

  # ── 续接 or 新开 ──────────────────────────────────────────
  # claude -c 按 **cwd** 续最近会话，而每路 worktree 的 cwd 各不相同
  # → 天然是各自独立的续接点，不会串到另一路，也不会串到主仓。
  # 判「这一路以前开过吗」用 .claude/projects/ 下按 cwd 编码的会话目录。
  # ⚠️ $wt 是相对路径，这里必须用绝对路径推导（实测 key 是绝对路径把非字母数字替成 -）。
  #    推导规则已在本机核对过：
  #    /Users/.../worktrees/fix-catalog-concurrent-write-merge
  #    → -Users-zhourusheng-Code-person-sid-code--claude-worktrees-fix-catalog-...
  # ⚠️ 这是对 claude 内部布局的依赖，属于**实现细节**，将来可能变。
  #    所以判不出历史时的兜底行为是「按新开处理」——最差就是重跑一遍 prompt，
  #    不会出错，只是多花 token。绝不能反过来（误判有历史 → 该新开的却去续接）。
  cwd_key="$(printf '%s' "$REPO_ROOT/$WT_BASE/$slug" | sed 's/[^a-zA-Z0-9]/-/g')"
  has_history=0
  for base in "$HOME/.claude/projects" "$HOME/.config/claude/projects"; do
    if compgen -G "$base/$cwd_key/*.jsonl" >/dev/null 2>&1; then has_history=1; fi
  done

  cd "$wt"
  if [[ $fresh -eq 0 && $has_history -eq 1 ]]; then
    echo "→ 检测到这一路有历史会话，**续上次的**（不从零开始，省掉重读 prompt 的 token）"
    echo "   想彻底重来加 --fresh。"
    echo
    # -c 续接：不再重复喂 prompt（它已在历史里），只给一句复位指令。
    # ⚠️ 不重复喂 prompt 的理由：重复长 prompt 会让模型以为这是新任务而重做已完成的部分。
    # ⚠️ 续接时**不**重新贴整份分叉协议（它已在历史里），只提醒它还生效。
    #    重复长文本会让模型以为这是新任务而重做已完成的部分。
    exec claude "${perm_args[@]}" -c \
      "继续上一轮未完成的工作。先用 git status / git diff / git log --oneline origin/main.. 核实当前进度到哪了，再说明你接下来要做什么，然后继续。不要重头开始，也不要重复已经完成的改动。上一轮附加的「分叉处置协议」仍然生效：顺手发现的别的问题一律按那套格式开 issue（含第一行的 pr-batch 标记），不要塞进本 PR，也不要只在对话里说一句。" \
      "$@"
  else
    [[ $fresh -eq 1 ]] && echo "→ --fresh: 忽略历史，从零开始"
    echo
    # prompt 作为位置参数传给 claude（`claude [options] [prompt]`）。
    # 任务 prompt ＋ 分叉协议拼在一起：任务部分由人按方案写，协议部分固定。
    # 把 id 显式告诉它 —— 协议里的 `from=<你的PR id>` 需要这个值，
    # 而 agent 无从得知自己在编排里叫什么（那是 plan.json 的信息）。
    my_id="$(jq -r '.id // ""' "$REPO_ROOT/$STATUS_DIR/${slug}.json" 2>/dev/null || true)"
    # ⚠️ prompt 是**手写**文件（全仓无任何代码生成它），且要入库 ——
    #    所以里面的方案文档路径与 check-gen 调用写成 $DOCS_ROOT / $REPO_ROOT，
    #    喂给 claude 之前在这里展开。agent 拿到的必须是绝对路径：
    #    它的 cwd 是 worktree，相对路径解析不到 docs-research。
    exec claude "${perm_args[@]}" \
      "$(expand_paths < "$prompt_file")

---

（以下由编排脚本 pr-batch open 机械附加，适用于所有并行路，不是本 PR 的任务内容）

**你在编排里的 id 是 \`${my_id:-未登记}\`** —— 开 issue 时 \`from=\` 写这个值。

$(cat "$fork_protocol")" "$@"
  fi
  ;;

unlock) # unlock <slug>  —— 清掉陈旧锁（会话崩了但锁还在时用）
  [[ $# -ge 1 ]] || { echo "用法: unlock <slug>" >&2; exit 1; }
  slug="$(resolve_slug "$1")" || exit 1
  lock_dir="$REPO_ROOT/.pr-batch/locks/${slug}.lock"
  [[ -d "$lock_dir" ]] || { echo "$slug 没有锁"; exit 0; }

  holder_pid="$(cat "$lock_dir/pid" 2>/dev/null || echo '')"
  if [[ -n "$holder_pid" ]] && kill -0 "$holder_pid" 2>/dev/null; then
    echo "⛔ PID $holder_pid **还活着** —— 拒绝解锁。" >&2
    echo "   强行解锁会让两个会话同时改一份文件。请先关掉那个终端。" >&2
    exit 1
  fi
  rm -f "$lock_dir"/pid "$lock_dir"/started_at 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
  echo "已解锁 $slug"
  ;;

reperm) # reperm [slug...] —— 把权限模板重新应用到已存在的 worktree。
  # 用于两种情况：① worktree 是在加权限模板之前建的；② 你改了模板要重新下发。
  # ⚠️ 会**覆盖** worktree 里的 .claude/settings.local.json。
  #    那个文件是本地状态、由本脚本生成，不是人手写的，覆盖是预期行为。
  [[ -f "$SETTINGS_TEMPLATE" ]] || { echo "FATAL: 缺 $SETTINGS_TEMPLATE" >&2; exit 1; }

  targets=()
  if [[ $# -ge 1 ]]; then
    for q in "$@"; do
      s="$(resolve_slug "$q")" || exit 1
      targets+=("$s")
    done
  else
    shopt -s nullglob
    for f in "$STATUS_DIR"/*.json; do targets+=("$(basename "$f" .json)"); done
    shopt -u nullglob
  fi
  [[ ${#targets[@]} -ge 1 ]] || { echo "(无登记的 worktree。先跑 prepare)"; exit 0; }

  for slug in "${targets[@]}"; do
    wt="$WT_BASE/$slug"
    [[ -d "$wt" ]] || { echo "SKIP ${slug}（worktree 缺失）"; continue; }
    mkdir -p "$wt/.claude"
    # 展开路径占位符，理由同 prepare 里那段注释（留着 $ 则规则永不命中）。
    jq 'walk(if type == "object"
             then with_entries(select(.key | startswith("_") | not))
             else . end)' \
      "$SETTINGS_TEMPLATE" | expand_paths > "$wt/.claude/settings.local.json"
    echo "配好 $wt/.claude/settings.local.json"
  done
  echo
  echo "⚠️ **已经开着的会话不会热加载这份配置** —— 需要退出该会话再 open 一次。"
  echo "   （权限配置在会话启动时读取）"
  ;;

list|sync) # list —— 各路的**当前**状态 + 建议的下一步。
  # ⚠️ 这里的每一列都是现算的，不读任何存下来的 state。
  #    上一版 list 读 status/*.json 里 prepare 时写死的 state:"ready"，
  #    结果 PR 合并了、worktree 删了它还显示 ready —— **误导用户**。
  #    那是 G4（「本地状态是唯一真值」）在同一份脚本里的第二次发作：
  #    上一轮只把 `status` 子命令改成以 gh 为权威，**漏了 list**，
  #    而 list 才是人最常看的那个。这次的修法是**删掉 state 字段本身**。
  git fetch origin main --quiet 2>/dev/null || true

  shopt -s nullglob
  files=("$STATUS_DIR"/*.json)
  shopt -u nullglob
  [[ ${#files[@]} -ge 1 ]] || { echo "(无。先跑 prepare)"; exit 0; }

  printf '%-6s %-38s %-7s %-9s %-9s %s\n' ID 分支 PR PR状态 CI 下一步
  printf '%-6s %-38s %-7s %-9s %-9s %s\n' ------ -------------------------------------- ------- --------- --------- ----------------

  for f in "${files[@]}"; do
    dir="$(basename "$f" .json)"
    wt="$WT_BASE/$dir"
    id="$(jq -r '.id // "?"' "$f")"

    if [[ ! -d "$wt" ]]; then
      printf '%-6s %-38s %-7s %-9s %-9s %s\n' "$id" "(worktree 已删)" - - - "已清理，无需动作"
      continue
    fi

    br="$(wt_branch "$wt")"
    split_tsv "$(pr_for_branch "$br")" pr_num pr_state merge_oid ci

    # 会话在跑吗（锁 + PID 探活）
    session=""
    lk="$REPO_ROOT/.pr-batch/locks/${dir}.lock"
    if [[ -d "$lk" ]]; then
      lp="$(cat "$lk/pid" 2>/dev/null || true)"
      [[ -n "$lp" ]] && kill -0 "$lp" 2>/dev/null && session="会话在跑"
    fi
    dirty="$(git -C "$wt" status --porcelain -unormal 2>/dev/null | head -1 || true)"

    # 建议的下一步：**这一列才是人真正要看的东西**。
    # 前一版让人自己从 ready/OPEN/MERGED 推断该干什么 —— 那是把派生工作推给人。
    if [[ -z "${pr_num:-}" ]]; then
      if [[ -n "$session" ]]; then nxt="$session，等它提 PR"
      elif [[ -n "$dirty" ]]; then nxt="有改动未提交 → open 续上"
      else nxt="未开工 → bun run pr-batch open $id"; fi
    elif [[ "$pr_state" == "MERGED" ]]; then
      split_tsv "$(cleanable "$dir" "$br" "$pr_state" "$merge_oid" "$pr_num")" ok why
      if [[ "$ok" == "YES" ]]; then nxt="✅ 可清理 → cleanup --force"
      else nxt="⛔ 暂不可清理：$why"; fi
    elif [[ "$pr_state" == "CLOSED" ]]; then
      nxt="PR 已关闭（未合）→ 人工决定"
    else
      case "$ci" in
        SUCCESS) nxt="CI 绿 → 你 review + merge" ;;
        FAILING) nxt="⛔ CI 红 → open 续上修" ;;
        PENDING) nxt="CI 跑着 → gh pr checks $pr_num --watch" ;;
        *)       nxt="无 CI → 检查 workflow 触发条件" ;;
      esac
      [[ -n "$session" ]] && nxt="$session；$nxt"
    fi

    printf '%-6s %-38s %-7s %-9s %-9s %s\n' \
      "$id" "${br:0:38}" "${pr_num:+#$pr_num}" "${pr_state:--}" "${ci:--}" "$nxt"
  done

  echo
  # ── 派生问题一栏：list 是人最常看的入口，分叉必须在这里可见 ────────
  # ⚠️ 只打摘要行，明细留给 `derived` —— list 塞满了就没人读。
  #    但**未闭环数必须出现在这里**：它是「我还有什么没做」这个问题的答案，
  #    而原来这个答案只存在于 GitHub 的 issue 列表里（不去翻就看不见）。
  if [[ -f "$DERIVED_LIB" ]]; then
    derived_out="$(derived_payload | bun run "$DERIVED_LIB" 2>/dev/null || true)"
    d_total="$(printf '%s\n' "$derived_out" | sed -n 's/^派生问题（现查，共 \([0-9]*\) 条.*/\1/p' | head -1)"
    # ⚠️ 必须锚定 `⚠️ ` 前缀（明细行的形态），不能裸搜关键词 ——
    #    报告末尾的**处置说明**里也有「分层需重算」这四个字，裸搜会把它算进去。
    #    实测：3 条真明细被数成 4。这类「分子多算一」很难看出来，
    #    因为数字本身看着合理 —— 本仓铁律「每个指标必须能指到源字段」的同一形态。
    d_relayer="$(printf '%s\n' "$derived_out" | grep -c '⚠️ 分层需重算' || true)"
    d_reflow="$(printf '%s\n' "$derived_out" | grep -c '⚠️ 方案文档回流未做' || true)"
    if [[ -n "${d_total:-}" && "${d_total:-0}" != "0" ]]; then
      echo "派生问题: ${d_total} 条（分层需重算 ${d_relayer} / 待回流方案文档 ${d_reflow}）"
      if [[ "${d_relayer:-0}" != "0" || "${d_reflow:-0}" != "0" ]]; then
        echo "  ⛔ 有未闭环项 → bun run pr-batch derived   看明细与处置"
      else
        echo "  ✅ 已全部闭环 → bun run pr-batch derived   看明细"
      fi
    else
      echo "派生问题: 无（本批 PR 正文里没有指回来的 issue）"
    fi
  fi

  echo
  echo "⚠️ 以上每列都是现查的（gh + git），不是存下来的快照。"
  echo "   权威：PR 状态在 GitHub，本地改动在各 worktree 的 git，分层在 .pr-batch/plan.json。"
  ;;

derived) # derived —— 派生问题（分叉）核算。
  # 回答三个问题，全部现查：
  #   ① 这批 PR 派生了哪些 issue（正文指回本批 PR 号的）
  #   ② 有没有跟方案文档里**还没做**的 PR 撞上（撞上 = 之前算的分层失效了）
  #   ③ 推翻方案文档的发现有没有回流
  #
  # ⚠️ 退出码 4 = 有未闭环项。这是**分类结果**，不是门禁失败（同 check-gen 的 3）。
  [[ -f "$DERIVED_LIB" ]] || { echo "FATAL: 缺 $DERIVED_LIB" >&2; exit 1; }
  shopt -s nullglob
  _dfiles=("$STATUS_DIR"/*.json)
  shopt -u nullglob
  [[ ${#_dfiles[@]} -ge 1 ]] || { echo "(无登记的 PR。先跑 prepare)"; exit 0; }

  derived_payload | bun run "$DERIVED_LIB"
  ;;

reflow) # reflow <issue号> [--synced]
  # 方案文档回流：把「issue 推翻了方案文档某节」变成一个可粘贴的修正块。
  #
  # ⚠️ 刻意**不自动改方案文档**。它在另一个仓库（docs-research），
  #    而本仓铁律是「不动与本次任务无关的文件」—— 跨仓自动写入更是没有回收站。
  #    这里输出可粘贴的块 + 一条 sed 定位命令，人贴一次（10 秒），
  #    然后 --synced 打标签闭环。**能自动的是「记得要做」和「做完能确认」，
  #    不是「替人改别人仓库的文档」**。
  [[ $# -ge 1 ]] || { echo "用法: reflow <issue号> [--synced]" >&2; exit 1; }
  issue_num="${1#\#}"
  shift
  synced=0
  [[ "${1:-}" == "--synced" ]] && synced=1

  body="$(gh issue view "$issue_num" --json body --jq .body 2>/dev/null)" || {
    echo "FATAL: 读不到 issue #$issue_num" >&2; exit 1; }
  title="$(gh issue view "$issue_num" --json title --jq .title)"
  section="$(printf '%s' "$body" | sed -n 's/.*plan-doc-correction=\([^ ]*\).*/\1/p' | head -1)"

  if [[ $synced -eq 1 ]]; then
    [[ -n "$section" ]] || {
      echo "⛔ #$issue_num 的正文里没有 plan-doc-correction 标记 —— 它不该被标成已回流。" >&2
      echo "   （若它确实推翻了方案文档，先把标记补进 issue 正文）" >&2
      exit 1
    }
    # 标签可能不存在，先建（幂等：已存在时 gh 会报错，忽略即可）
    gh label create "$SYNCED_LABEL" --description "该 issue 对方案文档的修正已回流" --color 0E8A16 2>/dev/null || true
    gh issue edit "$issue_num" --add-label "$SYNCED_LABEL"
    echo "✅ #$issue_num 已标记为「方案文档 $section 已回流」。"
    echo "   权威在 GitHub 标签，不在本地文件 —— 换台机器跑 derived 结论一致。"
    exit 0
  fi

  [[ -n "$section" ]] || {
    echo "#$issue_num 没有 plan-doc-correction 标记 → 它只是「多一个待办」，不需要回流。"
    echo "（若它确实推翻了方案文档的描述，把标记补进 issue 正文再跑一次）"
    exit 0
  }

  plan_doc="$(jq -r '._plan // ""' .pr-batch/plan.json 2>/dev/null || true)"
  resolved="$(resolve_plan_doc "$plan_doc")"

  echo "════════════════════════════════════════════════════════════"
  echo "方案文档回流：#$issue_num → $section"
  echo "  $title"
  echo "════════════════════════════════════════════════════════════"
  echo
  if [[ -n "$resolved" ]]; then
    echo "目标文件: $resolved"
    # 小节号形如 §6.2 → 找 "### 6.2"
    sec_num="${section#§}"
    hit="$(grep -n "^#\{2,4\} ${sec_num}" "$resolved" | head -1 || true)"
    if [[ -n "$hit" ]]; then
      echo "定位: 第 ${hit%%:*} 行  —— ${hit#*:}"
      echo "打开: \${EDITOR:-vi} +${hit%%:*} '$resolved'"
    else
      echo "⚠️ 在文档里找不到 $section 这一节（可能小节号写错，或文档已重构）。"
      echo "   人工定位: grep -n '$sec_num' '$resolved'"
    fi
  else
    echo "⚠️ 找不到方案文档（plan.json 的 _plan = '${plan_doc:-空}'）。"
    echo "   人工找到它，把下面的块贴进 $section。"
  fi
  echo
  echo "── 贴到 $section 末尾（原描述**保留并标注**，不要删）─────────"
  echo
  echo "> ⚠️ **本节的描述已被 #$issue_num 推翻（$(date '+%Y-%m-%d') 回源码核实）**。"
  echo ">"
  # 从 issue 正文里抽「推翻/核实」那一节。标题写法不统一（实测 #64 用的是
  # 「## 回源码核出的事实」，不是协议里建议的「## ⚠️ 推翻方案文档 §X.Y」），
  # 所以按一组关键词匹配，而不是死盯一个标题。
  #
  # ⛔ **抽不到时必须显式说「抽不到」，绝不留一个空引用块**。
  #    空块看起来像「已经生成好了」，人贴上去就等于往方案文档里塞了一段空话，
  #    而 --synced 之后 derived 会报绿 —— 那是本仓「绿了但没测到」的同一形态，
  #    只不过这次骗的是方案文档的读者。
  excerpt="$(awk '
    /^#{2,3} .*(推翻|核出|核实|事实|勘误)/ { f=1; print; next }
    f && /^#{2,3} / { f=0 }
    f { print }
  ' <<<"$body" | head -40)"
  if [[ -n "$(printf '%s' "$excerpt" | tr -d '[:space:]')" ]]; then
    printf '%s\n' "$excerpt" | sed 's/^/> /'
  else
    echo "> ⚠️ **本块没能从 issue 正文里自动抽出结论** —— 正文里找不到"
    echo "> 「推翻 / 核出 / 核实 / 事实 / 勘误」任一小节。"
    echo "> **请打开 issue 自己摘一段贴在这里**，不要就这样提交（空块比没有更糟）。"
  fi
  echo ">"
  echo "> 出处: https://github.com/rushengzhou/sid-code/issues/$issue_num"
  echo
  echo "──────────────────────────────────────────────────────────"
  echo "贴完并保存后跑: bun run pr-batch reflow $issue_num --synced"
  echo "（否则 derived 会一直把它报成未闭环 —— 这是刻意的：忘了贴 = 没闭环）"
  ;;

check-gen) # 在 worktree 里跑：判自己会不会改到 website/ref/ 生成物。
  # ⚠️ 条件触发，不是每次必跑。锚点直接抄 scripts/git-hooks/pre-commit.sh:62 ——
  #    理由见那个 hook 自己的注释（--check 要起一次 bun 进程 dump 工具定义约 1s，
  #    每次提交都跑会让无关提交也变慢，久了就会被 --no-verify 绕过）。
  #    实测近 60 天 53 个合入 PR 只有 4 个触及 website/ref/（7.5%），
  #    把成本压在 92.5% 不需要的 PR 上，结局就是被绕过。
  REF_SOURCES=$(git diff --name-only origin/main...HEAD \
    | grep -E '^packages/(cli|core)/src/(help\.ts|cli\.ts|tool/|command/|config/|hook/)' || true)

  if [[ -z "$REF_SOURCES" ]]; then
    echo "skip: 本 PR 未触及参考页数据源，无需检查生成物"
    exit 0
  fi

  echo "本 PR 触及参考页数据源，开始核对："
  printf '%s\n' "$REF_SOURCES" | sed 's/^/    /'
  bun run docs:gen-reference >/dev/null

  CHANGED=$(git diff --name-only website/ref/ website/public/llms.txt)
  if [[ -n "$CHANGED" ]]; then
    echo "gen: 本 PR 改动了生成物。**这不代表必须串行** ——"
    echo "     ① 把下面的行号告诉层内其他路，双方按方法论 §3.3 的 C1/C2/C3 判"
    echo "        （行号差 >= 2 即可继续并行；实测阈值，不是拍的）"
    echo "     ② 你若是本层第二个合入的：rebase 后要**重跑一次** docs:gen-reference 再提交"
    git diff --stat website/ref/ website/public/llms.txt
    git diff -U0 website/ref/ | grep -E '^@@' | sed 's/^/     行号: /' || true
    # ⚠️ 独立退出码 3：这是一个**分类结果**，不是门禁失败。
    #    混用 exit 1 会让上层脚本把「发现生成物改动」当成「门禁红了」。
    exit 3
  fi
  echo "no-gen: 数据源虽变但生成物无变化，与层内其他路无生成物耦合"
  ;;

status)
  # ⚠️ status 已并入 list —— 两个子命令回答同一个问题就必然有一个会过期。
  #    旧 status 读 status/*.json 的 state 字段，而那个字段已经删了（见 prepare 注释）。
  #    保留这个入口只为兼容手指记忆，直接转发。
  echo "（status 已并入 list —— 状态一律现查，不再有本地缓存那一栏）" >&2
  exec bash "$0" list
  ;;

cleanup) # cleanup [--force]
  # ⛔ 绝不 -f 强删、绝不 git clean、绝不 reset --hard。
  #    worktree 里可能有未提交的在途工作（CLAUDE.md 铁律，有真实数据丢失事故）。
  force="${1:-}"
  removed=0 skipped=0 candidates=0
  git fetch origin main --quiet 2>/dev/null || true

  while read -r wt; do
    [[ -n "$wt" ]] || continue
    dir="$(basename "$wt")"
    br="$(wt_branch "$wt")"
    split_tsv "$(pr_for_branch "$br")" pr_num pr_state merge_oid _ci
    split_tsv "$(cleanable "$dir" "$br" "$pr_state" "$merge_oid" "$pr_num")" ok why

    if [[ "$ok" != "YES" ]]; then
      printf 'KEEP  %-42s %s\n' "$dir" "$why"
      skipped=$((skipped + 1))
      continue
    fi

    candidates=$((candidates + 1))
    if [[ "$force" == "--force" ]]; then
      # 归档摘要：删除动作本身要留痕（你问的「全部删除如何追溯」）。
      # ⚠️ 真正需要追溯的东西本来就不在被删的目录里：
      #    提交在 GitHub（PR + mergeCommit）、会话记录在 ~/.claude/projects/、
      #    分层决策在 .pr-batch/plan.json。这里打印的是「怎么找回去」的索引。
      printf '归档  dir=%s branch=%s PR=#%s mergeCommit=%s\n' \
        "$dir" "$br" "${pr_num:-?}" "${merge_oid:0:12}"
      if git worktree remove "$wt"; then
        echo "REMOVED $wt"
        removed=$((removed + 1))
        rm -f "$STATUS_DIR/${dir}.json" 2>/dev/null || true
      fi
    else
      printf '可删  %-42s PR#%s 已合入 main（加 --force 才真删）\n' "$dir" "${pr_num:-?}"
    fi
  done < <(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep "$WT_BASE" || true)

  # 只动注册表元数据，不删任何文件，可以无条件跑
  git worktree prune

  echo "--- 汇总 ---"
  # ⚠️ 必须用 ${VAR} 而不是 $VAR：紧跟其后的全角字符（这里是「（」）会被吞进变量名，
  #    在 set -u 下报 "skipped?: unbound variable"。本仓 release.sh 踩过同一个坑
  #    （`$VERSION，` 被误判 unbound），结论是**一律用 ${VAR}**。
  echo "已删 ${removed} / 可删 ${candidates} / 保留 ${skipped}"
  if [[ "$force" != "--force" && $candidates -gt 0 ]]; then
    echo "→ 确认上面的归档信息后执行: bun run pr-batch cleanup --force"
  fi
  echo "⚠️ 保留的那些请人工确认后再处理，**不要强删** —— 它们有未提交改动或未进 PR 的提交。"
  du -sh "$WT_BASE" 2>/dev/null || true
  ;;

*)
  echo "未知子命令: $CMD" >&2
  usage
  exit 1
  ;;
esac
