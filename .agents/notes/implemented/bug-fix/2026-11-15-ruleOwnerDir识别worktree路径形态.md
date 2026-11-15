---
Status: implemented
Date: 2026-11-15
Source: 20261110-等CI时轮询与唤醒重复空转-剩余缺口-修复与验收方案（2026-11-10）§10.4
---
# ruleOwnerDir 不再把 git worktree 路径里的 `.sid-code` 段当成配置目录

## 决定了什么

- `ruleOwnerDir`（`packages/core/src/config/rules.ts`）的判据从「路径里**最后一个** `.claude` / `.sid-code` 段」
  改成「**形态合法**的最后一个段」：该段之后只剩一个文件名（`<dir>/.claude/CLAUDE.md`），
  或紧跟 `rules/` 子树（`<dir>/.sid-code/rules/**`，即 `PROJECT_RULES_DIRS` 的两种形态）。
  不合法则跳过该段继续往左找。
- 效果：git worktree 建在 `<repo>/.sid-code/worktrees/<name>/` 时，规则归属目录回到 worktree **之内**的
  规则所在目录，而不是被截到主仓根。`rulesPathsMatchFromOwner` 的「规则所在目录 → 项目根」逐级链
  因此重新成立，`packages/cli/src/ui/CLAUDE.md` 的 `paths: ["src/ui/**"]` 在 worktree 里能命中。
- 新增单测 `jit-paths-scope-monorepo.test.ts` 的「ruleOwnerDir 不被 git worktree 路径里的 .sid-code 段截断」：
  覆盖 worktree 内普通 `CLAUDE.md` / `.claude/rules` / `.sid-code/rules` 三种形态 + 一条端到端
  `rulesPathsMatchFromOwner` 断言。

## 放弃了什么（以及为什么不选）

- **用 `git rev-parse --show-toplevel` 之类判仓库根**：`ruleOwnerDir` 是纯字符串函数（无 IO），
  在每次规则加载的热路径上；引入 IO 会让它变成可失败、可阻塞、测试里依赖真实仓库的判定。
  且它回答的是「规则归属哪个目录」，不是「仓库根在哪」，判据本身也不同。
- **只特判 `.sid-code/worktrees`**：把 worktree 的宿主路径硬编码进规则模块，下一个把配置目录
  另作他用（或 `worktrees` 改名）的形态还会踩；形态校验是与「配置目录里能装什么」直接对应的判据。
- **改成「路径里出现 `.claude`/`.sid-code` 就一律不截断」**：会直接破坏 `.claude/rules/**` 与
  `.claude/CLAUDE.md` 的既有归属语义（既有单测会红）。
- **只修测试（worktree 里跳过哨兵）**：那是把真实缺陷藏起来 —— worktree 里用户确实丢规则注入，
  而 worktree 是 agent 与并行开发的主要工作形态。

## 拿什么证明它生效了

- **修复前探针**（`ruleOwnerDir` 直接打印，worktree 形态）：
  `owner=/Users/.../sid-code`（**主仓根**）、`ownerRel="<OUTSIDE>"`、`src/ui/**` 对
  `packages/cli/src/ui/utils/x.ts` 不命中 → 规则静默不注入。修复后 owner 为该 worktree 内的
  `packages/cli/src/ui`，命中。
- **哨兵复现与修复**（本 PR 的 worktree 恰好就在 `.sid-code/worktrees/` 下，是天然复现环境）：
  `bun test tests/build/rules-paths-scope-nonempty.test.ts`
  → 修复前 `1 pass / 2 fail`（`evals/CLAUDE.md`、`packages/cli/src/ui/CLAUDE.md`，`hit: null`）；
  修复后 `3 pass / 0 fail`。
- **变异自证**：把 `ruleOwnerDir` 临时改回旧实现 → 新单测 `13 pass / 1 fail`（红的正是新增用例），
  哨兵 `1 pass / 2 fail`；恢复修复版后两文件 `17 pass / 0 fail`。
- **门禁**：`bun run affected-tests:run` → **925 pass / 0 fail**（64 文件）；
  `make build` 成功且 `will always be undefined` 计数 **0**；
  `bun run lint` / `format:check` / `lint:boundary` / `lint:command-system` / `lint:legacy-tool` 全绿；
  `bun run typecheck:gate` → `当前 62 处错误 / 基线 62 处，无新增`；
  `bun run docs:gen-reference` 后 `git status` 无 `website/ref/` 漂移（本改动不进参考页）。
- **踩到并记录的一个 worktree 陷阱**：worktree 的 `node_modules` 默认软链到主仓，
  `@sid-code/core` 因此解析到**主仓源码**，worktree 里的改动测不到（表现为「修了还是 2 fail」）。
  必须先解除该软链并在 worktree 内 `bun install`，再用探针确认解析目标，不能只看测试结论。
- **取舍**：修好后，在 worktree 里触及 ui 的会话会多注入一次 `packages/cli/src/ui/CLAUDE.md`
  （约 9–10K tokens）。这是拿「更省」换「更准」——规则本该生效却静默不注入，属于用户无法感知的
  正确性损失，优先修。
