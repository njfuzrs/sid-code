#!/bin/bash
# scripts/release.sh — sid-code 跨平台构建 + 打包 + 发布
#
# 用法：
#   ./scripts/release.sh                        # 门禁(bun test)+bump 版本号+构建 4 目标并打包到 dist/release/
#   ./scripts/release.sh --upload                # 打包后上传到服务器
#   ./scripts/release.sh --no-bump               # 复用当前版本号，不再 bump（配合先跑过 make build 的场景）
#   ./scripts/release.sh --skip-test             # 跳过发布前 bun test 门禁（不推荐，仅救急）
#   ./scripts/release.sh --upload-team-defaults <file>  # 单独上传团队默认配置（不打版本号）
#   ./scripts/release.sh --upload-ripgrep <dir> <version>  # 单独上传预编译 ripgrep 二进制（不打版本号）
#
# 发布前门禁：默认先跑 `bun test` 全量单测，失败即中止（坏版本不会推到 latest.txt）。
#   构建完成后还会对「当前平台」的产物做一次 --version 冒烟，挡住产物损坏/无法执行的情况。
#   加 --skip-test 可跳过单测（救急用），冒烟测试始终执行、不可跳过。
#
# 内嵌 ripgrep（仓库本地优先，联网仅作缺失时回退，best-effort 不阻断发布）：
#   vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库，`fetch-ripgrep.ts --all`
#   优先直接复用（全程不联网）；仓库内缺失（如刚 bump 版本号还没提交）才回退联网下载。
#   每个 target 编译前把对应平台的二进制放到 vendor/rg-embed（bun --compile 的固定嵌入
#   import 路径，见 src/tool/rg-embedded.ts）。仓库内和服务器都没有对应二进制/版本时不
#   阻断发布，仅让该 target 的产物不含内嵌 rg（运行时透明回退系统 rg，与本功能上线前行为一致）。
#   升级 rg 版本：改 fetch-ripgrep.ts 的 DEFAULT_RG_VERSION → 跑 --all 下载新版本
#   → git add vendor/ripgrep/<新版本>/ 提交入库（可选再用 --upload-ripgrep 同步一份到服务器作为团队备用源）。
#
# Changelog + Git Tag：bump 版本号之后、构建之前，脚本会自动
#   ① 跑 scripts/generate-changelog.ts 从 git 历史生成 CHANGELOG.md（文本事实源，仓库根，
#      累积追踪）+ CHANGELOG.html（科技风网页，可直接点开，含 commit body 细节/分组/搜索）
#   ② 打 annotated tag vX.Y.Z 到当前 HEAD
#   --upload 时额外把 CHANGELOG.md + CHANGELOG.html 传到服务器顶层、并在上传成功后 push tag。
#   两者失败都不阻断发布（非致命 warn）；tag/changelog 幂等，--no-bump 复用版本安全。
#
# 版本号 bump 规则：release.sh 默认自增 patch 版本号一次。若你已经先跑过 make build
#   （它内部也会 bump），再直接 release 会导致版本号 +2；此时加 --no-bump 复用现有版本号。
#   推荐做法：不要先 make build，直接 ./scripts/release.sh --upload（一次 bump 到位）。
#
# 环境变量（--upload 时使用）：
#   DEPLOY_SSH_HOST         服务器地址（分发 host 的唯一权威，install.sh 的下载地址由它派生）
#   DEPLOY_SSH_USER         SSH 用户（必填，无默认值）
#   DEPLOY_SSH_PASSWORD     SSH 密码（可选，配置后用 sshpass 免交互上传；留空则交互式输入）
#   DEPLOY_PATH             服务器上的发布目录（默认 /var/www/html/releases/sid-code，
#                           对齐 nginx sites-enabled/default 的 root /var/www/html;）
#   DEPLOY_RG_PATH          服务器上预编译 ripgrep 二进制目录
#                           （默认 /var/www/html/vendor-bin/ripgrep，与 releases 版本目录隔离，
#                           不受旧版本清理逻辑影响；对应 fetch-ripgrep.ts 的下载根）
#   RELEASE_KEEP_VERSIONS   服务器端保留的历史版本数（默认 5，上传后清理更旧的版本目录）
#
#   凭据来源：脚本启动时自动 source scripts/deploy.env（不入库，见 deploy.env.example 模板）。
#   环境变量优先级高于 deploy.env 文件（已导出的同名变量不会被文件覆盖）。
#
# 设计要点（见 docs/install-guide.md 与 plan）：
#   - bump-version.ts / embed-builtin-skills.ts 全程只各跑一次，4 个目标复用同一份
#     版本号与内嵌 skill 产物，避免 4 个二进制的 --version 互不一致
#   - 每个目标独立输出路径（bun build --outfile 不会自动按 target 加后缀）
#   - install.sh 的 RELEASE_BASE 由 DEPLOY_SSH_HOST 在拷贝时注入，服务器地址只需改一处
#   - team-defaults.json 不随常规发布上传，避免用仓库里的占位模板覆盖服务器上的真实配置；
#     只能通过 --upload-team-defaults 显式单独推送
#   - vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库随仓库版本化，常规发布无需联网；
#     升级 rg 版本才需要 --upload-ripgrep 把新版本同步一份到服务器，供他人 fetch-ripgrep.ts
#     首次下载填充本地仓库副本时使用

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT/dist"
BUILD_DIR="$DIST_DIR/build"
RELEASE_DIR="$DIST_DIR/release"

