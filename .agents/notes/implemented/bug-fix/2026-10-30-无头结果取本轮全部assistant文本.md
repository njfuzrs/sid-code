---
Status: implemented
Date: 2026-10-30
---
# 无头 json / stream-json 结果改取本轮全部 assistant 文本，与 text 同口径

## 决定了什么

一轮 `-p` 调用里可能产生多条带文本的 assistant（todo 收尾门禁、续写、强制总结轮、后台唤醒续跑）。
修前三种输出格式口径不一致：text 累加全部增量（对的），json 取历史最后一条 assistant 的 content，
stream-json 倒序取第一条 assistant 的 text。模型「报告 → todo_write → 一句话收尾」时，
json / stream-json 只剩收尾句，报告只在轨迹里（F3 bench L3f#1、L2f#1、F2#3）。

- 新增纯函数 `packages/core/src/sdk/turn-text.ts` 的 `collectTurnAssistantText(messages)`：
  只取 assistant 的 text block，按顺序拼接（消息之间空一行，纯空白消息跳过）。cli 和 sdk 共用。
- stream-json：`SDKQueryEngine.runTurn` 从 `assistant_message` 事件收集本轮消息，`finalizeResult` 用它填 `result`。
- json：`runHeadless` 同样按事件收集；`content` 保持数组形状但改为本轮全部 text block，新增 `result: string`。
  后台唤醒续跑沿用 streamBuffer 的口径：续跑轮有文本就覆盖首轮，没有就退回首轮。
- 本轮一条 `assistant_message` 都没有时（无头斜杠命令 output 分支直接写历史），两处都退回「历史最后一条 assistant」。
- 官网 `website/extend/headless.md` 的 json 示例与取答案方式同步改为读 `.result`。

「本轮」的边界用事件流而不是「历史 + 起始下标」：轮中压缩会 `setMessages` 整体替换历史，下标随之失效。

## 放弃了什么（以及为什么不选）

- 取最后一条「长度超过阈值」的 assistant text：阈值随意，模型本来就短答时会取错。
- 门禁收尾时要求模型重复报告：改模型所见文案（要 A/B）、费 token，续写和唤醒路径仍会出问题。
- 只修 stream-json 的 `result`、json 不动：两种格式继续不一致。
- json `content` 直接改成字符串：破坏已有调用方读数组的形状；改为保持数组 + 新增 `result`。
- 按 `ctxMgr.getMessages()` 从最后一条用户 prompt 切片：门禁提示、任务通知也是 user 消息，压缩还会改写历史，边界不稳。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/sdk/turn-text.test.ts`：纯函数 5 例 + SDKQueryEngine 3 例（门禁收尾、前一轮不计入、无事件退回历史）全绿。
- `bun test ./packages/cli/tests/cli/print-result-all-assistant-text.test.ts`：子进程 + 假 OpenAI 端点，
  回复①报告 + ls 工具调用、②收尾句。json 的 `result` 为「报告\n\n收尾句」、`content` 两块 text；
  stream-json `result` 同上；text 输出报告在收尾句前。3 例全绿。
- 变异自证：M1 纯函数改回只取最后一条 → 纯函数、SDK、json、stream-json 共 5 例变红；
  M2 result 改按全量历史取 → 「前一轮不计入」变红；M3 不过滤 thinking → 3 例变红。恢复后全绿。
- `bun test ./packages/core/tests/sdk/` 176 pass；`bun run typecheck:gate` 66/66 无新增。
