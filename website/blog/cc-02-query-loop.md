---
title: Claude Code 源码解析（二）· 核心对话循环
description: 'LLM 的单次 API 调用如何变成持续的"对话-执行-反馈"循环？上下文窗口有限，长对话如何不丢失关键信息？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第二章：核心对话循环（Query Loop & Conversation Engine）

> Claude Code 的心脏——从用户输入到模型响应再到工具执行的完整循环。

## 核心问题

一个 LLM 驱动的编程助手，其核心交互模式看似简单：用户提问 → 模型回答。但 Claude Code 面临的对话循环问题远比"一问一答"复杂：

1. **模型不只是"回答"，它还会"行动"。** Claude 的回复中可能包含工具调用（tool_use）——读文件、写文件、执行命令、搜索代码。每个工具调用都需要被执行，结果需要被反馈给模型，模型再决定下一步。这不是一次 API 调用，而是一个**多轮循环**。

2. **一次回复可能包含多个工具调用，它们之间可能有依赖关系。** 模型可能同时请求读取 3 个文件（可以并发），也可能先执行一个 shell 命令再根据结果编辑文件（必须串行）。如何判断哪些可以并发、哪些必须串行？

3. **循环可能很长，上下文窗口是有限的。** 一个复杂任务可能需要几十轮工具调用，每轮都会产生大量 token（文件内容、命令输出、搜索结果）。当对话历史逼近上下文窗口极限时，怎么办？

4. **循环中随时可能出错。** API 限流、网络超时、工具执行失败、用户中断、模型输出截断……每种错误都需要不同的恢复策略。

5. **用户需要实时看到进展。** 不能等所有工具执行完才显示结果——用户需要看到模型正在思考、工具正在执行、文件正在被修改。

**核心矛盾：简单的交互模型 vs 复杂的运行时需求。**

Claude Code 的解法是一个**两层架构**：`QueryEngine`（会话引擎）负责会话级编排，`query()`（查询循环）负责单次查询的多轮工具执行循环。两者通过 async generator 协议连接，形成一个流式、可中断、可恢复的对话引擎。

---

## 2.1 架构总览：两层对话引擎

### 全局数据流

```
用户输入 "帮我重构这个函数"
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  QueryEngine.submitMessage()                             │
│  ─────────────────────────────────────────────────────── │
│  • 预处理用户输入（斜杠命令? 普通文本?）                    │
│  • 构建 System Prompt（基础提示 + 环境信息 + CLAUDE.md）   │
│  • 管理会话状态（消息历史、用量统计、权限追踪）              │
│  • 持久化会话记录（transcript）                            │
│                                                           │
│  shouldQuery = true?                                      │
│  ├─ NO  → 返回本地命令结果（如 /help, /clear）             │
│  └─ YES ↓                                                 │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  query() — 核心查询循环                               │ │
│  │  ─────────────────────────────────────────────────── │ │
│  │                                                       │ │
│  │  ┌──→ 构建消息窗口（压缩/截断/预算）                  │ │
│  │  │    │                                               │ │
│  │  │    ▼                                               │ │
│  │  │  调用模型 API（流式）                               │ │
│  │  │    │                                               │ │
│  │  │    ▼                                               │ │
│  │  │  收集 Assistant 响应                                │ │
│  │  │    │                                               │ │
│  │  │    ├─ 无 tool_use → 运行 Stop Hooks → 结束         │ │
│  │  │    │                                               │ │
│  │  │    └─ 有 tool_use ──→ 执行工具（并发/串行）         │ │
│  │  │                        │                           │ │
│  │  │                        ▼                           │ │
│  │  │                      收集工具结果                   │ │
│  │  │                        │                           │ │
│  │  └────────────────────────┘                           │ │
│  │                                                       │ │
│  │  终止条件: end_turn / abort / max_turns / 错误         │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  消费 query() 的 yield 流 → 规范化为 SDK 消息 → 输出       │
└─────────────────────────────────────────────────────────┘
         │
         ▼
    终端 UI 渲染 / SDK 返回
```

### 为什么是两层而不是一层？

这个分层不是偶然的，它解决了一个根本性的**关注点分离**问题：

| 关注点 | QueryEngine（会话层） | query()（执行层） |
|--------|----------------------|-------------------|
| 状态生命周期 | 跨多次提交持久化 | 单次查询内临时状态 |
| 消息历史 | 拥有 `mutableMessages`，跨轮次累积 | 接收只读快照，内部追加工具结果 |
| 用户输入处理 | 斜杠命令解析、输入预处理 | 不关心输入来源 |
| System Prompt | 组装和优先级决策 | 只使用最终结果 |
| 工具执行 | 提供权限回调和执行上下文 | 实际调度和执行工具 |
| 错误恢复 | 预算超限、结构化输出重试 | 模型降级、prompt-too-long、max_tokens |
| 输出格式 | 规范化为 SDK 消息格式 | 产出内部 Message 类型 |
| 持久化 | 写 transcript、刷新存储 | 不关心持久化 |

**如果合并成一层会怎样？** 一个 2000 行的函数，同时处理输入预处理、prompt 构建、API 调用、工具执行、错误恢复、状态持久化、SDK 格式转换……这正是 `query.ts` 已经 1700+ 行的原因——它只负责执行层就已经这么复杂了。

**另一个关键原因是复用。** `query()` 不仅被 `QueryEngine` 调用，子代理（subagent）也通过相同的 `query()` 函数执行对话循环，但使用不同的 `QueryEngine` 配置（不同的工具集、不同的 system prompt、不同的权限策略）。分层使得执行引擎可以在不同的会话上下文中复用。

### 连接协议：Async Generator

两层之间的连接不是简单的函数调用-返回，而是通过 **async generator** 实现的流式协议：

```typescript
// query.ts — 核心循环是一个 async generator
export async function* query(params: QueryParams): AsyncGenerator<Message> {
  // ... 每产出一个消息就 yield 给上层
  yield assistantMessage;
  yield toolResultMessage;
  yield streamEvent;
  // ...
}

// QueryEngine.ts — 消费 generator 的流
for await (const message of query({...})) {
  // 每收到一个消息：
  // 1. 追加到会话历史
  // 2. 持久化到 transcript
  // 3. 规范化为 SDK 格式
  // 4. yield 给更上层（UI / SDK 调用者）
}
```

为什么用 async generator 而不是回调或 EventEmitter？

1. **背压控制（backpressure）**：generator 天然支持消费者控制生产速度。如果上层处理慢了，`query()` 会自然暂停在 `yield` 处。
2. **类型安全**：generator 的 yield 类型是静态可检查的，不像 EventEmitter 的事件名是字符串。
3. **组合性**：`yield*` 可以无缝委托给子 generator（如 `handleStopHooks`），不需要手动转发事件。
4. **生命周期清晰**：generator 的 `return` 就是循环结束，不需要额外的"完成"信号。

---

## 2.2 queryLoop：核心执行循环

### 面临的问题

`queryLoop()` 是整个 Claude Code 最核心的函数——它驱动"调用模型 → 收集响应 → 执行工具 → 反馈结果 → 再次调用模型"的循环。但这个循环远不是一个简单的 `while(true)` + API 调用。它需要在每次迭代中处理：

- **上下文窗口管理**：消息历史可能已经逼近 token 上限，需要压缩/截断/替换
- **流式响应处理**：模型的回复是流式到达的，需要边接收边处理
- **工具并发执行**：多个工具调用可能可以并行，需要智能调度
- **多种错误恢复**：prompt-too-long、max_output_tokens、模型降级、用户中断……
- **循环终止判定**：什么时候该停？end_turn？max_turns？abort？stop hook 阻止？

### queryLoop 的状态机

