#!/bin/sh
# 安装 scripts/git-hooks/ 下的脚本到 .git/hooks/
#
# 用法：bun run install-hooks
# 或：sh scripts/install-git-hooks.sh

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
SRC_DIR="$REPO_ROOT/scripts/git-hooks"

# 必须用 --git-common-dir，不能拼 "$REPO_ROOT/.git"：
# 在 **worktree** 里 `.git` 是一个**文件**（内容形如 `gitdir: …/.git/worktrees/<name>`），
# 于是 `mkdir "$REPO_ROOT/.git/hooks"` 直接失败（`Not a directory`），整个安装退 1。
# 实测后果不是"少装一次"——本仓日常就在 worktree 里干活（一次并行开发同时有 7 个），
# 于是所有 hook 门禁在 worktree 里**从来没装上过**，而失败信息藏在 bun run 的输出里很容易被划过去。
#
# --git-common-dir 在主 checkout 与 worktree 里都解析到**主仓** .git 目录，
# 这正好也是我们要的语义：hooks 是仓库级共享的（git 不支持 per-worktree hooks），
# 主仓装一次，全部 worktree 生效。
DST_DIR="$(git rev-parse --git-common-dir)/hooks"

if [ ! -d "$SRC_DIR" ]; then
  echo "❌ 找不到 $SRC_DIR"
  exit 1
fi

mkdir -p "$DST_DIR"

for src in "$SRC_DIR"/*.sh; do
  [ -e "$src" ] || continue
  name=$(basename "$src" .sh)
  dst="$DST_DIR/$name"
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "✅ installed: $dst"
done

echo ""
echo "已安装："
echo "  pre-commit  B6-10 数据污染扫描 + T-3.8 参考页反漂移对账 + Agent Note 形态校验"
echo "  pre-push    holdout 泄露检测 + T-3.9 站点构建（死链门禁）+ P0-3 北极星生成块陈旧检测"
echo "完成。要禁用某个 hook，加 --no-verify 跳过单次，或删除 $DST_DIR/<name>"
