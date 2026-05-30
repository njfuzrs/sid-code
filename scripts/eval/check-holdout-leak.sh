#!/bin/sh
# F-H5: 检测 evals/CASES.md / evals/DASHBOARD.md 是否含 holdout 题面/锚点/答案
#
# 用法（pre-push 调用）:
#   sh scripts/eval/check-holdout-leak.sh && echo "OK"
#
# 退出码:
#   0 = 无泄露
#   1 = 检测到 holdout 题面字符串泄露,push 应被 block
#
# 检测策略:
#   1. 扫所有 holdout/* yaml,提取 must_include_any_of / must_not_include / user_query / reference_answer
#   2. 把这些 token 在 evals/CASES.md / evals/DASHBOARD.md 里 grep
#   3. 任一命中 → 视为泄露
#
# 误报豁免:
#   - holdout case 的 id 字段允许出现(只锁题面/答案/锚点);
#   - 公共词/常见词由长度 ≥ 5 字符过滤(短词抑噪).

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

PUBLIC_FILES="evals/CASES.md evals/DASHBOARD.md"

if [ ! -d "evals/holdout" ] && ! ls evals/holdout/architecture/ >/dev/null 2>&1; then
  exit 0
fi

# 在 bun 环境下用 ts 脚本提取(避免 yaml 解析靠 grep 误报)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

bun run scripts/eval/extract-holdout-tokens.ts > "$TMP" 2>/dev/null || {
  echo "[check-holdout-leak] ⚠️  无法运行 extract-holdout-tokens.ts,fallback 跳过"
  exit 0
}

LEAKS=0
while IFS= read -r token; do
  [ -z "$token" ] && continue
  for f in $PUBLIC_FILES; do
    [ -f "$f" ] || continue
    if grep -F -q -- "$token" "$f"; then
      echo "[check-holdout-leak] ❌ $f 含 holdout token: '$token'"
      LEAKS=$((LEAKS + 1))
    fi
  done
done < "$TMP"

if [ "$LEAKS" -gt 0 ]; then
  echo ""
  echo "[check-holdout-leak] ❌ 检测到 $LEAKS 处 holdout 题面泄露,push 中止"
  echo "  修复:① 检查 gen-cases-md.ts 的 holdout 渲染分支(F-H1);"
  echo "       ② 检查 dashboard render holdout 行(F-H6);"
  echo "       ③ 必要时 \`git rm --cached evals/CASES.md\` 后 regen"
  exit 1
fi

exit 0