# 加载本地凭据文件（不入库）。已在环境中导出的同名变量优先于文件值，
# 因此这里只对「未设置」的变量生效——用 : "${VAR:=...}" 的 source 无法实现，
# 故先记录已存在的值，source 后再恢复。
ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
    _pre_host="${DEPLOY_SSH_HOST:-}"
    _pre_user="${DEPLOY_SSH_USER:-}"
    _pre_pass="${DEPLOY_SSH_PASSWORD:-}"
    _pre_path="${DEPLOY_PATH:-}"
    _pre_rg_path="${DEPLOY_RG_PATH:-}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    # 恢复调用方显式导出的值（环境变量优先级更高）
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
    [ -n "$_pre_path" ] && DEPLOY_PATH="$_pre_path"
    [ -n "$_pre_rg_path" ] && DEPLOY_RG_PATH="$_pre_rg_path"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-121.196.144.227}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/releases/sid-code}"
DEPLOY_RG_PATH="${DEPLOY_RG_PATH:-/var/www/html/vendor-bin/ripgrep}"
RELEASE_KEEP_VERSIONS="${RELEASE_KEEP_VERSIONS:-5}"

# ripgrep 版本号从 fetch-ripgrep.ts 的 DEFAULT_RG_VERSION 读取（唯一事实源，避免两处硬编码漂移）
RG_VERSION="$(bun run "$SCRIPT_DIR/fetch-ripgrep.ts" --print-version)"

# bun-<os>-<arch> target → 打包命名用的 <os>-<arch>
TARGETS=(
    "bun-darwin-arm64:darwin-arm64"
    "bun-darwin-x64:darwin-x64"
    "bun-linux-x64:linux-x64"
    "bun-linux-arm64:linux-arm64"
)

DO_UPLOAD=false
DO_UPLOAD_TEAM_DEFAULTS=false
TEAM_DEFAULTS_FILE=""
DO_UPLOAD_RIPGREP=false
RIPGREP_DIR=""
RIPGREP_VERSION=""
DO_BUMP=true
DO_TEST=true

while [ $# -gt 0 ]; do
    case "$1" in
        --upload) DO_UPLOAD=true; shift ;;
        --no-bump) DO_BUMP=false; shift ;;
        --skip-test) DO_TEST=false; shift ;;
        --upload-team-defaults)
            DO_UPLOAD_TEAM_DEFAULTS=true
            TEAM_DEFAULTS_FILE="${2:-}"
            [ -n "$TEAM_DEFAULTS_FILE" ] || { echo "错误: --upload-team-defaults 需要传入文件路径"; exit 1; }
            shift 2
            ;;
        --upload-ripgrep)
            DO_UPLOAD_RIPGREP=true
            RIPGREP_DIR="${2:-}"
            RIPGREP_VERSION="${3:-}"
            [ -n "$RIPGREP_DIR" ] && [ -n "$RIPGREP_VERSION" ] \
                || { echo "错误: --upload-ripgrep 需要传入目录路径和版本号: --upload-ripgrep <dir> <version>"; exit 1; }
            shift 3
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

info()  { echo "  $*"; }
ok()    { echo "  ✅ $*"; }
warn()  { echo "  ⚠️  $*" >&2; }
fail()  { echo "  ❌ $*" >&2; exit 1; }

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "找不到 sha256sum 或 shasum"
    fi
}

