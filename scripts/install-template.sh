#!/bin/bash
# scripts/install-template.sh — sid-code 一键安装脚本（模板）
#
# release.sh 会把这份模板原样拷贝为发布产物 install.sh 一起上传，
# 团队同事的实际安装命令：
#   curl -fsSL http://121.196.144.227/releases/sid-code/install.sh | bash
#
# 全程非交互，不依赖 jq/python3：
#   - 版本默认取服务器 latest.txt，可用 SID_CODE_VERSION=x.y.z 锁定版本
#   - 团队默认 provider 配置仅在 ~/.sid-code/settings.json 不存在时才写入，
#     已有配置的机器（含升级场景）完全不动
#
# 本地测试（不用碰真实服务器）：
#   RELEASE_BASE="file:///abs/path/to/dist/release" bash scripts/install-template.sh
#   （curl 原生支持 file:// URL，可以直接指向本地 dist/release/ 目录验证全流程）

set -euo pipefail

RELEASE_BASE="${RELEASE_BASE:-http://121.196.144.227/releases/sid-code}"
INSTALL_ROOT="$HOME/.local/share/sid-code"
VERSIONS_DIR="$INSTALL_ROOT/versions"
BIN_DIR="$HOME/.local/bin"
BIN_SYMLINK="$BIN_DIR/sid-code"
KEEP_VERSIONS=2

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            echo "用法: curl -fsSL <url>/install.sh | bash"
            echo ""
            echo "环境变量："
            echo "  SID_CODE_VERSION   锁定安装版本（默认读取服务器 latest.txt）"
            echo "  SID_CONFIG_DIR     配置目录（默认 ~/.sid-code，与 sid-code 本体一致）"
            echo "  RELEASE_BASE       下载地址前缀（默认内置团队服务器）"
            exit 0
            ;;
    esac
done

# ─── 工具函数 ───

info()  { echo "  $*"; }
ok()    { echo "  ✅ $*"; }
warn()  { echo "  ⚠️  $*"; }
fail()  { echo "  ❌ $*" >&2; exit 1; }

detect_shell_rc() {
    case "$(basename "${SHELL:-}")" in
        zsh)  echo "$HOME/.zshrc" ;;
        bash) echo "$HOME/.bashrc" ;;
        *)    echo "" ;;
    esac
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "找不到 sha256sum 或 shasum，无法校验下载完整性"
    fi
}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   sid-code 安装程序                   ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 检测 OS / ARCH ───

UNAME_S="$(uname -s)"
case "$UNAME_S" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)      fail "不支持的操作系统: ${UNAME_S}（目前仅支持 macOS / Linux）" ;;
esac

UNAME_M="$(uname -m)"
case "$UNAME_M" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)             fail "不支持的架构: $UNAME_M" ;;
esac

info "系统: $OS ($ARCH)"

# ─── 临时目录 ───

TMPDIR_DL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DL"' EXIT

# ─── 解析版本 ───

VERSION="${SID_CODE_VERSION:-}"
if [ -z "$VERSION" ]; then
    info "解析最新版本..."
    VERSION="$(curl -fsSL "$RELEASE_BASE/latest.txt" 2>/dev/null || true)"
    VERSION="$(echo "$VERSION" | tr -d '[:space:]')"
    [ -n "$VERSION" ] || fail "无法从 $RELEASE_BASE/latest.txt 解析版本号"
fi
info "目标版本: v$VERSION"

# ─── 下载 + 校验 ───

echo ""
echo "=== 下载安装包 ==="

TARBALL_NAME="sid-code-${VERSION}-${OS}-${ARCH}.tar.gz"
TARBALL_URL="${RELEASE_BASE}/${VERSION}/${TARBALL_NAME}"
TARBALL_PATH="$TMPDIR_DL/$TARBALL_NAME"

info "下载: $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TARBALL_PATH" || fail "下载失败: $TARBALL_URL"

CHECKSUM_URL="${TARBALL_URL}.sha256"
CHECKSUM_PATH="$TARBALL_PATH.sha256"
curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_PATH" || fail "下载校验文件失败: $CHECKSUM_URL"

EXPECTED_SHA="$(awk '{print $1}' "$CHECKSUM_PATH")"
ACTUAL_SHA="$(sha256_of "$TARBALL_PATH")"
[ -n "$EXPECTED_SHA" ] || fail "校验文件内容异常: $CHECKSUM_PATH"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    fail "sha256 校验失败（期望 ${EXPECTED_SHA}，实际 ${ACTUAL_SHA}），安装中止，未影响现有安装"
fi
ok "校验通过 (sha256)"

