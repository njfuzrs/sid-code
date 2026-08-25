#!/bin/bash
# scripts/rollback.sh — 把发布通道回滚到某个历史版本（秒级，纯指针操作）
#
# 用法：
#   ./scripts/rollback.sh                    # 列出服务器上可回滚的版本与两个通道当前指向
#   ./scripts/rollback.sh 0.1.600            # 把 stable 通道（latest.txt）指回 v0.1.600
#   ./scripts/rollback.sh 0.1.600 --channel beta   # 回滚 beta 通道（beta.txt）
#   ./scripts/rollback.sh 0.1.600 --yes      # 跳过交互确认（脚本化场景）
#
# ─── 为什么需要这个脚本（这才是它的全部价值）────────────────────────────────────
#
# 回滚能力**在此之前就已经存在**：服务器上是 `<path>/<version>/` 版本目录 + 顶层一行
# 指针文件，改一行文本就回滚了，5 个历史版本目录都还在（RELEASE_KEEP_VERSIONS=5）。
#
# 缺的从来不是能力，是**这件事没有任何地方写下来**。出线上事故时，要靠现场读
# release.sh（900+ 行）反推出"原来改 latest.txt 就行"，而那正是最不该做推理的时刻。
# 一个能力如果只存在于"读完源码就能推出来"，在事故现场等于不存在。
#
# 所以这个脚本刻意**只做一件事**、不做任何聪明的事：
#   · 不重新构建、不重新上传任何产物（要回滚的版本目录本来就在服务器上）
#   · 不碰 git（本地 tag / 提交 / 版本号一律不动 —— 回滚的是"用户拿到哪一版"，
#     不是"仓库停在哪一版"。两者混在一起会让回滚本身变成一次需要 review 的改动）
#   · 不删任何东西
#
# ⚠️ 回滚**不会**让已经装了坏版本的用户自动降级 —— 他们要再跑一次 `sid-code update`。
# 这个脚本挡住的是"还没更新的人不再踩坑"，这是它能做到的全部，脚本末尾会明确说这句。
#
# 凭据与 release.sh / website-deploy.sh 同源（scripts/deploy.env，不入库），
# 不新造一套凭据管理。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── 加载本地凭据（与 release.sh 同一套写法：已导出的环境变量优先于文件值）───
ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
    _pre_host="${DEPLOY_SSH_HOST:-}"
    _pre_user="${DEPLOY_SSH_USER:-}"
    _pre_pass="${DEPLOY_SSH_PASSWORD:-}"
    _pre_path="${DEPLOY_PATH:-}"
    _pre_public="${PUBLIC_BASE_URL:-}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
    [ -n "$_pre_path" ] && DEPLOY_PATH="$_pre_path"
    [ -n "$_pre_public" ] && PUBLIC_BASE_URL="$_pre_public"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/releases/sid-code}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://www.sid-code.cc}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

TARGET_VERSION=""
CHANNEL="stable"
ASSUME_YES=false

while [ $# -gt 0 ]; do
    case "$1" in
        --channel)
            CHANNEL="${2:-}"
            [ -n "$CHANNEL" ] || { echo "错误: --channel 需要传入 stable 或 beta"; exit 1; }
            shift 2
            ;;
        --yes|-y) ASSUME_YES=true; shift ;;
        --help|-h)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*) echo "未知参数: $1"; exit 1 ;;
        *)
            [ -z "$TARGET_VERSION" ] || { echo "错误: 只能指定一个版本号（收到 '$TARGET_VERSION' 与 '$1'）"; exit 1; }
            TARGET_VERSION="$1"
            shift
            ;;
    esac
done

info()  { echo "  $*"; }
ok()    { echo "  ✅ $*"; }
warn()  { echo "  ⚠️  $*" >&2; }
fail()  { echo "  ❌ $*" >&2; exit 1; }

