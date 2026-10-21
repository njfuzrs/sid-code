---
Status: implemented
Date: 2026-10-21
---
# Responses 流式带工具的轮报 tool_use，与非流式共用映射；F2 告警按 (provider, model) 去重

## 决定了什么

- `llm/openai-responses.ts`：
  - `ParserState` 加 `sawToolCall`，创建 function_call 块时置位；
  - `response.completed` 不再写死 `end_turn`，改走 `mapResponsesStatus`，非流式也调这一份（签名改成 `status, incompleteReason, sawToolCall`）；
  - `response.incomplete` 带工具也保持 `max_tokens`，让主循环走「截断带工具」分支。
- `cli/entrypoints/headless.ts`：收尾判据改成和主循环一致的 `isEndTurnLikeStopReason && !hasPendingToolUse`，工具分支加 F2 fall-through。旧判据只看 `stopReason==="end_turn"`，带着没执行的工具就收工了。
- 新增 `agent/stop-reason-mismatch.ts`：进程级的 (provider, model) 计数表。
  - 主循环和子循环的 F2 告警只在每对首次 warn；
  - 主循环每次发一条 `StopReasonMismatch` 事件，trace-digest 新增「协议偏差」一节，按 provider/model 计数。
- 起因：会话 20261020-110542-ce7ea52e 里 warn.log 有 1340 条同文案，20261019 复盘的 Q7 也记过这个问题（99 条）。

## 放弃了什么（以及为什么不选）

- **只修解析器，F2 告警照旧每次都打**：根因修掉后它本该是 0，但下一个协议偏差一出现照样会刷屏，告警再次失去区分度。
- **把 F2 告警整个删掉**：它是发现下一个协议偏差的唯一信号，保留它，只做去重加计数。
- **incomplete 带工具也报 tool_use**：截断时最后一个工具的参数可能不完整，当成完整工具轮执行会拿残缺参数调工具。保持 `max_tokens`，和主循环 P1-4 的口径一致。
- **计数写进 warn.log 再从日志里数**：日志不是结构化取数源，换成事件才能指到源字段（北极星铁律 2）。

## 拿什么证明它生效了

- 新增断言：
  - `openai-responses.test.ts` 的工具流 stop_reason 为 `tool_use`；
  - `provider-parity.test.ts` PARITY-2 纳入 responses 族（单工具 + 并行工具两个夹具）；
  - `stop-reason-mismatch.test.ts` 7 条（去重、digest 聚合、映射、三处接线）。
- 变异自证：
  - 把流式 completed 改回写死 `end_turn`，2 条变红；
  - 把 headless 判据去掉 `!hasPendingToolUse`，接线断言变红。
  - 恢复后全绿。
- `bun run affected-tests:run`（判定为大范围，578 个文件）：7108 pass / 0 fail。`make build` 自检通过；lint / format:check / typecheck:gate / lint:boundary / docs:gen-reference --check 全绿。
- 未验证：没有用 `sc-dev` 跑 gpt-6-luna 的真实带工具会话，所以「真实会话里告警为 0」还要在 A2 端到端时一并确认。
