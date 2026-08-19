---
Status: rejected
Date: 2026-08-02
---
# 否决用 gitignore/exclude 体系隐藏 worktree 内的 symlink

## 决定了什么

不靠 exclude 文件让 worktree 内的 symlink（如 `node_modules`）不算改动。
**git 没有 per-worktree 的 exclude 文件** —— 这不是配置问题，是 git 的路径白名单里就没有 `info/`。

需要让 worktree 内某些文件不算改动时，在**判定侧**解决：按 `lstat` 事实排除。

## 放弃了什么（以及为什么不选）

两条候选路径，2026-08-02 实测**都是死的**：

1. **写 `git rev-parse --git-path info/exclude` 解析出的文件** —— 在 worktree 里它解析到的是
   **主仓** `.git/info/exclude`。写它等于污染主仓，所有 worktree 和主仓共享同一份。
2. **写 `.git/worktrees/<name>/info/exclude`** —— git **完全忽略**该文件，`git status` 不受任何影响。

根因：`info/` 不在 git 的 per-worktree 路径白名单里（只有 `HEAD` / `index` / `logs/HEAD` 等是）。
所以这不是"写法不对"，是能力不存在。

## 拿什么证明它生效了

- 两条路径都是实测的：路径 1 用 `git rev-parse --git-path` 打印出的绝对路径直接指向主仓；
  路径 2 写完后 `git status` 输出无变化。
- **这次能发现"注释里写错了前提、实际在污染主仓"，靠的是副作用审计**：写任何 git 状态前，
  先快照 `.gitignore` / `.git/info/exclude` / `status` / `HEAD` / `refs` / `config --local`，
  操作前后逐项比对。没有这一步，路径 1 会被当成"生效了"（因为 status 确实变干净了 ——
  代价是主仓被改）。这条流程对任何要写 git 状态的改动都适用。
