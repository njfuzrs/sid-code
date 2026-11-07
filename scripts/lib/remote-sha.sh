#!/bin/sh
# scripts/lib/remote-sha.sh — 远端 sha256 校验的唯一实现（由 release.sh source）
#
# 为什么抽出来：`--upload` 的「落地前校验」与 `--promote` 的「促升前复核」是
# **同一段**远端脚本 + 同一套判定，此前各写一份 12 行字符串。两份都在
# 「服务器既没有 sha256sum 也没有 shasum」时远端 `exit 0`、本地 `warn` 后继续 ——
# 于是**「跳过校验」被当成通过**（X3-05）。降级之后，这两道校验存在的全部价值
# （拦截传输/磁盘层的静默损坏）归零，而日志与真正校验通过只差一行 ⚠️。
#
# 抽成一份之后，「缺工具」只有一处判定，且它可以在本地被真跑验证
# （tests/release-remote-sha.test.ts 用一个 PATH 里没有 sha 工具的 sh 执行它）。
#
# 调用约定：
#   · 本文件只定义函数，没有顶层副作用；依赖调用方提供 ok / warn / fail。
#   · remote_sha_verify_script <目录>                     → 远端要执行的 sh 脚本文本
#   · judge_remote_sha_output <输出> <场景> [失败清理钩子] → 判定并打日志（失败即 fail 退出）
#     第三个参数是函数名，会在**失败**分支里先调用（upload 侧要清掉远端半成品目录）。
#   · SKIP_REMOTE_SHA=true 时「缺工具」降级为**显式跳过**（命令行 --skip-remote-sha），
#     并且必须打出来：放弃一条门禁是一个可见的决定，不是调用环境带来的副作用。
#     这与「静默 warn」的区别是决定写在命令行上，review 时看得见。

# 远端要跑的那段：cd 到目标目录，逐个 *.sha256 校验同目录下的同名产物。
# 三个标记串是本地判定的唯一依据：
#   __SHA_OK__      全部通过
#   __NO_SHA_TOOL__ 远端既无 sha256sum 也无 shasum —— **没量到**，不是通过
#   其他            某个 .sha256 校验失败，或 cd 失败（输出里带原因）
#
# ⚠️ 只用 shell 内建（printf / echo），不依赖 `cat` 等外部命令：这段是在**远端**跑的，
# 而调用它的场景之一恰恰是「远端工具链不全」。用 heredoc + cat 的写法会让
# `PATH` 里没有 cat 时 generation 侧就静默输出空串（实测：远端脚本拿到空输入、
# 本地判定看到空输出，又是一次假绿）。
remote_sha_verify_script() {
    printf 'cd %s || exit 1\n' "'$1'"
    printf '%s\n' 'for s in *.sha256; do
    [ -e "$s" ] || continue
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c "$s" >/dev/null 2>&1 || { echo "校验失败: $s"; exit 1; }
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 -c "$s" >/dev/null 2>&1 || { echo "校验失败: $s"; exit 1; }
    else
        echo "__NO_SHA_TOOL__"; exit 0
    fi
done
echo __SHA_OK__'
}

judge_remote_sha_output() {
    local _sha_out="$1"
    local _sha_what="$2"
    local _sha_cleanup="${3:-}"

    case "$_sha_out" in
        *__SHA_OK__*)
            ok "sha256 ${_sha_what}通过"
            ;;
        *__NO_SHA_TOOL__*)
            if [ "${SKIP_REMOTE_SHA:-false}" = true ]; then
                warn "服务器上没有 sha256sum/shasum，已按 --skip-remote-sha **显式跳过** sha256 ${_sha_what}"
                warn "  ⚠️ 本次发布**没有校验传输完整性**（这是一条被显式放弃的门禁，不是通过）"
                return 0
            fi
            [ -n "$_sha_cleanup" ] && "$_sha_cleanup"
            fail "服务器上没有 sha256sum/shasum，无法做 sha256 ${_sha_what}。
  → 在服务器上装一次即可永久解决（Debian/Ubuntu: apt-get install -y coreutils；RHEL 系一般自带）。
  → 确实装不了时，显式加 --skip-remote-sha 重跑（日志会留痕，本次发布不带完整性校验）。"
            ;;
        *)
            [ -n "$_sha_cleanup" ] && "$_sha_cleanup"
            fail "sha256 ${_sha_what}输出异常：${_sha_out}"
            ;;
    esac
}
