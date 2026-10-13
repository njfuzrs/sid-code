#!/bin/bash
# scripts/plugins-release.sh — 把仓内一个官方插件发布到官方静态市场（内置 Skill 下沉方案 §7）
#
# 用法：
#   ./scripts/plugins-release.sh <插件名>             # 发布 plugins/<插件名>/ 当前 plugin.json 版本
#   ./scripts/plugins-release.sh <插件名> --dry-run   # 只做门禁 + 打包 + 合并 index，不上传、不打 tag
#   ./scripts/plugins-release.sh <插件名> --yes       # 跳过交互确认
#
# 服务器布局（PLUGINS_DEPLOY_PATH，默认 /var/www/html/plugins，对外 ${PUBLIC_BASE_URL}/plugins/）：
#   index.json                               当前目录（客户端只读这一个文件）
#   index.json.prev-<UTC 时间戳>              每次替换前的旧目录（回滚 = 把它 mv 回 index.json）
#   artifacts/<name>/<version>.tar.gz        制品，一经上传不再改动
#
# 刻意不放在 website-deploy.sh 管的站点目录里：那边每次部署 rsync --delete 到新 release 目录，
# 插件目录放进去会在下一次官网部署时整体消失。
#
# ─── 门禁（与 release.sh 同一套信任模型，方案 §7「版本可追溯靠三点」）──────────────
#   G1 工作区干净            拦「带着未提交改动发布」——发出去的字节必须能从某个 commit 复现
#   G2 HEAD 已进 origin/main 拦「把分支上没 review 的插件发成官方版」（照搬 release.sh --promote）
#   G3 版本不可覆盖          tag plugin/<name>@<ver> 不存在 + 远端 index 没有该版本 + 制品文件不存在
#   G4 版本单调递增          新版本必须高于线上最新：否则自动更新用户会被静默「升级」到旧版本
#
# ─── 原子性 ────────────────────────────────────────────────────────────────────
#   制品先上传 → 服务器端 sha256 复核 → 再替换 index（同目录 tmp + mv，rename 原子）。
#   任一步失败 index 不动，线上客户端看到的始终是一份自洽的目录：最坏情况是多一个没被引用的制品。
#
# 凭据与 release.sh / rollback.sh 同源（scripts/deploy.env，不入库）。
# CI 不跑本脚本：给 Actions 一份能写服务器的凭据，范围远大于「发插件」（方案 §7）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
    _pre_host="${DEPLOY_SSH_HOST:-}"
    _pre_user="${DEPLOY_SSH_USER:-}"
    _pre_pass="${DEPLOY_SSH_PASSWORD:-}"
    _pre_ppath="${PLUGINS_DEPLOY_PATH:-}"
    _pre_public="${PUBLIC_BASE_URL:-}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
    [ -n "$_pre_ppath" ] && PLUGINS_DEPLOY_PATH="$_pre_ppath"
    [ -n "$_pre_public" ] && PUBLIC_BASE_URL="$_pre_public"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
PLUGINS_DEPLOY_PATH="${PLUGINS_DEPLOY_PATH:-/var/www/html/plugins}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://www.sid-code.cc}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

NAME=""
DRY_RUN=false
ASSUME_YES=false
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --yes|-y) ASSUME_YES=true; shift ;;
        --help|-h) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "未知参数: $1"; exit 1 ;;
        *)
            [ -z "$NAME" ] || { echo "错误: 一次只发布一个插件（收到 '$NAME' 与 '$1'）"; exit 1; }
            NAME="$1"; shift ;;
    esac
done

info() { echo "  $*"; }
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*" >&2; }
fail() { echo "  ❌ $*" >&2; exit 1; }

[ -n "$NAME" ] || fail "用法: ./scripts/plugins-release.sh <插件名> [--dry-run] [--yes]"
case "$NAME" in
    *[!a-z0-9_-]*|"") fail "插件名只允许小写字母 / 数字 / - / _：$NAME" ;;
esac
[ -f "$REPO_ROOT/plugins/$NAME/plugin.json" ] || fail "plugins/$NAME/plugin.json 不存在"
command -v bun >/dev/null 2>&1 || fail "需要 bun"

cd "$REPO_ROOT"
VERSION="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('plugins/$NAME/plugin.json','utf8')).version)")"
TAG="plugin/${NAME}@${VERSION}"
echo "=== 发布官方插件 ${NAME}@${VERSION} ==="

