#!/bin/sh
# 安装 scripts/git-hooks/ 下的脚本到 .git/hooks/
#
# 用法：bun run install-hooks
# 或：sh scripts/install-git-hooks.sh

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
SRC_DIR="$REPO_ROOT/scripts/git-hooks"
DST_DIR="$REPO_ROOT/.git/hooks"

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
echo "已安装：pre-commit (B6-10 数据污染扫描) / pre-push (holdout 泄露检测 + dashboard 刷新)"
echo "完成。要禁用某个 hook，加 --no-verify 跳过单次，或删除 $DST_DIR/<name>"
