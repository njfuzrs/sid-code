#!/bin/bash
# scripts/archive-ops.sh — 热缓存 ↔ OSS 归档的两个只读/回填操作（**在发布服务器上执行**）
#
# 用法（由 release.sh / rollback.sh scp 到服务器 /tmp 后调用，不直接手跑）：
#   bash archive-ops.sh verify <版本目录> <版本号>
#       问归档：这个版本目录能不能删。最后一行 `__ARCHIVED__ <ver>` 才算能删，
#       其余一律是 `__NOT_ARCHIVED__ <ver> <原因>`（退出码 0：这是一个合法答案，不是故障）。
#   bash archive-ops.sh warm <发布根目录> <版本号>
#       回暖：服务器没有这个版本目录时，从归档拉回并 sha256 校验后原子落位。
#       成功最后一行 `__WARM_OK__ <ver>`；目录已在则 `__WARM_PRESENT__ <ver>`。
#
# 环境变量与 archive-version.sh 相同：ARCHIVE_OSSUTIL / ARCHIVE_PREFIX / ARCHIVE_PLATFORMS。
#
# ─── 为什么 verify 要三条全过才算「已归档」（B46 P3）─────────────────────────
#
# 清理是**唯一会删原始字节**的地方，而发布凭据删不掉 OSS 对象、也就没法事后补救。
# 所以「能删」的判据必须比「归档时回读校验过」更强：归档之后对象可能被人在控制台删了、
# 换了，服务器上的目录也可能被人手工改过。删除前当场再问一次：
#   1. 每个平台的 tarball 与 .sha256 都在归档里（逐 key 精确比对，`ls` 是前缀匹配）；
#   2. 归档里的 .sha256 与服务器上的**逐字相同**（下载回来 cmp，不比 ETag：分片上传的 ETag 不是 MD5）；
#   3. 对象大小与服务器文件一致（tarball 不整包下载，大小是它的廉价代理）。
# 任一不满足 → 不删。判据缺的方向只会多留一个目录，不会少一个版本。

set -euo pipefail

die() { echo "  ❌ [archive-ops] $*" >&2; exit 1; }

MODE="${1:-}"
case "$MODE" in
    verify|warm) ;;
    *) die "用法: archive-ops.sh verify <版本目录> <版本号> | warm <发布根目录> <版本号>" ;;
esac
VERSION="${3:-}"
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "版本号形态不对: ${VERSION}" ;;
esac

# shellcheck disable=SC2206
OSSUTIL=(${ARCHIVE_OSSUTIL:-/usr/local/bin/ossutil64 -c /root/.ossutilconfig-releases})
PREFIX="${ARCHIVE_PREFIX:-oss://sid-code-releases/sid-code}"
PREFIX="${PREFIX%/}/${VERSION}"
PLATFORMS="${ARCHIVE_PLATFORMS:-darwin-arm64 darwin-x64 linux-x64 linux-x64-baseline linux-arm64}"

# ossutil 一律 </dev/null：它会尝试交互提问，读到 stdin 就会吃掉调用方的输入
oss() { "${OSSUTIL[@]}" "$@" </dev/null; }

sha_check() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c "$1" >/dev/null 2>&1
    else
        shasum -a 256 -c "$1" >/dev/null 2>&1
    fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sid-archive-ops-${VERSION}-XXXXXX")"
STAGE=""
trap 'rm -rf "$WORK"; [ -z "$STAGE" ] || rm -rf "$STAGE"' EXIT

# ─── verify ─────────────────────────────────────────────────────────────────
if [ "$MODE" = verify ]; then
    DIR="${2:-}"
    [ -d "$DIR" ] || die "版本目录不存在: ${DIR}"
    DIR="$(cd "$DIR" && pwd)"
    no() { echo "__NOT_ARCHIVED__ ${VERSION} $*"; exit 0; }

    # 不带 -s 的 ls 每行是「日期 时间 时区 时区名 大小 存储类型 ETag 对象名」，从行尾取列：
    # 对象名 = $NF、大小 = $(NF-3)。ossutil 失败直接 die（调用方把非 __ARCHIVED__ 一律当「不删」）
    listing="$(oss ls "${PREFIX}/")" || die "ossutil ls 失败: ${PREFIX}/"
    remote_size() { awk -v k="${PREFIX}/$1" '$NF == k { print $(NF-3); exit }' <<<"$listing"; }
    local_size() { wc -c <"$DIR/$1" | tr -d ' '; }

    for p in $PLATFORMS; do
        t="sid-code-${VERSION}-${p}.tar.gz"
        for f in "$t" "$t.sha256"; do
            [ -f "$DIR/$f" ] || no "服务器目录缺 ${f}（不完整的目录不按「已归档」处理）"
            rs="$(remote_size "$f")"
            [ -n "$rs" ] || no "归档里没有 ${f}"
            [ "$rs" = "$(local_size "$f")" ] || no "${f} 大小不一致（归档 ${rs}，服务器 $(local_size "$f")）"
        done
        oss cp -f "${PREFIX}/$t.sha256" "$WORK/$t.sha256" >/dev/null || no "下载归档 ${t}.sha256 失败"
        cmp -s "$WORK/$t.sha256" "$DIR/$t.sha256" || no "归档的 ${t}.sha256 与服务器内容不同"
    done
    echo "__ARCHIVED__ ${VERSION}"
    exit 0
fi

# ─── warm ───────────────────────────────────────────────────────────────────
ROOT_DIR="${2:-}"
[ -d "$ROOT_DIR" ] || die "发布根目录不存在: ${ROOT_DIR}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
TARGET="${ROOT_DIR}/${VERSION}"
if [ -e "$TARGET" ]; then
    echo "__WARM_PRESENT__ ${VERSION}"
    exit 0
fi

existing="$(oss ls -s "${PREFIX}/" | grep -E '^oss://' || true)"
for p in $PLATFORMS; do
    t="sid-code-${VERSION}-${p}.tar.gz"
    for f in "$t" "$t.sha256"; do
        # here-string 而非 `printf | grep -q`：后者在 pipefail 下会因 SIGPIPE 偶发判失败
        grep -Fxq "${PREFIX}/$f" <<<"$existing" || die "归档里没有 v${VERSION} 的 ${f}，无法回暖"
    done
done

# 拉到发布根目录下的隐藏目录：与目标同一文件系统，最后一步 mv 是原子的；
# `.` 开头的名字既不进 `ls */`（清理的候选集），也不进 nginx autoindex
STAGE="${ROOT_DIR}/.warm-${VERSION}-$$"
mkdir -p "$STAGE"
oss cp -r -f "${PREFIX}/" "$STAGE/" >/dev/null || die "从归档下载 v${VERSION} 失败"
(
    cd "$STAGE"
    for p in $PLATFORMS; do
        t="sid-code-${VERSION}-${p}.tar.gz"
        [ -f "$t" ] && [ -f "$t.sha256" ] || die "回暖下载缺对象: ${t}(.sha256)"
        sha_check "$t.sha256" || die "回暖 sha256 校验失败: ${t}"
    done
)
chmod 755 "$STAGE"
# 下载期间被别的进程放回了（并发回滚/促升）：以已在的为准，丢弃本次
[ ! -e "$TARGET" ] || { echo "__WARM_PRESENT__ ${VERSION}"; exit 0; }
mv "$STAGE" "$TARGET"
STAGE=""
echo "  [archive-ops] 已从归档回暖 v${VERSION}（sha256 校验通过）"
echo "__WARM_OK__ ${VERSION}"
