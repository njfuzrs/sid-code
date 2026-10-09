#!/bin/bash
# scripts/archive-version.sh — 把服务器上的一个版本目录归档到 OSS（**在发布服务器上执行**）
#
# 用法（由 release.sh scp 到服务器 /tmp 后调用，不直接手跑）：
#   bash archive-version.sh <版本目录> <版本号> <provenance>
#     <provenance>  original | rebuilt
#
# 环境变量：
#   ARCHIVE_OSSUTIL   ossutil 调用前缀（默认用发布专用凭据，见下）
#   ARCHIVE_PREFIX    归档前缀（默认 oss://sid-code-releases/sid-code）
#   ARCHIVE_PLATFORMS 必须齐全的平台列表（空格分隔，默认与 release.sh 的 TARGETS 一致）
#
# 成功时最后一行输出 `__ARCHIVE_OK__ <版本号>`，release.sh 以这一行为唯一成功判据。
#
# ─── 为什么「已归档」的判据是回读校验，而不是「上传命令返回 0」────────────────
#
# 归档层是「热缓存可以淘汰」的唯一前提（B46 P3）。它要是假的，淘汰就是删除。
# 实测 ossutil 有两处会让「返回 0」不等于「对象是对的」：
#   · `cp` 遇到目标已存在：非交互默认 **skip 且返回 0**，打印 `skip 1 files`。
#     所以「禁止覆盖」不能靠 cp 返回码，`x-oss-forbid-overwrite` 也不依赖。
#   · `stat` 要读 ACL，发布凭据没有 GetObjectAcl → 403。存在性改用 `ls -s` 精确比对 key。
#     ⚠️ `ls` 是**前缀**匹配：`ls …/x.tar.gz` 也会列出 `x.tar.gz.sha256`，
#     看 `Object Number` 会把「只有 .sha256」误判成「tarball 在」。必须逐行 `grep -Fx`。
# 所以最后把整个前缀下载回来跑 `sha256sum -c`，并逐字比对 .sha256 —— 这是唯一判据。
#
# ─── 已存在的对象：不覆盖，但不拒绝 ────────────────────────────────────────
#
# 发布凭据本来就没有删除权限（Bucket Policy 拒绝 DeleteObject），已存在的对象**只能**由
# 主账号在控制台删。所以「已存在即失败」会让一次中途失败的归档永远无法重跑。
# 这里改为：已存在的跳过、缺的补传，然后整体回读校验 —— 已存在但内容不对的，在回读那一步
# 一样会红。不覆盖这条不变量不变，换来的是可重入。

set -euo pipefail

VERSION_DIR="${1:-}"
VERSION="${2:-}"
PROVENANCE="${3:-}"

die() { echo "  ❌ [archive] $*" >&2; exit 1; }
log() { echo "  [archive] $*"; }

[ -n "$VERSION_DIR" ] && [ -n "$VERSION" ] && [ -n "$PROVENANCE" ] \
    || die "用法: archive-version.sh <版本目录> <版本号> <original|rebuilt>"
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "版本号形态不对: $VERSION" ;;
esac
case "$PROVENANCE" in
    original|rebuilt) ;;
    *) die "provenance 只能是 original 或 rebuilt（不能把重建产物标成 original）: $PROVENANCE" ;;
esac
[ -d "$VERSION_DIR" ] || die "版本目录不存在: $VERSION_DIR"
# 转绝对路径：下面会 cd 进回读目录，相对路径会在那之后指向错的地方
VERSION_DIR="$(cd "$VERSION_DIR" && pwd)"

# shellcheck disable=SC2206
OSSUTIL=(${ARCHIVE_OSSUTIL:-/usr/local/bin/ossutil64 -c /root/.ossutilconfig-releases})
PREFIX="${ARCHIVE_PREFIX:-oss://sid-code-releases/sid-code}"
PREFIX="${PREFIX%/}/${VERSION}"
PLATFORMS="${ARCHIVE_PLATFORMS:-darwin-arm64 darwin-x64 linux-x64 linux-x64-baseline linux-arm64}"

# ossutil 一律 </dev/null：它在目标已存在时会尝试交互提问，读到 stdin 就会吃掉调用方的输入
oss() { "${OSSUTIL[@]}" "$@" </dev/null; }

sha_check() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c "$1" >/dev/null 2>&1
    else
        shasum -a 256 -c "$1" >/dev/null 2>&1
    fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sid-archive-${VERSION}-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ─── 1. 前置：平台齐全 + 服务器本地 sha256 复核 ───────────────────────────────
cd "$VERSION_DIR"
FILES=()
for p in $PLATFORMS; do
    t="sid-code-${VERSION}-${p}.tar.gz"
    [ -f "$t" ] || die "缺平台产物: $t"
    [ -f "$t.sha256" ] || die "缺校验文件: $t.sha256"
    sha_check "$t.sha256" || die "服务器本地 sha256 复核失败: $t"
    FILES+=("$t" "$t.sha256")
done
log "v${VERSION}：$(echo $PLATFORMS | wc -w | tr -d ' ') 个平台齐全，本地 sha256 复核通过"