`queryLoop()` 定义在 `src/query.ts:241`，它是一个 `while(true)` 循环，每次迭代代表一次完整的"API 调用 + 工具执行"周期。循环通过一个显式的 `State` 对象在迭代间传递状态：

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]                              // 当前消息历史
  toolUseContext: ToolUseContext                    // 工具执行上下文
  autoCompactTracking: AutoCompactTrackingState    // 自动压缩追踪
  maxOutputTokensRecoveryCount: number             // max_tokens 恢复次数
  hasAttemptedReactiveCompact: boolean             // 是否已尝试响应式压缩
  maxOutputTokensOverride: number | undefined      // max_tokens 覆盖值
  pendingToolUseSummary: Promise<...> | undefined  // 异步工具摘要
  stopHookActive: boolean | undefined              // stop hook 是否激活
  turnCount: number                                // 当前轮次计数
  transition: Continue | undefined                 // 上一次迭代为何继续
}
```

**为什么用一个 `State` 对象而不是多个独立变量？**

源码注释说得很清楚：

```typescript
// Mutable cross-iteration state. The loop body destructures this at the top
// of each iteration so reads stay bare-name (`messages`, `toolUseContext`).
// Continue sites write `state = { ... }` instead of 9 separate assignments.
```

循环中有 **7+ 个 `continue` 分支**（工具执行后继续、错误恢复后继续、stop hook 重试后继续……），每个分支都需要更新状态后跳到下一次迭代。如果用 9 个独立变量，每个 `continue` 前都要写 9 行赋值语句，极易遗漏。用一个 `State` 对象，`state = { ...state, messages: newMessages }` 一行搞定，且编译器会检查类型完整性。

### 单次迭代的完整流程

```
┌─ 迭代开始 ─────────────────────────────────────────────────────┐
│                                                                 │
│  ① 解构 State，获取当前迭代的 messages、toolUseContext 等        │
│                                                                 │
│  ② 启动异步预取                                                 │
│     • Skill 发现预取（与后续工作并行）                            │
│     • Memory 预取（整个 query 生命周期只启动一次）                │
│                                                                 │
│  ③ 构建消息窗口                                                 │
│     • getMessagesAfterCompactBoundary() — 截取压缩边界后的消息    │
│     • applyToolResultBudget() — 替换超大工具结果                 │
│     • snip（历史裁剪）                                           │
│     • microcompact（轻量压缩：清理旧工具结果）                    │
│     • autoCompact（自动压缩：调用模型生成摘要）                   │
│     • 阻塞限制检查（token 超限则直接返回错误）                    │
│                                                                 │
│  ④ 调用模型 API（流式）                                         │
│     • prependUserContext() — 注入 CLAUDE.md、日期等              │
│     • appendSystemContext() — 注入 git 状态等                    │
│     • 流式接收 assistant 消息                                    │
│     • 边接收边启动工具执行（StreamingToolExecutor）               │
│     • 处理流式降级（streaming fallback）                         │
│     • 扣留可恢复错误（prompt-too-long、max_output_tokens）       │
│                                                                 │
│  ⑤ 流式结束后的分支判定                                         │
│     ├─ 用户中断（abort）→ 生成中断消息 → 返回                    │
│     ├─ 被扣留的 prompt-too-long → 尝试压缩恢复 → continue       │
│     ├─ 被扣留的 max_output_tokens → 尝试续写恢复 → continue     │
│     ├─ 无 tool_use → 运行 Stop Hooks                            │
│     │   ├─ stop hook 有阻塞错误 → 注入错误消息 → continue       │
│     │   ├─ stop hook 阻止继续 → 返回                            │
│     │   └─ 正常结束 → 返回                                      │
│     └─ 有 tool_use → 进入工具执行阶段 ⑥                         │
│                                                                 │
│  ⑥ 工具执行                                                     │
│     • StreamingToolExecutor.getRemainingResults() 或 runTools()  │
│     • 收集工具结果到 toolResults[]                               │
│     • 异步生成工具使用摘要（与下一轮并行）                        │
│     • 检查用户中断                                               │
│     • 检查 max_turns 限制                                        │
│                                                                 │
│  ⑦ 收集附加消息                                                 │
│     • 队列命令（queued commands）                                │
│     • Memory 预取结果                                            │
│     • Skill 发现结果                                             │
│     • Token 预算检查（是否需要自动续写）                          │
│                                                                 │
│  ⑧ 构建下一轮状态                                               │
│     state = { messages: [...messages, ...assistant, ...tools] }  │
│     continue → 回到 ①                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 核心源码解读：循环骨架

```typescript
// src/query.ts:241-307 — queryLoop 入口
async function* queryLoop(params, consumedCommandUuids) {
  // 不可变参数解构
  const { systemPrompt, userContext, systemContext, canUseTool,
          fallbackModel, querySource, maxTurns } = params

  // 可变跨迭代状态
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    turnCount: 1,
    // ... 其他初始值
  }

  // Token 预算追踪器（feature-gated）
  const budgetTracker = feature('TOKEN_BUDGET')
    ? createBudgetTracker() : null

  // Memory 预取——整个 query 生命周期只启动一次
  // 使用 `using` 关键字确保在 generator 退出时自动清理
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages, state.toolUseContext
  )

  while (true) {
    // 解构当前迭代状态
    let { toolUseContext } = state
    const { messages, turnCount, ... } = state

    // ... 构建消息窗口、调用 API、执行工具 ...

    // 每个 continue 分支都会写入新的 state
    state = { ...state, messages: newMessages, turnCount: turnCount + 1 }
    continue
  }
}
```

注意 `using pendingMemoryPrefetch` 这个语法——这是 TC39 的 [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) 提案。`using` 声明的变量在作用域退出时会自动调用 `[Symbol.dispose]()`。这里用它来确保 memory 预取的清理逻辑（遥测上报等）在 generator 的所有退出路径上都能执行——无论是正常 `return`、`throw`、还是外部调用 `.return()`。

### 设计决策讨论

**为什么是 `while(true)` 而不是递归？**

早期版本可能用过递归（`queryLoop` 调用自身），但递归有两个致命问题：
1. **栈深度**：一个复杂任务可能需要 50+ 轮工具调用，递归会导致栈溢出
2. **generator 组合**：递归的 generator 需要 `yield*` 委托，每层递归都增加一层 generator 包装，影响性能

`while(true)` + `State` 对象是经典的**状态机模式**——用数据（State）而不是控制流（递归栈）来表达状态转换。

**为什么 `transition` 字段要记录"上一次为何继续"？**

```typescript
transition: Continue | undefined
// Why the previous iteration continued. Undefined on first iteration.
// Lets tests assert recovery paths fired without inspecting message contents.
```

这是一个**可测试性设计**。循环内部有 7+ 个 `continue` 分支（工具执行、prompt-too-long 恢复、max_tokens 恢复、stop hook 重试……），测试需要验证"在特定条件下，循环走了正确的恢复路径"。如果没有 `transition` 字段，测试只能通过检查消息内容来间接推断——脆弱且不直观。

---

## 2.3 单次 API 调用编排

### 面临的问题

`queryLoop` 的每次迭代都需要调用一次 Claude API。但"调用 API"远不是发一个 HTTP 请求那么简单：

1. **消息需要规范化**：内部消息格式和 API 期望的格式不完全一致
2. **响应是流式的**：需要边接收边处理，不能等全部接收完
3. **流式过程中可能发生降级**：模型可能从主模型降级到备用模型
4. **某些错误需要"扣留"**：prompt-too-long 和 max_output_tokens 错误不能立即暴露给上层，因为循环可能自行恢复

### 消息窗口构建：从历史到 API 请求

在调用 API 之前，`queryLoop` 需要把原始消息历史转换为一个适合发送给 API 的"消息窗口"。这个过程涉及多个步骤，每个步骤都在解决一个具体问题：

```
原始消息历史 (messages)
    │
    ▼
getMessagesAfterCompactBoundary()
    │  问题：压缩后，边界之前的消息已被摘要替代，不应再发送
    │  解法：找到最后一个 compact_boundary 消息，只取其后的消息
    ▼
applyToolResultBudget()
    │  问题：某些工具结果巨大（如读取大文件），占用过多 token
    │  解法：超过预算的工具结果被替换为占位符，原始内容持久化到磁盘
    ▼
snipCompact（feature-gated）
    │  问题：历史太长但还没到自动压缩阈值
    │  解法：裁剪最早的消息，保留最近的上下文
    ▼
microcompactMessages()
    │  问题：旧的工具结果（如 10 分钟前读的文件）占用空间但价值低
    │  解法：清理旧工具结果的内容，保留结构
    │  两种模式：
    │  • 缓存模式：不修改本地消息，通过 API cache_edits 删除
    │  • 时间模式：直接清空旧工具结果内容
    ▼
autoCompact（如果 token 超过阈值）
    │  问题：即使经过上述步骤，消息仍然太长
    │  解法：调用模型生成对话摘要，替换旧消息
    ▼
messagesForQuery — 准备好发送给 API
```

这个管道的设计体现了一个重要原则：**渐进式压缩**。不是一步到位地压缩到最小，而是从最轻量（截断边界）到最重量（调用模型生成摘要）逐步尝试。每一步都有成本：

- `getMessagesAfterCompactBoundary()`：零成本，纯内存操作
- `applyToolResultBudget()`：低成本，字符串替换 + 可选磁盘写入
- `snipCompact`：低成本，数组裁剪
- `microcompactMessages()`：低成本，内容清理或 cache edit 标记
- `autoCompact`：**高成本**，需要额外的 API 调用来生成摘要

只有当轻量手段不够时，才会触发重量手段。这避免了不必要的 API 调用和延迟。

### 流式响应处理

API 调用通过 `deps.callModel()` 发起，返回一个 async iterable，逐步产出消息：

```typescript
// src/query.ts:659-708 — 流式 API 调用
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    onStreamingFallback: () => { streamingFallbackOccured = true },
    // ... 其他选项
  },
})) {
  // 处理每个流式消息...
}
```

流式循环内部需要处理几种情况：

**1. 流式降级（Streaming Fallback）**

```typescript
// src/query.ts:712-739
if (streamingFallbackOccured) {
  // 为已产出的孤儿消息生成 tombstone（从 UI 和 transcript 中移除）
  for (const msg of assistantMessages) {
    yield { type: 'tombstone', message: msg }
  }
  // 清空所有已收集的状态
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  needsFollowUp = false
  // 丢弃并重建 StreamingToolExecutor
  streamingToolExecutor?.discard()
  streamingToolExecutor = new StreamingToolExecutor(...)
  streamingFallbackOccured = false
}
```

当主模型流式传输失败时，系统会降级到备用模型。但此时可能已经向上层 yield 了部分 assistant 消息。这些"孤儿消息"需要被撤回——通过 yield `tombstone` 消息通知上层删除它们。这是一个**补偿事务**模式：先乐观地产出结果，失败时发送补偿操作。

**2. 工具调用检测与流式执行**

