#!/usr/bin/env bash
#
# 清理 dist/branch-builds/ 里的旧分支包。**默认 dry-run，不删任何东西。**
#
#   用法: scripts/prune-branch-builds.sh [--apply] [--keep N]
#
# ## 为什么需要它
#
# 一个分支包 143MB（93MB 裸二进制 + 34MB tar.gz + sidecar）。`build-branch-artifact.sh`
# 每换一个 commit 就多一个目录，而它们没有任何自动回收 —— 跑一周评测就是几个 GB。
#
# ## 判据刻意**不用 mtime**
#
# 两条理由，都是实测出来的：
#
#   ① `cp` / 下载 / `docker cp` 会把 mtime 重置成"现在"，所以 mtime 既不描述
#      「这个包多老」也不描述「它还有没有用」—— 整个构建溯源方案的起因就是
#      mtime 判据两个方向都会错（方案 §1 F2）。
#   ② 本仓另有一条实测教训（记忆 `mtime-float-breaks-maxage-zero`）：
#      mtime 是浮点，`maxAgeMs=0` 这类边界会静默恒 false 且**不报错**。
#
# 用的是「**目录名里的 commit 是否还被引用**」+ 「commit 的提交时间」（git 说的，
# 不是文件系统说的）。
#
# ## 三档决策
#
#   protected  commit 仍是某个本地分支的 HEAD（含当前 HEAD）→ 永不删
#   keep       在按 commit 时间排序的最近 N 个里 → 保留
#   prune      其余 → 删除候选
#   unknown    目录名解不出 commit12，或那个 commit 不在本地对象库 → **保留并点破**
#
# ⚠️ `unknown` 一律保留，不是"顺手也删了"。本仓有一条铁律（`CLAUDE.md` §0）：
# 这个仓库随时有多任务并行，`dist/` 里可能有别人正在用的包。
# **留着一个多余目录的代价是几十 MB；删错一个的代价是别人几小时的工作。**
# 所以判不出来时一律偏向保留，且必须在输出里说清楚"这个我没判"。
#
# ⚠️ 同理：删除前**一定先把完整清单打印出来**（三档全打，不只打要删的那几个）。
# 只打印要删的那几个，人就无法核对「该保的有没有被误判成 prune」。
#
# ⚠️ 一条已知性质（不是 bug，但会让人以为脚本没生效）：`refs/heads` 是整个仓库的，
# 已合并但没删的本地分支照样把它的包钉成 `protected`。实测在一个有 7 条陈旧分支的
# checkout 上跑 `--keep 3`，10 个目录里 4 个是 protected、只删掉 1 个。
# 想真正回收空间就先 `git branch -d` 清掉陈旧分支 —— 这条刻意不自动化：
# 「哪条分支还要不要」只有人知道，而这里的判据一旦替人做这个决定，
# 就会删掉某个人正在用的包（本仓 §0 铁律防的正是这件事）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 测试用的注入点：让测试对着一个合成目录跑**真脚本**，而不是重写一遍判据。
# （重写一遍的后果是测的那份和跑的那份各自漂移，而漂移不报错。）
BB_DIR="${BRANCH_BUILDS_DIR:-$ROOT/dist/branch-builds}"

APPLY=false
KEEP=10

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=true; shift ;;
        --dry-run) APPLY=false; shift ;;
        --keep) KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
        -h | --help)
            sed -n '2,6p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *) echo "未知参数: $1" >&2; exit 64 ;;
    esac
done

case "$KEEP" in
    '' | *[!0-9]*) echo "--keep 必须是非负整数，收到: $KEEP" >&2; exit 64 ;;
esac

if [ ! -d "$BB_DIR" ]; then
    echo "没有 $BB_DIR —— 无事可做。"
    exit 0
fi

# ─── 收集「受保护的 commit」：全部本地分支 HEAD + 当前 HEAD ───
#
# 用全长 40 位取出来再截 12 位比对。反过来（拿 12 位去 git 里查）会引入前缀歧义，
# 而歧义的形态是"误判成 unknown 然后保留"——不致命，但没必要。
PROTECTED_COMMITS=""
while IFS= read -r sha; do
    [ -n "$sha" ] && PROTECTED_COMMITS="${PROTECTED_COMMITS} ${sha:0:12}"
done < <(git -C "$ROOT" for-each-ref --format='%(objectname)' refs/heads 2>/dev/null || true)
_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
[ -n "$_head" ] && PROTECTED_COMMITS="${PROTECTED_COMMITS} ${_head:0:12}"

