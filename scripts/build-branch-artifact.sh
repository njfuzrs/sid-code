#!/usr/bin/env bash
#
# 编一个「当前 commit 的」评测产物，放进 dist/branch-builds/<branch-slug>-<commit12>/。
#
#   用法: scripts/build-branch-artifact.sh [--target <bun-target>] [--no-tarball]
#
# ## 为什么需要它（而不是「make build 就行了」）
#
# `make build` 编的是**宿主平台**的产物，而评测需要 `linux-x64-baseline`
# （arm64 mac + qemu 是常态，官方 SWE-bench 镜像只发 amd64）。
# 而 `release.sh` 会 bump 版本号 —— 为了跑一轮评测而 bump 一个版本号是荒谬的。
#
# 中间这个位置此前是空的，人只能手抄一条 `bun build --compile ...` 长命令。
# 手抄的后果实测过三种，全都是**静默的**：
#   ① 漏 `--target=...-baseline` → qemu 里一启动 SIGILL(132)，
#      而 core dump 被 `git add -A` 收进 patch → 一次崩溃被记成「产出了 patch」；
#   ② 漏跑 `fetch-ripgrep.ts` → 产物不含内嵌 rg，容器里没有系统 rg 时工具直接不可用；
#   ③ 漏 `--define SID_CODE_BUILD_INFO` → 产物没有身份 → G1 门禁一律退化到 mtime 兜底，
#      形态是「门禁看起来在跑、实际全在走兜底路径」。
#
# ## 目录名不是身份
#
# `<branch-slug>-<commit12>` 只是**人肉可读的索引**（让 `ls` 一眼看出有哪些包）。
# 判据的唯一输入是**产物字节里那 40 位 commit** —— 门禁一律读字节，绝不解析目录名。
# 目录名撞了最多是覆盖一个包（重编一次即可），而判据读错 commit 会让整轮评测的归因错掉。
#
# 顺带一个已知的冗余：同一 commit 在两条分支上编会得到两个目录
# （`main-abc…` 与 `fix-x-abc…`），内容基本相同只差 `branch` 字段。冗余但无害。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUN_TARGET="bun-linux-x64-baseline"
MAKE_TARBALL=true

while [ $# -gt 0 ]; do
    case "$1" in
        --target) BUN_TARGET="${2:?--target 需要一个 bun target}"; shift 2 ;;
        --no-tarball) MAKE_TARBALL=false; shift ;;
        -h | --help)
            sed -n '2,8p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *) echo "未知参数: $1" >&2; exit 64 ;;
    esac
done

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠️\033[0m  %s\n' "$1" >&2; }
fail() { printf '  \033[31m❌\033[0m %s\n' "$1" >&2; exit 1; }

# ─── 目录名（人肉索引，不是身份）───
COMMIT="$(git rev-parse HEAD)"
COMMIT12="${COMMIT:0:12}"
BRANCH_SLUG="$(git rev-parse --abbrev-ref HEAD |
    tr -c 'A-Za-z0-9' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-32)"
[ -n "$BRANCH_SLUG" ] || BRANCH_SLUG="detached"
OUT_DIR="$ROOT/dist/branch-builds/${BRANCH_SLUG}-${COMMIT12}"

echo "=== 分支包：${BRANCH_SLUG}-${COMMIT12} (${BUN_TARGET}) ==="
if [ -n "$(git status --porcelain)" ]; then
    warn "工作区不干净 —— 产物的 commit 只描述基线，改动内容无记录（dirty=true 会编进身份，报告会点破）"
fi

mkdir -p "$OUT_DIR"

# ─── 编译前的三个生成步骤 ───
#
# ⚠️ 这三步不是"顺手做的优化"，漏任何一步产物都会缺东西而**编译照样成功**：
#   · embed-builtin-skills  → 缺了内置 skill 全部消失（硬失败：import 不到）
#   · fetch-ripgrep         → 缺了不含内嵌 rg（软失败：运行时回退系统 rg，容器里通常没装）
#   · gen-model-catalog     → 缺了 `bun build` 直接 Could not resolve
# 与 Makefile 的 `build` 目标保持同一组（含 `-` 前缀那两个的可失败语义）。
info "生成内置 skill 内联文件 ..."
bun run scripts/embed-builtin-skills.ts || fail "embed-builtin-skills 失败"
info "放置内嵌 ripgrep ..."
bun run scripts/fetch-ripgrep.ts --as-embed ||
    warn "fetch-ripgrep 失败 —— 产物不含内嵌 rg，容器里没有系统 rg 时工具会不可用"
info "生成模型目录快照 ..."
bun run scripts/gen-model-catalog-snapshot.ts ||
    warn "gen-model-catalog-snapshot 失败 —— 若 vendor 快照已存在则沿用旧的"

