#!/bin/sh
# B7-3 holdout sid 名单完整性校验（sha256 + line count + grep 防泄露）
#
# 用法：
#   sh scripts/eval/check-holdout-real-tasks-sealed.sh
#
# 退出码：
#   0 = 完整且无泄露
#   1 = 文件被改 / 校验和不等 / 公开页面命中 sid → push 中止
#
# 设计依据：路线 §9.1.2（holdout 永封）+ §9.1.1（白名单字段铁律）

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

SEALED="evals/holdout/real-tasks/holdout-sids.txt"
EXPECTED_SHA="11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc"
EXPECTED_LINES=200

if [ ! -f "$SEALED" ]; then
  echo "[check-holdout-sealed] ⚠️  $SEALED 不存在，跳过（M4 之前可能未落地）"
  exit 0
fi

# Step 1: line count 必须等于 200
ACTUAL_LINES=$(wc -l < "$SEALED" | tr -d ' ')
if [ "$ACTUAL_LINES" != "$EXPECTED_LINES" ]; then
  echo "[check-holdout-sealed] ❌ $SEALED 行数=$ACTUAL_LINES 期望=$EXPECTED_LINES"
  echo "  说明：holdout 永封文件被改，违反路线 §9.1.2 铁律"
  exit 1
fi

# Step 2: sha256 必须等于永封时刻
ACTUAL_SHA=$(shasum -a 256 "$SEALED" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[check-holdout-sealed] ❌ $SEALED sha256 不匹配"
  echo "  期望: $EXPECTED_SHA"
  echo "  实际: $ACTUAL_SHA"
  echo "  说明：holdout 永封文件内容被改，违反路线 §9.1.2 铁律"
  echo "  修复：git checkout HEAD -- $SEALED"
  exit 1
fi

# Step 3: 公开页面（CASES.md / DASHBOARD.md）不能含任何 holdout sid 短码
PUBLIC_FILES="evals/CASES.md evals/DASHBOARD.md evals/eval-dashboard.html evals/eval-data.json"
LEAKS=0
while IFS= read -r short_sid; do
  [ -z "$short_sid" ] && continue
  for f in $PUBLIC_FILES; do
    [ -f "$f" ] || continue
    if grep -F -q -- "$short_sid" "$f" 2>/dev/null; then
      echo "[check-holdout-sealed] ❌ $f 含 holdout sid: '$short_sid'"
      LEAKS=$((LEAKS + 1))
    fi
  done
done < "$SEALED"

if [ "$LEAKS" -gt 0 ]; then
  echo ""
  echo "[check-holdout-sealed] ❌ 公开页面 $LEAKS 处 holdout sid 泄露，push 中止"
  echo "  修复：① regen DASHBOARD.md（不应渲染 holdout sid）"
  echo "       ② 若 case yaml 误用 holdout sid 作为 anchor，删除该字段"
  exit 1
fi

exit 0