# ─── G1 / G2 / G3（本地部分）───
_dirty="$(git status --porcelain 2>/dev/null || true)"
[ -z "$_dirty" ] || fail "工作区不干净，拒绝发布（G1）：
$_dirty"
ok "G1 工作区干净"

info "拉取远端主线（G2 要问 origin/main，不是本地 main）..."
git fetch origin main --quiet || fail "git fetch origin main 失败，无法判定 G2"
git merge-base --is-ancestor HEAD origin/main \
    || fail "HEAD $(git rev-parse --short HEAD) 不在 origin/main 上，拒绝发布（G2）：先合并 PR 再从 main 发"
ok "G2 HEAD $(git rev-parse --short HEAD) 已进 origin/main"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    fail "tag $TAG 已存在，版本不可覆盖（G3）：请先升 plugins/$NAME/plugin.json 的 version"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    fail "远端已有 tag $TAG，版本不可覆盖（G3）"
fi
ok "G3 tag $TAG 未被占用"

# ─── 远端 ───
[ -n "$DEPLOY_SSH_HOST" ] || fail "需要设置 DEPLOY_SSH_HOST（scripts/deploy.env 或环境变量）"
[ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER（scripts/deploy.env 或环境变量）"
_SSH_OPTS=(-o StrictHostKeyChecking=no)
if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
    command -v sshpass >/dev/null 2>&1 || fail "已配置 DEPLOY_SSH_PASSWORD 但未安装 sshpass（macOS: brew install sshpass）"
fi
run_ssh() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then sshpass -p "$DEPLOY_SSH_PASSWORD" ssh "${_SSH_OPTS[@]}" "$@"
    else ssh "${_SSH_OPTS[@]}" "$@"; fi
}
run_scp() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then sshpass -p "$DEPLOY_SSH_PASSWORD" scp "${_SSH_OPTS[@]}" "$@"
    else scp "${_SSH_OPTS[@]}" "$@"; fi
}
REMOTE="${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 读服务器上的 index（走 ssh 而不是 curl：绕开 CDN / nginx 缓存，拿到真正要被替换的那一份）
run_ssh "$REMOTE" "mkdir -p '${PLUGINS_DEPLOY_PATH}/artifacts' && cat '${PLUGINS_DEPLOY_PATH}/index.json' 2>/dev/null || true" \
    > "$STAGE/remote-index.json" || fail "读取服务器上的 index.json 失败"
if [ -s "$STAGE/remote-index.json" ]; then
    REMOTE_INDEX_SHA="$(shasum -a 256 "$STAGE/remote-index.json" | awk '{print $1}')"
    info "线上 index.json sha256=${REMOTE_INDEX_SHA:0:12}…"
else
    REMOTE_INDEX_SHA=""
    info "线上还没有 index.json（首次发布）"
fi

# ─── 打包 + 合并（G3 远端版本 / G4 单调递增都在 mergeIntoIndex 里判）───
_prep_out="$(bun run scripts/plugins-pack.ts --release-prep "$NAME" --remote-index "$STAGE/remote-index.json" --out "$STAGE/out")" \
    || fail "打包 / 合并 index 失败（见上方输出）"
_prep_line="$(echo "$_prep_out" | grep '^__PREP__ ' | tail -n 1)"
[ -n "$_prep_line" ] || fail "plugins-pack 没有输出 __PREP__ 行：$_prep_out"
read -r _ P_NAME P_VERSION P_SHA P_ARTIFACT <<<"$_prep_line"
[ "$P_NAME" = "$NAME" ] && [ "$P_VERSION" = "$VERSION" ] || fail "打包结果与 plugin.json 不一致：$_prep_line"
ok "G3/G4 版本 ${VERSION} 未发布过且高于线上最新"
info "制品 ${P_ARTIFACT}  sha256=${P_SHA}"

if [ "$DRY_RUN" = true ]; then
    echo ""
    ok "dry-run 完成：未上传、未改 index、未打 tag"
    info "合并后的 index 预览："
    sed 's/^/    /' "$STAGE/out/index.json"
    exit 0
fi

if [ "$ASSUME_YES" != true ]; then
    printf "  确认发布 %s@%s 到 %s/plugins/？[y/N] " "$NAME" "$VERSION" "$PUBLIC_BASE_URL"
    read -r _ans </dev/tty || _ans=""
    case "$_ans" in y|Y|yes|YES) ;; *) fail "已取消，服务器未改动" ;; esac
fi

