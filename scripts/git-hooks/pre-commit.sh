#!/bin/sh
# pre-commit hook —— B6-10 数据污染防护 + B7-7 SKILL holdout 回归护栏
#
# 行为：
#   1. 扫 staged 的 evals/real-tasks/**.yaml 是否含 §9.1.1 黑名单关键词
#      （tool_result_content / response_content / patch_content / observation_content / completion_text）
#      命中即 reject commit（B6-10）
#   2. 扫 staged 的 SKILL.md（src/skill/builtin/**/SKILL.md 或 .sid-code/skills/**/*.md）
#      调用 holdout 回归扫描器：holdout 暂无 execution case → INFO skip；有则提示应跑回归
#      （B7-7 §13.4.4 蒸馏护栏 2，holdout case 入库后会自动激活）
#
# 安装：
#   bun run install-hooks
# 或手动：
#   cp scripts/git-hooks/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# 跳过单次（不推荐，仅在确认误报时用）：
#   git commit --no-verify

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)

# ============================================================================
# B6-10: real-tasks yaml 污染扫描
# ============================================================================
STAGED_REAL_TASKS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^evals/real-tasks/.*\.ya?ml$' || true)

if [ -n "$STAGED_REAL_TASKS" ]; then
  echo "[pre-commit] B6-10 扫描 staged real-tasks yaml ($(echo "$STAGED_REAL_TASKS" | wc -l | tr -d ' ') 个文件)..."

  ABS_FILES=""
  for f in $STAGED_REAL_TASKS; do
    ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
  done

  # shellcheck disable=SC2086
  if ! bun run "$REPO_ROOT/scripts/eval/check-real-tasks-pollution.ts" $ABS_FILES; then
    echo "[pre-commit] ❌ B6-10 数据污染扫描失败，commit 中止"
    echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
    exit 1
  fi
fi

# ============================================================================
# B7-7: SKILL.md 改动 → 提示 holdout execution 回归（§13.4.4 v1.3 蒸馏护栏 2）
# ============================================================================
STAGED_SKILLS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '(^src/skill/builtin/.*/SKILL\.md$|^.*\.sid-code/skills/.*\.md$)' || true)

if [ -n "$STAGED_SKILLS" ]; then
  ABS_FILES=""
  for f in $STAGED_SKILLS; do
    ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
  done

  # shellcheck disable=SC2086
  bun run "$REPO_ROOT/scripts/eval/check-skill-holdout-regression.ts" $ABS_FILES
fi

exit 0
