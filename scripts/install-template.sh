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

# 返回应该写入 PATH/alias 的 RC 文件
# 策略：只写一个最优先的 RC 文件，避免多文件重复和副作用
# - zsh: .zshrc（macOS login+interactive 都会读）
# - bash: macOS 写 .bash_profile（login shell 必读）；Linux 写 .bashrc（interactive 必读）
detect_shell_rc() {
    case "$(basename "${SHELL:-}")" in
        zsh)
            echo "$HOME/.zshrc"
            ;;
        bash)
            if [ "$(uname -s)" = "Darwin" ]; then
                # macOS Terminal.app 开 login bash，只读 .bash_profile
                echo "$HOME/.bash_profile"
            else
                # Linux 桌面终端开 non-login interactive bash，读 .bashrc
                echo "$HOME/.bashrc"
            fi
            ;;
        *)
            echo ""
            ;;
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

# 安全地向 RC 文件插入内容（保留原文件权限）
# 用法: safe_insert_before_marker <file> <marker> <content_line>
safe_insert_before_marker() {
    local file="$1" marker="$2" content="$3"
    local orig_mode
    orig_mode="$(stat -f '%A' "$file" 2>/dev/null || stat -c '%a' "$file" 2>/dev/null || echo '644')"
    awk -v line="$content" -v m="$marker" '$0 ~ m {print line} 1' "$file" > "${file}.sid-tmp"
    mv "${file}.sid-tmp" "$file"
    chmod "$orig_mode" "$file"
}