# 当前机器对应的打包平台标识（darwin-arm64 等），用于对本平台产物做冒烟测试
self_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux)  os="linux" ;;
        *)      echo ""; return ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64)  arch="x64" ;;
        *)             echo ""; return ;;
    esac
    echo "${os}-${arch}"
}

require_ssh_user() {
    [ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER（在 scripts/deploy.env 或环境变量中，SSH 到 $DEPLOY_SSH_HOST 用哪个账号）"
}

# ssh/scp 包装：配置了 DEPLOY_SSH_PASSWORD 时用 sshpass 免交互，否则回退为普通调用（交互式输密码）。
_SSH_OPTS=(-o StrictHostKeyChecking=no)
if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
    command -v sshpass >/dev/null 2>&1 || fail "已配置 DEPLOY_SSH_PASSWORD 但未安装 sshpass（macOS: brew install sshpass）"
fi

run_ssh() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        sshpass -p "$DEPLOY_SSH_PASSWORD" ssh "${_SSH_OPTS[@]}" "$@"
    else
        ssh "${_SSH_OPTS[@]}" "$@"
    fi
}

run_scp() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        sshpass -p "$DEPLOY_SSH_PASSWORD" scp "${_SSH_OPTS[@]}" "$@"
    else
        scp "${_SSH_OPTS[@]}" "$@"
    fi
}

# ─── 单独上传团队默认配置（不涉及版本构建）───

if [ "$DO_UPLOAD_TEAM_DEFAULTS" = true ]; then
    [ -f "$TEAM_DEFAULTS_FILE" ] || fail "文件不存在: $TEAM_DEFAULTS_FILE"
    require_ssh_user
    echo ">>> 上传团队默认配置 $TEAM_DEFAULTS_FILE ..."
    run_scp "$TEAM_DEFAULTS_FILE" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/team-defaults.json"
    ok "team-defaults.json 已更新"
    exit 0
fi

# ─── 单独上传预编译 ripgrep 二进制（不涉及版本构建）───
# 目录内按平台命名：rg-darwin-arm64 / rg-darwin-x64 / rg-linux-x64 / rg-linux-arm64。
# 上传到 ${DEPLOY_RG_PATH}/<version>/，与 fetch-ripgrep.ts 的下载路径约定一致；
# 同时生成 .sha256 供下载时完整性校验。目录内缺某个平台文件时跳过该平台（非致命）。

if [ "$DO_UPLOAD_RIPGREP" = true ]; then
    [ -d "$RIPGREP_DIR" ] || fail "目录不存在: $RIPGREP_DIR"
    require_ssh_user
    echo ">>> 上传 ripgrep 二进制 v${RIPGREP_VERSION}（来自 ${RIPGREP_DIR}）..."
    RG_REMOTE_DIR="${DEPLOY_RG_PATH}/${RIPGREP_VERSION}"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "mkdir -p '${RG_REMOTE_DIR}'"

    _rg_uploaded=0
    for plat in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
        f="$RIPGREP_DIR/rg-${plat}"
        if [ ! -f "$f" ]; then
            warn "跳过缺失: rg-${plat}（目录内未找到）"
            continue
        fi
        SHA="$(sha256_of "$f")"
        echo "$SHA" > "${f}.sha256"
        info "上传 rg-${plat} ..."
        run_scp "$f" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${RG_REMOTE_DIR}/rg-${plat}"
        run_scp "${f}.sha256" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${RG_REMOTE_DIR}/rg-${plat}.sha256"
        _rg_uploaded=$((_rg_uploaded + 1))
    done

    [ "$_rg_uploaded" -gt 0 ] || fail "目录内没有找到任何 rg-<platform> 文件（期望文件名如 rg-darwin-arm64）"
    ok "ripgrep v${RIPGREP_VERSION} 已上传（${_rg_uploaded}/4 平台）"
    echo "  下次 release.sh / make build 会自动通过 fetch-ripgrep.ts 拉取并嵌入"
    exit 0
fi

echo "=== sid-code 发布构建 ==="
echo ""

cd "$ROOT"

# ─── 发布前门禁：全量单测（可 --skip-test 跳过）───

if [ "$DO_TEST" = true ]; then
    echo ">>> 发布前门禁：bun test ..."
    bun test || fail "单测未通过，发布中止（如需救急跳过：--skip-test）"
    ok "单测通过"
    echo ""
