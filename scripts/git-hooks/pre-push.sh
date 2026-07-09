#!/bin/sh
# pre-push hook 受控版本（git track，团队成员安装一次即可同步）
#
# 行为：
#   1. 检查最近 commit 是否涉及 evals/ 下的 yaml / _scores / _reports
#   2. 如果有变动，跑 bun run eval:dashboard 刷新 DASHBOARD.md
#   3. 如果 DASHBOARD.md 有变化，生成独立 commit（不 amend）
#
# 安装：
#   bun run scripts/install-git-hooks.sh
# 或手动：
#   cp scripts/git-hooks/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push

# F-H5: holdout 泄露检测(双重防御 L5)
echo "[pre-push] 跑 holdout 泄露检测 ..."
if [ -x "scripts/eval/check-holdout-leak.sh" ] || [ -f "scripts/eval/check-holdout-leak.sh" ]; then
  sh scripts/eval/check-holdout-leak.sh || {
    echo "[pre-push] ❌ holdout 泄露检测失败,push 中止"
    exit 1
  }
  echo "[pre-push] ✅ 无 holdout 泄露"
fi

# B7-3 (2026-05-31)：holdout/real-tasks/holdout-sids.txt 永封校验 + 公开页面 sid 泄露检测
echo "[pre-push] 跑 holdout/real-tasks 永封校验 ..."
if [ -f "scripts/eval/check-holdout-real-tasks-sealed.sh" ]; then
  sh scripts/eval/check-holdout-real-tasks-sealed.sh || {
    echo "[pre-push] ❌ holdout/real-tasks 永封被改 / 公开页面泄露 sid，push 中止"
    echo "  恢复方法：git checkout HEAD -- evals/holdout/real-tasks/holdout-sids.txt"
    exit 1
  }
  echo "[pre-push] ✅ holdout/real-tasks 永封完整"
fi

# Step 2-3：dashboard 刷新（与原 hook 行为一致）
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
