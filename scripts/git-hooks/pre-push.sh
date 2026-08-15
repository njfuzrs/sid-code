#!/bin/sh
# pre-push hook 受控版本（git track，团队成员安装一次即可同步）
#
# 行为：
#   1. holdout 泄露检测 / 永封校验
#   2. website/ 有变动时跑一次站点构建（死链检测）
#   3. 北极星指标生成块的陈旧检测（P0-3，阈值 30 天）
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

# P0-3：北极星指标生成块的陈旧检测
#
# 为什么需要机制而不是告诫：现状数字是人手抄进 markdown 的，于是无法自动过期、
# 无法机械校验、改代码的人不会想起改文档。**同一个失效模式已经发生三次**
# （2026-08-05 / 08-08 / 08-14），三次都是"读者看不出那个快照是三天前还是三个月前
# 量的，于是照抄"。路线图与 CLAUDE.md 都写了"引用前先回源码核验"的告诫，
# 第三次照样发生 —— 告诫 + 自觉这条路已被证伪三次，所以换成门禁。
#
# 为什么放 pre-push 而不是 pre-commit：现状陈旧不该阻塞单次提交（那会让人烦到
# 卸掉 hook），但不该带着三个月前的数字去 push。push 边界正合适。
#
# 阈值 30 天：短于此会因正常开发节奏频繁误拦，而误拦几次之后人就会开始
# 无脑加 --no-verify —— 一个被绕过的门禁比没有门禁更糟，它还给人虚假的安全感。
#
# ⚠ 必须点破的现实约束：方案文档与路线图在 `docs-research/`，**不在本仓库内**，
# 所以本检查**管不到它们**。跨仓库门禁做不了 —— 生成块自带时间戳（读者一眼能看出
# 新鲜度）才是那边唯一可行的手段。这里能管的只有本仓库内引用了生成块的文件。
if [ -f "scripts/northstar-snapshot.ts" ]; then
  # 只扫本仓库内**确实含生成块**的文件。找不到块的文件由脚本自己判为"不拦"
  #（见 checkStaleness 注释：找不到就拦会在无关文件上误报，人会直接卸掉 hook）。
  _ns_files=$(grep -rl "NORTHSTAR:BEGIN" --include="*.md" . 2>/dev/null | grep -v node_modules || true)
  if [ -n "$_ns_files" ]; then
    echo "[pre-push] 检查北极星生成块新鲜度（阈值 30 天）..."
    _ns_stale=0
    for _f in $_ns_files; do
      bun run scripts/northstar-snapshot.ts --check-staleness 30 "$_f" || _ns_stale=1
    done
    if [ "$_ns_stale" = "1" ]; then
      echo "[pre-push] ❌ 北极星生成块已陈旧，push 中止"
      echo "    刷新：bun run scripts/northstar-snapshot.ts --emit-markdown"
      echo "    （数字全部由脚本生成，不要手改块内内容 —— 手改会让时间戳与数字脱节）"
      exit 1
    fi
    echo "[pre-push] ✅ 北极星生成块新鲜"
  fi
fi

exit 0
