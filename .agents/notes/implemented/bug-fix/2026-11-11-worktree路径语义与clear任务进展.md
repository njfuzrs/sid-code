---
Status: implemented
Date: 2026-11-11
Source: 上下文治理专项：后续规划（2026-11-10）、台账（2026-11-10）
---
# CG-2：worktree 路径语义提示 + /clear 补清任务进展

## 决定了什么

修台账 H3 / H4 两类**会过期的上下文状态**，对应修复项 R7、R8。

**R7（H3，worktree 路径语义）** —— 新增 `packages/core/src/worktree/path-semantics.ts`，
三个出口，全部是**提示不拦截**：

1. `enter_worktree` 的两条成功出口（新建 / 进入已存在）都追加
   `enterWorktreePathsNotice`：写明主仓根、worktree 路径，以及
   「此前在该仓库读过的文件路径指向主仓，写入会落到主仓而不是这个 worktree；此后写文件请用
   `<worktree>` 下的路径」。
2. `exit_worktree` 的 keep / remove 两条出口都追加 `exitWorktreePathsNotice`：
   keep 说明「目录仍保留在磁盘上」、remove 说明「已删除」，并给出当前工作目录。
3. `edit` / `write` 在 worktree 会话里写到主仓路径时追加 `mainRepoWriteHint`，
   直接给出**可执行的替换路径**：
   `你写入的 <主仓根>/a/b.ts 在主仓，不在当前 worktree。当前 worktree 里对应的路径是 <worktree>/a/b.ts。`
   （后续规划 §2.7 规定的文案形态）。`edit` 的两条成功出口（`old_string=''` 创建 /
   常规替换）都接；`write` 一条。

替换路径按相对位置拼：`join(worktreePath, relative(mainRoot, target))`。只在这一种情况下拼，
其余一律返回空串（见下方「放弃了什么」）。

**R8（H4，/clear 任务进展）** —— `SessionState` 新增 `resetTaskProgressKeys()`，
清 `MEASURED_PROGRESS_KEY`（实测进展）与 `TODO_REWORK_KEY`（标完成后又返工），
`app.ts` 的 `clearConversation` 与 `resetReminderDedupKeys()` 并列调用。
键名从 `query/` 两个模块 import 常量，不复制字面量（复制会在常量改名时静默漏清）。

## 放弃了什么（以及为什么不选）

- **拦截「写到主仓」的写入** —— 不放行会让用户「在 worktree 里顺手改主仓一份共享配置」没法做，
  而验收判据本来就是「每个会话 ≤ 1 次」：允许写错一次，提示之后必须改正。拦截是拿误伤换指标。
- **给「写到 `.sid-code/worktrees/` 下的别的 worktree」也拼替换路径** —— 按当前 worktree 做
  替换会拼出 `<WT>/.sid-code/worktrees/feat+y/a.ts`，一个不存在的路径。提示错比不提示更糟
  （模型会照着去试再失败一次，与 `path-utils.ts` 里「拼出来的路径必须存在才给」是同一条教训）。
  这种情形直接不给提示。
- **用裸 `startsWith` 判路径前缀** —— `/repo-other` 以 `/repo` 开头，会被当成主仓内的文件并给出
  错路径。按路径分段判断（`isUnder`），并在测试里留了这条护栏。
- **把 `resetTaskProgressKeys` 的键写成字面量** —— 看起来更"自包含"，但常量改名时会静默漏清，
  而漏清的形态是「/clear 后仍显示上一个任务的进展」，测试全绿也发现不了。
- **让 `session/state.ts` 反向 import `tool/`** —— 不需要：两个键的常量都在 `query/`，
  且 `query/measured-progress.ts` 无依赖、`query/todo-rework.ts` 只 import 类型，
  不会形成运行时环。
- **enter / exit 的成功分支也写行为测试** —— 那要真 `git init` + 真建 worktree，成本高于收益；
  文案本体由纯函数测试覆盖，接线用源码计数断言锁（漏一条出口就红）。

## 拿什么证明它生效了

新增三个测试文件，`bun test` 全部真跑过：

```
packages/core/tests/worktree/path-semantics.test.ts          12 pass
packages/core/tests/tool/worktree-path-hint-wiring.test.ts    6 pass
packages/core/tests/session/clear-task-progress.test.ts       5 pass
```

- `path-semantics.test.ts` 锁文案与**反向边界**：不在 worktree、写 worktree 内、写主仓外、
  写别的 worktree、前缀边界 `/main-repo-other`、写主仓根本身，都不许出提示。
- `worktree-path-hint-wiring.test.ts` 真跑 `WriteTool` / `EditTool`（`SID_CONFIG_DIR` 指到
  tmpdir），断言 output 里带提示与替换路径，并确认写入**确实落在模型指定的路径**（提示不改变行为）；
  另用源码计数锁 enter / exit 各两条出口都接了 notice。
- `clear-task-progress.test.ts` 断言两个键被清、其它键不动、与 `resetReminderDedupKeys` 不交叉、
  不动用量统计。

**变异自证**（5 处，逐个注入 → 跑测试 → 恢复）：

| 变异 | 变红的断言 |
| --- | --- |
| `isUnder` 退化成裸 `startsWith` | 「前缀边界：/main-repo-other 不被当成 /main-repo 下的文件」 |
| 删掉 `.sid-code/worktrees` 排除 | 「写在其它 worktree：不提示」 |
| `state.ts` 删掉 `TODO_REWORK_KEY` 的 delete | 「两个键全部被清除」 |
| `edit.ts` 创建分支删掉 `mainRepoWriteHint` | 「old_string='' 创建分支也带提示」 |
| `enter-worktree.ts` 进入已存在分支删掉 notice | 「enter_worktree 的两条成功出口都调用了进入说明」 |

门禁：`bun run typecheck:gate` 无新增类型错误；`bun run format` 已跑；
`bun run affected-tests:run`、`make build`、`bun run smoke`、`bun run lint` 结果见 PR 正文。

**上线两周后仍需按台账 §5 复跑**（本 PR 只做到「已合入」，不是「已验收」）：
`mine/h3.ts` 的「worktree 内写主仓路径」每会话 ≤ 1、「主仓读过 / worktree 没读过」每会话 ≤ 1、
`mine/h4c.ts` 的「/clear 会话里点破上一个任务的落盘」= 0。