```typescript
// src/query.ts:826-862
const msgToolUseBlocks = message.message.content.filter(
  content => content.type === 'tool_use',
) as ToolUseBlock[]

if (msgToolUseBlocks.length > 0) {
  toolUseBlocks.push(...msgToolUseBlocks)
  needsFollowUp = true

  // 流式工具执行：模型还在输出时就开始执行工具
  if (streamingToolExecutor) {
    for (const block of msgToolUseBlocks) {
      streamingToolExecutor.addTool(block, message)
    }
    // 立即收割已完成的工具结果
    for (const result of streamingToolExecutor.getCompletedResults()) {
      yield result.message
      toolResults.push(
        ...normalizeMessagesForAPI([result.message], tools)
          .filter(_ => _.type === 'user')
      )
    }
  }
}
```

这是一个关键的性能优化：**模型还在流式输出后续内容时，已经检测到的工具调用就开始执行了**。比如模型回复中包含 3 个 `tool_use` block，第一个 block 完整到达时就立即开始执行，不需要等后面两个 block 也到达。

**3. 可恢复错误的扣留**

```typescript
// src/query.ts:788-825 — 扣留逻辑（简化）
if (isPromptTooLongMessage(message)) {
  // 不 yield 给上层，存入 assistantMessages 等待恢复
  assistantMessages.push(message)
  continue  // 继续接收流
}
if (isWithheldMaxOutputTokens(message)) {
  assistantMessages.push(message)
  continue
}
// 正常消息：yield 给上层
yield message
```

为什么要"扣留"而不是立即上报？因为 SDK 调用者（如 VS Code 插件）可能在收到 `error` 类型的消息时就终止会话。但 `queryLoop` 有能力自行恢复这些错误（通过压缩或续写）。如果过早暴露错误，上层会终止，恢复逻辑就没机会执行了。

### 设计决策讨论

**为什么 `deps.callModel` 是通过依赖注入传入的？**

```typescript
// src/query/deps.ts
export type QueryDeps = {
  callModel: typeof callModel
  microcompact: typeof microcompactMessages
  uuid: typeof randomUUID
}
export const productionDeps = (): QueryDeps => ({
  callModel,
  microcompact: microcompactMessages,
  uuid: randomUUID,
})
```

这是一个经典的**依赖注入 seam**。`queryLoop` 是一个 1700 行的复杂函数，直接 mock 它的内部行为几乎不可能。通过 `deps` 注入，测试可以替换 `callModel` 为一个返回预设响应的 mock，从而测试循环的各种分支（错误恢复、工具执行、压缩触发等）而不需要真正调用 API。

**为什么 `normalizeMessagesForAPI` 只保留 `user` 类型的消息？**

```typescript
toolResults.push(
  ...normalizeMessagesForAPI([result.message], tools)
    .filter(_ => _.type === 'user')
)
```

Claude API 的消息格式要求 `tool_result` 必须包含在 `user` 角色的消息中。工具执行可能产出多种内部消息类型（progress、attachment、system 等），但只有 `user` 类型的消息（包含 `tool_result` block）才应该被反馈给模型。其他类型是给 UI 或 SDK 消费的，不应该进入下一轮 API 请求。

---

## 2.4 并发工具执行策略

### 面临的问题

模型的一次回复中可能包含多个工具调用。比如：

```
Assistant: 让我先看看这几个文件的内容。
[tool_use: FileRead("src/main.ts")]
[tool_use: FileRead("src/utils.ts")]
[tool_use: FileRead("src/types.ts")]
[tool_use: BashTool("npm test")]
```

这里有 3 个文件读取和 1 个命令执行。文件读取之间没有依赖关系，可以并发；但 `npm test` 可能依赖文件系统状态，不能和写操作并发。

**核心问题：如何在保证正确性的前提下最大化并发？**

### 解法：基于 `isConcurrencySafe` 的分区执行

Claude Code 的工具并发策略建立在一个简单但有效的抽象上：每个工具声明自己是否"并发安全"（`isConcurrencySafe`）。这个声明不是静态的——它取决于工具的**输入参数**。

```typescript
// Tool 接口中的并发安全声明（src/Tool.ts）
interface Tool<Input, Output, Progress> {
  // ...
  isConcurrencySafe(input: Input): boolean
  // ...
}
```

比如 `BashTool`：
- `ls -la` → 只读命令，`isConcurrencySafe = true`
- `rm -rf /tmp/test` → 写操作，`isConcurrencySafe = false`

比如 `FileReadTool`：始终返回 `true`（读文件不会修改状态）

比如 `FileEditTool`：始终返回 `false`（编辑文件会修改状态）

### 两种执行器：批量模式 vs 流式模式

Claude Code 提供了两种工具执行器，通过 feature flag 切换：

#### 批量模式：`runTools()`（`src/services/tools/toolOrchestration.ts`）

```typescript
// src/services/tools/toolOrchestration.ts:19-82
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  // 将工具调用分区为连续的批次
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // 并发安全的批次：并行执行
      yield* runToolsConcurrently(blocks, ...)
    } else {
      // 非并发安全的批次：串行执行
      yield* runToolsSerially(blocks, ...)
    }
  }
}
```

分区算法（`partitionToolCalls`）将工具调用序列切分为交替的"并发批次"和"串行批次"：

```
输入: [Read, Read, Read, Bash(rm), Edit, Read, Read]
分区: [Read, Read, Read]  →  并发批次
      [Bash(rm)]          →  串行批次
      [Edit]              →  串行批次
      [Read, Read]        →  并发批次
```

规则很简单：连续的 `isConcurrencySafe=true` 工具合并为一个并发批次，每个 `isConcurrencySafe=false` 工具独占一个串行批次。批次之间严格顺序执行。

并发批次内部通过 `all()` 工具函数实现有限并发（默认最大 10 个并发，可通过 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 环境变量调整）：

```typescript
// src/services/tools/toolOrchestration.ts:152-177
async function* runToolsConcurrently(...) {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      yield* runToolUse(toolUse, ...)
    }),
    getMaxToolUseConcurrency(),  // 默认 10
  )
}
```

#### 流式模式：`StreamingToolExecutor`（`src/services/tools/StreamingToolExecutor.ts`）

流式执行器是一个更激进的优化——**在模型还在流式输出时就开始执行工具**。

```typescript
// src/services/tools/StreamingToolExecutor.ts:40
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private hasErrored = false
  private siblingAbortController: AbortController

  // 模型流式输出中检测到 tool_use block 时调用
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    // 判断并发安全性
    const isConcurrencySafe = toolDefinition.isConcurrencySafe(parsedInput)
    this.tools.push({ id, block, status: 'queued', isConcurrencySafe, ... })
    void this.processQueue()  // 立即尝试执行
  }

  // 并发控制：能否执行这个工具？
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||  // 没有正在执行的工具
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
      // 或者：自己和所有正在执行的都是并发安全的
    )
  }
}
```

流式执行器的时间线：

```
时间 ──────────────────────────────────────────────────────────►

模型流式输出:
  ├─ "让我看看这些文件"
  ├─ [tool_use: Read("a.ts")]  ──→ addTool() → 立即开始执行
  ├─ [tool_use: Read("b.ts")]  ──→ addTool() → 立即并发执行
  ├─ "然后运行测试"
  ├─ [tool_use: Bash("test")]  ──→ addTool() → 排队（等 Read 完成）
  └─ 流式结束

                                    ↑ 此时 Read 可能已经完成了！
                                    getRemainingResults() 只需等 Bash
```

对比批量模式：

```
时间 ──────────────────────────────────────────────────────────►

模型流式输出:
  ├─ ... 完整接收所有内容 ...
  └─ 流式结束
                    ↑ 此时才开始执行工具
                    runTools([Read, Read, Bash])
```

流式模式的优势在于**将工具执行时间与模型输出时间重叠**。对于包含多个工具调用的长回复，这可以显著减少总延迟。

### Bash 错误的级联取消

`StreamingToolExecutor` 有一个精妙的错误处理机制：**Bash 命令失败时，取消所有并行的兄弟工具**。

```typescript
// src/services/tools/StreamingToolExecutor.ts:354-363
if (isErrorResult) {
  thisToolErrored = true
  // Only Bash errors cancel siblings. Bash commands often have implicit
  // dependency chains (e.g. mkdir fails → subsequent commands pointless).
  // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
  if (tool.block.name === BASH_TOOL_NAME) {
    this.hasErrored = true
    this.siblingAbortController.abort('sibling_error')
  }
}
```

为什么只有 Bash 错误会级联取消？

- **Bash 命令之间常有隐式依赖**：`mkdir /tmp/build` 失败了，后续的 `cp src/* /tmp/build/` 必然也会失败。继续执行只是浪费时间。
- **读取类工具之间是独立的**：`FileRead("a.ts")` 失败不影响 `FileRead("b.ts")`。一个文件不存在不意味着其他文件也不存在。

这个区分体现了**领域知识驱动的工程决策**——不是用通用的"全部取消"或"全部继续"策略，而是根据工具的语义特性做出不同选择。

### 结果顺序保证

并发执行带来一个问题：工具完成的顺序可能和请求的顺序不同。但 Claude API 要求 `tool_result` 的顺序与 `tool_use` 的顺序一致。

`StreamingToolExecutor` 通过 `getCompletedResults()` 方法解决这个问题：

