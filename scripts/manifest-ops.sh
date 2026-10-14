#!/bin/bash
# scripts/manifest-ops.sh — 版本清单 versions.json 的取数与发布（**在发布服务器上执行**，B46 P5）
#
# 用法（由 release.sh scp 到服务器 /tmp 后调用，不直接手跑）：
#   bash manifest-ops.sh dump
#       把归档里生成清单所需的原料原样吐到 stdout：一次 `ossutil ls` + 每个版本的
#       全部 .sha256 与 provenance.json 内容。解析与生成在开发机上做
#       （scripts/release-manifest.ts），这里只取数 —— 服务器上没有 bun，逻辑也不该写两份。
#       成功最后一行 `__DUMP_OK__`。
#   bash manifest-ops.sh publish <清单文件> <发布根目录>
#       ① 原子写到 <发布根目录>/versions.json（指针层，nginx 不回源）；
#       ② 在 OSS 存一份 manifest/versions-<UTC 时间戳>.json 审计副本（只追加、不覆盖）。
#       ① 成功即最后一行 `__PUBLISH_OK__`；② 失败只 warn（清单随时可从归档重建）。
#
# 环境变量：ARCHIVE_OSSUTIL / ARCHIVE_PREFIX 与 archive-version.sh 相同；
#           MANIFEST_PREFIX 审计副本前缀（默认 oss://sid-code-releases/manifest）。
#
# ⚠️ 为什么清单从**归档**生成而不是从服务器热缓存目录生成：热缓存只有最近 5 个版本，
# 而清单要列的是「所有可安装的版本」—— 那只有归档知道。用热缓存生成，--list 就只剩 5 行，
# 而且看起来完全正常。

set -euo pipefail

die() { echo "  ❌ [manifest-ops] $*" >&2; exit 1; }

# shellcheck disable=SC2206
OSSUTIL=(${ARCHIVE_OSSUTIL:-/usr/local/bin/ossutil64 -c /root/.ossutilconfig-releases})
PREFIX="${ARCHIVE_PREFIX:-oss://sid-code-releases/sid-code}"
PREFIX="${PREFIX%/}"
MANIFEST_PREFIX="${MANIFEST_PREFIX:-oss://sid-code-releases/manifest}"
MANIFEST_PREFIX="${MANIFEST_PREFIX%/}"

# ossutil 一律 </dev/null：它会尝试交互提问，读到 stdin 就会吃掉调用方的输入
oss() { "${OSSUTIL[@]}" "$@" </dev/null; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sid-manifest-ops-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

case "${1:-}" in
dump)
    listing="$(oss ls "${PREFIX}/")" || die "ossutil ls 失败: ${PREFIX}/"
    echo "__LS_BEGIN__"
    printf '%s\n' "$listing"
    echo "__LS_END__"
    # 只取 <PREFIX>/<x.y.z>/ 下的 .sha256 与 provenance.json：
    # 探针（_probe/）等版本目录之外的对象不进清单
    # 前缀用 awk index 精确比对、不拼进正则：bucket 名里的 `.`/`-` 进正则就是一类静默错配
    keys="$(awk -v p="${PREFIX}/" '{ k = $NF } index(k, p) == 1 { print substr(k, length(p) + 1) }' <<<"$listing" \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+/([A-Za-z0-9._-]+\.sha256|provenance\.json)$' \
        | sed "s|^|${PREFIX}/|" || true)"
    n=0
    while IFS= read -r k; do
        [ -n "$k" ] || continue
        f="$WORK/obj"
        oss cp -f "$k" "$f" >/dev/null || die "下载失败: $k"
        echo "__FILE__ $k"
        cat "$f"
        # 内容末尾可能没有换行：补一个，保证结束标记独占一行
        [ -z "$(tail -c 1 "$f")" ] || echo
        echo "__ENDFILE__"
        n=$((n + 1))
    done <<<"$keys"
    echo "  [manifest-ops] 取到 ${n} 个元数据对象" >&2
    echo "__DUMP_OK__"
    ;;
publish)
    SRC="${2:-}"
    ROOT_DIR="${3:-}"
    [ -f "$SRC" ] || die "清单文件不存在: ${SRC}"
    [ -d "$ROOT_DIR" ] || die "发布根目录不存在: ${ROOT_DIR}"
    grep -Eq '"schema": ?1[,}]' "$SRC" || die "清单形态不对（缺 schema: 1），拒绝发布"
    # 同目录临时文件 + mv：读者要么看到旧清单，要么看到完整的新清单
    tmp="${ROOT_DIR}/.versions.json.tmp.$$"
    cp "$SRC" "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "${ROOT_DIR}/versions.json"
    echo "  [manifest-ops] 已写入 ${ROOT_DIR}/versions.json"

    key="${MANIFEST_PREFIX}/versions-$(date -u +%Y%m%dT%H%M%SZ).json"
    # 只追加不覆盖：同名已存在（同一秒内重复发布）就跳过，不碰已有副本
    if grep -Fxq "$key" <<<"$(oss ls -s "$key" 2>/dev/null | grep -E '^oss://' || true)"; then
        echo "  ⚠️  [manifest-ops] 审计副本 ${key} 已存在，跳过（不覆盖）" >&2
    elif oss cp "$SRC" "$key" >/dev/null 2>&1; then
        echo "  [manifest-ops] 审计副本: ${key}"
    else
        echo "  ⚠️  [manifest-ops] 审计副本上传失败（不影响清单；清单可随时从归档重建）" >&2
    fi
    echo "__PUBLISH_OK__"
    ;;
*)
    die "用法: manifest-ops.sh dump | publish <清单文件> <发布根目录>"
    ;;
esac
