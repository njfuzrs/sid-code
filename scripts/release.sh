#!/bin/bash
# scripts/release.sh — sid-code 跨平台构建 + 打包 + 发布
#
# 用法：
#   ./scripts/release.sh                        # 门禁(bun test)+bump 版本号+构建 4 目标并打包到 dist/release/
#   ./scripts/release.sh --upload                # 打包后上传到服务器
#   ./scripts/release.sh --no-bump               # 复用当前版本号，不再 bump（配合先跑过 make build 的场景）
#   ./scripts/release.sh --skip-test             # 跳过发布前 bun test 门禁（不推荐，仅救急）
#   ./scripts/release.sh --upload-team-defaults <file>  # 单独上传团队默认配置（不打版本号）
#
# 发布前门禁：默认先跑 `bun test` 全量单测，失败即中止（坏版本不会推到 latest.txt）。
#   构建完成后还会对「当前平台」的产物做一次 --version 冒烟，挡住产物损坏/无法执行的情况。
#   加 --skip-test 可跳过单测（救急用），冒烟测试始终执行、不可跳过。
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
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    # 恢复调用方显式导出的值（环境变量优先级更高）
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
    [ -n "$_pre_path" ] && DEPLOY_PATH="$_pre_path"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-121.196.144.227}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/releases/sid-code}"
RELEASE_KEEP_VERSIONS="${RELEASE_KEEP_VERSIONS:-5}"

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

# ─── --no-bump 覆盖同版本告警：上传前先探测服务器是否已存在该版本 ───

if [ "$DO_UPLOAD" = true ] && [ "$DO_BUMP" = false ]; then
    require_ssh_user
    if run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "test -d '${DEPLOY_PATH}/${VERSION}'" 2>/dev/null; then
        warn "服务器上已存在版本 v$VERSION，继续将【覆盖】该版本的现有产物。"
        printf "  确认覆盖？(y/N) "
        read -r _ans </dev/tty || _ans=""
        case "$_ans" in
            y|Y|yes|YES) info "已确认，继续覆盖 v$VERSION" ;;
            *) fail "已取消（避免误覆盖 v$VERSION）。如需新版本，去掉 --no-bump 重跑。" ;;
        esac
        echo ""
    fi
fi

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

SELF_PLATFORM="$(self_platform)"
SELF_SMOKE_DONE=false

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

    # ─── 冒烟测试：只有当前平台的产物能在本机执行，跑一次 --version 挡住损坏产物 ───

    if [ -n "$SELF_PLATFORM" ] && [ "$PLATFORM" = "$SELF_PLATFORM" ]; then
        SMOKE_VER="$("$OUT_DIR/sid-code" --version 2>/dev/null)" \
            || fail "冒烟测试失败：$PLATFORM 产物无法执行 --version，发布中止"
        ok "冒烟测试通过（$PLATFORM）: $SMOKE_VER"
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

    echo ""
    ok "发布完成！安装命令："
    echo "    curl -fsSL http://${DEPLOY_SSH_HOST}/releases/sid-code/install.sh | bash"
else
    echo ""
    echo "  提示：加 --upload 参数可上传到服务器（凭据读自 scripts/deploy.env）"
fi