```typescript
// src/services/tools/StreamingToolExecutor.ts:412-440
*getCompletedResults(): Generator<MessageUpdate, void> {
  for (const tool of this.tools) {
    // 按添加顺序遍历
    if (tool.status === 'yielded') continue
    if (tool.status === 'completed' && tool.results) {
      tool.status = 'yielded'
      for (const message of tool.results) {
        yield { message, newContext: this.toolUseContext }
      }
    } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
      break  // 遇到正在执行的非并发安全工具，停止产出
    }
  }
}
```

关键逻辑：按工具的**添加顺序**（即模型请求的顺序）遍历。如果一个工具已完成，产出其结果；如果遇到一个正在执行的非并发安全工具，停止产出——因为后续工具的结果不能在它之前被发送。

这是一个**有序并发**模式：执行是并发的，但结果的产出是有序的。

### 设计决策讨论

**为什么 `isConcurrencySafe` 是工具自己声明的，而不是由框架分析？**

框架无法可靠地分析一个工具是否有副作用。`BashTool` 执行的命令是一个字符串，静态分析几乎不可能判断 `echo hello` 和 `rm -rf /` 的区别。让工具自己声明是唯一可行的方案——工具的实现者最了解自己的语义。

**为什么并发上限默认是 10 而不是更高？**

每个并发工具都可能 spawn 子进程（Bash 命令）、打开文件句柄（FileRead）、发起网络请求（WebFetch）。过高的并发会导致：
- 文件描述符耗尽
- 子进程数量爆炸
- 系统负载过高影响用户体验

10 是一个经验值——足够利用 I/O 并行性，又不会压垮系统。通过环境变量可调，给高级用户留了调优空间。

---

## 2.5 System Prompt 构建

### 面临的问题

System Prompt 是 Claude 的"操作手册"——它告诉模型自己是谁、能做什么、应该怎么做。对于 Claude Code 这样的复杂应用，System Prompt 不是一段静态文本，而是一个**动态组装**的产物，需要包含：

- 基础行为指令（如何使用工具、如何与用户交互）
- 当前环境信息（操作系统、shell、工作目录、模型名称）
- Git 仓库状态（当前分支、最近提交、未提交变更）
- 用户自定义指令（CLAUDE.md 文件内容）
- 可用工具描述
- MCP 服务器指令
- 当前日期
- 各种 feature-gated 的附加指令

问题是：这些信息来自不同的源头，有不同的缓存策略，有不同的安全约束，还需要考虑 prompt cache 的命中率。

### 三层组装架构

Claude Code 的 System Prompt 不是在一个地方一次性构建的，而是通过三层架构逐步组装：

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 基础 Prompt（getSystemPrompt）                 │
│  来源: src/constants/prompts.ts                          │
│  内容: 静态指令 + 动态指令                                │
│  缓存: 静态部分可全局缓存，动态部分按会话缓存              │
│                                                           │
│  ┌─ 静态区 ──────────────────────────────────────────┐  │
│  │  • intro（身份介绍）                                │  │
│  │  • system（系统能力描述）                            │  │
│  │  • doing tasks（任务执行指南）                       │  │
│  │  • actions（操作安全指南）                           │  │
│  │  • using your tools（工具使用指南）                  │  │
│  │  • tone and style（语气风格）                        │  │
│  │  • output efficiency（输出效率）                     │  │
│  └────────────────────────────────────────────────────┘  │
│  ── SYSTEM_PROMPT_DYNAMIC_BOUNDARY ──                     │
│  ┌─ 动态区 ──────────────────────────────────────────┐  │
│  │  • session guidance（会话特定指导）                  │  │
│  │  • memory（自动记忆）                               │  │
│  │  • env info（环境信息：OS/shell/cwd/model）         │  │
│  │  • language（语言偏好）                              │  │
│  │  • output style（输出样式）                          │  │
│  │  • MCP instructions（MCP 服务器指令）               │  │
│  │  • token budget（token 预算指导）                    │  │
│  │  • ...                                              │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: 优先级决策（buildEffectiveSystemPrompt）        │
│  来源: src/utils/systemPrompt.ts                         │
│  问题: 多个 prompt 源可能冲突，谁优先？                    │
│                                                           │
│  优先级（高→低）:                                         │
│  1. overrideSystemPrompt  — 完全替换（SDK 覆盖）          │
│  2. coordinator prompt    — 多 Agent 协调器模式           │
│  3. agent prompt          — 子代理专用 prompt             │
│  4. customSystemPrompt    — 用户自定义 prompt             │
│  5. defaultSystemPrompt   — 上面 Layer 1 的输出           │
│                                                           │
│  + appendSystemPrompt（追加内容，除 override 外都生效）    │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3: 运行时注入（query.ts 中的最终组装）             │
│  来源: src/context.ts + src/utils/api.ts                 │
│                                                           │
│  System 侧注入:                                          │
│  • appendSystemContext(systemPrompt, systemContext)       │
│    → 追加 gitStatus、cacheBreaker                        │
│                                                           │
│  User 侧注入:                                            │
│  • prependUserContext(messages, userContext)               │
│    → 在消息列表前插入 <system-reminder> 消息              │
│    → 包含 claudeMd（CLAUDE.md 内容）和 currentDate       │
└─────────────────────────────────────────────────────────┘
```

### 为什么 CLAUDE.md 和日期不在 System Prompt 里，而是作为 User 消息注入？

这是一个**prompt cache 优化**。

Claude API 的 prompt cache 机制是：如果两次请求的 system prompt 前缀相同，缓存可以命中。System prompt 中的静态指令（行为规范、工具描述）在整个会话中不变，非常适合缓存。但 CLAUDE.md 内容和日期是会话特定的——不同项目有不同的 CLAUDE.md，不同天有不同的日期。

如果把它们放在 system prompt 中，每个项目、每一天的 system prompt 都不同，cache 命中率会大幅下降。

把它们作为 user 消息注入，system prompt 保持稳定，cache 命中率更高。代价是多了一条 user 消息，但这个 trade-off 是值得的——prompt cache 命中可以节省大量的 token 计费和延迟。

### `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的作用

```typescript
// src/constants/prompts.ts:105-115
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = {
  type: 'text' as const,
  text: '',
  cache_control: { type: 'ephemeral' as const },
}
```

这个空文本 block 被插入在静态区和动态区之间，带有 `cache_control: ephemeral` 标记。它的作用是告诉 API：**这个位置之前的内容可以使用全局缓存范围，之后的内容是会话特定的**。

这意味着：
- 静态区（行为指令、工具描述）可以跨会话缓存——所有用户共享
- 动态区（环境信息、MCP 指令）只在当前会话内缓存

### MCP 指令为什么是"故意不缓存"的？

```typescript
// src/constants/prompts.ts:513-520
if (!mcpDeltaMode) {
  sections.push({
    key: 'mcp_instructions',
    section: DANGEROUS_uncachedSystemPromptSection(
      getMCPInstructionsSection(mcpClients)
    ),
  })
}
```

`DANGEROUS_uncachedSystemPromptSection` 这个名字本身就是一个警告。MCP 服务器可能在两次 API 调用之间连接或断开，如果缓存了 MCP 指令，模型可能会尝试使用已经不存在的工具。所以 MCP 指令被标记为不可缓存，每次 API 调用都会重新构建。

代价是每次请求都要重新传输 MCP 指令的 token，但正确性比性能更重要。

### `getSystemContext()` 和 `getUserContext()` 的缓存策略

