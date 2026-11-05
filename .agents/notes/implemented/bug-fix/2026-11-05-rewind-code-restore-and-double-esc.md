---
Status: implemented
Date: 2026-11-05
---
# 会话回退的靶心修正：新增 restoreBeforeSnapshot，双击 Esc 改在 App 层按时间窗口判定

## 决定了什么

**缺陷 R1「仅代码回滚 0 个文件」**：新增 `CheckpointManager.restoreBeforeSnapshot(snapshotId)`，
回滚 `[sN, 最新]` **含 sN 自己**，index 截断为 `slice(0, targetIndex)`；`RewindManager` 的注入项
同步改名为 `restoreBeforeSnapshot` 并改调它。`restoreToSnapshot`（回滚 sN **之后**）一字未改。

判据是单一真相源「快照 sN 存的是产生 sN 那次工具调用**之前**的内容」。会话回退点的锚点是
**本轮首个快照**，靶心就在该快照上；借 `restoreToSnapshot` 会少撤一格：本轮只改过一次文件时
区间切出空数组（「回滚了 0 个文件」），改过多次时少撤第一次（比用户选的位置晚一步），
两种形态 UI 都显示「已回退」。

**部分失败可见**：`CheckpointManager.failedFiles` → `RewindResult.filesFailed` →
`RewindResultInfo.filesFailed` → `RewindDialog` 警告行，三层透传。修之前 `app.ts` 的闭包只回传
`files.length`，把 checkpoint 层 N4 引入的失败通道在这一层掐断了。

**缺陷 R2「双击 Esc 无响应」**：`escape-escape` 只在解析器**同一轮 data** 里收到 `\x1b\x1b` 时
产生，而 `ESC_TIMEOUT=50ms` 一到就把单个 `\x1b` 冲刷成 `escape`；人手双击间隔 150–300ms，
所以正常速度下**永远**收不到 `escape-escape`。改为在 App 层按 **800ms** 时间窗口判定：

- `hooks/double-press.ts`：纯函数判定器（注入时钟，可精确测 799/801ms 边界）；
- `hooks/use-rewind-escape.ts`：三条派发路径——High 的 `escape-escape` 快路径、
  **Critical 只观察不消费**的复位器（任何非 Esc 按键清计时）、**Low** 的慢路径；
- 慢路径必须让到 Low：单个 Esc 在中断 / 关面板 / 关补全 / vim 切模式下已有语义，
  必须让它们先消费，**被消费掉的那次不计入双击**（否则「中断 + 再按一次」立刻弹面板）；
- 门控：空闲 + 无任何面板/请求 + 回退能力已接线 + **输入框为空**（用 UIState 新增的
  `inputEmptyRef` 可变引用，不触发整树重渲）；
- vim：InputArea 在 `normal && pending 为空` 时把 Esc 放行给上层（insert 的第一次 Esc 仍被消费，
  只切模式不计入双击）。

抽成 `useRewindEscape` hook 而不是留在 App.tsx，是为了**可测**：优先级与消费顺序是这次修复的
核心，只有真实 `KeypressProvider` 驱动的测试才验得了「谁先消费」；留在组件里只能靠源码文本断言。

**变异自证中发现并修掉的同型问题**：`restoreBeforeSnapshot` 初版把「回滚区间」表达了两遍——
一次是 `snapshotsToRollback = slice(targetIndex)`（只用于计数），一次是 `earliestEntry` 的
`for (i = targetIndex; ...)` 循环（真正决定回滚范围）。把 `slice` 改成 `slice(targetIndex + 1)`
时单测红了、**集成测试却全绿**，正是「同一语义两处定义」的典型症状。已改为
`earliestEntry` 从 `snapshotsToRollback` 派生，区间只定义一次。

## 放弃了什么（以及为什么不选）