# ─── 解压到版本化目录 ───

NEW_DIR="$VERSIONS_DIR/$VERSION"
if [ -d "$NEW_DIR" ]; then
    info "版本 v$VERSION 已存在于 ${NEW_DIR}，直接复用"
else
    mkdir -p "$NEW_DIR"
    tar -xzf "$TARBALL_PATH" -C "$NEW_DIR" --strip-components=1
    ok "已解压到 $NEW_DIR"
fi

chmod +x "$NEW_DIR/sid-code"

# macOS 防御性去隔离属性（仅对本次新增目录，不重扫旧版本）
if [ "$OS" = "darwin" ]; then
    xattr -cr "$NEW_DIR" 2>/dev/null || true
fi

# ─── 冒烟测试（挡住"校验通过但产物损坏/架构不对"的情况）───

if ! "$NEW_DIR/sid-code" --version >/dev/null 2>&1; then
    fail "新版本二进制无法执行 --version，安装中止（未影响现有安装，$NEW_DIR 可手动检查）"
fi
ok "冒烟测试通过: $("$NEW_DIR/sid-code" --version)"

# ─── 原子切换软链接 ───

echo ""
echo "=== 安装二进制 ==="

mkdir -p "$BIN_DIR"
TMP_LINK="$BIN_DIR/.sid-code.tmp.$$"
ln -sfn "$NEW_DIR/sid-code" "$TMP_LINK"
mv -f "$TMP_LINK" "$BIN_SYMLINK"
ok "命令入口: $BIN_SYMLINK -> $NEW_DIR/sid-code"

# ─── 确保 PATH ───

PATH_SNIPPET_RC=""
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    RC_FILE="$(detect_shell_rc)"
    if [ -z "$RC_FILE" ]; then
        warn "未识别当前 shell，请手动加入 PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
    else
        touch "$RC_FILE"
        if ! grep -qF '# >>> sid-code >>>' "$RC_FILE"; then
            cat >> "$RC_FILE" <<'EOF'

# >>> sid-code >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< sid-code <<<
EOF
            PATH_SNIPPET_RC="$RC_FILE"
            ok "已写入命令 PATH 到 $RC_FILE"
        fi
    fi
fi

# ─── 团队默认配置（仅当本地尚无配置时才写入，绝不覆盖已有配置）───

echo ""
echo "=== 团队默认配置 ==="

CONFIG_DIR="${SID_CONFIG_DIR:-$HOME/.sid-code}"
SETTINGS_PATH="$CONFIG_DIR/settings.json"

if [ -f "$SETTINGS_PATH" ]; then
    info "检测到已有配置 ${SETTINGS_PATH}，保留不变"
else
    TEAM_DEFAULTS_PATH="$TMPDIR_DL/team-defaults.json"
    if curl -fsSL "${RELEASE_BASE}/team-defaults.json" -o "$TEAM_DEFAULTS_PATH" 2>/dev/null; then
        mkdir -p "$CONFIG_DIR"
        cp "$TEAM_DEFAULTS_PATH" "$SETTINGS_PATH"
        chmod 600 "$SETTINGS_PATH"
        ok "已写入团队默认配置: $SETTINGS_PATH"
    else
        info "未找到团队默认配置，首次运行 sid-code 时会弹出引导向导手动配置"
    fi
fi

# ─── 清理旧版本（只保留最新 N 个）───

if [ -d "$VERSIONS_DIR" ]; then
    OLD_VERSIONS="$(ls -1t "$VERSIONS_DIR" 2>/dev/null | tail -n "+$((KEEP_VERSIONS + 1))" || true)"
    if [ -n "$OLD_VERSIONS" ]; then
        echo "$OLD_VERSIONS" | while IFS= read -r old; do
            [ -n "$old" ] || continue
            rm -rf "${VERSIONS_DIR:?}/$old"
        done
    fi
fi

# ─── 完成 ───

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   安装完成！v$VERSION"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  现在可以运行："
echo "    sid-code             # 启动"
echo "    sid-code --version   # 确认版本"
echo "    sid-code update      # 以后升级到最新版本"
echo ""

if [ -n "$PATH_SNIPPET_RC" ]; then
    echo "  当前 shell 还未加载 PATH，请先执行一次："
    echo "    source $PATH_SNIPPET_RC"
    echo ""
fi
