#!/bin/bash
# scripts/website-deploy.sh — sid-code 官网与文档站发布（纯静态产物，版本目录 + symlink 原子切换）
#
# 用法：
#   ./scripts/website-deploy.sh                 # 生成参考页 + 构建 + 预压缩 + 上传 + 原子切换
#   ./scripts/website-deploy.sh --dry-run       # 只本地构建与预压缩，完全不碰服务器
#   ./scripts/website-deploy.sh --no-gen        # 跳过参考页生成（website/ref 用当前磁盘内容）
#   ./scripts/website-deploy.sh --rollback      # 把 current 切回上一个版本目录（秒级）
#   ./scripts/website-deploy.sh --allow-dirty   # 允许工作区有未提交改动（默认拒绝）
#
# 设计要点（见 docs/reference/官网与文档站设计方案.md §5.2/§5.4）：
#   - 与 release.sh 解耦：文档改动频率远高于版本发布，可独立随时发布；
#     但复用同一份 scripts/deploy.env 与 run_ssh/run_scp 写法，不新造凭据管理。
#   - 构建全程在本地：服务器无 bun、可用内存仅约 1G 且无 swap，绝不在服务器构建。
#   - 原子切换：rsync 到全新的 releases/<VER>/，**完成后**才 ln -sfn current，
#     切换是单个 inode 操作，用户永远看不到新旧混杂的中间态。
#   - 每次发布强制冒烟 /releases/sid-code/install.sh 必须 200：nginx root 已换成
#     站点目录，靠 alias 指回二进制目录；这条链路断了等于所有用户装不上/更不了。
#
# 环境变量（读自 scripts/deploy.env，环境变量优先级更高）：
#   DEPLOY_SSH_HOST / DEPLOY_SSH_USER / DEPLOY_SSH_PASSWORD   与 release.sh 同源
#   WEBSITE_DEPLOY_PATH      站点根（默认 /var/www/sid-code-site）
#   WEBSITE_KEEP_VERSIONS    服务器保留的历史版本目录数（默认 3）
#   WEBSITE_MIN_FREE_MB      发布前要求的服务器最小可用内存 MB（默认 300，低于即中止）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBSITE_DIR="$ROOT/website"
DIST_DIR="$WEBSITE_DIR/.vitepress/dist"

# ─── 加载本地凭据（与 release.sh 同一套写法：已导出的环境变量优先于文件值）───
ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
    _pre_host="${DEPLOY_SSH_HOST:-}"
    _pre_user="${DEPLOY_SSH_USER:-}"
    _pre_pass="${DEPLOY_SSH_PASSWORD:-}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-121.196.144.227}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
WEBSITE_DEPLOY_PATH="${WEBSITE_DEPLOY_PATH:-/var/www/sid-code-site}"
WEBSITE_KEEP_VERSIONS="${WEBSITE_KEEP_VERSIONS:-3}"
WEBSITE_MIN_FREE_MB="${WEBSITE_MIN_FREE_MB:-300}"

DO_DRY_RUN=false
DO_GEN=true
DO_ROLLBACK=false
ALLOW_DIRTY=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)     DO_DRY_RUN=true; shift ;;
        --no-gen)      DO_GEN=false; shift ;;
        --rollback)    DO_ROLLBACK=true; shift ;;
        --allow-dirty) ALLOW_DIRTY=true; shift ;;
        -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "未知参数: $1（可用：--dry-run --no-gen --rollback --allow-dirty）" >&2; exit 1 ;;
    esac
done

info() { echo "  $*"; }
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*" >&2; }
fail() { echo "  ❌ $*" >&2; exit 1; }

_SSH_OPTS=(-o StrictHostKeyChecking=no)

# 本机 LC_ALL/LANG（如 zh_CN.UTF-8）经 ssh SendEnv 转发到服务器后，服务器没装该 locale，
# 每条远程命令都会吐 "setlocale: cannot change locale" 噪音，把真正该看的 warn 淹掉。
# 这里在调用 ssh/rsync 时清掉这几个变量（只影响子进程，不改本地 shell）。
_ssh_env=(env -u LC_ALL -u LANG -u LC_CTYPE)

run_ssh() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        "${_ssh_env[@]}" sshpass -p "$DEPLOY_SSH_PASSWORD" ssh "${_SSH_OPTS[@]}" "$@"
    else
        "${_ssh_env[@]}" ssh "${_SSH_OPTS[@]}" "$@"
    fi
}

run_rsync() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        "${_ssh_env[@]}" sshpass -p "$DEPLOY_SSH_PASSWORD" rsync -e "ssh ${_SSH_OPTS[*]}" "$@"
    else
        "${_ssh_env[@]}" rsync -e "ssh ${_SSH_OPTS[*]}" "$@"
    fi
}