else
    warn "已跳过发布前 bun test 门禁（--skip-test）"
    echo ""
fi

# ─── 版本号（只 bump 一次，4 个目标复用）───

if [ "$DO_BUMP" = true ]; then
    bun run scripts/bump-version.ts
else
    echo "  跳过 bump-version（--no-bump）：复用 package.json 当前版本号"
fi
VERSION="$(bun -e "console.log(require('./package.json').version)")"
echo "  版本: v$VERSION"
echo ""

# ─── 生成 changelog + 打 annotated tag（bump 之后、构建之前）───
# tag 打在当前 HEAD（已提交的功能代码）上，符合"发布产物对应确切 commit"的铁律。
# bump 提交由用户在 release.sh 结束后补做；tag 的 push 推迟到上传成功之后（见下方 --upload 块），
# 避免为一个尚未上传成功的版本对外广播 tag。
TAG="v$VERSION"

echo ">>> 生成 changelog (v$VERSION) ..."
bun run scripts/generate-changelog.ts "$VERSION" || warn "changelog 生成失败（不阻断发布）"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    warn "tag $TAG 已存在，跳过创建（--no-bump 复用场景）"
else
    if git tag -a "$TAG" -m "Release $TAG"; then
        ok "已创建 tag ${TAG}（HEAD=$(git rev-parse --short HEAD)）"
    else
        warn "tag 创建失败（不阻断发布）"
    fi
fi
echo ""

# ─── --no-bump 覆盖同版本告警：上传前先探测服务器是否已存在该版本 ───

if [ "$DO_UPLOAD" = true ] && [ "$DO_BUMP" = false ]; then
    require_ssh_user
    if run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "test -d '${DEPLOY_PATH}/${VERSION}'" 2>/dev/null; then
        warn "服务器上已存在版本 v${VERSION}，继续将【覆盖】该版本的现有产物。"
        printf "  确认覆盖？(y/N) "
        read -r _ans </dev/tty || _ans=""
        case "$_ans" in
            y|Y|yes|YES) info "已确认，继续覆盖 v$VERSION" ;;
            *) fail "已取消（避免误覆盖 v${VERSION}）。如需新版本，去掉 --no-bump 重跑。" ;;
        esac
        echo ""
    fi
fi

# ─── 内嵌 skill（只跑一次，与目标架构无关）───

echo ">>> 生成内嵌 skill..."
bun run scripts/embed-builtin-skills.ts
echo ""

# ─── 准备内嵌 ripgrep（4 平台，best-effort）───
# vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库，优先直接复用（全程不联网）；
# 仓库内缺失（如刚 bump 版本号还没提交）才回退联网下载服务器。服务器缺文件不阻断发布，
# 产物退化为「无内嵌 rg，运行时回退系统 rg」——与本功能上线前的行为完全一致。

echo ">>> 准备内嵌 ripgrep（4 平台，best-effort）..."
if bun run scripts/fetch-ripgrep.ts --all; then
    ok "ripgrep 二进制就绪"
else
    warn "准备 ripgrep 二进制失败（仓库内缺失且服务器也拉不到，见 --upload-ripgrep）。本次产物不含内嵌 rg，运行时回退系统 rg，不影响发布。"
fi
echo ""

# ─── 清理旧产物 ───
# dist/release/ 本地目录结构与服务器完全镜像：install.sh + latest.txt 在顶层，
# tarball/sha256 落在 <version>/ 子目录 —— 这样 file://dist/release 本地测试
# 和真实服务器上 http://.../releases/sid-code 走的是同一套相对路径逻辑。

VERSION_DIR="$RELEASE_DIR/$VERSION"
rm -rf "$BUILD_DIR" "$RELEASE_DIR"
mkdir -p "$BUILD_DIR" "$VERSION_DIR"

# ─── 循环交叉编译 4 个目标 ───

SELF_PLATFORM="$(self_platform)"
SELF_SMOKE_DONE=false