```typescript
// src/context.ts:116-150
export const getSystemContext = memoize(async () => {
  // gitStatus: 整个会话只获取一次
  const gitStatus = await getGitStatus()
  return { gitStatus, cacheBreaker }
})

// src/context.ts:155-189
export const getUserContext = memoize(async () => {
  // claudeMd: 整个会话只加载一次
  const claudeMd = await getClaudeMds(...)
  const currentDate = `Today's date is ${getLocalISODate()}.`
  return { claudeMd, currentDate }
})
```

两个函数都用 `memoize` 包装——**整个进程生命周期只执行一次**。这意味着：

- Git 状态是"会话开始时的快照"，不会随着用户的 git 操作而更新
- CLAUDE.md 内容在会话期间不会重新加载

这是一个刻意的设计选择。源码注释中 `getGitStatus` 的输出被标记为 "git status at the start of the conversation"。如果每次 API 调用都重新获取 git 状态，会增加延迟（需要 spawn git 子进程），而且模型看到不断变化的 git 状态可能会困惑。

缓存可以被显式清除——`/clear` 命令和 `/compact` 命令都会调用 `getUserContext.cache.clear()` 和 `getSystemContext.cache.clear()`。

### Git 状态的安全门控

```typescript
// src/context.ts:36-111
export const getGitStatus = memoize(async () => {
  if (!await getIsGit()) return null
  // 并行获取多个 git 信息
  const [branch, defaultBranch, status, log, userName] = await Promise.all([
    getBranch(), getDefaultBranch(),
    execFileNoThrow(gitExe(), ['status', '--short'], ...),
    execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5'], ...),
    execFileNoThrow(gitExe(), ['config', 'user.name'], ...),
  ])
  // 截断过长的 status 输出
  const truncatedStatus = status.length > MAX_STATUS_CHARS
    ? status.slice(0, MAX_STATUS_CHARS) + '\n... (truncated)'
    : status
  // ...
})
```

注意 `MAX_STATUS_CHARS = 2000` 的截断——这是 System Prompt 中唯一的直接大小控制。`git status` 在大型仓库中可能输出数万字符，不截断会浪费大量 token。

更重要的是安全门控。在第一章中我们提到，`getSystemContext()` 的预取有安全门控——在用户接受信任对话框之前不会执行 git 命令。这是因为 git 命令可以通过 hooks 和 config 执行任意代码。

### 设计决策讨论

**为什么 System Prompt 有这么多层，而不是一个函数直接生成最终结果？**

因为不同的调用场景需要不同的组合：

- **主 REPL**：默认 prompt + 环境信息 + CLAUDE.md + git 状态
- **子代理（Explore）**：精简 prompt + 无 CLAUDE.md + 无 git 状态
- **SDK 调用**：可能有 customSystemPrompt 覆盖默认 prompt
- **协调器模式**：使用 coordinator prompt 替代默认 prompt

分层架构让每个场景可以选择性地组合不同的层，而不是为每个场景写一个独立的 prompt 构建函数。

**为什么子代理可以省略 CLAUDE.md 和 git 状态？**

```typescript
// src/tools/AgentTool/runAgent.ts:380-410
// 子代理 prompt 精简：
// - Explore/Plan 子代理省略 gitStatus
// - 某些子代理省略 claudeMd
```

子代理的上下文窗口更宝贵（它们通常有更严格的 token 限制），而且它们的任务更聚焦。一个 Explore 子代理只需要搜索代码，不需要知道 git 状态或用户的项目约定。省略这些信息可以为实际的搜索结果留出更多空间。

---

## 2.6 Token 预算与上下文窗口管理

### 面临的问题

Claude 的上下文窗口是有限的（如 200k tokens）。一个复杂的编程任务可能涉及几十轮工具调用，每轮都会产生大量 token：

- 读取一个 1000 行的源文件 ≈ 3000-5000 tokens
- 一次 `npm test` 的输出 ≈ 500-5000 tokens
- 一次 `grep` 搜索结果 ≈ 200-2000 tokens

10 轮工具调用就可能消耗 30k-50k tokens。加上 system prompt（~10k）、对话历史、模型的思考过程，上下文窗口很快就会被填满。

**核心问题：如何在有限的上下文窗口内支持无限长的对话？**

### 多级阈值体系

Claude Code 在 `src/services/compact/autoCompact.ts` 中定义了一套多级阈值体系：

```typescript
// src/services/compact/autoCompact.ts:62-65
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
```

这些阈值相对于"有效上下文窗口"（上下文窗口 - 预留输出空间）计算：

```
有效上下文窗口 (effectiveContextWindow)
= 模型上下文窗口 - min(模型最大输出, 20000)

各阈值位置:
├─ 0%                                              ← 空
│
├─ autoCompactThreshold (effective - 13k)           ← 自动压缩触发
│
├─ warningThreshold (effective - 20k)               ← UI 警告
│
├─ errorThreshold (effective - 20k)                 ← UI 错误提示
│
├─ blockingLimit (effective - 3k)                   ← 硬阻塞，拒绝发送
│
└─ 100% effectiveContextWindow                      ← 上限
```

**为什么自动压缩阈值（-13k）比阻塞限制（-3k）低这么多？**

因为压缩本身需要空间。自动压缩会调用模型生成对话摘要，这个摘要需要输出空间。如果等到只剩 3k token 才触发压缩，压缩请求本身可能因为 prompt-too-long 而失败。13k 的缓冲给了压缩足够的"呼吸空间"。

### Token 预算续写机制

除了上下文窗口管理，还有一个独立的"Token 预算"机制（`src/query/tokenBudget.ts`），用于控制模型在单次任务中的输出量。

当用户指定了 token 预算（如"用大约 50k tokens 完成这个任务"），模型可能在预算用完之前就停止输出（`end_turn`）。此时系统会注入一条"续写提示"，让模型继续工作：

```typescript
// src/query/tokenBudget.ts:45-93
export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  // 子代理不参与预算续写——防止递归自我续写
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

  // 递减收益检测：连续 3 次续写后，如果连续两次增量 < 500 tokens
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  // 未达 90% 且未递减 → 继续
  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    return { action: 'continue', nudgeMessage: ... }
  }
  // 否则 → 停止
  return { action: 'stop', ... }
}
```

这个算法有两个精妙的停止条件：

1. **90% 阈值**：当输出达到预算的 90% 时停止，而不是 100%。因为模型不能精确控制输出长度，90% 留了缓冲。

2. **递减收益检测**：如果连续两次续写的增量都小于 500 tokens，说明模型已经"没什么可说的了"。继续续写只会产生重复或低质量内容。要求"连续两次"而不是"一次"，是为了避免一次偶然的短输出就误判。

**为什么子代理不参与预算续写？**

如果子代理也能自我续写，一个主代理派生的子代理可能无限续写下去，消耗大量 token 而主代理无法控制。只让主线程参与预算续写，保证了资源消耗的可控性。

---

## 2.7 上下文压缩（Compact）

### 面临的问题

当对话历史逼近上下文窗口极限时，必须"腾出空间"。但怎么腾？

- **直接截断旧消息？** 会丢失重要上下文，模型可能忘记之前做了什么。
- **调用模型生成摘要替换旧消息？** 保留了语义，但需要额外的 API 调用，有延迟和成本。
- **只清理工具结果的内容？** 工具结果（文件内容、命令输出）通常是最大的 token 消耗者，清理它们效果显著，但模型会失去对这些内容的直接访问。

Claude Code 的答案是：**全都要**——但按成本从低到高分层触发。

### 压缩层级体系

```
成本低 ──────────────────────────────────────────── 成本高

┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐
│ 工具结果  │  │ Micro        │  │ Snip     │  │ Auto         │
│ 预算替换  │→ │ Compact      │→ │ Compact  │→ │ Compact      │
│          │  │              │  │          │  │              │
│ 超大结果  │  │ 清理旧工具   │  │ 裁剪最早  │  │ 调用模型     │
│ 替换为   │  │ 结果的内容   │  │ 的消息    │  │ 生成摘要     │
│ 占位符   │  │              │  │          │  │              │
│          │  │ 两种模式:    │  │          │  │ 替换全部     │
│ 零API    │  │ • 缓存模式   │  │ 零API    │  │ 旧消息       │
│ 调用     │  │ • 时间模式   │  │ 调用     │  │              │
│          │  │              │  │          │  │ 1次API调用   │
│ ~0ms     │  │ ~0ms         │  │ ~0ms     │  │ ~3-10s       │
└──────────┘  └──────────────┘  └──────────┘  └──────────────┘
```

每一层都在 `queryLoop` 的迭代开始时按顺序执行。只有当轻量层不够时，才会触发重量层。

### 第一层：工具结果预算替换（applyToolResultBudget）

每个工具的结果都有一个大小预算。当结果超过预算时，内容被替换为占位符，原始内容持久化到磁盘：

```typescript
// src/query.ts:379-394 — 在 queryLoop 迭代开始时执行
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements
    ? records => void recordContentReplacement(records, toolUseContext.agentId)
    : undefined,
  // 没有设置 maxResultSizeChars 的工具不参与替换
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

这一层的关键特性是**可恢复**——原始内容存在磁盘上，如果模型后续需要，可以重新读取。代价几乎为零（纯内存操作 + 可选的磁盘写入）。

### 第二层：MicroCompact（轻量压缩）

MicroCompact（`src/services/compact/microCompact.ts`）专门针对**旧的工具结果**。它的核心洞察是：10 分钟前读取的文件内容，对当前决策的价值远低于刚刚读取的文件内容。

MicroCompact 有两种运行模式：

**缓存模式（Cached MicroCompact）**：当 prompt cache 仍然"热"时使用。不修改本地消息内容，而是通过 API 的 `cache_edits` 机制在服务端删除旧工具结果。这样既释放了 token 空间，又不破坏 prompt cache 的命中。

**时间模式（Time-based MicroCompact）**：当距离上次 assistant 响应超过一定时间（默认 60 分钟）时，cache 大概率已经过期。此时直接在本地清空旧工具结果的内容，替换为 `[Old tool result content cleared]`。

```typescript
// src/services/compact/microCompact.ts:253-293 — 入口函数（简化）
export async function microcompactMessages(messages, toolUseContext, querySource) {
  // 优先检查时间触发（cache 已冷，直接清理更高效）
  const timeTrigger = evaluateTimeBasedTrigger(messages, querySource)
  if (timeTrigger) {
    return maybeTimeBasedMicrocompact(messages, timeTrigger, toolUseContext)
  }
  // 否则尝试缓存模式（保护 prompt cache）
  if (canUseCachedMicrocompact(querySource, toolUseContext)) {
    return cachedMicrocompactPath(messages, toolUseContext)
  }
  // 都不适用，不做任何事
  return { messages }
}
```

**为什么时间模式优先于缓存模式？**

源码注释解释了这个决策：如果距离上次响应已经过了很长时间，prompt cache 大概率已经过期。此时用缓存模式（通过 `cache_edits` 删除）没有意义——cache 已经不存在了，不需要保护它。直接清理内容更简单、更可靠。

**哪些工具的结果会被清理？**

