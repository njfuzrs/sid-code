#!/bin/bash
# scripts/release.sh — sid-code 跨平台构建 + 打包 + 发布
#
# 用法：
#   ./scripts/release.sh                        # 构建 4 个目标并打包到 dist/release/
#   ./scripts/release.sh --upload                # 打包后上传到服务器
#   ./scripts/release.sh --upload-team-defaults <file>  # 单独上传团队默认配置（不打版本号）
#
# 环境变量（--upload 时使用）：
#   DEPLOY_SSH_HOST   服务器地址（默认 121.196.144.227）
#   DEPLOY_SSH_USER   SSH 用户（必填，无默认值）
#   DEPLOY_PATH       服务器上的发布目录（默认 /var/www/html/releases/sid-code，
#                     对齐 nginx sites-enabled/default 的 root /var/www/html;）
#
# 设计要点（见 docs/install-guide.md 与 plan）：
#   - bump-version.ts / embed-builtin-skills.ts 全程只各跑一次，4 个目标复用同一份
#     版本号与内嵌 skill 产物，避免 4 个二进制的 --version 互不一致
#   - 每个目标独立输出路径（bun build --outfile 不会自动按 target 加后缀）
#   - team-defaults.json 不随常规发布上传，避免用仓库里的占位模板覆盖服务器上的真实配置；
#     只能通过 --upload-team-defaults 显式单独推送

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT/dist"
BUILD_DIR="$DIST_DIR/build"
RELEASE_DIR="$DIST_DIR/release"

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-121.196.144.227}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/releases/sid-code}"

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

while [ $# -gt 0 ]; do
    case "$1" in
        --upload) DO_UPLOAD=true; shift ;;
        --upload-team-defaults)
            DO_UPLOAD_TEAM_DEFAULTS=true
            TEAM_DEFAULTS_FILE="${2:-}"
            [ -n "$TEAM_DEFAULTS_FILE" ] || { echo "错误: --upload-team-defaults 需要传入文件路径"; exit 1; }
            shift 2
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

info()  { echo "  $*"; }
ok()    { echo "  ✅ $*"; }
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

require_ssh_user() {
    [ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER 环境变量（SSH 到 $DEPLOY_SSH_HOST 用哪个账号）"
}

# ─── 单独上传团队默认配置（不涉及版本构建）───

if [ "$DO_UPLOAD_TEAM_DEFAULTS" = true ]; then
    [ -f "$TEAM_DEFAULTS_FILE" ] || fail "文件不存在: $TEAM_DEFAULTS_FILE"
    require_ssh_user
    echo ">>> 上传团队默认配置 $TEAM_DEFAULTS_FILE ..."
    scp "$TEAM_DEFAULTS_FILE" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/team-defaults.json"
    ok "team-defaults.json 已更新"
    exit 0
fi

# ─── 版本号（只 bump 一次，4 个目标复用）───

echo "=== sid-code 发布构建 ==="
echo ""

cd "$ROOT"
bun run scripts/bump-version.ts
VERSION="$(bun -e "console.log(require('./package.json').version)")"
echo "  版本: v$VERSION"
echo ""

# ─── 内嵌 skill（只跑一次，与目标架构无关）───

echo ">>> 生成内嵌 skill..."
bun run scripts/embed-builtin-skills.ts
echo ""

# ─── 清理旧产物 ───
# dist/release/ 本地目录结构与服务器完全镜像：install.sh + latest.txt 在顶层，
# tarball/sha256 落在 <version>/ 子目录 —— 这样 file://dist/release 本地测试
# 和真实服务器上 http://.../releases/sid-code 走的是同一套相对路径逻辑。

VERSION_DIR="$RELEASE_DIR/$VERSION"
rm -rf "$BUILD_DIR" "$RELEASE_DIR"
mkdir -p "$BUILD_DIR" "$VERSION_DIR"

# ─── 循环交叉编译 4 个目标 ───

for entry in "${TARGETS[@]}"; do
    BUN_TARGET="${entry%%:*}"
    PLATFORM="${entry##*:}"

    echo ">>> 构建 $PLATFORM ($BUN_TARGET) ..."
    OUT_DIR="$BUILD_DIR/$PLATFORM"
    mkdir -p "$OUT_DIR"

    bun build --compile --target="$BUN_TARGET" \
        --outfile "$OUT_DIR/sid-code" \
        src/entrypoints/bootstrap.ts

    [ -f "$OUT_DIR/sid-code" ] || fail "构建失败: 未找到 $OUT_DIR/sid-code"
    chmod +x "$OUT_DIR/sid-code"

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

echo ""

# ─── 生成 install.sh（RELEASE_BASE 默认值已经指向正式服务器，无需 sed 替换）───

cp "$SCRIPT_DIR/install-template.sh" "$RELEASE_DIR/install.sh"
chmod +x "$RELEASE_DIR/install.sh"
echo "$VERSION" > "$RELEASE_DIR/latest.txt"

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

    ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "mkdir -p '${DEPLOY_PATH}/${VERSION}'"

    for f in "$VERSION_DIR"/*; do
        info "上传 $(basename "$f") ..."
        scp "$f" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/${VERSION}/"
    done

    scp "$RELEASE_DIR/install.sh" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/install.sh"

    # latest.txt 放最后：确保它指向的版本此时已经完整上传
    scp "$RELEASE_DIR/latest.txt" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/latest.txt"

    echo ""
    ok "发布完成！安装命令："
    echo "    curl -fsSL http://${DEPLOY_SSH_HOST}/releases/sid-code/install.sh | bash"
else
    echo ""
    echo "  提示：加 --upload 参数可上传到服务器（需要 DEPLOY_SSH_USER 环境变量）"
fi
