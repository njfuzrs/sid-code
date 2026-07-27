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

# 公开面清单。website/ 是 2026-07 新增的对外站点（T-3.7）——它比 evals/CASES.md
# 更"公开"：会构建成静态站挂上公网。参考页由脚本从源码生成，理论上不会带 holdout
# 题面，但"理论上不会"正是需要门禁的地方（生成器读的是源码，源码里出现过 holdout
# 相关串就会被带出去）。
#
# 用 find 展开而非写死 glob：PUBLIC_FILES 靠 shell 分词遍历，
# 未匹配的 glob 在 sh 下会原样留下（成为不存在的文件名），靠下方 [ -f ] 兜底虽不报错，
# 但会掩盖"目录改名后再也没扫到"的静默失效。find 拿不到就是空，语义更干净。
PUBLIC_FILES="evals/CASES.md evals/DASHBOARD.md"
if [ -d "website" ]; then
  WEBSITE_MD=$(find website -name node_modules -prune -o -name '.vitepress' -prune -o -name '*.md' -print 2>/dev/null || true)
  # llms.txt 也是生成物且会被公网抓取，一并纳入
  [ -f "website/public/llms.txt" ] && WEBSITE_MD="$WEBSITE_MD website/public/llms.txt"
  PUBLIC_FILES="$PUBLIC_FILES $WEBSITE_MD"
fi

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