# 安全地向 RC 文件在标记后插入内容（保留原文件权限）
# 用法: safe_insert_after_marker <file> <marker> <content_line>
safe_insert_after_marker() {
    local file="$1" marker="$2" content="$3"
    local orig_mode
    orig_mode="$(stat -f '%A' "$file" 2>/dev/null || stat -c '%a' "$file" 2>/dev/null || echo '644')"
    awk -v line="$content" -v m="$marker" '1; $0 ~ m {print line}' "$file" > "${file}.sid-tmp"
    mv "${file}.sid-tmp" "$file"
    chmod "$orig_mode" "$file"
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

# ─── 确保 PATH + 快捷命令 ───
#
# 安全原则：
# 1. 只追加，绝不覆盖/删除用户已有内容
# 2. 只写一个 RC 文件（zsh→.zshrc，bash→.bash_profile/.bashrc），不多写以避免重复
# 3. 不创建用户原本不存在的文件（文件不存在则只追加到已存在的文件）
# 4. 修改已有文件时保留原始权限（chmod 恢复）
# 5. 如果用户已有同名 alias，尊重用户配置不覆盖
# 6. PATH 使用追加式 $HOME/.local/bin:$PATH，不影响用户原有 PATH
#
# 对 zsh 独立终端找不到命令的修复：
# - 旧版只写 .zshrc，且依赖运行时 $PATH 判断是否跳过（curl|bash 子 shell PATH 不准确）
# - 新版直接检查文件内容，确保 PATH 配置存在

echo ""
echo "=== 注册命令 ==="

PATH_WRITTEN=false
RC_FILE="$(detect_shell_rc)"

if [ -z "$RC_FILE" ]; then
    warn "未识别当前 shell（${SHELL:-未设置}），请手动配置："
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    warn "  alias sc='sid-code --dangerously-skip-permissions'"
elif [ ! -f "$RC_FILE" ]; then
    # RC 文件不存在 — 不替用户创建新文件，只输出提示
    # 理由：创建不存在的 .bash_profile/.zshrc 可能影响用户 shell 的默认加载行为
    warn "$(basename "$RC_FILE") 不存在，请手动创建或添加以下内容："
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    warn "  alias sc='sid-code --dangerously-skip-permissions'"
else
    # RC 文件已存在，安全追加
    if grep -qF '# >>> sid-code >>>' "$RC_FILE"; then
        # 已有 sid-code 块 — 只做增量补充，不重写整块
        if ! grep -qF "alias sc=" "$RC_FILE"; then
            safe_insert_before_marker "$RC_FILE" '# <<< sid-code <<<' "alias sc='sid-code --dangerously-skip-permissions'"
            ok "已补充 sc 快捷命令到 $(basename "$RC_FILE")"
        fi
        # 检查 PATH export 是否还在（防止用户手动删了中间内容导致命令找不到）
        if ! grep -qF '.local/bin' "$RC_FILE"; then
            safe_insert_after_marker "$RC_FILE" '# >>> sid-code >>>' 'export PATH="$HOME/.local/bin:$PATH"'
            ok "已修复 PATH 配置到 $(basename "$RC_FILE")"
        fi
    else
        # 全新写入完整块（追加到文件末尾，不影响文件前面的任何内容）
        cat >> "$RC_FILE" <<'EOF'

# >>> sid-code >>>
# 稳定版命令入口（sid-code / sc）。此块由安装脚本管理，`sid-code update` 会重跑安装脚本。
# PATH 采用幂等前置：$HOME/.local/bin 已在 PATH 中则不重复前置，避免每次 update 把它
# 拱到最前、与你手动配置的其它目录（如开发版所在的 $HOME/bin）争抢优先级。
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
alias sc='sid-code --dangerously-skip-permissions'
# <<< sid-code <<<
EOF
        PATH_WRITTEN=true
        ok "已写入 PATH + sc 到 $(basename "$RC_FILE")"
    fi

    # bash 特殊处理：macOS 写了 .bash_profile，但如果用户有 .bashrc 且 .bash_profile
    # 不 source .bashrc，非 login 场景（如 VSCode 终端）可能读不到。
    # 如果 .bash_profile 里没有 source .bashrc，在 .bashrc 也补一份（仅当 .bashrc 已存在时）
    if [ "$(basename "${SHELL:-}")" = "bash" ] && [ "$(uname -s)" = "Darwin" ]; then
        if [ -f "$HOME/.bashrc" ] && [ "$RC_FILE" = "$HOME/.bash_profile" ]; then
            if ! grep -qF '.local/bin' "$HOME/.bashrc" && ! grep -qF '# >>> sid-code >>>' "$HOME/.bashrc"; then
                cat >> "$HOME/.bashrc" <<'EOF'

# >>> sid-code >>>
# 稳定版命令入口（sid-code / sc）。此块由安装脚本管理，`sid-code update` 会重跑安装脚本。
# PATH 采用幂等前置：$HOME/.local/bin 已在 PATH 中则不重复前置，避免每次 update 把它
# 拱到最前、与你手动配置的其它目录（如开发版所在的 $HOME/bin）争抢优先级。
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
alias sc='sid-code --dangerously-skip-permissions'
# <<< sid-code <<<
EOF
                ok "已同步到 .bashrc（VSCode 终端兼容）"
            fi
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
echo "    sc                   # 启动（推荐，跳过权限确认）"
echo "    sid-code             # 启动（需逐条确认权限）"
echo "    sid-code --version   # 确认版本"
echo "    sid-code update      # 以后升级到最新版本"
echo ""
echo "  📄 更新日志（网页）: ${RELEASE_BASE}/CHANGELOG.html"
echo "  📄 更新日志（文本）: ${RELEASE_BASE}/CHANGELOG.md"
echo ""

# 仅当「刚写入 PATH 块」且「当前 shell 的 PATH 里还没有该 bin 目录」时才提示 source。
# 典型场景区分：
#   - 首次安装：RC 文件里此前没有 sid-code 块 → 新写入(PATH_WRITTEN=true)，且当前 shell
#     PATH 通常还不含 ~/.local/bin → 需要 source 才能立刻用上。
#   - sid-code update：命令本就从 PATH 里找到才跑起来，当前 shell 的 PATH 已含 bin 目录 →
#     二进制原地换掉即刻生效，无需 source（旧逻辑无脑提示，纯噪声）。
if [ "$PATH_WRITTEN" = true ]; then
    case ":$PATH:" in
        *":$BIN_DIR:"*)
            : ;; # 当前 shell 已能找到命令，无需任何额外操作
        *)
            echo "  ⚡ 请重新打开终端，或在当前窗口执行："
            echo "    source $(detect_shell_rc)"
            echo ""
            ;;
    esac
fi