# 未知通道值硬失败，不回落 —— 与 install-template.sh 同一条理由：
# `--channel Beta` 被当 stable 处理的话，人会以为自己回滚了 beta 而实际改了稳定通道，
# 也就是把一次"降低影响面"的操作变成了一次影响全部用户的操作。
case "$CHANNEL" in
    stable) POINTER="latest.txt" ;;
    beta)   POINTER="beta.txt" ;;
    *)      fail "未知通道 '$CHANNEL'（可选：stable / beta）" ;;
esac

[ -n "$DEPLOY_SSH_HOST" ] || fail "需要设置 DEPLOY_SSH_HOST（scripts/deploy.env 或环境变量）"
[ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER（scripts/deploy.env 或环境变量）"

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

# ─── 读服务器现状：两个通道当前指向 + 可回滚的版本目录清单 ───

REMOTE="${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}"

_state_cmd="cd '${DEPLOY_PATH}' 2>/dev/null || { echo __NO_PATH__; exit 0; }
echo \"__STABLE__\$(cat latest.txt 2>/dev/null | tr -d '[:space:]')\"
echo \"__BETA__\$(cat beta.txt 2>/dev/null | tr -d '[:space:]')\"
echo __VERSIONS__
ls -1dt */ 2>/dev/null | while IFS= read -r d; do
    d=\"\${d%/}\"
    case \"\$d\" in
        *[0-9].*[0-9].*[0-9]) echo \"\$d\" ;;
    esac
done"

_state="$(run_ssh "$REMOTE" "$_state_cmd" 2>&1)" || fail "无法读取服务器状态：${_state}"
case "$_state" in
    *__NO_PATH__*) fail "服务器上没有 ${DEPLOY_PATH}（DEPLOY_PATH 配错了？）" ;;
esac

CUR_STABLE="$(echo "$_state" | sed -n 's/^__STABLE__//p')"
CUR_BETA="$(echo "$_state" | sed -n 's/^__BETA__//p')"
VERSIONS="$(echo "$_state" | sed -n '/^__VERSIONS__$/,$p' | tail -n +2)"

echo "=== 发布通道现状（${DEPLOY_SSH_HOST}:${DEPLOY_PATH}）==="
echo ""
info "stable (latest.txt): ${CUR_STABLE:-<空>}"
info "beta   (beta.txt)  : ${CUR_BETA:-<空>}"
echo ""
echo "  服务器上可回滚的版本（按 mtime 新→旧）："
if [ -z "$VERSIONS" ]; then
    warn "一个版本目录都没有 —— 无法回滚"
else
    echo "$VERSIONS" | while IFS= read -r v; do
        _mark=""
        [ "$v" = "$CUR_STABLE" ] && _mark="  ← stable 当前"
        [ "$v" = "$CUR_BETA" ] && _mark="${_mark}  ← beta 当前"
        echo "    v${v}${_mark}"
    done
fi
echo ""

# 不带版本号 = 只看现状（事故现场第一件事就是"现在指着哪一版、有哪些可回"）
if [ -z "$TARGET_VERSION" ]; then
    echo "  回滚命令："
    echo "    ./scripts/rollback.sh <version>                  # 回滚 stable 通道"
    echo "    ./scripts/rollback.sh <version> --channel beta   # 回滚 beta 通道"
    exit 0
fi

# ─── 前置校验：目标版本必须真的能装 ───
#
# 只查"目录在不在"是不够的：半成品目录（上传中断残留）也是存在的，指过去就是 404。
# 判据与 release.sh --promote 一致 —— 按平台清单逐个点名，不数文件个数。
CUR_POINTER_VALUE="$CUR_STABLE"
[ "$CHANNEL" = "beta" ] && CUR_POINTER_VALUE="$CUR_BETA"

if [ "$TARGET_VERSION" = "$CUR_POINTER_VALUE" ]; then
    ok "${CHANNEL} 通道已经指向 v${TARGET_VERSION}，无需回滚"
    exit 0
fi

PLATFORMS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"