is_protected() {
    case " ${PROTECTED_COMMITS} " in
        *" $1 "*) return 0 ;;
        *) return 1 ;;
    esac
}

# ─── 分档 ───
#
# 排序键是 **git 说的提交时间**（`git log -1 --format=%ct`），不是文件 mtime。
# 取不到就归 unknown（保留），不给它编一个时间 —— 编一个的后果是它会参与排序，
# 然后按一个假数字被删掉。
CANDIDATES=""   # "<ct>\t<dirname>" 的行，按 ct 排序
UNKNOWNS=""
PROTECTEDS=""

for d in "$BB_DIR"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    # 目录名形态 `<branch-slug>-<commit12>`：只取结尾那 12 位十六进制。
    commit12="${name##*-}"
    case "$commit12" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
        *) UNKNOWNS="${UNKNOWNS}${name}\t目录名结尾不是 12 位 commit\n"; continue ;;
    esac
    if is_protected "$commit12"; then
        PROTECTEDS="${PROTECTEDS}${name}\t${commit12} 仍是某个本地分支的 HEAD\n"
        continue
    fi
    ct="$(git -C "$ROOT" log -1 --format=%ct "$commit12" 2>/dev/null || true)"
    case "$ct" in
        '' | *[!0-9]*) UNKNOWNS="${UNKNOWNS}${name}\t${commit12} 不在本地对象库（别人编的？没 fetch？）\n"; continue ;;
    esac
    CANDIDATES="${CANDIDATES}${ct}\t${name}\n"
done

# 按提交时间降序（新的在前），前 KEEP 个保留。
SORTED="$(printf '%b' "$CANDIDATES" | grep -v '^$' | sort -rn -k1,1 || true)"
TOTAL_CAND=0
[ -n "$SORTED" ] && TOTAL_CAND="$(printf '%s\n' "$SORTED" | wc -l | tr -d ' ')"

KEEPS=""
PRUNES=""
i=0
while IFS=$'\t' read -r ct name; do
    [ -n "${name:-}" ] || continue
    i=$((i + 1))
    when="$(date -r "$ct" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$ct")"
    if [ "$i" -le "$KEEP" ]; then
        KEEPS="${KEEPS}${name}\t提交于 ${when}（最近 ${KEEP} 个之内）\n"
    else
        PRUNES="${PRUNES}${name}\t提交于 ${when}\n"
    fi
done < <(printf '%s\n' "$SORTED")

# ─── 打印完整清单（三档全打，见文件头）───
show() {
    local label="$1" body="$2" color="$3"
    printf '%b' "$body" | grep -v '^$' | while IFS=$'\t' read -r name why; do
        [ -n "${name:-}" ] || continue
        local size
        size="$(du -sh "$BB_DIR/$name" 2>/dev/null | cut -f1 || echo '?')"
        printf '  \033[%sm%-9s\033[0m %-46s %6s  %s\n' "$color" "$label" "$name" "$size" "$why"
    done
}

echo "=== dist/branch-builds 清理计划（--keep ${KEEP}，判据=commit 引用 + 提交时间，**不看 mtime**）==="
echo ""
show protected "$PROTECTEDS" 32
show keep "$KEEPS" 36
show unknown "$UNKNOWNS" 33
show prune "$PRUNES" 31
echo ""

PRUNE_COUNT=0
[ -n "$PRUNES" ] && PRUNE_COUNT="$(printf '%b' "$PRUNES" | grep -c . || true)"

if [ "$PRUNE_COUNT" -eq 0 ]; then
    echo "没有需要清理的目录（候选 ${TOTAL_CAND} 个，全部在保留窗口内或受保护）。"
    exit 0
fi

if [ "$APPLY" != true ]; then
    echo "以上 ${PRUNE_COUNT} 个是**删除候选**。这是 dry-run，什么都没删。"
    echo "确认无误后加 --apply 执行："
    echo "    scripts/prune-branch-builds.sh --apply --keep ${KEEP}"
    exit 0
fi

printf '%b' "$PRUNES" | grep -v '^$' | while IFS=$'\t' read -r name _; do
    [ -n "${name:-}" ] || continue
    # 只删 BB_DIR 下的一级子目录。路径拼错时宁可什么都不做。
    target="$BB_DIR/$name"
    case "$name" in
        */* | '' | '.' | '..') echo "  ⚠️  跳过可疑目录名: $name" >&2; continue ;;
    esac
    [ -d "$target" ] || continue
    rm -rf "$target"
    echo "  🗑  已删除 $name"
done

echo ""
echo "完成。剩余："
ls -1 "$BB_DIR" 2>/dev/null | sed 's/^/  /' || true
