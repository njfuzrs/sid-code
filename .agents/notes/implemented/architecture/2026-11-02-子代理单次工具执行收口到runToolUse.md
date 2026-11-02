---
Status: implemented
Date: 2026-11-02
---
# 子代理单次工具执行收口到 runToolUse，hook 收尾函数全仓只留一份

## 决定了什么

- 新增 `packages/core/src/query/run-tool-use.ts`：`runToolUse(block, tool, deps, mode)` 是子代理单次工具执行的唯一实现，顺序为 abort 预检 → PreToolUse → 权限（或 B0 fail-closed）→ zod 校验 → 执行 → side events / LSP → processToolResult → PostToolUse/Failure 回灌 → 漏斗埋点。两条路径的差异（sessionId、agentId、diagnosticOwner、onProgress）只在 `RunToolUseMode` 里声明。
- 进程内子代理 `agent/tool-executor.ts` 只剩调度（分区 / 并发上限 / 中断后不再启动 / N 进 N 出），873 → 262 行。spawn 子代理 `agent/sub-agent.ts` 的 `executeToolForChild` 只做 `ChildToolUseMessage` ↔ tool_result 的形态转换，约 240 → 20 行。
- 新增 `query/tool-hook-lifecycle.ts`：`firePermissionDenied` / `firePostToolUseFailure` / `runPostToolHooks` / `runToolExceptionHook` / `hookFeedbackText` 的唯一定义。主循环原先的私有副本删掉，改为 import 这份。agent 归属字段统一走 `hookAgentOptions()`（读 ALS），所以主循环拿到的载荷与原先逐字段相同。
- 收口顺带修掉 spawn 路径相对进程内路径漏掉的 4 处：没有 abort 预检；未配检查器时写类工具不 fail-closed；不剥离模型伪造的 `_agentId` / `_parentToolUseId`；hook 改参后不告知模型。
- 契约测试 `packages/core/tests/query/run-tool-use-contract.test.ts`：6 个场景 × 3 条路径的 hook 事件序列矩阵，加上 3 条针对上述缺口的用例。

## 放弃了什么（以及为什么不选）

- **主循环 `executeSingleTool` 也并入 runToolUse**：本次没做。主循环多出三路竞争权限（UI 确认 / 分类器并行 / hook）、PreToolUse fire-once 缓存、执行前快照、HITL 记录，以及 harness_context / progress_events 遥测载荷。硬并进来要在 mode 里开多个大开关，等于在函数内部重新分叉。当前用契约矩阵锁住三条路径事件序列一致，并共用同一份 hook 收尾实现，作为下一步的护栏。
- **子代理直接复用 `query()`（完全照 CC）**：`query/loop.ts` 6600 多行，带着只属于主会话的压缩、重试、终止判定，改动面过大。保留为远期方向。
- **把 forked 也收进来**：它刻意不触发用户 hook，权限走 canUseTool 回调，属于显式例外，在契约测试文件头列出。
- **把 runToolUse 放进 `query/tool-executor.ts`**：那个文件已有 2000 多行，放进去还会让子代理依赖整个主循环执行器。
- **hook 收尾函数放在 agent/ 下**：主循环会反过来依赖子代理模块。所以放在 query/ 下，做成只依赖 hook / result-storage 的叶子模块。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/query/run-tool-use-contract.test.ts` → 21 pass。
- 变异自证（看的是报了哪些用例红，不只看退出码）：
  - runToolUse 里 PreToolUse 不 fire → 路径 2、3 的 12 格全红；路径 1 不变，因为主循环尚未并入，符合预期。
  - `tool-hook-lifecycle.ts` 的 `firePostToolUseFailure` 不 fire → 「参数校验失败」「PreToolUse 阻止」两行的路径 1/2/3 共 6 格全红，说明主循环确实用的是同一份实现。
  - 删掉 abort 预检 / fail-closed / stripInternalFields → 对应 3 条用例红。
- 基线对照：把契约测试复制到 `origin/main`（`91d1b6f2`）的 detached worktree 上跑 → 18 pass、3 fail，红的正是 spawn 路径那 3 处缺口，说明缺口在改动前真实存在。
- 验收 grep：`grep -rnE 'function (firePostToolUseFailure|firePermissionDenied)\b' packages/core/src` 只剩 `tool-hook-lifecycle.ts` 一处；`agent/tool-executor.ts` 与 `sub-agent.ts` 里都没有 `permissionChecker.check`。
- `bun test ./packages/core/tests/agent/ ./packages/core/tests/query/` 只有 2 fail，都在 `todo-gate-forgot-mark-loop.test.ts`。该文件不 import 本次改动的模块；在父仓 main `91d1b6f2` 上用同一命令也是这 2 条 fail，单跑 2 pass，是同进程跨文件的状态污染。
- 一条既有假绿已修正：`sub-agent-spawn.test.ts` 的「大输出截断」原先只断言长度 < 50000。收口后无检查器的写类工具会被 fail-closed 拦下，拒绝文案同样短于 50000，测试照样绿。现在把工具标为只读，并先断言 `is_error=false`、内容确实来自工具。
- 未做：用 `sc-dev` 跑端到端子代理任务 + `/trace` 核 span、子代理串行工具执行中按 ESC。合并前需人工过一遍。