# rg 的 vendor 文件按**平台**命名（rg-linux-x64），没有 baseline 变体 ——
# baseline 只是 CPU 指令集基线的差别，同一平台的 rg 通用。不剥这个后缀会去找一个
# 不存在的 `rg-linux-x64-baseline`，然后产物**静默不含内嵌 rg**（与 release.sh 同一处坑）。
RG_VERSION="$(bun run scripts/fetch-ripgrep.ts --print-version)"
PLATFORM="${BUN_TARGET#bun-}"
RG_PLATFORM="${PLATFORM%-baseline}"
RG_VENDOR="$ROOT/packages/core/vendor/ripgrep/${RG_VERSION}/rg-${RG_PLATFORM}"
if [ -f "$RG_VENDOR" ]; then
    cp "$RG_VENDOR" "$ROOT/packages/core/vendor/rg-embed"
    chmod +x "$ROOT/packages/core/vendor/rg-embed"
    ok "内嵌 rg: rg-${RG_PLATFORM} (${RG_VERSION})"
else
    warn "没有 vendor/ripgrep/${RG_VERSION}/rg-${RG_PLATFORM} —— 本产物不含内嵌 rg"
fi

# ─── 构建身份 ───
# origin=local：它不是发布流程编的，所以发布通道门禁（G2）会拒绝它上通道 —— 这是对的。
# 但 G1（评测）**刻意不要求 origin=release**：评测是发版的前置门禁，
# 要求"先发版才能评测"会死锁。
BUILD_INFO_LINE="$(scripts/build-info-line.sh local)" ||
    fail "拼构建身份失败 —— 产物会没有身份、G1 会退化到 mtime 兜底，拒绝继续"

# ⚠️ 两个 define 都必须带：
#   NODE_ENV            不带则产物跑 React development build，console.error 刷用户的屏
#   SID_CODE_BUILD_INFO 不带则产物没身份，G1 全程走 mtime 兜底
# 防漂移哨兵：tests/build/node-env-define.test.ts + tests/build/build-info-define.test.ts
info "编译 ${BUN_TARGET} ..."
bun build --compile --target="$BUN_TARGET" \
    --define process.env.NODE_ENV='"production"' \
    --define process.env.SID_CODE_BUILD_INFO="\"$BUILD_INFO_LINE\"" \
    --outfile "$OUT_DIR/sid-code" \
    packages/cli/src/entrypoints/bootstrap.ts || fail "bun build 失败"
chmod +x "$OUT_DIR/sid-code"

# ─── 自证：产物里真的能读回身份 ───
#
# 这一步不能省。漏带 define 时**构建照样 exit 0**，只有几天后 G1 把产物读成
# 「没有身份」时才会发现，而那时它已经静默走了 N 轮 mtime 兜底。
_read="$(bun run scripts/artifact-identity.ts read "$OUT_DIR/sid-code")" ||
    fail "读不回产物身份"
case "$_read" in
    *'"identity_source": "embedded"'*) ok "产物身份可读回（embedded）" ;;
    *) fail "产物里读不到构建身份（identity_source != embedded）—— define 没生效，拒绝交付这个包" ;;
esac

# ─── 旁路 build-info.json（**不是事实源**）───
#
# 它存在只为一件事：不解包、不 grep 就能 `ls` 出一目录里都有什么。
# 产物字节里那一行才是事实源 —— 所以必须能检测到两者不一致（G1 的 sidecar-mismatch），
# 一个会骗人的索引比没有索引更糟。
printf '%s\n' "$_read" > "$OUT_DIR/build-info.json"

if [ "$MAKE_TARBALL" = true ]; then
    # 打包成 `sid-code/sid-code`，与 release.sh 的 tarball 结构一致 ——
    # `resolve_binary()` 按 `find -name 'sid-code*'` 取，结构不一致会取不到。
    STAGING="$(mktemp -d)"
    mkdir -p "$STAGING/sid-code"
    cp "$OUT_DIR/sid-code" "$STAGING/sid-code/sid-code"
    chmod +x "$STAGING/sid-code/sid-code"
    TARBALL="$OUT_DIR/sid-code-${PLATFORM}.tar.gz"
    tar -czf "$TARBALL" -C "$STAGING" sid-code
    rm -rf "$STAGING"
    if command -v shasum >/dev/null 2>&1; then
        (cd "$OUT_DIR" && shasum -a 256 "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
    elif command -v sha256sum >/dev/null 2>&1; then
        (cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
    fi
    ok "$(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"
fi

echo ""
ok "分支包已就位：${OUT_DIR#"$ROOT"/}"
echo ""
echo "  跑评测（artifact_for() 的查找顺序 ③ 会自动挑到当前 commit 的包）："
echo "    bash evals/external-benchmarks/swe-bench/exec-swebench.sh run <run_id>"
echo ""
echo "  指定某个别的包："
echo "    SWE_BUILD_REF=${COMMIT12} bash .../exec-swebench.sh run <run_id>"
