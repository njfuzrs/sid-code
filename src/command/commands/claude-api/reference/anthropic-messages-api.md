# Anthropic Messages API — Streaming 协议参考

> 来源：docs.anthropic.com/en/docs/build-with-claude/streaming（2026-06 拉取核对）
> 用途：校验 `src/llm/anthropic.ts` raw stream 状态机的协议假设。
> 本文档只收录与 provider 实现强相关的部分，非全量 API 文档。

---

## 1. 流式总览

创建 Message 时设 `"stream": true`，响应以 **server-sent events (SSE)** 增量返回。

sid-code 用 SDK 的 **raw stream 模式** `messages.create({ stream: true })`（非高层 `messages.stream()`），
自管事件解析。原因见 `anthropic.ts` 头部注释（避免 O(n²) partialParse、自管 tool input 拼接、拿 controller 主动 abort）。

每个 SSE 事件含一个 `event:` 名（如 `event: message_stop`），data 中带相同的 `type` 字段。

---

## 2. 事件流顺序（关键协议保证）

标准事件流：

```
message_start
  → content_block_start
  → (content_block_delta)*        ← 同一 index 的多个增量
  → content_block_stop
  → [上述 content_block 三段可重复 N 次，每个 block 一组]
message_delta
message_stop
```

- 每个 content block 由 `content_block_start` 开启、若干 `content_block_delta` 更新、`content_block_stop` 收尾。
- block 的 `index` 标识它在 `content` 数组中的位置。

> ⚠️ **官方 API 保证 index 从 0 连续递增**。但 sid-code 支持**第三方 Anthropic 代理**，
> 实测代理可能返回**跳跃 index**（session 9bc92c2c：跳过 0 直接给 index=1）。
> 因此 `anthropic.ts` 采用 **fail-safe 策略**：
> - `content_block_start` 用 `contentBlocks[idx]` 记录（稀疏数组容忍跳跃）
> - `content_block_delta` 引用不存在的 index → `log.error + continue`（不 throw）
> - `stream-processor.ts` 用 indexToPosition 映射 + `filter(Boolean)` 兜底
> 对应测试：`tests/llm/provider-anthropic-conformance.test.ts` 「index 不连续」用例。

### Ping 事件

流中可能穿插任意数量的 `ping` 事件（`{"type": "ping"}`）。状态机必须忽略未知/ping 事件。

### Error 事件

高负载时可能在流中收到 error 事件（如 `overloaded_error`，对应非流式的 HTTP 529）：

```
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

`anthropic.ts` 把它转为 `{ type: "error", error: { message } }` 事件向下游透传。

### 未知事件

按 versioning 政策，未来可能新增事件类型，代码须**优雅忽略未知类型**（`anthropic.ts` switch 的 `default` 分支即此用途）。

---

## 3. content_block_delta 的 delta 类型

每个 `content_block_delta` 带一个 `delta`，按 `index` 更新对应 content block。

### text_delta（文本）

```
data: {"type": "content_block_delta","index": 0,"delta": {"type": "text_delta", "text": "ello frien"}}
```

### input_json_delta（工具输入）

`tool_use` block 的 input 通过 **partial JSON 字符串**增量流出，最终 `tool_use.input` 永远是**对象**。

```
data: {"type": "content_block_delta","index": 1,"delta": {"type": "input_json_delta","partial_json": "{\"location\": \"San Fra"}}
```

**正确做法**：累加 partial_json 字符串，在收到 `content_block_stop` 后**一次性 `JSON.parse`**。
不要每个 delta 都 parse（SDK 高层 MessageStream 的 O(n²) 问题正源于此）。

> `anthropic.ts` 实现：`entry._inputAccumulator += delta.partial_json`，
> 在 `content_block_stop` 时 `normalizeToolInput(JSON.parse(_inputAccumulator))`，
> parse 失败兜底 `{}`（对应测试「tool input 非法 JSON 不崩溃」）。

> 注：当前模型一次只发一个完整 key+value，所以 delta 间可能有延迟（模型在算）。

### thinking_delta（Extended Thinking）

启用 extended thinking + streaming 时，thinking 内容通过 `thinking_delta` 流出，对应 thinking block 的 `thinking` 字段：

```
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "1071 = 2 × 462 + 147"}}
```

`anthropic.ts` 把 thinking_delta 作为 `text_delta` 向下游透传（由 history-adapter 转 ThinkingMessage 渲染）。

### signature_delta（思考签名）

thinking block 在 `content_block_stop` 前会发一个 `signature_delta`，用于校验 thinking block 完整性：

```
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "EqQBCgIYAhIM..."}}
```

`anthropic.ts` 当前**静默忽略** signature_delta / citations_delta（不影响主流程）。

---

## 4. usage token 口径（关键）

> **`message_delta` 事件 `usage` 字段中的 token 计数是「累积值」（cumulative），不是增量。**

- `message_start.message.usage`：给出 input_tokens 全量 + output_tokens 初值（通常 1）。
- `message_delta.usage.output_tokens`：**累积**输出 token（不是本次增量）。

> `anthropic.ts` 的 PARSE-2 逻辑据此设计：
> - `emittedOutputTokens` 跟踪已发累积值
> - 每次 message_delta 取 `cumulativeOutput - emittedOutputTokens` 作为增量向下游发
> - 下游 `accumulateUsage` 累加增量后 == 最终累积值，不重复计种子
> 对应测试：「message_start 给全量 input，message_delta 给 output 增量」。

cache 相关字段（`cache_creation_input_tokens` / `cache_read_input_tokens`）在 `message_start.usage` 中给出。

---

## 5. message_start 完整示例

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_...", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-4-8", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}
```

---

## 6. 与 sid-code 实现的映射

| 协议事件 | anthropic.ts 处理 |
| --- | --- |
| message_start | 初始化 accumulatedUsage + emittedOutputTokens 基线 |
| content_block_start | `contentBlocks[idx] = { block }`（稀疏容忍跳跃） |
| content_block_delta / text_delta | 透传 |
| content_block_delta / input_json_delta | `_inputAccumulator += partial_json` + 透传 |
| content_block_delta / thinking_delta | 作为 text_delta 透传 |
| content_block_delta / signature_delta | 静默忽略 |
| content_block_stop | tool_use 一次性 JSON.parse + normalizeToolInput |
| message_delta | output_tokens 累积转增量（PARSE-2） |
| message_stop | 收尾日志 + 透传 |
| error | 转 error 事件透传 |
| ping / 未知 | default 分支忽略 |

流内超时/stall 由 `stream-guard.ts` 包装提供（idle 90s / stall 30s）；资源清理在 finally 块（abort + body.cancel）。
