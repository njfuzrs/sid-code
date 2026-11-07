#!/bin/sh
# push-scope —— 从 git pre-push 的 stdin 读出「本次推送的变更路径」，每行一个。
#
# ## 为什么要有它（X3-02）
#
# git 只通过 stdin 把「这次推哪些 ref」告诉 pre-push hook，格式是每行
#   <local_ref> <local_sha> <remote_ref> <remote_sha>
# 这是拿到推送区间的**唯一**途径。不读 stdin 就只能用 `HEAD~1..HEAD` 猜，
# 而这个猜法只看最后一个提交：分支上第 2 个提交改了 `website/` 引入死链、
# 第 3、4 个提交只改 `packages/` 时，站点构建（死链检测的唯一落点）不会跑，
# 终端上也不会说「跳过」——死链就这样推上去了。
#
# ## 输出约定
#
#   · 能判出范围：本次推送涉及的全部变更路径（相对仓库根），每行一个
#   · 判不出范围：输出 `__UNKNOWN__`（调用方按「跑」处理，宁可多跑一次）
#     触发条件：新分支且没有 `<base-ref>`、`remote_sha` 本地不存在、git diff 失败
#   · stdin 是终端（手动执行 hook，没有推送区间）：输出 `__UNKNOWN__`
#     —— 不能 read，否则会挂在终端上等输入
#
# 退出码恒 0：这是「收集信息」的脚本，判不出范围用 `__UNKNOWN__` 表达，
# 由调用方决定策略（pre-push 的策略是跑构建）。
#
# ## 为什么不内联在 pre-push.sh 里
#
# pre-push.sh 是被 `cp` 到 `.git/hooks/` 的快照（X3-11 未修前如此），内联的
# 判定逻辑没法在 tmpdir 仓库里单独跑测试。抽成独立脚本后，测试可以直接对
# 「多提交 push」「新分支」「远端被更新过」这几种输入求值。
#
# 环境变量 `PUSH_SCOPE_BASE_REF` 覆盖新分支求差的基线（默认 `origin/main`），
# 测试用它把基线指到临时仓库里真实存在的 ref。

set -u

ZERO=0000000000000000000000000000000000000000
BASE_REF="${PUSH_SCOPE_BASE_REF:-origin/main}"

# 手动执行（无管道输入）时不能 read —— 会一直等终端输入。
# 判不出范围就按「跑」处理，这是安全方向。
if [ -t 0 ]; then
  echo "__UNKNOWN__"
  exit 0
fi

_unknown=0
_paths=""

while read -r _lref lsha _rref rsha; do
  # 空行 / 字段不全：不是合法的 ref 行
  [ -z "${lsha:-}" ] && continue
  # 删除远端分支：没有内容会被推上去
  [ "$lsha" = "$ZERO" ] && continue

  if [ "${rsha:-}" = "$ZERO" ]; then
    # 新分支：与基线求分歧点。求不出（没有 origin/main、浅克隆）就判不出范围。
    base=$(git merge-base "$lsha" "$BASE_REF" 2>/dev/null) || base=""
    if [ -z "$base" ]; then
      _unknown=1
      continue
    fi
  else
    # 已有远端分支：推送区间就是 remote_sha..local_sha。
    # remote_sha 本地不存在（远端被别人更新过、本地没 fetch）时 git 会失败，
    # 此时不能当成「没有改动」，必须判不出范围。
    base="$rsha"
    if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
      _unknown=1
      continue
    fi
  fi

  # --no-renames：重命名要同时看到旧路径和新路径，否则「旧路径在 website/ 下」
  # 这类改动会漏判。
  if ! diff_out=$(git diff --name-only --no-renames "$base" "$lsha" 2>/dev/null); then
    _unknown=1
    continue
  fi
  _paths="$_paths$diff_out
"
done

# 去掉尾部与空行后逐行输出。
if [ -n "$_paths" ]; then
  printf '%s' "$_paths" | grep -v '^[[:space:]]*$' || true
fi

if [ "$_unknown" = "1" ]; then
  echo "__UNKNOWN__"
fi

exit 0
