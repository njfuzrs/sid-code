---
Status: implemented
Date: 2026-08-19
---
# 修 install-git-hooks.sh 在 worktree 里整个失败

## 决定了什么

`scripts/install-git-hooks.sh` 的目标目录从 `$REPO_ROOT/.git/hooks` 改为
`$(git rev-parse --git-common-dir)/hooks`。

Bug：在 **worktree** 里 `.git` 是一个**文件**（内容形如 `gitdir: …/.git/worktrees/<name>`），
不是目录。于是 `mkdir "$REPO_ROOT/.git/hooks"` 报 `Not a directory`，`set -e` 让整个安装退 1，
**一个 hook 都没装上**。

后果比"少装一次"严重得多：本仓日常就在 worktree 里干活（发现时同时有 7 个活跃 worktree），
所以任何在 worktree 里跑 `bun run install-hooks` 的人，两道 hook 门禁
（pre-commit 的 lint/format/参考页对账，pre-push 的 holdout 泄露检测/站点死链）**从来没生效过**。
失败信息只是 `bun run` 输出里的一行 `mkdir: … Not a directory`，极易被划过去，
而此后一切照常 —— 正是本仓反复出现的「门禁静默失效」形态。

`--git-common-dir` 在主 checkout 与 worktree 里都解析到主仓 `.git`，这也正好是想要的语义：
git 不支持 per-worktree hooks，hooks 是仓库级共享的，主仓装一次全部 worktree 生效。

## 放弃了什么（以及为什么不选）

- **放弃 `--git-dir`**：它在 worktree 里解析到 `.git/worktrees/<name>/`，往那儿放 hooks
  git 不会执行（与 `info/exclude` 同类的 per-worktree 路径白名单问题，
  见 `rejected/architecture/2026-08-02-用-exclude-隐藏-worktree-内-symlink.md`）。
- **放弃 `core.hooksPath`**（让 git 直接指向 `scripts/git-hooks/`，免掉复制这一步）：
  它改的是 `git config`，而本仓有一条明确约束是**不动 git config**。
  改法更干净但越权，留给专门的一个 PR 去讨论。
- **放弃"顺手在这个 PR 里重构安装器"**：只修这一行 + 注释说清为什么不能拼 `.git`。

## 拿什么证明它生效了

- 复现：修改前在 worktree 里跑 `bun run install-hooks` →
  `mkdir: /…/p1-4-agent-note/.git: Not a directory` + `exited with code 1`。
- 修复后同一条命令 → `✅ installed: /…/sid-code/.git/hooks/pre-commit`（与 pre-push），exit 0。
- 端到端确认 hook 真的会拦：故意造一份形态不合规的 Note（`Status: implemented` 放在
  `proposed/` 目录、缺两段）→ `git commit` **exit 1**，输出三条具体违规。
  这一步是必要的 —— 「安装成功」与「hook 真的执行并拦住」是两件事。
- 防复发：`tests/build/agent-note-gate.test.ts` 断言安装器含 `--git-common-dir`
  且不含旧的 `$REPO_ROOT/.git/hooks` 拼法。

⚠️ 这个 bug 是**做 P1-4 时撞上的**，不是找出来的：我本想端到端验证新门禁，
命令链里 `install-hooks &&` 先失败，才暴露它。它已经潜伏了多久无从考证 ——
`scripts/install-git-hooks.sh` 的这行从未被任何测试覆盖过。
