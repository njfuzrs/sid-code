#!/usr/bin/env bash
#
# 拼出一行构建身份，供 `bun build --compile --define process.env.SID_CODE_BUILD_INFO=` 使用。
#
#   用法: scripts/build-info-line.sh <origin>       origin ∈ local | ci | release
#   输出: SIDCODE_BUILD_V1|commit=<40hex>|branch=<slug>|describe=<str>|dirty=<bool>|...
#
# ## 为什么是一个独立脚本而不是在各处内联一段 shell
#
# 有三个构建入口要拼这一行（Makefile / release.sh / 分支包脚本），而拼这一行的难点
# **全在 slug 化**：分支名可能含 `/`，builder 可能含空格或中文，任何一个漏处理都会
# 切坏那一行 —— 而切坏的形态是**从截断点往后的字段静默丢失**，构建照样成功。
# 内联三份等于给这个坑留三个入口。
#
# 语义与格式的完整说明（含"为什么 commit 必须是第一个字段"、
# "为什么默认值前缀必须与真值不同"）在 packages/shared/src/build-info.ts 的文件头。
# 那里是事实源，本脚本只负责取数。
#
# ⚠️ 值域只允许 [A-Za-z0-9=|:._@+/-]。所有从 git / 环境取来的值都必须过 slug 化，
# **不要**因为"我这台机器上分支名很干净"就跳过。

set -euo pipefail

ORIGIN="${1:-local}"
case "$ORIGIN" in
local | ci | release) ;;
*)
  echo "build-info-line.sh: origin 必须是 local|ci|release（收到 '$ORIGIN'）" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# slug 化：把不在值域里的字符统一换成 `-`，再折叠连续的 `-`、去掉首尾的 `-`。
# 截断长度由调用方按字段决定（分支名 32、builder 64、dirty_files 200）。
slug() {
  local s="$1" max="${2:-64}"
  s="$(printf '%s' "$s" | tr -c 'A-Za-z0-9._@+/-' '-')"
  s="$(printf '%s' "$s" | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
  s="$(printf '%s' "$s" | cut -c "1-$max")"
  # 截断可能又在末尾留下 `-`，再削一次
  printf '%s' "${s%-}"
}

# ── commit：40 位全长。不用 short —— 12 位在大仓有碰撞风险，且拼不回全长。
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
case "$COMMIT" in
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
*) COMMIT="unknown" ;;
esac

# ── branch：detached HEAD 时 git 输出 `HEAD`，如实记（不要编一个分支名）。
BRANCH="$(slug "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" 32)"
[ -n "$BRANCH" ] || BRANCH="unknown"

# ── describe：人读友好（`v0.1.601-59-g454cf79c` 一眼看出版本号后面还挂 59 个提交）。
# ⚠️ 只作展示。它依赖本地有 tag —— CI 的 shallow clone（无 fetch-depth: 0）里会
# 静默退化成裸 hash，**格式突变而不报错**。所以判据一律用 commit，不用它。
DESCRIBE="$(slug "$(git describe --tags --always --dirty 2>/dev/null || echo unknown)" 48)"
[ -n "$DESCRIBE" ] || DESCRIBE="unknown"

# ── dirty + dirty_files
# 发布产物的 dirty **必然是 true**：release.sh 的真实顺序是
# 「洁净门禁 → bump（改 package.json，工作区变脏）→ 构建」。
# 所以发布通道门禁不能写成 `dirty == false`（那会 100% 误拦每次真实发版，
# 然后被人加 flag 绕过），而要断言"脏的文件恰好只有 package.json" —— 这需要 dirty_files。
PORCELAIN="$(git status --porcelain 2>/dev/null || true)"
if [ -n "$PORCELAIN" ]; then
  DIRTY=true
  # porcelain 的前 3 列是状态位，路径从第 4 列起。
  # ⚠️ 路径之间用 `+` 分隔而不是逗号：逗号不在值域字符类里（会被 slug 换成 `-`，
  # 而 `-` 本身就出现在路径里 → 消费方切不开）。`+` 在值域里且不出现在本仓路径中。
  DIRTY_FILES="$(printf '%s\n' "$PORCELAIN" | cut -c4- | sed 's/ -> /+/' | tr '\n' '+')"
  DIRTY_FILES="$(slug "$DIRTY_FILES" 200)"
  DIRTY_FILES="${DIRTY_FILES%+}"
else
  DIRTY=false
  DIRTY_FILES=""
fi

# ── built_at：UTC。⚠️ 只作展示，不作判据（判据用 commit —— `cp` 会重置 mtime，
# 时间戳同理不能证明"这份字节多新"）。
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── builder：谁打的包。CI 上 `$USER` 是 `runner`，没有信息量，改记 workflow run id。
if [ "$ORIGIN" = "ci" ]; then
  BUILDER="$(slug "ci-${GITHUB_RUN_ID:-unknown}-${GITHUB_RUN_ATTEMPT:-1}" 64)"
else
  BUILDER="$(git config user.email 2>/dev/null || true)"
  [ -n "$BUILDER" ] || BUILDER="${USER:-unknown}@$(hostname -s 2>/dev/null || echo unknown)"
  BUILDER="$(slug "$BUILDER" 64)"
fi
[ -n "$BUILDER" ] || BUILDER="unknown"

# ⚠️ 字段顺序不是随意的：commit 必须是第一个。
# 任何值域事故都从截断点往后丢字段，把最关键的字段放最前面，
# 坏的方式至少是可预期的（判据还能用，只是辅助字段丢了）。
LINE="SIDCODE_BUILD_V1|commit=${COMMIT}|branch=${BRANCH}|describe=${DESCRIBE}|dirty=${DIRTY}|built_at=${BUILT_AT}|builder=${BUILDER}|origin=${ORIGIN}"

# dirty_files 只在发布产物上带：G2 需要它来区分「bump 造成的脏」与「真带着未提交代码发版」。
# 其它场景不带是刻意的 —— 本地开发工作区常年脏，带上只会把这一行撑长。
if [ "$ORIGIN" = "release" ] && [ -n "$DIRTY_FILES" ]; then
  LINE="${LINE}|dirty_files=${DIRTY_FILES}"
fi

# 自证：拼完的这一行必须能被嗅探正则完整取回。
# 不做这一步的话，slug 化漏掉某个字符时**构建照样成功**，
# 只有几天后门禁把产物读成半截身份时才会发现。
# ⚠️ 字符类必须与 packages/shared/src/build-info.ts 的 BUILD_INFO_VALUE_CLASS 完全一致
# （特别是**不含 `]`** —— 那个字符在 JS 正则里会让整个类变成空类、恒不匹配）。
# 两处一致性由 tests/build/build-info-define.test.ts 锁住。
if ! printf '%s' "$LINE" | LC_ALL=C grep -q "^SIDCODE_BUILD_V1|commit=[A-Za-z0-9=|:._@+/-]*$"; then
  echo "build-info-line.sh: 拼出的身份行含值域外字符，会被嗅探截断，拒绝输出：" >&2
  printf '%s\n' "$LINE" >&2
  exit 3
fi

printf '%s' "$LINE"