for entry in "${TARGETS[@]}"; do
    BUN_TARGET="${entry%%:*}"
    PLATFORM="${entry##*:}"

    echo ">>> 构建 $PLATFORM ($BUN_TARGET) ..."
    OUT_DIR="$BUILD_DIR/$PLATFORM"
    mkdir -p "$OUT_DIR"

    # ─── 切换嵌入的 rg 二进制为当前 target 对应平台 ───
    # vendor/rg-embed 是 bun --compile 的固定嵌入 import 路径（见 src/tool/rg-embedded.ts）。
    # 明确置空（而非跳过）以避免复用上一个 target 残留的错误平台二进制。
    RG_VENDOR_FILE="$ROOT/vendor/ripgrep/${RG_VERSION}/rg-${PLATFORM}"
    if [ -f "$RG_VENDOR_FILE" ]; then
        cp "$RG_VENDOR_FILE" "$ROOT/vendor/rg-embed"
        chmod +x "$ROOT/vendor/rg-embed"
    else
        : > "$ROOT/vendor/rg-embed"
        warn "未找到 vendor/ripgrep/${RG_VERSION}/rg-${PLATFORM}，本次 ${PLATFORM} 产物不含内嵌 rg（运行时回退系统 rg）"
    fi

    bun build --compile --target="$BUN_TARGET" \
        --outfile "$OUT_DIR/sid-code" \
        src/entrypoints/bootstrap.ts

    [ -f "$OUT_DIR/sid-code" ] || fail "构建失败: 未找到 $OUT_DIR/sid-code"
    chmod +x "$OUT_DIR/sid-code"

    # ─── 冒烟测试：只有当前平台的产物能在本机执行，跑一次 --version 挡住损坏产物 ───

    if [ -n "$SELF_PLATFORM" ] && [ "$PLATFORM" = "$SELF_PLATFORM" ]; then
        SMOKE_VER="$("$OUT_DIR/sid-code" --version 2>/dev/null)" \
            || fail "冒烟测试失败：$PLATFORM 产物无法执行 --version，发布中止"
        ok "冒烟测试通过（${PLATFORM}）: $SMOKE_VER"
        # 方向 0（编译产物自检）：本平台产物额外跑 --self-check，断言 git-status 仲裁锚点等
        # 关键修复已内联进二进制。堵住"源码有修复但编译产物没跟上"的发布陷阱——那正是
        # git-status 快照冻结死循环的直接触发因素（根因分析-commit任务git状态快照冻结死循环.md）。
        "$OUT_DIR/sid-code" --self-check \
            || fail "自检失败：$PLATFORM 产物缺失关键修复（git-status 锚点等），发布中止"
        ok "编译产物自检通过（${PLATFORM}）"
        SELF_SMOKE_DONE=true
    fi

    # ─── 打包 tar.gz（staging 成 sid-code/sid-code，install.sh 用 --strip-components=1 解压）───

    STAGING="$BUILD_DIR/_staging_$PLATFORM"
    rm -rf "$STAGING"
    mkdir -p "$STAGING/sid-code"
    cp "$OUT_DIR/sid-code" "$STAGING/sid-code/sid-code"
    chmod +x "$STAGING/sid-code/sid-code"

    TARBALL_NAME="sid-code-${VERSION}-${PLATFORM}.tar.gz"
    tar -czf "$VERSION_DIR/$TARBALL_NAME" -C "$STAGING" sid-code
    rm -rf "$STAGING"

    # ─── sha256 ───

    SHA="$(sha256_of "$VERSION_DIR/$TARBALL_NAME")"
    echo "$SHA  $TARBALL_NAME" > "$VERSION_DIR/${TARBALL_NAME}.sha256"

    SIZE="$(du -h "$VERSION_DIR/$TARBALL_NAME" | cut -f1)"
    ok "$TARBALL_NAME ($SIZE, sha256=${SHA:0:12}...)"
done

if [ "$SELF_SMOKE_DONE" = false ]; then
    warn "当前平台（$(uname -s)/$(uname -m)）不在构建目标内，跳过本机冒烟测试"
fi

echo ""

# ─── 生成 install.sh：把 DEPLOY_SSH_HOST 注入为下载地址，服务器地址只需在 deploy.env 改一处 ───

sed "s#121\.196\.144\.227#${DEPLOY_SSH_HOST}#g" \
    "$SCRIPT_DIR/install-template.sh" > "$RELEASE_DIR/install.sh"
chmod +x "$RELEASE_DIR/install.sh"
echo "$VERSION" > "$RELEASE_DIR/latest.txt"

