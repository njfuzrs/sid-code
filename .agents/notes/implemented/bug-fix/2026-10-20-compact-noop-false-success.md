---
Status: implemented
Date: 2026-10-20
---
# 手动 /compact 本地截断兜底 no-op 时不再谎报成功（含 builtins 旧版同型修复）

## 决定了什么

`compactWithSummary`（`packages/core/src/context/manager.ts`）有三条 no-op 路径
（`no_split_point` / `invalid_result_rolled_back` / `no_reduction`），触发时消息一字不动。
此前两个手动 /compact 调用方都不读返回值、固定报「对话已压缩」，no-op 时用户看到
「156 → 156 条消息」的自相矛盾文案，以为上下文已释放，下一次请求直接撞溢出——
这正是 P0-1 假压缩事故要消灭的形态，在 compactWithSummary 收紧后漏改的两处。

1. `packages/cli/src/command/commands/compact/compact.ts` 的 `runLocalTruncationFallback`
   （无参全量模式 LLM 摘要失败后的本地截断兜底）：接收 `CompactionOutcome`，
   `success:false` 时报「压缩未生效：<reason>……N 条消息未变」，且不再 fire PostCompact
   hook（消息没动，hook 语义不成立）；`success:true` 时文案不变（回归保护）。
2. `packages/cli/src/command/builtins.ts` 的旧版 `CompactCommand`：同型修复。
   `/compact` 已迁移到新命令体系（`loaders.ts` 过滤掉旧版），生产主路径不可达，
   但旧 Registry 回退路径（无 unifiedRegistry 时）仍可达，且留着谎报范本等于给
   下一个复制粘贴的人留错误示例。
3. 三个既有 compact 测试文件的 mock `compactWithSummary` 补返回 `CompactionOutcome`
   （契约变更的同步修正，非改断言凑绿）；新增
   `packages/cli/tests/command/compact-noop-report.test.ts` 锁两处 no-op 不谎报。

## 放弃了什么（以及为什么不选）

- **只修 compact.ts、不动 builtins.ts**：否决。缺陷文档原判「仅 compact.ts 一处漏网」
  经全仓 grep 复核不成立——builtins.ts:400 是第二个同型违例。按「消灭错误范本」的
  契约理由，两处都该修；差异只在 builtins 版附注了可达性（仅回退路径）。
- **把 no-op 场景做成「强制一定能压动」**（切点找不到时退化成整段替换）：否决。
  「压缩后序列合法」优先于「一定压得动」是 P2-3 回滚机制的设计前提——发一条配对
  破缺的历史出去换来「必成功」，代价是 provider 400，比 no-op 更糟。
- **在 compactWithSummary 内部 throw**：否决。其余调用方（auto-compact.ts 四处、
  reactive-compact.ts 一处）都依赖返回值做优雅降级（熔断路径、session-memory 回退），
  throw 会破坏它们的错误分类。
- **no-op 时仍 fire PostCompact hook**：否决。hook 收到的会是 before===after，
  与谎报文案同型；PostCompact 语义是「压缩已完成」。

## 拿什么证明它生效了

- 变异自证（先改坏再恢复）：
  - compact.ts 临时改回「忽略 outcome 固定报成功」→ 新测试恰好 3 个 no-op 断言变红
    （`bun test ./packages/cli/tests/command/compact-noop-report.test.ts` → 4 pass / 3 fail）；
  - builtins.ts 同型改坏 → 旧版两个用例变红（5 pass / 2 fail）；恢复后全绿。
- 全量 compact 测试：`bun test ./packages/cli/tests/command/compact-{noop-report,focus,analytics,post-compact-wiring}.test.ts`
  → 30 pass / 0 fail / 100 expect()。
- 门禁：`bun run affected-tests:run`、`make build`、lint/format/typecheck 结果见 PR 正文。