_check_cmd="set -e
[ -d '${DEPLOY_PATH}/${TARGET_VERSION}' ] || { echo __NO_DIR__; exit 0; }
cd '${DEPLOY_PATH}/${TARGET_VERSION}'
_missing=''
for p in ${PLATFORMS}; do
    f=\"sid-code-${TARGET_VERSION}-\$p.tar.gz\"
    [ -f \"\$f\" ] || _missing=\"\$_missing \$f\"
    [ -f \"\$f.sha256\" ] || _missing=\"\$_missing \$f.sha256\"
done
if [ -n \"\$_missing\" ]; then echo \"__MISSING__\$_missing\"; exit 0; fi
echo __COMPLETE__"

_check_out="$(run_ssh "$REMOTE" "$_check_cmd" 2>&1)" || fail "无法检查 v${TARGET_VERSION}：${_check_out}"
case "$_check_out" in
    *__NO_DIR__*)
        fail "服务器上没有 v${TARGET_VERSION} 的版本目录 —— 它可能已被保留窗口清理掉（上面的清单里就是全部可选项）"
        ;;
    *__MISSING__*)
        fail "v${TARGET_VERSION} 产物不完整，拒绝回滚到它（缺：${_check_out#*__MISSING__}）"
        ;;
    *__COMPLETE__*)
        ok "v${TARGET_VERSION} 产物齐全（4 个平台）"
        ;;
    *)
        fail "产物完整性检查输出异常：${_check_out}"
        ;;
esac

# ─── 确认 ───

echo ""
echo "  即将把 ${CHANNEL} 通道从 v${CUR_POINTER_VALUE:-<空>} 回滚到 v${TARGET_VERSION}"
if [ "$CHANNEL" = "stable" ]; then
    echo "  影响面：所有**尚未更新**的稳定版用户下次 update 会拿到 v${TARGET_VERSION}"
fi
echo ""

if [ "$ASSUME_YES" != true ]; then
    printf "  确认回滚？[y/N] "
    read -r _ans </dev/tty || _ans=""
    case "$_ans" in
        y|Y|yes|YES) ;;
        *) fail "已取消，${POINTER} 未改动" ;;
    esac
fi

# ─── 写指针 ───
#
# 本地生成再 scp（与 release.sh 同一套写法）：不用 `ssh "echo x > f"`，
# 引号层数一多就容易在远端 shell 里被吃掉，而这一步写错的后果是指针内容变成空字符串
# —— 那会让**全部**用户的 install.sh 在解析版本号那一步失败。
_tmp="$(mktemp)"
echo "$TARGET_VERSION" > "$_tmp"
run_scp "$_tmp" "${REMOTE}:${DEPLOY_PATH}/${POINTER}" || { rm -f "$_tmp"; fail "写 ${POINTER} 失败（通道保持在 v${CUR_POINTER_VALUE:-未知}）"; }
rm -f "$_tmp"

# 回读自证：scp 成功不等于内容对（本地文件写错了它也会成功传上去）。
_readback="$(run_ssh "$REMOTE" "cat '${DEPLOY_PATH}/${POINTER}' 2>/dev/null || true" 2>/dev/null | tr -d '[:space:]')"
[ "$_readback" = "$TARGET_VERSION" ] \
    || fail "回读校验失败：${POINTER} 现在是 '${_readback}'，期望 '${TARGET_VERSION}' —— 请立即人工检查服务器"

echo ""
ok "${CHANNEL} 通道已回滚到 v${TARGET_VERSION}（原为 v${CUR_POINTER_VALUE:-未知}）"
echo ""
echo "  验证："
echo "    curl -fsSL ${PUBLIC_BASE_URL}/releases/sid-code/${POINTER}"
echo ""
echo "  ⚠️  已经装了坏版本的用户不会自动降级，需要各自再跑一次："
if [ "$CHANNEL" = "beta" ]; then
    echo "    SID_CODE_CHANNEL=beta sid-code update"
else
    echo "    sid-code update"
fi
echo ""
echo "  本次回滚**没有动 git**：本地版本号、tag、提交全部保持原样。"
echo "  修好问题后正常发下一版即可，不需要为回滚补任何提交。"