REMOTE="" # 上传/回滚路径才需要，dry-run 下不校验凭据
require_remote() {
    [ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER（scripts/deploy.env 或环境变量）"
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        command -v sshpass >/dev/null 2>&1 || fail "已配置 DEPLOY_SSH_PASSWORD 但未安装 sshpass（macOS: brew install sshpass）"
    fi
    command -v rsync >/dev/null 2>&1 || fail "未找到 rsync"
    REMOTE="${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}"
}

# 冒烟：站点首页 + install.sh。install.sh 这条是刻意加的硬门禁——
# nginx root 已指向站点目录，/releases/ 靠 alias 回落，断了就是所有用户装不上。
smoke_test() {
    local rc=0
    info "冒烟校验 ..."
    if curl -fsS --max-time 15 "http://${DEPLOY_SSH_HOST}/" | grep -q "sid-code"; then
        ok "首页 200 且含 sid-code"
    else
        warn "首页内容校验失败"
        rc=1
    fi
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
        "http://${DEPLOY_SSH_HOST}/releases/sid-code/install.sh")"
    if [ "$code" = "200" ]; then
        ok "install.sh 200（用户安装/更新链路完好）"
    else
        warn "install.sh 返回 $code —— 用户安装链路可能已断，立即检查 nginx 的 /releases/ alias！"
        rc=1
    fi
    return $rc
}

# ─── --rollback：切回上一个版本目录 ───

if [ "$DO_ROLLBACK" = true ]; then
    require_remote
    echo ">>> 回滚站点到上一个版本 ..."
    # 远程按 mtime 倒序列版本目录，第 2 个即上一版；当前 current 指向第 1 个。
    ROLLBACK_CMD="set -e
cd '${WEBSITE_DEPLOY_PATH}/releases' 2>/dev/null || { echo 'NO_RELEASES_DIR'; exit 1; }
cur=\"\$(readlink -f '${WEBSITE_DEPLOY_PATH}/current' 2>/dev/null || true)\"
prev=''
for d in \$(ls -1dt */ 2>/dev/null); do
    d=\"\${d%/}\"
    if [ \"\$(readlink -f \"\$d\")\" != \"\$cur\" ]; then prev=\"\$d\"; break; fi
done
[ -n \"\$prev\" ] || { echo 'NO_PREVIOUS_VERSION'; exit 1; }
ln -sfn \"${WEBSITE_DEPLOY_PATH}/releases/\$prev\" '${WEBSITE_DEPLOY_PATH}/current'
echo \"已切回 \$prev\""
    run_ssh "$REMOTE" "$ROLLBACK_CMD" || fail "回滚失败（可能只有一个版本，或 releases 目录不存在）"
    smoke_test || warn "回滚后冒烟未全绿，请人工确认"
    ok "回滚完成：http://${DEPLOY_SSH_HOST}/"
    exit 0
fi

# ─── 1. 前置校验 ───

echo ">>> [1/12] 前置校验 ..."
[ -d "$WEBSITE_DIR" ] || fail "找不到 website/ 目录"
command -v bun >/dev/null 2>&1 || fail "未找到 bun"

if [ "$ALLOW_DIRTY" != true ]; then
    if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
        fail "git 工作区有未提交改动（发布产物须能对应确切 commit）。确认无碍可加 --allow-dirty"
    fi
fi
if [ "$DO_DRY_RUN" != true ]; then
    [ -f "$ENV_FILE" ] || fail "缺少 ${ENV_FILE}（见 deploy.env.example 模板）"
    require_remote
fi
ok "前置校验通过"

# ─── 2. 依赖 ───

echo ">>> [2/12] 安装 website 依赖 ..."
(cd "$WEBSITE_DIR" && bun install --frozen-lockfile >/dev/null) \
    || (cd "$WEBSITE_DIR" && bun install >/dev/null) \
    || fail "bun install 失败"
ok "依赖就绪"

# ─── 3. 生成参考页（源码自省，先刷新再构建）───

if [ "$DO_GEN" = true ]; then
    echo ">>> [3/12] 生成参考页（docs-gen-reference）..."
    bun run "$SCRIPT_DIR/docs-gen-reference.ts" || fail "参考页生成失败"
    ok "参考页已刷新"
else
    echo ">>> [3/12] 跳过参考页生成（--no-gen）"
fi

# ─── 4. 构建（死链检测在此生效，失败即停）───

echo ">>> [4/12] 构建站点（VitePress，含死链检测）..."
rm -rf "$DIST_DIR"
(cd "$WEBSITE_DIR" && bun run build) || fail "站点构建失败（死链或语法错误，看上方输出）"
[ -f "$DIST_DIR/index.html" ] || fail "构建产物缺少 index.html"
ok "构建完成：$(du -sh "$DIST_DIR" | awk '{print $1}')"

# ─── 5. 预压缩（gzip_static on 直吐 .gz，2 核机器零 CPU 开销）───

echo ">>> [5/12] 预压缩 html/js/css/json/svg ..."
GZ_COUNT=0
while IFS= read -r f; do
    gzip -9 -k -f "$f"
    GZ_COUNT=$((GZ_COUNT + 1))
done < <(find "$DIST_DIR" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \
    -o -name '*.json' -o -name '*.svg' \) ! -name '*.gz')
ok "生成 $GZ_COUNT 个 .gz"

# ─── 6. 版本号 ───

VER="$(date +%Y%m%d)-$(git -C "$ROOT" rev-parse --short HEAD)"
echo ">>> [6/12] 版本号：$VER"

if [ "$DO_DRY_RUN" = true ]; then
    echo ""
    ok "--dry-run 完成：本地构建与预压缩均成功，未触碰服务器"
    info "产物：${DIST_DIR}（$(find "$DIST_DIR" -type f | wc -l | tr -d ' ') 个文件）"
    info "若要真实发布，去掉 --dry-run 重跑"
    exit 0
fi

# ─── 7. 服务器资源前置检查（内存吃紧就拒绝发布，而不是中途失败）───

echo ">>> [7/12] 服务器资源检查 ..."
FREE_MB="$(run_ssh "$REMOTE" "free -m | awk '/^Mem:/{print \$7}'" 2>/dev/null | tr -d '\r')"
DISK_AVAIL="$(run_ssh "$REMOTE" "df -h '${WEBSITE_DEPLOY_PATH}' | tail -1 | awk '{print \$4}'" 2>/dev/null | tr -d '\r')"
case "$FREE_MB" in
    ''|*[!0-9]*) warn "无法解析服务器可用内存（读到：'$FREE_MB'），跳过内存门禁" ;;
    *)
        info "可用内存 ${FREE_MB}MB / 磁盘可用 ${DISK_AVAIL:-未知}"
        [ "$FREE_MB" -ge "$WEBSITE_MIN_FREE_MB" ] \
            || fail "服务器可用内存 ${FREE_MB}MB 低于阈值 ${WEBSITE_MIN_FREE_MB}MB，拒绝发布（避免中途 OOM）"
        ok "资源充足"
        ;;
