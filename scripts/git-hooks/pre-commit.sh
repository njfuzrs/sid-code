#!/bin/sh
# pre-commit hook —— B6-10 数据污染防护
#
# 行为：扫 staged 的 evals/real-tasks/**.yaml 是否含 §9.1.1 黑名单关键词
#       （tool_result_content / response_content / patch_content / observation_content / completion_text）
#       命中即 reject commit
#
# 安装：
#   bun run install-hooks
# 或手动：
#   cp scripts/git-hooks/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# 跳过单次（不推荐，仅在确认误报时用）：
#   git commit --no-verify

set -e

# 找 staged 的 real-tasks yaml
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^evals/real-tasks/.*\.ya?ml$' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
echo "[pre-commit] 扫描 staged real-tasks yaml ($(echo "$STAGED" | wc -l | tr -d ' ') 个文件)..."

# 把相对路径转绝对路径传给扫描器
ABS_FILES=""
for f in $STAGED; do
  ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
done

# shellcheck disable=SC2086
bun run "$REPO_ROOT/scripts/eval/check-real-tasks-pollution.ts" $ABS_FILES
SCAN_EXIT=$?

if [ $SCAN_EXIT -ne 0 ]; then
  echo "[pre-commit] ❌ 数据污染扫描失败 (exit=$SCAN_EXIT)，commit 中止"
  echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
  exit 1
fi

exit 0
