---
Status: implemented
Date: 2026-11-14
Source: bash 只读判定与 cd 复合命令对齐 claude-code-缺陷修复与验收方案（2026-11-14）
---
# `git worktree remove --force` 列入危险命令模式

## 决定了什么

`git worktree remove` 带 `--force` / `-f` / `-ff`（任意位置）时，判为危险命令
（severity `high`，与 `git branch -D` 同级），改动落在
`packages/core/src/permission/git-danger-patterns.ts`：

1. `GIT_DANGER_PATTERNS` 新增一条「git 强删 worktree」。它是 `checker.ts` 的
   `DANGEROUS_PATTERNS` 的单一事实源，所以 Step 2 拦截、复合命令拆分、
   「剥 git 全局选项再匹配」（`normalizeGitGlobalOptions`）全部自动继承：
   `git -C . worktree remove --force x` 经归一化后同样命中。
2. `GIT_DANGER_DISPLAY` 同步加一条展示规则，让 TUI 确认框标红并把「拒绝」作为安全默认
   —— 与拦截规则同源，避免「拦得住但界面看不出危险」。

修前实测：`git worktree remove --force` 在 default 下是普通确认（`step=14`，
`reason_type` 为空，与 `git log` 同级），在 always-allow（`-y`）下是
`ALLOW step=8-mode`，直接放行。修后三种模式（default / acceptEdits / always-allow）
都落到 `step=2` 的危险确认，`yesMode` 也越不过。

**不包括**：不带 force 的 `git worktree remove`、`git worktree prune`、`git worktree list`
—— 它们不进危险模式，行为不变。

## 放弃了什么（以及为什么不选）

1. **不放宽成「拦所有 `git worktree remove`」**。不带 force 时 git 自己会拒绝删除
   含未提交改动或 locked 的 worktree，那条命令的语义是「安全地删干净的工作树」，
   拦它只是多一次无意义确认（本仓开发过程中常态化执行）。真正不可恢复的只有 force 形态。
2. **不拦 `git worktree prune`**。它只清 `.git/worktrees/` 下的管理元数据，
   不动任何工作目录内容，误判成危险会让清理动作每次弹窗。
3. **照抄 CC 清单（即什么都不做）**。CC 的 `destructiveCommandWarning.ts:15-51`
   确实没有这一条，这是本文**刻意超出 CC** 的唯一一项：判断依据不是「CC 有没有」，
   而是本仓的工作方式——并行开发时 worktree 数量上百（`harness-bench/wt/*`、
   `.sid-code/worktrees/*` 带 `locked`），每个都可能是另一路 agent 的在途工作区。
   CLAUDE.md 的「⛔ 不删与本次任务无关的文件」就来自 2026-07-28 的真实丢数据事故，
   `worktree remove --force` 正是能绕过那条铁律的最短路径。
4. **不加 `critical`**。critical 不允许用户确认（直接拒绝），而「会话自己建的临时 worktree
   用完就删」是合法高频操作；证据是本次会话最后一步就执行过
   `git worktree remove --force /tmp/wt-n2-base`。保留 `high` + UI 标红 + 安全默认，
   让用户能确认执行。
5. **不给 UI display 做全局选项归一化**。`GIT_DANGER_DISPLAY` 是静态正则表，
   `git -C x worktree remove --force` 在 UI 侧不标红，与 `push --force` / `reset --hard`
   等既有项一致；拦截层不受影响（checker 走归一化串）。要修的是整张 display 表的归一化
   能力，属于另一件事，不在这个缺陷修复里顺手做。

代价（点破牺牲的方向）：更安全 ←→ 更快。always-allow 下 `worktree remove --force`
从直接放行变成多一次确认，量级是「本会话 1 次」，可忽略。

## 拿什么证明它生效了

1. **单测**（`packages/core/tests/permission/git-danger.test.ts` 新增
   「git worktree 强删列入危险模式（B6）」，5 个用例）：
   `bun test ./packages/core/tests/permission/git-danger.test.ts`
   → `29 pass / 0 fail`。断言包含 `r.step === "2"` 与
   `decisionReason.type === "dangerousCommand"`，覆盖 default / acceptEdits / always-allow
   三种配置 × 五条 force 变体（含 `-ff`、flag 在末尾、`git -C .` 前缀）。
2. **变异自证**：把新增的 pattern 改成永不匹配的 `\bgit\s+worktreeMUTANT\s+remove\b`
   后重跑，`force 变体命中` 与 `Step 2 危险确认` 两条当场变红（27 pass / 2 fail），
   恢复后回到 29 pass / 0 fail。
3. **选测**：`bun run affected-tests:run` → `1244 pass / 0 fail`（51 个文件，含
   `hook-decision-injection` 等依赖危险模式的护栏用例）。
4. **构建**：`make build` 成功（含编译产物自检）；worktree 里先按 CLAUDE.md
   的处置删掉 `node_modules` 软链后 `bun install`，否则 `@sid-code/tui` 解析不到。
5. **未变的护栏**：`git worktree remove x`、`git worktree prune`、`git worktree list`
   在 always-allow 下 `decisionReason.type !== "dangerousCommand"`（仍走原来的放行/普通确认）。