```typescript
// src/services/compact/microCompact.ts:40-50
const COMPACTABLE_TOOLS = [
  'file read', 'shell tools', 'grep', 'glob',
  'web search', 'web fetch', 'file edit', 'file write'
]
```

这些都是"结果体积大、时效性强"的工具。一个 5 分钟前的 `grep` 搜索结果，在代码已经被修改后，价值大幅下降。

### 第三层：AutoCompact（自动压缩）

当上述轻量手段都不够时，`autoCompactIfNeeded()`（`src/services/compact/autoCompact.ts:241`）触发完整的对话压缩。这是最重量级的操作——它会**调用模型生成整个对话的摘要**，然后用摘要替换所有旧消息。

```typescript
// src/services/compact/autoCompact.ts:241-277 — 核心逻辑（简化）
export async function autoCompactIfNeeded(messages, toolUseContext, ...) {
  // 熔断器：连续失败 3 次后停止尝试
  if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false }
  }

  if (!await shouldAutoCompact(messages, model, querySource, snipTokensFreed)) {
    return { wasCompacted: false }
  }

  // 先尝试 Session Memory 压缩（实验性）
  const sessionMemoryResult = await trySessionMemoryCompaction(...)
  if (sessionMemoryResult) {
    return sessionMemoryResult
  }

  // 否则执行完整压缩
  const result = await compactConversation(messages, toolUseContext, ...)
  return result
}
```

**熔断器设计**值得注意：

```typescript
// src/services/compact/autoCompact.ts:67-70
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
```

注释中的数据触目惊心：在没有熔断器之前，有些会话连续失败了 3000+ 次压缩尝试，每天全球浪费 25 万次 API 调用。这是一个典型的**生产环境教训驱动的防御性设计**——不是理论上觉得需要熔断器，而是真实数据证明了它的必要性。

### 压缩后的消息结构

压缩完成后，消息历史变成：

```
压缩前:
[User1, Assistant1, User2(tool_result), Assistant2, User3, Assistant3, ...]

压缩后:
[CompactBoundary(summary="用户请求重构函数，助手读取了3个文件并..."),
 User_latest, Assistant_latest]
```

`CompactBoundary` 是一个特殊的系统消息，包含压缩摘要。`queryLoop` 通过 `getMessagesAfterCompactBoundary()` 只取边界之后的消息发送给 API。

### 响应式压缩（Reactive Compact）与上下文折叠（Context Collapse）

除了主动压缩，还有两种**被动压缩**机制（均为 feature-gated 的实验性功能）：

**Reactive Compact**：当 API 返回 `prompt_too_long` 错误时触发。它不是在发送前预防，而是在失败后补救——压缩消息后重试。这是 autoCompact 的"安全网"。

**Context Collapse**：一种更精细的上下文管理策略。它不是一次性压缩所有旧消息，而是逐步"折叠"不再需要的上下文段落，保留更多的结构信息。

这两种机制与 autoCompact 之间存在复杂的互斥关系：

```typescript
// src/services/compact/autoCompact.ts:200-223 — 互斥逻辑
// Context-collapse mode: same suppression. Collapse IS the context
// management system when it's on — the 90% commit / 95% blocking-spawn
// flow owns the headroom problem. Autocompact firing at effective-13k
// (~93% of effective) sits right between collapse's commit-start (90%)
// and blocking (95%), so it would race collapse and usually win, nuking
// granular context that collapse was about to save.
```

当 Context Collapse 启用时，autoCompact 被抑制。因为两者的触发阈值太接近（autoCompact 在 ~93%，Collapse 在 90%-95%），如果同时运行，autoCompact 会"抢先"触发，破坏 Collapse 正在精心保存的细粒度上下文。

### 设计决策讨论

**为什么不用一种压缩策略统一处理？**

因为不同场景的最优策略不同：

- **工具结果刚产生 5 秒**：不应该压缩，模型可能马上要引用
- **工具结果产生了 10 分钟**：可以清理内容，保留结构
- **对话已经进行了 50 轮**：需要生成摘要，否则早期上下文全部丢失
- **API 返回 prompt-too-long**：需要紧急压缩，不能等

单一策略无法覆盖所有场景。分层策略让每种场景都能得到最合适的处理。

**为什么压缩操作放在 `queryLoop` 的迭代开始而不是结束？**

因为压缩的目的是为**下一次 API 调用**腾出空间。如果放在迭代结束（工具执行后），压缩后的消息还要等到下一次迭代才能被使用，中间可能又有新的消息加入。放在迭代开始，压缩的效果立即生效。

---

## 2.8 循环终止与错误恢复

### 面临的问题

`queryLoop` 的 `while(true)` 循环必须在某个时刻停下来。但"停下来"有很多种原因，每种原因需要不同的处理：

- 模型说"我做完了"（`end_turn`）→ 正常结束
- 模型的输出被截断了（`max_output_tokens`）→ 可能需要续写
- 上下文太长，API 拒绝了（`prompt_too_long`）→ 需要压缩后重试
- 用户按了 ESC（abort）→ 需要清理正在执行的工具
- 达到了最大轮次限制（`max_turns`）→ 强制停止
- 模型降级失败（fallback error）→ 切换模型重试
- Stop Hook 阻止了继续（blocking error）→ 注入错误消息后重试

**核心挑战：在一个 `while(true)` 循环中优雅地处理 7+ 种终止/恢复路径，且不能遗漏任何清理工作。**

### 终止路径全景图

```
流式响应结束后
    │
    ├─ 用户中断（abort signal）
    │   ├─ 有 StreamingToolExecutor → 消费剩余结果（生成合成错误）
    │   └─ 无 → 为未完成的 tool_use 生成错误 tool_result
    │   → yield 中断消息 → return { reason: 'aborted_streaming' }
    │
    ├─ 被扣留的 prompt_too_long 错误
    │   ├─ reactiveCompact 启用 → 压缩后 continue
    │   ├─ contextCollapse 启用 → 折叠后 continue
    │   └─ 都不可用 → yield 错误 → return { reason: 'prompt_too_long' }
    │
    ├─ 被扣留的 max_output_tokens 错误
    │   ├─ 恢复次数 < 3 → 注入续写提示 → continue
    │   └─ 恢复次数 >= 3 → yield 错误 → return
    │
    ├─ 无 tool_use（模型没有请求工具）
    │   ├─ 运行 Stop Hooks
    │   │   ├─ 有阻塞错误 → 注入错误消息 → continue
    │   │   ├─ 阻止继续 → return
    │   │   └─ 正常 → return { reason: 'end_turn' }
    │   └─ Token 预算续写 → 注入续写提示 → continue
    │
    └─ 有 tool_use（模型请求了工具）
        ├─ 执行工具，收集结果
        ├─ 检查 max_turns 限制 → 超限则 return
        ├─ 检查用户中断 → 中断则 return
        └─ 构建新状态 → continue（回到循环顶部）
```

### 关键恢复路径解读

#### 1. 模型降级（Fallback）

```typescript
// src/query.ts:893-953 — catch 块中的降级处理
catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true  // 内层 while 循环重试

    // 清理已产出的孤儿消息
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')
    assistantMessages.length = 0

    // 重建 StreamingToolExecutor
    streamingToolExecutor?.discard()
    streamingToolExecutor = new StreamingToolExecutor(...)

    // 思考签名是模型绑定的：将受保护的 thinking block 发给
    // 不支持的备用模型会导致 400 错误。降级前必须清除。
    messagesForQuery = stripSignatureBlocks(messagesForQuery)

    yield createSystemMessage(
      `Switched to ${fallbackModel} due to high demand for ${originalModel}`,
      'warning',
    )
    continue  // 重试内层 while 循环
  }
  throw innerError
}
```

降级处理中有一个容易忽略的细节：`stripSignatureBlocks`。Claude 的 extended thinking 功能会在 assistant 消息中包含加密签名的 thinking block。这些签名是**模型绑定**的——用模型 A 生成的签名发给模型 B 会导致 API 400 错误。降级时必须清除这些签名。

#### 2. max_output_tokens 恢复

当模型的输出被截断时（通常因为单次回复的 token 上限），系统会尝试让模型"续写"：

```typescript
// src/query.ts:164 — 恢复次数上限
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
```

恢复机制是：将截断的 assistant 消息保留在历史中，注入一条系统消息提示模型继续，然后 `continue` 回到循环顶部重新调用 API。模型会看到自己之前的（截断的）输出，并从断点继续。

为什么限制为 3 次？因为每次恢复都会增加上下文长度（之前的截断输出 + 新的续写），如果无限恢复，最终会触发 prompt-too-long。3 次是一个经验值——足够处理大多数截断场景，又不会导致上下文爆炸。

#### 3. 用户中断的清理

用户中断（按 ESC）时，可能有工具正在执行。必须确保每个 `tool_use` block 都有对应的 `tool_result` block，否则 API 会拒绝后续请求：

```typescript
// src/query.ts:1015-1052
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    // StreamingToolExecutor 会为中断的工具生成合成错误 tool_result
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) yield update.message
    }
  } else {
    // 手动为每个未完成的 tool_use 生成错误 tool_result
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Interrupted by user')
  }
  return { reason: 'aborted_streaming' }
}
```

`yieldMissingToolResultBlocks` 是一个防御性函数——它遍历所有 assistant 消息中的 `tool_use` block，为每个生成一个 `is_error: true` 的 `tool_result`。这确保了消息历史的**结构完整性**，即使在异常退出时也不会留下"悬空"的 tool_use。

