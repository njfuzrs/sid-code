---
Status: implemented
Date: 2026-11-15
Source: monitor 实测暴露的退出泄漏与审计口径缺陷-修复与验收方案（2026-11-09）
---
# tool-selection-audit 跨天会话不再被 `--since` 静默排除

## 决定了什么

- `scripts/tool-selection-audit.ts` 的 `--since` 从「`startedAt < since` 直接 `return null`」改为
  `classifySince` 三态归因：`in-range`（纳入）/ `before`（排除）/ `mixed`（跨天会话）。
- **跨天会话默认排除但计数**（`mixed_sessions`），新增 `--include-mixed` 让它们整会话纳入后段，
  作为**乐观界**。
- 文本输出与 `--json` 都带 `since` / `include_mixed` / `mixed_sessions`，引用数字时必须标明口径。
- 抽出两个纯函数 `lastTimestamp(traj)` 与 `classifySince(startedAt, lastActivity, since)` 并导出，
  单测直接覆盖；`auditOne` 里 `readTraj` 只读一次（原先 `since` 判定与 `auditSession` 各读一次）。

## 放弃了什么（以及为什么不选）

- **放弃「按 traj 最后活动时间整会话算后段」**：这是最直觉的修法，但会把切分点**之前**提出的
  等待需求算进后段分母，等于用更细的时间做了更粗的归因。默认排除 + 可选纳入把不确定性
  暴露给读者，而不是替读者猜。
- **放弃用 `messages.json` 的 mtime 切**：mtime 是落盘时刻，会被导出 / 复制 / 清理改写；
  同一个会话复制一次就变成「后段」。traj 的 `timestamp` 是会话内真实发生时刻，与 wait-audit
  窗口同源。
- **放弃给 user 消息补 `ts` 落盘（本 PR 内）**：那要动 core 的 messages 落盘契约，且**历史
  轨迹无法回填** —— 补了也只对以后生效，本次要复算的恰恰是历史。新轨迹要不要补是独立问题，
  真需要消息级切分时应先落 ts、再改本脚本，不应在脚本里假装能拿到。
- **没有把 `mixed_sessions` 做成 `Totals` 字段**：`summarize` 是「场景维度」的纯函数，
  加会话级计数会污染它的语义；放在 `main` 的输出层，JSON 顶层独立字段。

## 拿什么证明它生效了

- 单测：`bun test ./tests/scripts/tool-selection-audit.test.ts` → **38 pass / 0 fail**
  （新增 7 条：`lastTimestamp` 取值 / 忽略非字符串；`classifySince` 的 in-range、before、
  mixed、startedAt 缺失穿透、无 since、无时间戳保守排除）。
- 真实轨迹（本机 1148 会话）：
  - `--all --since 2026-11-10T06:59:00Z` → 输出「切分：跨天会话 **1** 个（默认排除）」，
    合计 **195** 会话 / 场景 99 / accuracy 81.8%；
  - 加 `--include-mixed` → 合计 **196** 会话，accuracy 仍 81.8%（该会话无场景），
    证明两档只影响分母、不改变已有场景归类。
  - 修复前同一命令报 193 会话且**没有任何跨天提示** —— 那 1 个会话就是静默丢失的样本。
- 门禁：`bun run lint` / `bun run format:check` / `make build` 全部通过。
- worktree 里 `bun run affected-tests:run` 有 2 条 `tests/build/rules-paths-scope-nonempty.test.ts`
  失败，已归因为 worktree 路径特有（`ruleOwnerDir` 把 `<repo>/.sid-code/worktrees/...` 里的
  `.sid-code` 段当成规则目录标记），父仓同 HEAD 单跑 **3 pass / 0 fail**，CI 不在 worktree 下跑，
  与本改动无关。
- 造数据（补充「等不到样本」的判据）：`bun scripts/verify-monitor.ts --case D4-discovery-checks`
  用真实模型跑 **3 轮全 PASS**（71s / 68s / 68s），`called=true searched=true mentioned=true`，
  即 event-stream 场景下模型确实调用 monitor，不必等日常会话自然出现该场景。
