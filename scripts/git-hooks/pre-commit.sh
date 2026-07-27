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
# T-3.8: 参考页反漂移门禁（官网方案 §4.5.2 机制一）
#
# 改了参考页的 6 个数据源之一（help.ts / tool/ / command/ / config/ / hook/），
# 就必须重新生成 website/ref/ 下的参考页。不一致则**阻止提交**。
#
# 这道门禁的保证是：源码改了但文档没跟着改，物理上进不了仓库。
# 参考表一旦漂移就是骗人——用户照着文档写了一个不存在的参数，比没有文档更糟。
#
# 注意只在数据源变动时才跑：--check 要起一次 bun 进程 dump 工具定义（约 1s），
# 每次提交都跑会让无关提交也变慢，久了就会被 --no-verify 绕过。
# ============================================================================
STAGED_REF_SOURCES=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^src/(help\.ts|cli\.ts|tool/|command/|config/|hook/)' || true)
STAGED_REF_PAGES=$(git diff --cached --name-only --diff-filter=ACMRD | grep -E '^website/(ref/|public/llms\.txt)' || true)

if [ -n "$STAGED_REF_SOURCES" ] || [ -n "$STAGED_REF_PAGES" ]; then
  echo "[pre-commit] T-3.8 参考页与源码对账（改动涉及参考页数据源）..."
  if ! bun run "$REPO_ROOT/scripts/docs-gen-reference.ts" --check; then
    echo "[pre-commit] ❌ 参考页与源码不一致，commit 中止"
    echo "             修复：bun run docs:gen-reference && git add website/ref website/public/llms.txt"
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