esac

# ─── 8. 建版本目录 ───

echo ">>> [8/12] 建远程版本目录 releases/$VER ..."
run_ssh "$REMOTE" "mkdir -p '${WEBSITE_DEPLOY_PATH}/releases/${VER}'" || fail "创建远程目录失败"

# ─── 9. 上传（目标是全新目录，--delete 只用于清上次失败的残留）───

echo ">>> [9/12] rsync 上传 ..."
run_rsync -az --delete "$DIST_DIR/" "${REMOTE}:${WEBSITE_DEPLOY_PATH}/releases/${VER}/" \
    || fail "rsync 上传失败（current 未切换，线上仍是旧版本）"
# rsync -a 会保留本地 uid/gid（Mac 上是 501:staff），实测上传后文件属主是数字 501。
# §5.2 要求站点目录属 root:root 755，这里显式归位——nginx 以 www-data 运行只需读，
# 但留着构建机的 uid 会让服务器上出现无对应用户的孤儿属主，后续排查权限时误导人。
run_ssh "$REMOTE" "chown -R root:root '${WEBSITE_DEPLOY_PATH}/releases/${VER}'" \
    || warn "属主归位失败（不影响访问，文件仍可读）"
ok "上传完成"

# ─── 10. 原子切换（上传全部完成之后才做，单个 inode 操作无中间态）───

echo ">>> [10/12] 原子切换 current → releases/$VER ..."
run_ssh "$REMOTE" "test -f '${WEBSITE_DEPLOY_PATH}/releases/${VER}/index.html' \
    && ln -sfn '${WEBSITE_DEPLOY_PATH}/releases/${VER}' '${WEBSITE_DEPLOY_PATH}/current'" \
    || fail "切换失败（新版本目录不完整，线上仍是旧版本）"
ok "current 已指向 $VER"

# ─── 11. 清理旧版本（保留最近 N 个；current 指向的那个永不删）───

echo ">>> [11/12] 清理旧版本（保留最近 ${WEBSITE_KEEP_VERSIONS} 个）..."
_keep_plus_one=$((WEBSITE_KEEP_VERSIONS + 1))
CLEANUP_CMD="cd '${WEBSITE_DEPLOY_PATH}/releases' 2>/dev/null || exit 0
cur=\"\$(readlink -f '${WEBSITE_DEPLOY_PATH}/current' 2>/dev/null || true)\"
ls -1dt */ 2>/dev/null | tail -n +${_keep_plus_one} | while IFS= read -r d; do
    d=\"\${d%/}\"
    [ \"\$(readlink -f \"\$d\")\" = \"\$cur\" ] && continue
    rm -rf -- \"\$d\" && echo \"  已删除旧版本 \$d\"
done"
run_ssh "$REMOTE" "$CLEANUP_CMD" || warn "旧版本清理失败（不影响本次发布）"

# ─── 12. 冒烟 + 打印地址 ───

echo ">>> [12/12] 冒烟校验 ..."
if ! smoke_test; then
    fail "冒烟校验未通过 —— 如影响用户请立即 ./scripts/website-deploy.sh --rollback"
fi

echo ""
ok "文档站发布完成（版本 ${VER}）"
echo "    🌐 站点：      http://${DEPLOY_SSH_HOST}/"
echo "    📘 快速开始：  http://${DEPLOY_SSH_HOST}/start/"
echo "    📄 Changelog： http://${DEPLOY_SSH_HOST}/releases/sid-code/CHANGELOG.html"
echo ""
echo "    回滚：./scripts/website-deploy.sh --rollback"
