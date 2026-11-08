---
Status: implemented
Date: 2026-11-08
---
# G2 运行器支持 stream-json 多轮输入；用例 A6-compact 守住长驻会话里的手动压缩

## 决定了什么

运行器新增 `SmokeCase.streamInput: string[]`。置上时主运行以 `-p --input-format stream-json --output-format stream-json --verbose` 启动，**逐条写 user 消息，等到上一条的 `result` 再写下一条**，全部写完关 stdin。`RunOutput.stdout` 变成逐行解析的消息数组，会话 id 取首条带 `session_id` 的 result；result 条数与输入条数不等直接判失败。

用例 `A6-compact`（台账 A6，2026-11-08 由 G4 过渡期迁到 G2）：三轮问答后 `/compact`，断言最后一条 result 以「对话已压缩」开头、`PreCompact{trigger=manual}` 1 条、`telemetry/events.jsonl` 的 `context_compact{outcome=summarized,trigger=manual}` 恰 1 条且 `tokens_after < tokens_before`。用例 env 打开遥测（`SID_CODE_DISABLE_TELEMETRY=0`、`SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0`）：运行器默认 no-telemetry，analytics sink 直接丢弃，`context_compact` 一条都不落。隔离配置无远程后端，打开只写本地。

这套「长驻进程 + 输入通道 + 可靠退出」是 A12 bridge 的前置。

## 放弃了什么（以及为什么不选）

- **一次性写满 stdin**：不行。2026-11-08 探针：4 条输入只出 2 个 result。空闲前到达的连续 prompt 被 `CommandQueue.dequeueBatch` 合并成一轮，`/compact` 被拼进「问题二\n\n问题三\n\n/compact」当文本发给模型。真实宿主是一问一答，逐条等才对得上。这个合并行为本身是有意设计（省 token，`command-queue.ts` 头注释），不当缺陷处理；但「连续输入里夹一条斜杠命令会被当文本」值得记一笔，见下。
- **断言会话 JSONL 的 `context_compact` 记录**：不断言。手动 `/compact` 走 `partialCompact` + `ctxMgr.setMessages`，不经 `notifyCompacted`，会话 JSONL 里没有这条记录；触发清单 A6 的判据本来就是遥测，不是会话记录。是否该补落盘超出本次范围。
- **stream-json 也给 `after` 步骤用**：不加。目前没有用例需要。

**附带发现（未处理，需另判）**：stream-json 下宿主连续快速发送时，夹在中间的斜杠命令会被合并进 prompt、不经命令分发。现实宿主（IDE、SDK）若不等 result 就连发，`/compact` 会变成发给模型的文本。

## 拿什么证明它生效了

- `bun run smoke`：18 例全过；A6 单例 0.3s，连跑 10 次 10 PASS。
- `bun run smoke:mutate -- A6-compact`：2/2 killed。
  - `compact` 的 `modes` 收窄为只 bridge → `PreCompact` 期望 1 实际 0。
  - 删掉 `ctx.ctxMgr.setMessages(result.messages)`（摘要生成但不写回）→ `tokens_after(6102)` 不小于 `tokens_before(6102)`。
- 探针（构建产物）：三轮 + `/compact` → result「已将最早 4 条压成 LLM 摘要…（6 → 4 条消息）」，遥测 `messages_before=6`、`tokens_before=6095`、`tokens_after=6066`。