# ─── 上传制品（不覆盖）→ 服务器端 sha256 复核 ───
R_ART="${PLUGINS_DEPLOY_PATH}/${P_ARTIFACT}"
R_ART_TMP="${R_ART}.upload-$$"
run_ssh "$REMOTE" "[ ! -e '${R_ART}' ] || { echo __EXISTS__; exit 0; }; mkdir -p \"\$(dirname '${R_ART}')\"; echo __OK__" \
    | grep -q '^__OK__$' || fail "服务器上已有 ${P_ARTIFACT}，版本不可覆盖（G3）"
run_scp "$STAGE/out/${P_ARTIFACT}" "${REMOTE}:${R_ART_TMP}" || fail "上传制品失败（index 未改动）"
_remote_sha="$(run_ssh "$REMOTE" "sha256sum '${R_ART_TMP}' | awk '{print \$1}'" | tr -d '[:space:]')"
if [ "$_remote_sha" != "$P_SHA" ]; then
    run_ssh "$REMOTE" "rm -f '${R_ART_TMP}'" || true
    fail "服务器端 sha256 复核失败：${_remote_sha} ≠ ${P_SHA}（index 未改动）"
fi
# mv -n：并发发布同一版本时，后到的不覆盖先到的
run_ssh "$REMOTE" "mv -n '${R_ART_TMP}' '${R_ART}' && [ ! -e '${R_ART_TMP}' ]" \
    || fail "制品落位失败（可能有并发发布），index 未改动"
ok "制品已上传，服务器端 sha256 复核通过"

# ─── 原子替换 index（先确认线上 index 没被别人改过）───
LOCAL_INDEX_SHA="$(shasum -a 256 "$STAGE/out/index.json" | awk '{print $1}')"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
R_IDX="${PLUGINS_DEPLOY_PATH}/index.json"
R_IDX_TMP="${R_IDX}.upload-$$"
run_scp "$STAGE/out/index.json" "${REMOTE}:${R_IDX_TMP}" || fail "上传 index 失败（线上 index 未改动）"
_swap_cmd="set -e
cur=\"\$(sha256sum '${R_IDX}' 2>/dev/null | awk '{print \$1}')\"
if [ \"\$cur\" != '${REMOTE_INDEX_SHA}' ]; then rm -f '${R_IDX_TMP}'; echo __CHANGED__; exit 0; fi
[ -e '${R_IDX}' ] && cp -p '${R_IDX}' '${R_IDX}.prev-${TS}'
mv -f '${R_IDX_TMP}' '${R_IDX}'
echo \"__SWAPPED__ \$(sha256sum '${R_IDX}' | awk '{print \$1}')\""
_swap_out="$(run_ssh "$REMOTE" "$_swap_cmd")" || fail "替换 index 失败：$_swap_out"
case "$_swap_out" in
    *__CHANGED__*) fail "读取后线上 index 被改过（并发发布？），已放弃替换；制品已在服务器上，重跑本脚本即可" ;;
    *"__SWAPPED__ ${LOCAL_INDEX_SHA}"*) ok "index.json 已原子替换（旧版本留在 index.json.prev-${TS}）" ;;
    *) fail "index 回读校验失败：${_swap_out}（期望 ${LOCAL_INDEX_SHA}）—— 请立即人工检查服务器" ;;
esac

# ─── tag ───
git tag -a "$TAG" -m "Release plugin ${NAME}@${VERSION} (sha256 ${P_SHA})"
git push origin "$TAG" || warn "tag 推送失败，可稍后手动推送 $TAG（发布本身已完成）"
ok "已打 tag $TAG"

# ─── 冒烟：对外地址能拿到新目录 ───
_pub="$(curl -fsSL --max-time 15 "${PUBLIC_BASE_URL}/plugins/index.json" 2>/dev/null || true)"
if echo "$_pub" | grep -q "\"sha256\": \"${P_SHA}\""; then
    ok "对外地址 ${PUBLIC_BASE_URL}/plugins/index.json 已是新目录"
else
    warn "对外地址还拿不到新目录：确认 nginx 已把 /plugins/ 指向 ${PLUGINS_DEPLOY_PATH}（或有缓存未过期）"
fi

echo ""
echo "  回滚（指针操作，不删制品）："
echo "    ssh ${REMOTE} \"cp -p '${R_IDX}.prev-${TS}' '${R_IDX}'\""
echo "  已安装新版本的用户不会自动降级；回滚只挡住还没更新的人。"
