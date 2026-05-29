#!/bin/sh
# pre-push hook 受控版本（git track，团队成员安装一次即可同步）
#
# 行为：
#   1. 跑 bun test：测试坏了直接 block push（评测系统改动越来越多，必须守门）
#   2. 检查最近 commit 是否涉及 evals/ 下的 yaml / _scores / _reports
#   3. 如果有变动，跑 bun run eval:dashboard 刷新 DASHBOARD.md
#   4. 如果 DASHBOARD.md 有变化，生成独立 commit（不 amend）
#
# 安装：
#   bun run scripts/install-git-hooks.sh
# 或手动：
#   cp scripts/git-hooks/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push

# Step 1：测试守门
# 这是 P2-9 的核心：以前 .git/hooks/pre-push 只跑 dashboard，测试坏了 push 不阻断
echo "[pre-push] 跑 bun test ..."
TEST_OUTPUT=$(bun test 2>&1)
TEST_EXIT=$?
echo "$TEST_OUTPUT" | tail -5
if [ $TEST_EXIT -ne 0 ]; then
  echo "[pre-push] ❌ bun test 失败 (exit=$TEST_EXIT)，push 中止"
  exit 1
fi
echo "[pre-push] ✅ bun test 通过"

# Step 2-4：dashboard 刷新（与原 hook 行为一致）
NEEDS_REFRESH=0

if ! git diff --quiet HEAD~1 HEAD -- 'evals/' 2>/dev/null; then
  NEEDS_REFRESH=1
fi
if ! git diff --quiet -- 'evals/' 2>/dev/null; then
  NEEDS_REFRESH=1
fi

if [ "$NEEDS_REFRESH" = "0" ]; then
  exit 0
fi

echo "[eval-dashboard] 检测到 evals/ 变动，刷新 DASHBOARD.md..."

if grep -q '"eval:dashboard"' package.json 2>/dev/null; then
  bun run eval:dashboard || {
    echo "[eval-dashboard] ⚠️  Dashboard 刷新失败，push 中止"
    exit 1
  }
elif grep -q '"eval:dashboard:md"' package.json 2>/dev/null; then
  bun run eval:dashboard:md || {
    echo "[eval-dashboard] ⚠️  Dashboard 刷新失败，push 中止"
    exit 1
  }
else
  echo "[eval-dashboard] 未找到 eval:dashboard 命令，跳过"
  exit 0
fi

# 同步刷新 HTML 操作台（评测系统 HTML 可视化操作台，docs/eval/演进路线/评测系统html.md）
if grep -q '"eval:dashboard-html"' package.json 2>/dev/null; then
  echo "[eval-dashboard-html] 刷新 evals/eval-dashboard.html + eval-data.json ..."
  bun run eval:dashboard-html || {
    echo "[eval-dashboard-html] ⚠️  HTML dashboard 刷新失败，push 中止"
    exit 1
  }
fi

REFRESHED_FILES=""
if ! git diff --quiet evals/DASHBOARD.md 2>/dev/null; then
  REFRESHED_FILES="$REFRESHED_FILES evals/DASHBOARD.md"
fi
if ! git diff --quiet evals/eval-dashboard.html 2>/dev/null; then
  REFRESHED_FILES="$REFRESHED_FILES evals/eval-dashboard.html"
fi
if ! git diff --quiet evals/eval-data.json 2>/dev/null; then
  REFRESHED_FILES="$REFRESHED_FILES evals/eval-data.json"
fi

if [ -n "$REFRESHED_FILES" ]; then
  git add $REFRESHED_FILES
  git commit -m "ci(eval): refresh dashboard $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "[eval-dashboard] ✅ 已生成独立 commit (含:$REFRESHED_FILES)"
fi

exit 0