### 设计决策讨论

**为什么用 `while(true)` + 多个 `return`/`continue` 而不是状态机？**

理论上，可以用一个显式的状态机（`switch(state)` + 状态转换表）来实现这些路径。但实际上，这些路径之间的共享逻辑太多——它们都需要访问 `assistantMessages`、`toolResults`、`toolUseContext` 等局部变量。状态机要么把这些变量提升为状态机的字段（增加复杂度），要么在每个状态转换时传递（增加样板代码）。

`while(true)` + `State` 对象是一个务实的折中：用数据对象管理跨迭代状态，用控制流（`return`/`continue`）表达终止/继续语义。代码虽然长（1700+ 行），但每个分支的意图是清晰的。

**为什么 `transition` 字段要区分不同的 continue 原因？**

```typescript
// 每个 continue 分支都会设置 transition
state = { ...state, transition: { type: 'tool_use' } }
state = { ...state, transition: { type: 'max_output_tokens_recovery' } }
state = { ...state, transition: { type: 'stop_hook_retry' } }
```

这不仅是为了测试（如 2.2 节所述），也是为了**遥测和调试**。当一个会话出现异常行为时，`transition` 序列可以告诉开发者循环走了哪些路径，帮助定位问题。

---

## 2.9 Stop Hooks 与循环后处理

### 面临的问题

当模型的回复中没有 `tool_use` block 时，通常意味着模型认为任务完成了。但"模型认为完成"不等于"真的完成"。用户可能配置了自动化检查（如 lint、测试），这些检查可能发现模型遗漏的问题。

**核心问题：如何在模型"说完了"之后，给外部检查一个介入的机会？**

### Stop Hooks 的角色

Stop Hooks 是用户可配置的 shell 命令，在模型每次"停下来"时自动执行。它们定义在 `settings.json` 中：

```json
{
  "hooks": {
    "Stop": [
      { "command": "npm run lint --quiet", "blocking": true },
      { "command": "npm test --run", "blocking": true }
    ]
  }
}
```

`handleStopHooks()`（`src/query/stopHooks.ts:65`）是 Stop Hooks 的执行入口。它本身也是一个 async generator，与 `queryLoop` 通过 `yield*` 无缝组合。

### 执行流程

```typescript
// src/query/stopHooks.ts:65-81 — 签名
export async function* handleStopHooks(
  messagesForQuery, assistantMessages, systemPrompt,
  userContext, systemContext, toolUseContext, querySource,
): AsyncGenerator<Message, StopHookResult>
```

Stop Hooks 的执行流程：

```
模型回复无 tool_use
    │
    ▼
handleStopHooks()
    │
    ├─ ① 保存 CacheSafeParams（用于 /btw 命令和 SDK 侧问题）
    │
    ├─ ② 模板任务分类（feature-gated: TEMPLATES）
    │     如果在 job 模式下，分类当前状态
    │
    ├─ ③ 后台 fire-and-forget 任务
    │     • Prompt Suggestion（提示建议）
    │     • Extract Memories（记忆提取）
    │     • Auto Dream（自动梦境）
    │
    ├─ ④ Computer Use 清理（feature-gated: CHICAGO_MCP）
    │
    ├─ ⑤ 执行用户配置的 Stop Hooks
    │     • 并行执行所有 hook 命令
    │     • 收集 blocking errors
    │     • 收集 preventContinuation 信号
    │     • 生成摘要消息
    │
    ├─ ⑥ 如果是 Teammate 模式
    │     • 执行 TeammateIdle hooks
    │     • 执行 TaskCompleted hooks
    │
    └─ 返回 { blockingErrors, preventContinuation }
```

### Stop Hooks 的三种结果

Stop Hooks 执行后有三种可能的结果，每种导致 `queryLoop` 的不同行为：

**1. 正常通过（无错误，不阻止继续）**

```
→ queryLoop 正常终止，return { reason: 'end_turn' }
```

**2. 有阻塞错误（blocking error）**

```typescript
// 某个 hook 返回了非零退出码且标记为 blocking
// queryLoop 将错误注入为 user 消息，让模型看到并修复
state = { ...state,
  messages: [...messages, ...assistantMessages, ...blockingErrors],
  transition: { type: 'stop_hook_retry' },
}
continue  // 回到循环顶部，模型会看到错误并尝试修复
```

这是 Stop Hooks 最强大的能力——**自动修复循环**。比如 lint hook 发现了一个错误，错误信息被注入到对话中，模型看到后会尝试修复，修复后再次触发 Stop Hooks 检查，直到通过或达到重试上限。

**3. 阻止继续（preventContinuation）**

```
→ hook 明确要求停止，queryLoop 立即终止
→ 不再给模型重试的机会
```

### 后台 fire-and-forget 任务

Stop Hooks 执行期间还会启动几个"fire-and-forget"的后台任务：

```typescript
// src/query/stopHooks.ts:136-157
if (!isBareMode()) {
  // 提示建议：分析对话，为下一轮提供建议
  void executePromptSuggestion(stopHookContext)

  // 记忆提取：从对话中提取值得记住的信息
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    void extractMemoriesModule.executeExtractMemories(stopHookContext, ...)
  }

  // 自动梦境：后台分析和优化
  if (!toolUseContext.agentId) {
    void executeAutoDream(stopHookContext, ...)
  }
}
```

注意 `void` 前缀——这些都是 fire-and-forget，不等待结果。它们利用模型"停下来"的间隙做后台工作，不影响用户感知的响应时间。

`isBareMode()` 检查确保在脚本模式（`claude -p "..."` 非交互调用）下跳过这些后台任务——脚本调用不需要提示建议或记忆提取，而且这些后台任务可能在进程退出时竞争资源。

### 设计决策讨论

**为什么 Stop Hooks 在 `queryLoop` 内部而不是外部？**

因为 Stop Hooks 的阻塞错误需要**重新进入循环**——将错误注入消息后让模型修复。如果 Stop Hooks 在循环外部，就需要一个外层循环来处理重试，增加了架构复杂度。

**为什么后台任务用 `void` 而不是 `await`？**

这些任务的结果对当前轮次没有影响。`await` 它们会增加用户感知的延迟（记忆提取可能需要几秒）。`void` 让它们在后台运行，主线程立即返回。

对于非交互模式（`-p` 参数），`print.ts` 中有专门的 `drainPendingExtraction` 逻辑，在输出响应后、进程退出前等待记忆提取完成——确保后台任务不会因进程退出而被截断。

---

## 2.10 QueryEngine：会话层编排

### 面临的问题

`query()` 解决了"单次查询的多轮工具执行"问题，但一个完整的对话会话还需要更多：

- **用户输入可能不需要调用 API**：`/help`、`/clear`、`/compact` 等斜杠命令是本地处理的
- **每次提交都需要构建 System Prompt**：而 prompt 的构建依赖当前的工具集、MCP 状态、权限模式等
- **会话状态需要跨多次提交持久化**：消息历史、用量统计、文件读取缓存
- **会话需要可恢复**：用户关闭终端后重新打开，应该能继续之前的对话
- **SDK 调用者需要标准化的输出格式**：内部的 `Message` 类型需要转换为 SDK 消费者能理解的格式

`QueryEngine`（`src/QueryEngine.ts:184`）就是解决这些问题的会话层控制器。

### 类结构

```typescript
// src/QueryEngine.ts:184-207
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]        // 跨轮次的消息历史
  private abortController: AbortController  // 会话级取消控制
  private permissionDenials: SDKPermissionDenial[]  // 权限拒绝记录
  private readFileState: ReadFileState       // 文件读取缓存
  private totalUsage: Usage                  // 累计 token 用量
  private discoveredSkillNames: Set<string>  // 已发现的 skill
  private loadedNestedMemoryPaths: Set<string>  // 已加载的记忆文件

  constructor(config: QueryEngineConfig) {
    this.mutableMessages = config.initialMessages ?? []  // 支持会话恢复
    this.abortController = config.abortController ?? new AbortController()
    // ...
  }
}
```

关键设计：`mutableMessages` 从 `config.initialMessages` 初始化。这意味着 `QueryEngine` 可以从一个已有的消息历史恢复——这是会话恢复（`/resume`）功能的基础。

### submitMessage：核心方法

`submitMessage()` 是 `QueryEngine` 的核心方法，也是一个 async generator。它的执行分为几个阶段：

```
submitMessage(prompt)
    │
    ├─ Phase A: 构建上下文
    │   • 包装 canUseTool（追踪权限拒绝）
    │   • 获取 System Prompt 各部分
    │   • 组装 userContext（CLAUDE.md + 日期）
    │   • 组装 systemContext（git 状态）
    │   • 构建 processUserInputContext
    │
    ├─ Phase B: 预处理用户输入
    │   • processUserInput() → 斜杠命令? 普通文本?
    │   • 追加消息到 mutableMessages
    │   • 持久化到 transcript
    │
    ├─ Phase C: 短路判断
    │   • shouldQuery = false? → 返回本地结果
    │   • 例如 /help, /clear 等不需要 API 调用
    │
    ├─ Phase D: 消费 query() 流
    │   • for await (const message of query({...}))
    │   • 每个消息：追加历史 + 持久化 + 规范化 + yield
    │   • 检查预算限制、结构化输出重试
    │
    └─ Phase E: 终止处理
        • 判断成功/失败
        • yield 最终 result 消息
```