# ─── 2. provenance.json：从产物字节里取身份，不从环境猜 ─────────────────────────
#
# commit / built_at 取二进制内联的 SIDCODE_BUILD_V1 行（G2 构建溯源编进去的），
# bun_version 取二进制里的 `Bun vX.Y.Z`。不用版本目录 mtime（那是上传时间）、
# 不用 tag（tag 打在 bump 提交上，构建的是它的父提交）、不用发布机当前的 bun（可能已升级）。
probe_tar="sid-code-${VERSION}-linux-x64.tar.gz"
mkdir -p "$WORK/probe"
tar -xzf "$probe_tar" -C "$WORK/probe" 2>/dev/null || die "解包失败: $probe_tar"
bin="$WORK/probe/sid-code/sid-code"
[ -f "$bin" ] || die "$probe_tar 里没有 sid-code/sid-code"
# 字符类排除 `"`：真实二进制里这一行是 JS 字符串字面量 `"SIDCODE_BUILD_V1|…";`，
# 用 `[ -~]*` 会把收尾的 `";` 一起吞进 dirty_files（0.1.602–0.1.606 首次归档实测踩到）
build_line="$(LC_ALL=C grep -aoE 'SIDCODE_BUILD_V1\|commit=[0-9a-f]{40}\|[ !#-~]*' "$bin" | head -1 || true)"
bun_ver="$(LC_ALL=C grep -aoE 'Bun v[0-9]+\.[0-9]+\.[0-9]+' "$bin" | head -1 | sed 's/^Bun v//' || true)"
rm -rf "$WORK/probe"
[ -n "$build_line" ] || die "产物里取不到 SIDCODE_BUILD_V1 构建身份行（不是发布流程编出来的？）"

python3 - "$WORK/provenance.json" "$VERSION" "$PROVENANCE" "$build_line" "$bun_ver" <<'PY'
import json, sys
out, version, prov, line, bun = sys.argv[1:6]
f = dict(kv.split("=", 1) for kv in line.split("|")[1:] if "=" in kv)
note = ""
if f.get("dirty") == "true":
    note = "构建时工作区 dirty=true 是发布流程固有（bump 后构建），dirty_files=" + f.get("dirty_files", "")
json.dump({
    "schema": 1,
    "version": version,
    "git_tag": "v" + version,
    "commit": f.get("commit", "unknown"),
    "provenance": prov,
    "built_at": f.get("built_at", "unknown"),
    "bun_version": bun or "unknown",
    "build_info": line,
    "note": note,
}, open(out, "w"), ensure_ascii=False, indent=2)
open(out, "a").write("\n")
PY

# ─── 3. 上传：已存在的跳过（不覆盖），缺的补传 ────────────────────────────────
existing="$(oss ls -s "${PREFIX}/" | grep -E '^oss://' || true)"
# ⚠️ 不能写成 `printf … | grep -q`：pipefail 下 grep -q 命中即退出，printf 尚未写完就吃
# SIGPIPE（141），整条管道判失败 —— 对象明明在却报「不存在」。触发与否取决于管道缓冲时序，
# 首次对真 OSS 归档 0.1.602 时时有时无地踩到。here-string 没有写端，不存在这个竞态。
has_key() { grep -Fxq "${PREFIX}/$1" <<<"$existing"; }

uploaded=0; skipped=0
upload_one() { # <本地路径> <对象名>
    if has_key "$2"; then
        skipped=$((skipped + 1)); return 0
    fi
    oss cp "$1" "${PREFIX}/$2" >/dev/null || die "上传失败: $2"
    uploaded=$((uploaded + 1))
}
for f in "${FILES[@]}"; do upload_one "$VERSION_DIR/$f" "$f"; done
upload_one "$WORK/provenance.json" "provenance.json"
log "上传 ${uploaded} 个对象，跳过已存在 ${skipped} 个（已存在的一律不覆盖）"

# cp 返回 0 不代表写进去了（见文件头），再列一次确认每个 key 都在
existing="$(oss ls -s "${PREFIX}/" | grep -E '^oss://' || true)"
for f in "${FILES[@]}" provenance.json; do
    has_key "$f" || die "上传后对象仍不存在: ${PREFIX}/$f"
done

# ─── 4. 回读校验：「已归档」的唯一判据 ────────────────────────────────────────
back="$WORK/readback"
mkdir -p "$back"
oss cp -r -f "${PREFIX}/" "$back/" >/dev/null || die "回读下载失败: ${PREFIX}/"
cd "$back"
for p in $PLATFORMS; do
    t="sid-code-${VERSION}-${p}.tar.gz"
    [ -f "$t" ] && [ -f "$t.sha256" ] || die "回读缺对象: $t(.sha256)"
    # 归档里的 .sha256 必须与服务器上的逐字相同：只跑 -c 的话，tarball 和 .sha256
    # 被一起换掉也能过
    cmp -s "$t.sha256" "$VERSION_DIR/$t.sha256" || die "归档的 $t.sha256 与服务器不一致"
    sha_check "$t.sha256" || die "回读 sha256 校验失败: $t"
done
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["version"]==sys.argv[2], d["version"]' \
    provenance.json "$VERSION" 2>/dev/null || die "归档里的 provenance.json 缺失或版本号不符"

log "回读校验通过：${PREFIX}/"
echo "__ARCHIVE_OK__ ${VERSION}"