# 把仓库根 CHANGELOG.md + CHANGELOG.html 纳入发布产物（服务器顶层），让 file://$RELEASE_DIR
# 本地验证与真实上传走同一套相对路径逻辑。MD 是文本事实源，HTML 是可直接点开的科技风页面。
if [ -f "$ROOT/CHANGELOG.md" ]; then
    cp "$ROOT/CHANGELOG.md" "$RELEASE_DIR/CHANGELOG.md"
fi
if [ -f "$ROOT/CHANGELOG.html" ]; then
    cp "$ROOT/CHANGELOG.html" "$RELEASE_DIR/CHANGELOG.html"
fi

echo "=== 发布产物（${RELEASE_DIR}）==="
ls -1 "$RELEASE_DIR"
echo "  --- v$VERSION ---"
ls -1 "$VERSION_DIR"
echo ""
echo "  本地验证（不碰真实服务器）："
echo "    RELEASE_BASE=\"file://$RELEASE_DIR\" bash $RELEASE_DIR/install.sh"

# ─── 上传（可选）───

if [ "$DO_UPLOAD" = true ]; then
    require_ssh_user
    echo ""
    echo ">>> 上传到 ${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH} ..."

    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "mkdir -p '${DEPLOY_PATH}/${VERSION}'"

    for f in "$VERSION_DIR"/*; do
        info "上传 $(basename "$f") ..."
        run_scp "$f" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/${VERSION}/"
    done

    run_scp "$RELEASE_DIR/install.sh" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/install.sh"

    # 上传顶层 CHANGELOG.md + CHANGELOG.html（供用户通过链接查看版本变更）
    if [ -f "$RELEASE_DIR/CHANGELOG.md" ]; then
        info "上传 CHANGELOG.md ..."
        run_scp "$RELEASE_DIR/CHANGELOG.md" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/CHANGELOG.md"
    fi
    if [ -f "$RELEASE_DIR/CHANGELOG.html" ]; then
        info "上传 CHANGELOG.html ..."
        run_scp "$RELEASE_DIR/CHANGELOG.html" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/CHANGELOG.html"
    fi

    # latest.txt 放最后：确保它指向的版本此时已经完整上传
    run_scp "$RELEASE_DIR/latest.txt" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/latest.txt"

    # ─── 服务器端清理旧版本：保留最近 RELEASE_KEEP_VERSIONS 个版本目录 ───
    # 只删除形如 <path>/<x.y.z>/ 的版本目录，install.sh / latest.txt / team-defaults.json 不受影响。
    info "清理服务器旧版本（保留最近 ${RELEASE_KEEP_VERSIONS} 个）..."
    # 用普通双引号字符串构建远程命令（不用 heredoc-in-$()，规避 macOS bash 3.2 解析 bug）。
    # 本地展开：DEPLOY_PATH / 保留数量；远程展开：$d 等（用 \$ 转义留给远端 shell）。
    _keep_plus_one=$((RELEASE_KEEP_VERSIONS + 1))
    CLEANUP_CMD="cd '${DEPLOY_PATH}' 2>/dev/null || exit 0
ls -1dt */ 2>/dev/null | tail -n +${_keep_plus_one} | while IFS= read -r d; do
    d=\"\${d%/}\"
    case \"\$d\" in
        *[0-9].*[0-9].*[0-9]) rm -rf -- \"\$d\" && echo \"  已删除旧版本 \$d\" ;;
    esac
done"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "$CLEANUP_CMD" || warn "旧版本清理失败（不影响本次发布）"

    # ─── 上传成功后推送 tag ───
    # 推到 origin，让发布产物对应的 commit 在远端有确切 tag 标记。失败非致命：
    # 用户在铁律最后一步的 git push 也会把本地 tag 一并推上去。
    if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
        info "推送 tag $TAG 到 origin ..."
        git push origin "$TAG" || warn "tag 推送失败，可稍后手动 git push origin $TAG"
    fi

    echo ""
    ok "发布完成！安装命令："
    echo "    curl -fsSL http://${DEPLOY_SSH_HOST}/releases/sid-code/install.sh | bash"
    echo ""
    echo "  📄 Changelog（网页）: http://${DEPLOY_SSH_HOST}/releases/sid-code/CHANGELOG.html"
    echo "  📄 Changelog（文本）: http://${DEPLOY_SSH_HOST}/releases/sid-code/CHANGELOG.md"
else
    echo ""
    echo "  提示：加 --upload 参数可上传到服务器（凭据读自 scripts/deploy.env）"
fi