### 权限拒绝追踪

```typescript
// src/QueryEngine.ts:243-271
const wrappedCanUseTool: CanUseToolFn = async (...args) => {
  const decision = await this.config.canUseTool(...args)
  if (decision.behavior === 'deny') {
    this.permissionDenials.push({
      tool: args[0].name,
      input: args[0].input,
      reason: decision.reason,
    })
  }
  return decision
}
```

`QueryEngine` 包装了 `canUseTool` 回调，在每次权限拒绝时记录。这些记录最终会出现在终止结果中，让 SDK 调用者知道哪些工具调用被用户拒绝了——这对 IDE 集成（如 VS Code 插件）的 UX 很重要。

### 消息规范化：内部格式 → SDK 格式

`query()` 产出的是内部 `Message` 类型（包含 `progress`、`attachment`、`stream_event` 等），SDK 调用者需要标准化的格式。`submitMessage` 在消费 `query()` 流时做转换：

```typescript
// src/QueryEngine.ts:761-828 — 消息类型分发（简化）
for await (const message of query({...})) {
  if (message.type === 'assistant') {
    // → 规范化为 SDK AssistantMessage
    yield normalizeMessage(message)
  }
  else if (message.type === 'progress') {
    // → 转换为 SDK ProgressMessage
    yield normalizeMessage(message)
  }
  else if (message.type === 'user') {
    // → 追加到 mutableMessages + 持久化
    this.mutableMessages.push(message)
  }
  else if (message.type === 'stream_event') {
    // → 更新用量统计 + 可选透传
    if (message.event === 'message_delta') {
      lastStopReason = message.data.stop_reason
      currentMessageUsage = message.data.usage
    }
  }
  // ... 其他类型
}
```

### 预算与重试限制

`QueryEngine` 在 `query()` 之上施加了额外的限制：

```typescript
// src/QueryEngine.ts:971-1002 — 预算检查
if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
  yield { type: 'result', subtype: 'error_max_budget_usd', ... }
  return
}

// src/QueryEngine.ts:1004-1047 — 结构化输出重试限制
if (jsonSchema && structuredOutputRetries > MAX_STRUCTURED_OUTPUT_RETRIES) {
  yield { type: 'result', subtype: 'error_max_structured_output_retries', ... }
  return
}
```

这些限制在 `query()` 层面不存在——`query()` 不知道预算或结构化输出。这是分层的好处：每一层只关心自己的职责。

### `ask()`：无状态便捷包装

```typescript
// src/QueryEngine.ts:1186-1295
export async function* ask(prompt, config): AsyncGenerator<SDKMessage> {
  const engine = new QueryEngine(config)
  yield* engine.submitMessage(prompt)
}
```

`ask()` 是一个无状态的便捷函数——创建一个临时的 `QueryEngine`，提交一条消息，返回结果。它适用于"一问一答"的场景（如子代理的单次查询），不需要维护跨轮次的会话状态。

### 设计决策讨论

**为什么 `QueryEngine` 是一个类而不是一组函数？**

因为它需要**跨多次 `submitMessage` 调用维护状态**。`mutableMessages`、`totalUsage`、`permissionDenials` 等都是会话级状态，需要在多次提交之间持久化。类是封装这种有状态行为的自然选择。

**为什么 `submitMessage` 也是 async generator 而不是返回 Promise？**

因为 SDK 调用者（如 VS Code 插件）需要**实时看到进展**。如果返回 Promise，调用者只能等到整个查询完成才能看到结果。async generator 让调用者可以逐条接收消息——模型开始输出时就能看到文本，工具开始执行时就能看到进度。

---

## 2.11 消息类型系统

### 面临的问题

对话循环中流转的"消息"不只是用户文本和模型回复。系统需要表达十几种不同语义的消息：工具执行进度、附件、流式事件、系统通知、压缩边界、墓碑（撤回）……

**核心问题：如何用一个统一的类型系统表达这些异构消息，同时保证类型安全？**

### 消息类型全景

从源码的 import 语句中可以还原出完整的消息类型体系（定义在 `src/types/message.ts`）：

```
Message（联合类型）
├── UserMessage              — 用户消息 / tool_result 载体
├── AssistantMessage         — 模型回复（含 tool_use blocks）
├── SystemMessage            — 系统通知（info/warning/error）
├── ProgressMessage          — 工具执行进度
├── AttachmentMessage        — 附件（memory、skill、MCP delta 等）
├── SystemCompactBoundaryMessage — 压缩边界标记
├── SystemLocalCommandMessage    — 本地命令结果
└── HookResultMessage        — Hook 执行结果

辅助类型（非 Message 联合成员，但在循环中流转）:
├── StreamEvent              — 流式事件（message_start/delta/stop）
├── RequestStartEvent        — API 请求开始信号
├── TombstoneMessage         — 墓碑（标记需要撤回的消息）
└── ToolUseSummaryMessage    — 工具使用摘要
```

### 关键类型的角色

**`UserMessage`** 是最"重载"的类型。它不仅承载用户的文本输入，还承载 `tool_result` block——这是 Claude API 的设计约束：工具结果必须包含在 `role: 'user'` 的消息中。所以当工具执行完成后，结果被包装为 `UserMessage`：

```typescript
// src/utils/messages.ts — 创建工具结果消息
createUserMessage({
  content: [{
    type: 'tool_result',
    content: fileContent,
    tool_use_id: block.id,
  }],
  toolUseResult: 'File read successfully',
  sourceToolAssistantUUID: assistantMessage.uuid,
})
```

**`AssistantMessage`** 除了模型的文本回复，还可能包含 `tool_use` block、`thinking` block、以及 API 错误信息（`apiError` 字段）。`apiError` 字段是"扣留"机制的关键——它标记了这条消息是一个可恢复的错误（如 `max_output_tokens`），而不是正常的模型输出。

**`TombstoneMessage`** 是流式降级的产物。当模型从主模型降级到备用模型时，已经 yield 给上层的部分 assistant 消息需要被"撤回"。Tombstone 消息通知上层：删除这条消息，它已经无效了。

**`StreamEvent`** 携带流式传输的元数据——`message_start`（开始）、`message_delta`（增量，含 usage 和 stop_reason）、`message_stop`（结束）。`QueryEngine` 通过这些事件追踪 token 用量和停止原因。

### 消息在循环中的流转

```
query() yields:
  AssistantMessage ──→ QueryEngine 追加到 mutableMessages + 规范化为 SDK 格式
  UserMessage ──────→ QueryEngine 追加到 mutableMessages + 持久化 transcript
  ProgressMessage ──→ QueryEngine 规范化为 SDK 进度消息
  AttachmentMessage → QueryEngine 追加到 mutableMessages（不直接展示）
  StreamEvent ──────→ QueryEngine 更新 usage 统计 + 可选透传
  TombstoneMessage ─→ QueryEngine 从 mutableMessages 中移除对应消息
  ToolUseSummary ───→ QueryEngine 追加到 mutableMessages（UI 展示用）
```

### 设计决策讨论

**为什么用联合类型而不是继承？**

TypeScript 的 discriminated union（通过 `type` 字段区分）比类继承更适合这个场景：

1. **穷尽性检查**：`switch(message.type)` 可以在编译期确保处理了所有类型
2. **序列化友好**：plain object 可以直接 JSON 序列化，不需要类实例化
3. **不可变性**：消息创建后不应该被修改（除了 tombstone 撤回），plain object 比类实例更容易保持不可变

**为什么 `tool_result` 放在 `UserMessage` 里而不是独立类型？**

这是 Claude API 的约束，不是 Claude Code 的设计选择。API 要求 `tool_result` 必须在 `role: 'user'` 的消息中。Claude Code 选择遵循这个约束而不是在内部用独立类型再在发送前转换——减少了一层映射，降低了出错概率。

---

## 本章总结

Claude Code 的核心对话循环是一个精心设计的两层架构：

**`QueryEngine`（会话层）** 负责"对话"的生命周期——用户输入预处理、System Prompt 构建、会话状态管理、输出格式规范化。它是面向外部调用者的稳定接口。

**`query()`/`queryLoop()`（执行层）** 负责"执行"的生命周期——API 调用、流式响应处理、工具调度、错误恢复、上下文压缩。它是面向模型 API 的执行引擎。

两层通过 async generator 协议连接，实现了流式、可中断、可恢复的对话引擎。

这个架构中最值得关注的工程决策包括：

1. **渐进式压缩**：从零成本的截断到高成本的模型摘要，按需逐级触发
2. **流式工具执行**：模型还在输出时就开始执行工具，将工具延迟隐藏在模型延迟中
3. **基于 `isConcurrencySafe` 的分区并发**：让工具自己声明并发安全性，框架负责调度
4. **可恢复错误的扣留**：不过早暴露错误给上层，给内部恢复机制留出空间
5. **熔断器模式**：生产数据驱动的防御性设计，防止失败的压缩尝试无限重试
6. **Prompt Cache 感知的分层注入**：静态指令在 system prompt 中缓存，动态内容通过 user 消息注入

这些决策的共同主题是：**在正确性的前提下，最大化性能和用户体验**。每一个优化都有明确的问题驱动（而不是"看起来可以优化"），每一个 trade-off 都有清晰的理由。
