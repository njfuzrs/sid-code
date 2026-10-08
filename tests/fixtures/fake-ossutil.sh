#!/bin/bash
# 假 ossutil（供 tests/release-archive.test.ts 用）：oss://<bucket>/<key> 映射到 $FAKE_OSS_ROOT/<key>。
#
# 刻意复刻真 ossutil v1.7.16 的两处行为（都在 ECS 上实测过），否则测试证明不了归档脚本防住了它们：
#   · `cp` 目标已存在：不覆盖、打印 skip、**返回 0**
#   · `ls` 是前缀匹配：`ls …/x.tar.gz` 也会列出 `x.tar.gz.sha256`
#
# 故障注入：
#   FAKE_OSS_DROP=<文件名>     cp 该对象时返回 0 但不写入（静默丢失）
#   FAKE_OSS_CORRUPT=<文件名>  回读（cp -r）时把该文件改坏
set -e
R="${FAKE_OSS_ROOT:?}"
key_path() { echo "$R/$(echo "${1#oss://}" | cut -d/ -f2-)"; }
bucket() { echo "oss://$(echo "${1#oss://}" | cut -d/ -f1)"; }

cmd="$1"; shift
case "$cmd" in
ls)
    [ "$1" = -s ] && shift
    p="$(key_path "$1")"; b="$(bucket "$1")"
    (cd "$R" && find . -type f | sed 's|^\./||') | while read -r k; do
        case "$R/$k" in "$p"*) echo "$b/$k" ;; esac
    done
    echo "Object Number is: x"
    ;;
cp)
    if [ "$1" = -r ]; then
        shift 2 # -r -f
        mkdir -p "$2"
        cp -R "$(key_path "$1")"/. "$2"/
        [ -z "${FAKE_OSS_CORRUPT:-}" ] || echo x >> "$2/$FAKE_OSS_CORRUPT"
        exit 0
    fi
    d="$(key_path "$2")"
    if [ -e "$d" ]; then echo "Succeed: skip 1 files"; exit 0; fi
    [ "$(basename "$d")" != "${FAKE_OSS_DROP:-}" ] || exit 0
    mkdir -p "$(dirname "$d")"
    cp "$1" "$d"
    ;;
*) echo "fake-ossutil: 不支持 $cmd" >&2; exit 2 ;;
esac