| 方案 | 为什么不选 |
| --- | --- |
| 把 `restoreToSnapshot` 的范围改成 `slice(targetIndex)` | `/restore`（`restore.ts:70`）与 `p0-undo-restore-semantics` 的用例依赖「sN 之后」。改它等于把 rewind 的需求硬塞给 `/restore`：用户 `/restore s3` 会连 s3 自己一起撤，又回到 N5 修过的「多退一步」 |
| 锚点改成本轮首个快照的**前一个**，继续调 `restoreToSnapshot` | 会话第一轮没有「前一个快照」，锚点为空 ⇒ 第一轮的改动永远撤不掉（正是 N6 修掉的形态，而这次复现的恰好是这种场景） |
| rewind 循环调 `undo()` N 次 | 每次只撤最后一个快照，一轮里有几次工具调用、后面还有几轮都要换算成次数，又引入一种换算口径；且 `undo` 没有 `failedFiles` |
| 在 RewindManager 里自己算区间、逐个调 checkpoint API | RewindManager 的设计约束是纯数据 + 注入依赖、不懂快照格式；diff 链重建必须留在 CheckpointManager 内部 |
| 调大 `ESC_TIMEOUT`（如 500ms） | 它同时决定单按 Esc（中断 / 关补全 / 关面板）的生效延迟和 Alt 组合键（`ESC x`）的识别窗口。调到 500ms 等于每次单按 Esc 都慢半秒 |
| 在 `KeypressContext` 解析层合成 `escape-escape` | 解析层不知道第一个 Esc 有没有被中断 / 关面板消费掉，会把「中断 + 再按一次」误判成双击；而且它必须先发出第一个 `escape` 才能等第二个，发出去的那个已经收不回来 |
| 第一次 Esc 先挂起 800ms，等确定不是双击再派发 | 所有单按 Esc 都延迟 800ms，等于把原来的问题放大 16 倍 |
| 把双击写进 `keybindings/`（新增 stroke 类型 `double`） | 现有 stroke / chord 模型表达不了「同一个键在时间窗口内按两次」，扩展键位系统远超这次修复范围 |
| vim 方案 B（不修，vim 用户只能用 `/rewind`） | 等于该功能对 vim 用户不存在。方案 C（在 vim reducer 里识别双击）会把时钟依赖塞进纯函数状态机，破坏可测性 |
| 引入「输入框非空时双击 Esc 清空输入」（cc 的做法） | 改变用户输入相关行为，按 L4-A「永不丢失用户输入」需要单独讨论。本 PR 只做「输入框非空时不打开面板」，不清空、不打断 |

## 拿什么证明它生效了

**新增 / 修改的测试**（5 个文件，37 条全绿）：

- `packages/core/tests/checkpoint/restore-before-snapshot.test.ts`（11 条）：单快照复现、
  同轮多次改动、回到中间点、区间内新建、**新建后又 edit（存在性判断）**、diff 基点在区间之前、
  二进制字节一致、不存在 / 未启用返回 null、写盘失败进 `failedFiles`、`nextId` 不回退；
- `packages/core/tests/session/rewind-real-checkpoint.test.ts`（3 条）：**真实 CheckpointManager
  接真实 RewindManager**，按生产时序接线。这是修前完全缺失的一层——三份现有测试全用 mock，
  两边各自全绿而接线处语义错位；
- `packages/cli/tests/ui/double-press.test.ts`（5 条）：注入时钟的 799 / 801ms 边界、reset、
  连按三次只触发一次、窗口值等于 cc 的 800ms；
- `packages/cli/tests/ui/app-double-esc-rewind.test.tsx`（10 条）：真实 `KeypressProvider` 派发，
  覆盖 200ms 双击打开、1000ms 不打开、忙时中断不凑双击、输入框非空、打字复位、
  `escape-escape` 快路径、补全打开时先关补全、面板打开时不抢、未接线不响应；
- `packages/cli/tests/app/checkpoint-session-id-wiring.test.ts`：源码断言改为
  `cpMgr.restoreBeforeSnapshot(` 且 `.restoreToSnapshot(` 不得出现（只匹配调用表达式，不匹配注释）。

**变异自证**（每条都先改坏、确认变红、再恢复）：

| 变异 | 实际变红 |
| --- | --- |
| `slice(targetIndex)` → `slice(targetIndex + 1)` | 9 条：单测 5 条 + 集成测试 2 条 + 其余 2 条（**首轮只红 3 条、集成测试全绿**，据此发现两处定义同一区间的缺陷，重构后重做，集成测试才变红） |
| `app.ts` 闭包改回 `restoreToSnapshot` | T7 源码断言 1 条 |
| 存在性判断改成按最新条目（区间遍历反转） | 3 条，含「新建后又 edit」 |
| `DOUBLE_ESC_WINDOW_MS` 改成 50 | 5 条，含接线「间隔约 100ms 双击」 |
| 去掉 Low handler（只留 `escape-escape`） | 2 条接线 |
| Low handler 改成 High 优先级 | 「补全菜单打开时」1 条（`busy` 门控兜住了「忙时中断」，所以那条没红——门控比优先级更早拦截，属预期） |

**门禁**：`bun run typecheck:gate` 无新增类型错误；`bun run docs:gen-reference --check` 通过
（本次未改参考页数据源）；`bun run format` 已跑。

**没有做到的**：方案 6.4 的 sc-dev 端到端（E1–E7）需要真实 TUI 会话 + 模型调用，本会话无法
驱动交互式终端完成。接线测试覆盖了 E1/E5/E6 的等价断言（200ms 双击打开、忙时中断不弹面板、
输入框非空不弹），E2/E3/E4/E7 的磁盘结果由 `rewind-real-checkpoint.test.ts` 与
`restore-before-snapshot.test.ts` 在真实 CheckpointManager 上覆盖。PR 描述里如实标注，
真实会话的 E2E 需要人工补一次。
