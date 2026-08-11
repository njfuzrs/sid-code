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

# Step 3: 公开页面不能含任何 holdout sid 短码
#
# T-3.7：website/ 一并纳入。它是 2026-07 新增的对外站点，会构建成静态站挂公网，
# 公开程度高于 evals/CASES.md。参考页虽由脚本从源码生成，但生成器读的就是源码——
# 源码里出现过 holdout sid 就会被带出去，正是门禁该守的地方。
# 用 find 展开而非写死 glob：未匹配的 glob 在 sh 下原样留下成为不存在的文件名，
# 会被下方 [ -f ] 静默跳过，从而掩盖"目录改名后再也没扫到"的失效。
PUBLIC_FILES="evals/CASES.md evals/DASHBOARD.md evals/eval-dashboard.html evals/eval-data.json"
if [ -d "website" ]; then
  WEBSITE_PUBLIC=$(find website -name node_modules -prune -o -name '.vitepress' -prune -o -name '*.md' -print 2>/dev/null || true)
  [ -f "website/public/llms.txt" ] && WEBSITE_PUBLIC="$WEBSITE_PUBLIC website/public/llms.txt"
  PUBLIC_FILES="$PUBLIC_FILES $WEBSITE_PUBLIC"
fi
# 每个文件只起一次 grep（`-f` 一次性喂全部 200 个 sid），而不是「sid × 文件」两层循环。
# 纳入 website/ 的 30+ 页后，两层循环会变成 200×36 ≈ 7200 次 grep 进程，实测把本脚本
# 从 0.8s 拖到 12.8s，直接撞穿 tests/eval/check-holdout-real-tasks-sealed.test.ts 的 5s 超时。
# 门禁跑得慢就会被 --no-verify 绕过，所以这里的性能是正确性的一部分。
LEAKS=0
SIDS=$(mktemp)
trap 'rm -f "$SIDS"' EXIT
grep -v '^[[:space:]]*$' "$SEALED" > "$SIDS" || true

# 一次性把**全部文件**喂给同一个进程，且优先用 ripgrep。
#
# 2026-08-11 实测（88 个公开文件 × 200 个 sid 模式）：
#   逐文件循环 BSD grep   4.7 ~ 4.9s   ← 卡在 5s 超时线上，间歇性红
#   一次性 BSD grep       4.1 ~ 4.3s   ← 仍然危险
#   一次性 ripgrep        0.01s        ← 快 400 倍
#
# **成本主项是「200 个 -F 模式的匹配」本身，不是进程启动**（这一点最初判断反了：
# 把逐文件循环合成一次调用只省了 0.7s，说明 88 次 fork 根本不是瓶颈）。
# BSD grep 对多模式 `-F -f` 没有 Aho-Corasick 之类的多模式自动机，退化成近似
# 「模式数 × 文本量」；ripgrep 有，所以差距是数量级而非常数倍。
#
# 为什么这点性能算正确性问题：原先那条用例并发跑全量单测时红、单跑时绿
# —— 间歇性红比稳定红更糟，它训练人把失败当噪音，最终整道门禁失去可信度。
#
# 保留 grep 兜底：CI 或干净容器里可能没有 rg。兜底路径慢但结果等价，
# 两条路径的输出格式都统一成 `文件:sid`（grep 用 `-H` 强制带文件名前缀 ——
# grep 只在收到**多个**文件时才自动加前缀，「恰好只剩一个公开文件」时格式会静默
# 变化，下面按 `文件:sid` 切分的逻辑就会把 sid 当成文件名报错，指向错误的修复方向）。
if [ -s "$SIDS" ]; then
  # 只保留真实存在的文件：不存在的路径会让 grep/rg 往 stderr 抱怨并影响退出码。
  EXISTING=""
  for f in $PUBLIC_FILES; do
    [ -f "$f" ] && EXISTING="$EXISTING $f"
  done

  if [ -n "$EXISTING" ]; then
    # shellcheck disable=SC2086
    if command -v rg >/dev/null 2>&1; then
      HITS=$(rg -F -f "$SIDS" --no-heading --with-filename -o $EXISTING 2>/dev/null | sort -u || true)
    else
      HITS=$(grep -H -F -o -f "$SIDS" $EXISTING 2>/dev/null | sort -u || true)
    fi
    if [ -n "$HITS" ]; then
      # 逐行报告，保持与原来一致的「每处一行」输出（下游只看退出码，但人要看得懂）
      OLD_IFS=$IFS
      IFS='
'
      for hit in $HITS; do
        HIT_FILE=${hit%%:*}
        HIT_SID=${hit#*:}
        echo "[check-holdout-sealed] ❌ $HIT_FILE 含 holdout sid: '$HIT_SID'"
        LEAKS=$((LEAKS + 1))
      done
      IFS=$OLD_IFS
    fi
  fi
fi

if [ "$LEAKS" -gt 0 ]; then
  echo ""
  echo "[check-holdout-sealed] ❌ 公开页面 $LEAKS 处 holdout sid 泄露，push 中止"
  echo "  修复：① regen DASHBOARD.md（不应渲染 holdout sid）"
  echo "       ② 若 case yaml 误用 holdout sid 作为 anchor，删除该字段"
  exit 1
fi

exit 0
