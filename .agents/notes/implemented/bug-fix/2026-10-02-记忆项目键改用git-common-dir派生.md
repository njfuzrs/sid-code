---
Status: implemented
Date: 2026-10-02
---
# 长期记忆的项目键改用 git common-dir 派生，同仓多 worktree 真正共享记忆（B14）

## 决定了什么

- `memory/paths.ts` 新增 `resolveMemoryProjectRoot()`：`git rev-parse --git-common-dir` → `resolve(cwd, …)` 归一 → 末段是 `.git` 就取其父目录为主仓根；推不出来（非 git、`--separate-git-dir`、bare）回退 `resolveProjectRoot()`。`getAutoMemPath()` 改用它。
- **只改长期记忆这一条线**。`resolveProjectRoot()`（`--show-toplevel`）保持不变，会话目录、session-memory、团队记忆本地缓存、mcp.local.json 仍按 worktree 分开 —— 会话类数据按 worktree 隔离是对的（P0-4 那段注释的理由），改它会让 `-c` 在 worktree 之间串会话，且要再迁一次全部会话目录。
- 兼容策略选**首次加载时一次性并入**：`MemoryStore.load()` 发现本 worktree 旧键（`--show-toplevel` 派生）下有记忆，就**复制**（不移动）到共享目录，目标已有同名文件跳过，`MEMORY.md` 不复制而是重建；并完在旧目录写 `.merged-into-shared-memory` 标记，之后不再并。
- 修正三处与行为相反的注释（模块头、`resolveProjectRoot`、`getSessionMemoryPath`），以及官网四处措辞（「git 顶层目录」→「主仓根目录」，常见问题里的排查命令从 `--show-toplevel` 改成 `--git-common-dir`，前者在 worktree 里恰好会误判）。

## 放弃了什么（以及为什么不选）

- **读时兼容（新键没有就查老键）**：要让 load / get / list / delete / 索引注入每条读路径都认两个目录，漏一条就是「看得见删不掉」；而且 worktree 之间仍然各查各的老键，老记忆依旧不共享，没修到用户要的行为。
- **默认「反正是新键，旧的无所谓」**：用户视角是记忆凭空消失，正是本仓「静默丢数据」的事故形态。
- **移动而不是复制**：移动失败或误判时无法找回；复制的代价只是磁盘上多一份小 .md。
- **不写标记、每次启动都并**：用户在共享目录删掉的记忆会在下次启动从旧目录「复活」。
- **用 `--path-format=absolute`**：git ≥ 2.31 才有，老 git 会整条报错退回旧键（等于没修），而 `resolve(cwd, 相对输出)` 在所有版本都成立。
- **复用 `worktree/canonical.ts` 的 `findCanonicalGitRoot`**：它走文件系统解析 pointer，与这里的 execSync 路径口径不同；记忆根要与 git 自己的回答一致，直接问 git 更少分歧。
- **把 `resolveProjectRoot` 整体换成 common-dir**：见上，会话类数据不该共享。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/memory/worktree-shared-memory-b14.test.ts` **真的 `git worktree add`**，不 mock git：8 pass。其中端到端一条：worktree 里 `MemoryStore.set` 的记忆，主仓 `new MemoryStore(mainRepo).list()` 能看到。
- 变异自证四条全部变红：`getAutoMemPath` 改回 `resolveProjectRoot`（3 fail）、去掉 `resolve(cwd, …)` 归一（4 fail）、去掉并入调用（1 fail）、去掉标记判断（删除后复活，1 fail）。
- 实测 git 行为（2.53.0）：主仓子目录 `--git-common-dir` 返回相对 `../.git`、主仓根返回 `.git`、worktree 返回绝对 `<主仓>/.git` —— 三种输出都被测试覆盖。
