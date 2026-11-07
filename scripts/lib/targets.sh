#!/bin/bash
# scripts/lib/targets.sh — 发布平台清单与「版本目录完整性检查」的唯一事实源
#
# ## 为什么要有这个文件（X3-04，2026-11-07）
#
# 同一份清单曾经写在两处：`release.sh` 的 `TARGETS`（5 个平台）与 `rollback.sh` 的
# `PLATFORMS`（4 个，漏 `linux-x64-baseline`）。而 `rollback.sh` 那一行的上方注释
# 写着「判据与 release.sh --promote 一致」—— 注释没拦住漂移，代码早就已经不一致：
# 只缺 baseline 的版本目录，`--promote` 判「不齐全」拒绝，`rollback.sh` 判
# 「产物齐全（4 个平台）」并回滚过去，而 baseline 是评测容器显式取用的那一档。
#
# 判据复制一份，就必然会分叉；分叉的那天不会有任何东西变红。所以清单收在这里，
# 两个脚本 `source` 同一份；完整性检查命令也一起收，让「两边判据一致」由**同一份
# 实现**保证，而不是再由一句注释声明。
#
# ⚠️ 本文件被 `release.sh` / `rollback.sh` `source`，**不要**在这里写
# `set -euo pipefail`：那会改掉调用方的 shell 选项。
#
# ⚠️ `release.sh` 里 ripgrep 上传清单（`rg-<platform>`）是**另一套产物集合**，不是
# sid-code 的发布目标，不要把它并进来。

# bun-<os>-<arch> target → 打包命名用的 <os>-<arch>
#
# ## 为什么有一条 `linux-x64-baseline`
#
# Bun 默认编译的 x64 产物**要求 AVX2 等较新指令**，在 qemu-x86_64 下一启动就
# `Illegal instruction (core dumped)`（进程 exit 132 = 128+SIGILL）。
# 而 SWE-bench 官方 per-instance 镜像**只发布 amd64**，
# 所以 arm64 机器上跑评测必须走 qemu —— 常规 x64 产物在那里一题都跑不了。
#
# ⚠️ 这个失败形态在评测里会**伪装成 agent 能力差**，而且伪装得很好：
# qemu 的 core dump 掉在工作目录里被 `git add -A` 收走，于是「patch」是两个
# core 文件的二进制 diff，`patch_bytes` 看着还挺正常
# （详见方案文档 `01-coding-agent评测集全景与sid-code接入方案.md` §附录 ZZ.2 第 4 条）。
#
# `bun-linux-x64-baseline` 编出来的产物在同一 qemu 容器里 `--version` 与
# `--self-check` 全过（含内嵌 ripgrep 可执行）。
#
# 体积代价实测是**负的**：baseline 104.7M vs 常规 105.6M（少 0.9M，2026-08-25 实测，
# bun 1.3.14）—— 所以「多一个 target 会让发布变重」这个直觉在这里不成立，
# 不要拿体积当理由把它删掉。
#
# 且**不影响原生 x64 用户**：那条常规 `linux-x64` 仍在，
# `install-template.sh` 只按 `uname` 拼 `linux-x64` / `linux-arm64`，
# 永远不会拼出 `-baseline` —— 它是**给评测显式取用的**（见
# `evals/external-benchmarks/swe-bench/exec-swebench.sh` 的 `artifact_for()` 查找路径 ②，
# 那条路径在这个 target 加进来之前指向一个**没有任何东西会产出的文件**）。
TARGETS=(
    "bun-darwin-arm64:darwin-arm64"
    "bun-darwin-x64:darwin-x64"
    "bun-linux-x64:linux-x64"
    "bun-linux-x64-baseline:linux-x64-baseline"
    "bun-linux-arm64:linux-arm64"
)

# 发布平台名（上面 `bun-<os>-<arch>:<platform>` 的右半），每行一个。
# 调用方按需决定分隔符：远端脚本要空格（`release_platforms | tr '\n' ' '`），
# 本地列举要换行。
release_platforms() {
    local t
    for t in "${TARGETS[@]}"; do
        printf '%s\n' "${t#*:}"
    done
}

# 服务器上 `<dir>/<version>/` 的完整性检查脚本（本地生成、远端执行）。
#
# 判据：**按平台逐个点名**，不数文件个数 —— 数个数会被残留的 `.part` / 旧命名文件
# 糊弄过去。输出三个哨兵之一，调用方（`release.sh --promote` / `rollback.sh`）
# 按它们分流：
#
#   __NO_DIR__             版本目录不存在
#   __MISSING__ <文件清单>  缺产物（`.tar.gz` 与其 `.sha256` 都算）
#   __COMPLETE__           齐全
#
# 参数是**远端路径与版本号字面量**：调用方传进来的值会原样拼进远端脚本。
release_dir_check_cmd() { # <远端版本目录> <版本号>
    local dir="$1" ver="$2" platforms
    platforms="$(release_platforms | tr '\n' ' ')"
    cat <<EOF
set -e
[ -d '${dir}' ] || { echo __NO_DIR__; exit 0; }
cd '${dir}'
_missing=''
for p in ${platforms}; do
    f="sid-code-${ver}-\$p.tar.gz"
    [ -f "\$f" ] || _missing="\$_missing \$f"
    [ -f "\$f.sha256" ] || _missing="\$_missing \$f.sha256"
done
if [ -n "\$_missing" ]; then echo "__MISSING__\$_missing"; exit 0; fi
echo __COMPLETE__
EOF
}
