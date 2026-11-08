#!/bin/sh
# 安装 scripts/git-hooks/ 下的 hook 到 git 的 hooks 目录
#
# 用法：bun run install-hooks
# 或：sh scripts/install-git-hooks.sh
#
# ## 装的是 shim，不是副本（X3-11）
#
# 原先这里是 `cp "$src" "$dst"`，于是 `.git/hooks/<name>` 与 `scripts/git-hooks/<name>.sh`
# 从装完那一刻起各走各的：`git pull` 拉到 hook 源文件的改动后，本地执行的仍是旧副本，
# 且没有任何提示。失效形态是**静默**的 —— 有人给 pre-commit 加了新门禁并合入，
# 所有已装过 hook 的人和 agent 本地都不跑它，提交照常通过，而门禁看起来「已存在」。
#
# 现在写的是固定内容的转发脚本：每次执行都现取当前 checkout 里的源文件。
# 源文件更新后**不需要重装**，漂移从根上消失。
# 用 `exec` 转发（而不是 `sh "$_src"` 后再 `exit $?`）是为了保留 stdin ——
# pre-push 的推送区间就是通过 stdin 喂进来的（X3-02），转发层不能把它吞掉。

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
SRC_DIR="$REPO_ROOT/scripts/git-hooks"

# hooks 目录 = git 的**实际生效位置**，由 core.hooksPath 决定：
#   · 已设置（本仓本机 `.git/config` 就是这样，值为 .git/hooks 的绝对路径）
#     → 必须装到那里，否则装完等于没装；相对路径按 git 语义相对**工作树根**解析。
#   · 未设置 → 主仓 .git 下的 hooks/，用 --git-common-dir 定位。
#
# 必须用 --git-common-dir，不能拼 "$REPO_ROOT/.git"：
# 在 **worktree** 里 `.git` 是一个**文件**（内容形如 `gitdir: …/.git/worktrees/<name>`），
# 于是 `mkdir "$REPO_ROOT/.git/hooks"` 直接失败（`Not a directory`），整个安装退 1。
# 实测后果不是"少装一次"——本仓日常就在 worktree 里干活（一次并行开发同时有 7 个），
# 于是所有 hook 门禁在 worktree 里**从来没装上过**，而失败信息藏在 bun run 的输出里很容易被划过去。
#
# --git-common-dir 在主 checkout 与 worktree 里都解析到**主仓** .git 目录，
# 这正好也是我们要的语义：hooks 是仓库级共享的（git 不支持 per-worktree hooks），
# 主仓装一次，全部 worktree 生效 —— 而 shim 里的 `--show-toplevel` 会解析到
# **当前 checkout**，所以每个 worktree 执行的仍是它自己分支的 hook 版本（期望如此）。
_hooks_path=$(git config --get core.hooksPath 2>/dev/null || true)
if [ -n "$_hooks_path" ]; then
  case "$_hooks_path" in
    /*) DST_DIR="$_hooks_path" ;;
    *) DST_DIR="$REPO_ROOT/$_hooks_path" ;;
  esac
else
  DST_DIR="$(git rev-parse --git-common-dir)/hooks"
fi

if [ ! -d "$SRC_DIR" ]; then
  echo "❌ 找不到 $SRC_DIR"
  exit 1
fi

mkdir -p "$DST_DIR"

# 只装 git 会按名字调用的 hook。
# ⚠️ 不能写 `for src in "$SRC_DIR"/*.sh`：`push-scope.sh` 是 pre-push 的辅助脚本，
# 装成 `.git/hooks/push-scope` 不会被 git 调用，只会留下一个误导人的死文件
# （X3-11 改造时顺带发现：旧循环会把 src 目录下每个 .sh 都当 hook 装）。
HOOKS="pre-commit pre-push"

# 生成一个 shim。内容与源文件内容无关，所以源文件更新后不需要重跑安装。
# 用 printf 而不是 heredoc + cat：`cat` 缺失时 heredoc 会静默产出空文件
# （X3-05 修 release.sh 的远端脚本生成时踩过同款，见 scripts/lib/remote-sha.sh）。
write_shim() {
  _name="$1"
  _dst="$DST_DIR/$_name"
  printf '%s\n' \
    '#!/bin/sh' \
    '# 由 scripts/install-git-hooks.sh 生成，勿手改。' \
    '# 固定内容，只转发到当前 checkout 里的 hook 源文件 —— 源文件更新后无需重装（X3-11）。' \
    "_src=\"\$(git rev-parse --show-toplevel 2>/dev/null)/scripts/git-hooks/${_name}.sh\"" \
    '[ -f "$_src" ] || { echo "[hook] 找不到 ${_src}（旧分支？），跳过此 hook" >&2; exit 0; }' \
    '# exec 保留 stdin：pre-push 的推送区间是从 stdin 读的（X3-02），不能在这里吞掉。' \
    'exec sh "$_src" "$@"' >"$_dst"
  chmod +x "$_dst"
  echo "✅ installed: $_dst (shim → scripts/git-hooks/${_name}.sh)"
}

for _hook in $HOOKS; do
  if [ ! -f "$SRC_DIR/$_hook.sh" ]; then
    echo "❌ 找不到 hook 源文件 $SRC_DIR/$_hook.sh"
    exit 1
  fi
  write_shim "$_hook"
done

echo ""
echo "已安装（shim 转发，源文件更新后自动生效，无需重装）："
echo "  pre-commit  T-3.8 参考页反漂移对账 + Agent Note 形态校验"
echo "  pre-push    holdout 永封校验 + T-3.9 站点构建（死链门禁）+ P0-3 北极星生成块陈旧检测"
echo "完成。要禁用某个 hook，加 --no-verify 跳过单次，或删除 $DST_DIR/<name>"
