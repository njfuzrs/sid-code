#!/bin/sh
# pre-push hook 受控版本（git track，团队成员安装一次即可同步）
#
# 行为：
#   1. holdout 泄露检测 / 永封校验
#   2. website/ 有变动时跑一次站点构建（死链检测）
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

# T-3.9：website/ 有变动 → 跑一次站点构建
#
# 为什么放 pre-push 而不是 pre-commit：构建约 3s，比 pre-commit 该承担的成本高；
# 而它要防的是"推上去才发现构建挂了"，push 边界正好。
#
# 为什么值得跑：VitePress 的死链检测就是构建门禁（config.ts 的 ignoreDeadLinks: false），
# 这是**免费的第四道机制**（§4.5.4）——不另造断链检查脚本，改错内链构建即失败。
# 同时也拦 Vue 编译错误：参考页描述里的裸 `<xxx>` 会被当成未闭合标签（已实测撞到）。
if ! git diff --quiet HEAD~1 HEAD -- 'website/' 2>/dev/null || ! git diff --quiet -- 'website/' 2>/dev/null; then
  echo "[pre-push] 检测到 website/ 变动，跑站点构建（死链检测 = 构建门禁）..."
  if ! bun run website:build >/tmp/sid-website-build.log 2>&1; then
    echo "[pre-push] ❌ 站点构建失败，push 中止。常见原因："
    echo "    · 死链：sidebar/正文引用了不存在的页面（ignoreDeadLinks: false 刻意如此）"
    echo "    · Vue 编译错误：markdown 里有裸 < 或 {{（参考页由生成器转义，人工页需自己注意）"
    tail -20 /tmp/sid-website-build.log
    exit 1
  fi
  echo "[pre-push] ✅ 站点构建通过（无死链）"
fi

exit 0
