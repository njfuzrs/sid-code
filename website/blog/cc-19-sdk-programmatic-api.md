---
title: Claude Code 源码解析（十九）· SDK 与编程接口
description: '不想用 CLI 交互，想把 Claude Code 嵌入自己的工具链？SDK 入口、非交互式会话、HTTP Server 模式如何满足编程式调用需求？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十九章：SDK 与编程接口（SDK & Programmatic API）

> 当 Claude Code 不再是一个人类敲键盘的 CLI，而是被另一个程序调用时，一切都变了。

## 核心问题

Claude Code 最初是为人类用户设计的交互式终端应用。但随着生态发展，一个不可避免的需求出现了：

**如何让其他程序像调用函数一样使用 Claude Code？**

这个需求来自多个方向：
1. **IDE 集成**：VS Code、JetBrains 等 IDE 需要在后台调用 Claude Code，不需要终端 UI
2. **CI/CD 管道**：自动化脚本需要批量执行代码审查、生成测试等任务
3. **Daemon 架构**：后台守护进程需要持续监听并响应事件，按需调用 Claude
4. **远程控制**：claude.ai 网页端需要远程驱动一个 Claude Code 实例
5. **第三方 SDK**：Python、Go 等语言的 SDK 需要通过子进程协议与 Claude Code 通信

这些场景的共同特征是：**没有人类坐在终端前**。这意味着：
- 不能弹出权限确认对话框等待用户点击
- 不能渲染 React/Ink 终端 UI
- 输出必须是机器可解析的结构化数据，而非人类可读的彩色文本
- 需要一个明确的"完成"信号，而非开放式的 REPL 循环

**核心矛盾：Claude Code 的整个架构是围绕交互式 REPL 构建的，如何在不重写核心引擎的前提下，提供一个干净的编程接口？**

Claude Code 的解法是一个**三层 SDK 架构**——类型定义层、会话引擎层、协议传输层——它们共同将交互式 CLI 转化为可编程的 Agent 运行时。

---

## 19.1 架构总览

```
外部调用者（Python SDK / IDE / Daemon / CI 脚本）
         │
         │  子进程 spawn + NDJSON stdin/stdout
         │  或 WebSocket / SSE 远程连接
         ▼
┌─────────────────────────────────────────────────────────┐
│  传输层（Transport Layer）                                │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ StructuredIO  │  │ RemoteIO │  │ DirectConnect     │ │
│  │ (stdin/stdout)│  │ (WS/SSE) │  │ SessionManager    │ │
│  └──────┬───────┘  └────┬─────┘  └────────┬──────────┘ │
│         │               │                  │             │
│         └───────────────┼──────────────────┘             │
│                         │                                │
│  ┌──────────────────────▼──────────────────────────────┐│
│  │  控制协议（Control Protocol）                         ││
│  │  NDJSON 行分隔 JSON 消息                              ││
│  │  • SDKUserMessage / SDKAssistantMessage              ││
│  │  • SDKControlRequest / SDKControlResponse            ││
│  │  • SDKResultMessage（终止信号）                        ││
│  └──────────────────────┬──────────────────────────────┘│
│                         │                                │
└─────────────────────────┼────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────┐
│  会话引擎层（Session Engine Layer）                        │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  cli/print.ts — runHeadless()                     │   │
│  │  非交互式运行时编排器                               │   │
│  │  • 命令队列管理                                    │   │
│  │  • 多轮对话循环                                    │   │
│  │  • Bridge/远程集成                                 │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │  QueryEngine — submitMessage()                    │   │
│  │  无头会话引擎                                      │   │
│  │  • 会话状态管理（消息、缓存、用量）                  │   │
│  │  • System Prompt 构建                             │   │
│  │  • SDK 消息协议转换                                │   │
│  │  • 权限拒绝追踪                                    │   │
│  │  • 结构化输出验证                                  │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │  query() — 核心 Agent 循环                        │   │
│  │  （交互式 REPL 和 SDK 共享同一引擎）                │   │
│  │  • 模型流式调用                                    │   │
│  │  • 工具执行与结果回传                               │   │
│  │  • 上下文压缩与恢复                                │   │
│  │  • Stop Hooks 与终止判定                           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────┐
│  类型定义层（Type Definition Layer）                       │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  entrypoints/agentSdkTypes.ts  — 公共 API 函数签名       │
│  entrypoints/sdk/coreSchemas.ts — Zod Schema（真理源）   │
│  entrypoints/sdk/coreTypes.ts  — 生成的 TypeScript 类型  │
│  entrypoints/sdk/controlSchemas.ts — 控制协议 Schema     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

这个架构的关键洞察是：**SDK 不是一个独立的系统，而是交互式 CLI 的一个"投影"。** 核心引擎 `query()` 被交互式 REPL 和 SDK 共享，差异仅在于外层的状态管理和 I/O 协议。这避免了维护两套引擎的负担，同时确保 SDK 用户获得与交互式用户完全一致的 Agent 能力。

---

## 19.2 类型定义层：Schema-First 的 API 契约

### 面临的问题

SDK 的第一个挑战不是"怎么运行"，而是"怎么定义接口"。Claude Code 的 SDK 需要被多种语言的客户端消费——TypeScript/JavaScript 原生使用、Python SDK 通过子进程协议通信、IDE 插件通过 WebSocket 交互。这些客户端需要：

1. **类型安全**：TypeScript 用户需要完整的类型定义
2. **运行时校验**：跨进程通信的 JSON 消息需要在边界处校验
3. **多语言兼容**：Python SDK 需要从同一份定义生成自己的类型
4. **版本演进**：API 需要能向后兼容地添加新字段

**核心矛盾：TypeScript 类型只存在于编译期，无法做运行时校验；手写 JSON Schema 又容易与 TypeScript 类型不同步。**

### 解法：Zod Schema 作为单一真理源

Claude Code 采用了 **Schema-First** 的设计——所有 SDK 类型都从 Zod Schema 生成：

```
entrypoints/sdk/coreSchemas.ts     ← 手写 Zod Schema（真理源）
         │
         │  bun scripts/generate-sdk-types.ts
         ▼
entrypoints/sdk/coreTypes.generated.ts  ← 自动生成的 TypeScript 类型
         │
         │  re-export
         ▼
entrypoints/agentSdkTypes.ts       ← 公共 API 入口
```

```typescript
// entrypoints/sdk/coreSchemas.ts — 真理源

// 每个 Schema 都用 lazySchema() 包装，避免模块求值时的循环依赖
export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.boolean(),
    num_turns: z.number(),
    result: z.string(),
    stop_reason: z.string().nullable(),
    total_cost_usd: z.number(),
    usage: NonNullableUsagePlaceholder(),
    modelUsage: z.record(z.string(), ModelUsageSchema()),
    permission_denials: z.array(SDKPermissionDenialSchema()),
    structured_output: z.unknown().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)
```

### SDK 消息类型全景

`coreSchemas.ts` 定义了 **20+ 种 SDK 消息类型**，它们构成了 SDK 的完整输出协议：

| 消息类型 | Schema | 用途 |
|---------|--------|------|
| `user` | `SDKUserMessageSchema` | 用户输入消息 |
| `assistant` | `SDKAssistantMessageSchema` | 模型完整响应 |
| `stream_event` | `SDKPartialAssistantMessageSchema` | 流式响应增量 |
| `result` (success) | `SDKResultSuccessSchema` | 成功终止信号 |
| `result` (error) | `SDKResultErrorSchema` | 错误终止信号 |
| `system/init` | `SDKSystemMessageSchema` | 会话初始化元数据 |
| `system/compact_boundary` | `SDKCompactBoundaryMessageSchema` | 上下文压缩边界 |
| `system/status` | `SDKStatusMessageSchema` | 状态变更通知 |
| `system/api_retry` | `SDKAPIRetryMessageSchema` | API 重试通知 |
| `system/hook_*` | `SDKHookStarted/Progress/Response` | Hook 生命周期事件 |
| `system/task_*` | `SDKTaskStarted/Progress/Notification` | 后台任务事件 |
| `system/session_state_changed` | `SDKSessionStateChangedMessageSchema` | 会话状态变更 |
| `tool_progress` | `SDKToolProgressMessageSchema` | 工具执行进度 |
| `tool_use_summary` | `SDKToolUseSummaryMessageSchema` | 工具调用摘要 |
| `rate_limit_event` | `SDKRateLimitEventSchema` | 速率限制事件 |

其中最关键的是 `result` 消息——它是 SDK 调用的**终止信号**。每次 `query()` 调用最终都会产出一个 `result`，告诉调用者"这轮对话结束了"：

```typescript
// 成功结果
export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    result: z.string(),           // 最终文本输出
    total_cost_usd: z.number(),   // 总花费
    num_turns: z.number(),        // Agent 循环轮数
    permission_denials: z.array(SDKPermissionDenialSchema()), // 被拒绝的权限
    structured_output: z.unknown().optional(), // 结构化输出（JSON Schema 模式）
    // ...
  }),
)

// 错误结果——注意 subtype 的四种错误类型
export const SDKResultErrorSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.enum([
      'error_during_execution',              // 执行中出错
      'error_max_turns',                     // 达到最大轮数
      'error_max_budget_usd',                // 达到预算上限
      'error_max_structured_output_retries', // 结构化输出重试耗尽
    ]),
    errors: z.array(z.string()),
    // ...
  }),
)
```

### 控制协议：SDK 与 CLI 的双向通信

除了数据消息，SDK 还需要一个**控制通道**来管理会话。这由 `controlSchemas.ts` 定义：

```typescript
// 控制请求——从 SDK 宿主发往 CLI 进程
export const SDKControlRequestInnerSchema = lazySchema(() =>
  z.union([
    SDKControlInitializeRequestSchema(),      // 初始化会话
    SDKControlInterruptRequestSchema(),       // 中断当前执行
    SDKControlPermissionRequestSchema(),      // 权限请求（CLI → SDK 宿主）
    SDKControlSetPermissionModeRequestSchema(), // 设置权限模式
    SDKControlSetModelRequestSchema(),        // 切换模型
    SDKControlMcpStatusRequestSchema(),       // 查询 MCP 状态
    SDKControlMcpSetServersRequestSchema(),   // 动态管理 MCP 服务器
    SDKControlRewindFilesRequestSchema(),     // 回滚文件变更
    SDKControlGetContextUsageRequestSchema(), // 查询上下文用量
    SDKControlGetSettingsRequestSchema(),     // 查询设置
    SDKControlApplyFlagSettingsRequestSchema(), // 应用设置
    SDKControlElicitationRequestSchema(),     // MCP 用户输入请求
    SDKHookCallbackRequestSchema(),           // Hook 回调
    // ... 更多控制命令
  ]),
)
```

控制协议的消息格式是**请求-响应**模式，每个请求有唯一的 `request_id`：

```typescript
// 请求包装
export const SDKControlRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: SDKControlRequestInnerSchema(),
  }),
)

// 响应包装——成功或错误
export const SDKControlResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_response'),
    response: z.union([
      ControlResponseSchema(),      // { subtype: 'success', request_id, response? }
      ControlErrorResponseSchema(), // { subtype: 'error', request_id, error }
    ]),
  }),
)
```

### 公共 API 函数签名

`agentSdkTypes.ts` 是 SDK 的公共入口，它定义了所有可调用的函数签名：

```typescript
// 核心查询函数——支持字符串或流式输入
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query {
  throw new Error('query is not implemented in the SDK')
}

// V2 会话 API（alpha 阶段）
export function unstable_v2_createSession(_options: SDKSessionOptions): SDKSession
export function unstable_v2_resumeSession(_sessionId: string, _options: SDKSessionOptions): SDKSession
export function unstable_v2_prompt(_message: string, _options: SDKSessionOptions): Promise<SDKResultMessage>

// 会话管理
export async function getSessionMessages(_sessionId: string, _options?): Promise<SessionMessage[]>
export async function listSessions(_options?): Promise<SDKSessionInfo[]>
export async function forkSession(_sessionId: string, _options?): Promise<ForkSessionResult>

// 自定义工具
export function tool<Schema>(_name, _description, _inputSchema, _handler): SdkMcpToolDefinition<Schema>
export function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance

// 远程控制（内部 API）
export async function connectRemoteControl(_opts: ConnectRemoteControlOptions): Promise<RemoteControlHandle | null>
```

**一个关键的设计细节**：所有函数体都是 `throw new Error('not implemented')`。这不是未完成的代码——这是一个**占位模式**。`agentSdkTypes.ts` 只定义类型签名，实际实现在构建时被替换。这样做的好处是：

1. TypeScript 编译器可以检查类型签名的正确性
2. 如果有人错误地直接 import 这个文件（而非通过构建后的 SDK 包），会得到明确的错误信息
3. 类型定义和实现可以独立演进

### 设计决策讨论

**为什么用 Zod 而不是直接写 TypeScript 类型 + JSON Schema？**

Zod 同时解决了三个问题：
- **TypeScript 类型**：通过 `z.infer<typeof Schema>` 自动推导
- **运行时校验**：`Schema.safeParse(data)` 在进程边界校验消息
- **文档化**：`.describe()` 方法为每个字段添加描述

如果用 TypeScript 类型 + 手写 JSON Schema，需要维护两份定义并保持同步。Zod 消除了这个同步负担。

**为什么 Schema 用 `lazySchema()` 包装？**

```typescript
export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({ ... })
)
```

`lazySchema()` 延迟 Schema 的构造到首次使用时。这解决了两个问题：
1. **循环引用**：Schema 之间可能互相引用（如 `SDKMessageSchema` 引用 `SDKResultMessageSchema`，后者又引用 `SDKPermissionDenialSchema`）
2. **启动性能**：如果 SDK 类型文件被 import 但 Schema 未被使用（比如只用了类型），不会付出构造 Schema 的代价

**为什么 V2 API 标记为 `@alpha` / `unstable_`？**

这是一个**API 稳定性信号**。`query()` 是 V1 API，已经稳定；`unstable_v2_createSession()` 等是正在演进的 V2 API，接口可能变化。通过命名约定（`unstable_` 前缀）而非版本号来标记，让调用者在代码中就能看到稳定性承诺。

---

## 19.3 QueryEngine：无头会话引擎

### 面临的问题

交互式 REPL 的对话循环由 React 组件树驱动——`screens/REPL.tsx` 通过 React Hooks 管理消息状态、权限弹窗、UI 渲染。但 SDK 模式没有 React 运行时，也没有终端 UI。

**问题是：如何在没有 React/Ink 的情况下，复用 `query()` 核心引擎的全部能力？**

这不是简单地"去掉 UI"。交互式模式下，消息状态由 `AppState`（React 状态树）管理，权限检查通过 UI 弹窗完成，工具进度通过 Spinner 组件展示。SDK 模式需要替代所有这些交互点。

### 解法：QueryEngine 类——交互式 REPL 的无头替身

`QueryEngine` 是一个独立的类，它在没有 React 的环境中提供与 REPL 等价的会话管理能力：

```typescript
// src/QueryEngine.ts

export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]        // 本地消息存储（替代 AppState）
  private abortController: AbortController  // 中断控制
  private permissionDenials: SDKPermissionDenial[] // 权限拒绝追踪
  private totalUsage: NonNullableUsage      // 累计用量
  private readFileState: FileStateCache     // 文件读取缓存
  private discoveredSkillNames = new Set<string>()

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // ... 完整的会话轮次处理
  }

  interrupt(): void { this.abortController.abort() }
  getMessages(): readonly Message[] { return this.mutableMessages }
  setModel(model: string): void { ... }
}
```

### 交互式 REPL vs QueryEngine：关键差异

理解 QueryEngine 的最好方式是将它与交互式 REPL 对比：

```
                    交互式 REPL                    QueryEngine (SDK)
                    ───────────                    ─────────────────
消息状态所有者       AppState (React 状态树)         mutableMessages (本地数组)
权限处理            UI 弹窗 → 用户点击              canUseTool 回调 → 控制协议
工具进度            Spinner 组件渲染                 setInProgressToolUseIDs: () => {}
UI 渲染             React/Ink 终端 UI               无（纯数据流）
输出格式            彩色终端文本                     SDKMessage NDJSON 流
会话持久化          即时写入 + UI 滚动缓冲           fire-and-forget (bare) 或 await
上下文压缩后        保留完整历史供 UI 回滚           截断释放内存
querySource         'repl_main_thread'              'sdk'
isNonInteractive    false                           true
```

源码中有一段注释精确地描述了这个差异：

```typescript
// SDK-only: the REPL keeps full history for UI scrollback and projects
// on demand via projectSnippedView; QueryEngine truncates here to bound
// memory in long headless sessions (no UI to preserve).
```

### submitMessage() 的完整生命周期

`submitMessage()` 是 QueryEngine 的核心方法，它编排了一个完整的对话轮次：

```
submitMessage(prompt)
    │
    ├─ ① 初始化工作状态
    │   setCwd(cwd)
    │   构建 wrappedCanUseTool（追踪权限拒绝）
    │
    ├─ ② 构建 System Prompt
    │   fetchSystemPromptParts(tools, model, mcpClients, ...)
    │   合并: defaultSystemPrompt + memoryMechanicsPrompt + appendSystemPrompt
    │
    ├─ ③ 构建 ProcessUserInputContext
    │   关键设置: isNonInteractiveSession: true
    │   setMessages: fn => { this.mutableMessages = fn(this.mutableMessages) }
    │   setInProgressToolUseIDs: () => {}  // 无 UI，不需要进度指示
    │   setResponseLength: () => {}        // 无 UI，不需要长度追踪
    │
    ├─ ④ 处理孤儿权限（仅首次）
    │   handleOrphanedPermission(orphanedPermission, ...)
    │
    ├─ ⑤ 处理用户输入
    │   processUserInput({ input: prompt, mode: 'prompt', querySource: 'sdk' })
    │   → 解析斜杠命令、附件、元数据
    │   → 返回 { messages, shouldQuery, allowedTools, model }
    │
    ├─ ⑥ 持久化用户消息（防止进程崩溃丢失会话）
    │   if (bare) void recordTranscript(...)  // fire-and-forget
    │   else await recordTranscript(...)       // 阻塞等待
    │
    ├─ ⑦ yield buildSystemInitMessage(...)  // SDK 初始化元数据
    │
    ├─ ⑧ 如果不需要查询（纯斜杠命令）
    │   yield 本地命令输出 → yield result(success) → return
    │
    ├─ ⑨ 进入 query() 核心循环
    │   for await (const message of query({
    │     messages, systemPrompt, canUseTool: wrappedCanUseTool,
    │     querySource: 'sdk', maxTurns, taskBudget, ...
    │   })) {
    │     // 消息类型分发与 SDK 协议转换
    │   }
    │
    ├─ ⑩ 终止判定与结果合成
    │   isResultSuccessful(result, lastStopReason)
    │   → yield result(success) 或 result(error_during_execution)
    │
    └─ 终止条件检查（在循环内）
        • max_turns_reached → yield result(error_max_turns)
        • max_budget_usd → yield result(error_max_budget_usd)
        • structured_output_retries → yield result(error_max_structured_output_retries)
```

### 消息类型转换：内部消息 → SDK 消息

QueryEngine 的一个核心职责是将 `query()` 产出的内部消息类型转换为 SDK 消息协议。这个转换发生在 `for await` 循环的 `switch` 语句中：

```typescript
for await (const message of query({ ... })) {
  switch (message.type) {
    case 'assistant':
      // 记录 stop_reason，推入 mutableMessages，yield 标准化消息
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break

    case 'stream_event':
      // 累计 token 用量（message_start/delta/stop）
      // 仅在 includePartialMessages 时 yield 给调用者
      if (message.event.type === 'message_stop') {
        this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
      }
      if (includePartialMessages) {
        yield { type: 'stream_event', event: message.event, ... }
      }
      break

    case 'attachment':
      // 提取结构化输出、处理 max_turns_reached 信号
      if (message.attachment.type === 'structured_output') {
        structuredOutputFromTool = message.attachment.data
      } else if (message.attachment.type === 'max_turns_reached') {
        yield { type: 'result', subtype: 'error_max_turns', ... }
        return
      }
      break

    case 'system':
      // 上下文压缩边界 → 截断旧消息释放内存
      if (message.subtype === 'compact_boundary') {
        this.mutableMessages.splice(0, mutableBoundaryIdx)  // 释放 GC
        yield { type: 'system', subtype: 'compact_boundary', ... }
      }
      // API 重试通知
      if (message.subtype === 'api_error') {
        yield { type: 'system', subtype: 'api_retry', ... }
      }
      break

    case 'tombstone':
      break  // 控制信号，不转发

    case 'stream_request_start':
      break  // 内部信号，不转发
  }
}
```

### ask()：一次性便捷包装

`ask()` 是 `QueryEngine` 的便捷包装函数，用于一次性查询场景：

```typescript
// src/QueryEngine.ts

/**
 * Sends a single prompt to the Claude API and returns the response.
 * Assumes that claude is being used non-interactively -- will not
 * ask the user for permissions or further input.
 *
 * Convenience wrapper around QueryEngine for one-shot usage.
 */
export async function* ask({ ... }): AsyncGenerator<SDKMessage> {
  // 1. 克隆文件读取缓存（避免污染调用者的缓存）
  const readFileCache = cloneFileStateCache(getReadFileCache())

  // 2. 创建 QueryEngine 实例
  const engine = new QueryEngine({
    cwd, tools, commands, mcpClients, agents,
    canUseTool, getAppState, setAppState,
    initialMessages: mutableMessages,
    readFileCache,
    // ... 其他配置
  })

  try {
    // 3. 执行查询并转发所有消息
    yield* engine.submitMessage(prompt, { uuid: promptUuid, isMeta })
  } finally {
    // 4. 写回更新后的文件缓存
    setReadFileCache(engine.getReadFileState())
  }
}
```

`ask()` 和 `QueryEngine` 的关系是：
- **`ask()`**：一次性使用，每次调用创建新引擎，适合 `-p` 模式的单次查询
- **`QueryEngine`**：多轮复用，状态跨轮次持久化，适合 V2 Session API 的持久会话

### 设计决策讨论

**为什么 QueryEngine 不直接使用 AppState？**

交互式 REPL 中，`AppState` 是 React 状态树的一部分，通过 `useState` / `useReducer` 管理。SDK 模式没有 React 运行时，无法使用这些 Hook。

但 QueryEngine 并没有完全绕过 AppState——它接收 `getAppState` 和 `setAppState` 回调，让调用者决定如何管理状态。在 `cli/print.ts` 中，这些回调指向一个简单的内存对象；在未来的 REPL 集成中，它们可以指向 React 状态。

这是一个**依赖反转**设计——QueryEngine 不依赖具体的状态管理实现，而是通过回调接口抽象。

**为什么消息状态用 `mutableMessages` 而不是不可变数组？**

源码注释解释了这个决策：

```typescript
// Slash commands that mutate the message array (e.g. /force-snip)
// call setMessages(fn). In interactive mode this writes back to
// AppState; in print mode we write back to mutableMessages so the
// rest of the query loop sees the result.
```

斜杠命令（如 `/compact`、`/force-snip`）需要直接修改消息数组。在 React 中这通过 `setState` 实现不可变更新；在 SDK 模式中，直接修改可变数组更简单高效。

**为什么上下文压缩后要截断 mutableMessages？**

```typescript
// Release pre-compaction messages for GC. The boundary was just
// pushed so it's the last element. query.ts already uses
// getMessagesAfterCompactBoundary() internally, so only
// post-boundary messages are needed going forward.
const mutableBoundaryIdx = this.mutableMessages.length - 1
if (mutableBoundaryIdx > 0) {
  this.mutableMessages.splice(0, mutableBoundaryIdx)
}
```

这是 SDK 模式特有的内存优化。交互式 REPL 保留完整历史供用户滚动查看；SDK 模式没有 UI，压缩前的消息不再需要。在长时间运行的 Agent 会话中（可能数百轮），不截断会导致内存无限增长。

**为什么 `--bare` 模式下 transcript 写入是 fire-and-forget？**

```typescript
if (isBareMode()) {
  void transcriptPromise  // fire-and-forget
} else {
  await transcriptPromise  // 阻塞等待
}
```

`--bare` 是为脚本化调用优化的模式。脚本通常不需要 `--resume` 恢复会话，所以 transcript 写入不需要阻塞关键路径。注释量化了这个优化的价值：

> The await is ~4ms on SSD, ~30ms under disk contention — the single largest controllable critical-path cost after module eval.

4-30ms 看似微小，但对于高频调用的 CI 场景，累积效果显著。

---

## 19.4 传输层：StructuredIO 与控制协议

### 面临的问题

QueryEngine 解决了"如何在无头环境中运行 Agent 循环"的问题，但还有一个更底层的问题：

**SDK 宿主（Python SDK、IDE 插件、远程服务器）如何与 Claude Code CLI 进程通信？**

这个通信不是简单的"发送请求、接收响应"。它需要支持：
1. **双向流式通信**：模型响应是流式的，工具执行进度需要实时上报
2. **控制通道**：权限请求需要从 CLI 发往宿主，宿主决策后返回
3. **多种传输介质**：本地 stdin/stdout、WebSocket、SSE、HTTP POST
4. **断线重连**：远程场景下网络不稳定，需要消息重放
5. **消息去重**：重连后可能收到重复消息，需要幂等处理

### 解法：StructuredIO——统一的协议大脑

`StructuredIO` 是所有 SDK 通信的协议核心。无论底层传输是 stdin/stdout 还是 WebSocket，消息都经过 StructuredIO 的统一处理：

```
SDK 宿主（Python SDK / IDE / 远程服务器）
    │                          ▲
    │ stdin (NDJSON)           │ stdout (NDJSON)
    ▼                          │
┌──────────────────────────────────────────────┐
│  StructuredIO                                 │
│  ─────────────────────────────────────────── │
│                                               │
│  输入处理:                                     │
│  ├─ NDJSON 行分隔解析                          │
│  ├─ 消息类型分发:                              │
│  │   ├─ user → yield 给 print.ts 主循环       │
│  │   ├─ control_response → 解析 pending 请求   │
│  │   ├─ keep_alive → 静默忽略                  │
│  │   ├─ update_environment_variables → 应用    │
│  │   └─ control_request → yield 给主循环       │
│  └─ 重复响应检测 (resolvedToolUseIds)          │
│                                               │
│  输出处理:                                     │
│  ├─ write(StdoutMessage) → NDJSON 序列化       │
│  └─ outbound Stream → 有序写入                 │
│                                               │
│  控制通道:                                     │
│  ├─ sendRequest<T>(request, schema, signal)   │
│  │   → 发送 control_request                    │
│  │   → 等待匹配的 control_response             │
│  │   → Zod schema 校验响应                     │
│  ├─ createCanUseTool() → 权限检查函数          │
│  ├─ createHookCallback() → Hook 回调函数       │
│  ├─ handleElicitation() → MCP 用户输入请求     │
│  └─ sendMcpMessage() → MCP JSON-RPC 转发      │
│                                               │
└──────────────────────────────────────────────┘
```

### NDJSON 协议格式

SDK 协议使用 **NDJSON（Newline-Delimited JSON）** 格式——每行一个完整的 JSON 对象：

```
→ stdin（宿主 → CLI）:
{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"..."}
{"type":"control_response","response":{"subtype":"success",
  "request_id":"abc","response":{"behavior":"allow"}}}

← stdout（CLI → 宿主）:
{"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"..."}
{"type":"assistant","message":{"role":"assistant",
  "content":[{"type":"text","text":"Hi!"}]},...}
{"type":"control_request","request_id":"abc","request":{
  "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},...}}
{"type":"result","subtype":"success","result":"Hi!","total_cost_usd":0.001,...}
```

为什么选择 NDJSON 而非其他协议（如 gRPC、MessagePack）？

1. **人类可读**：调试时可以直接 `cat` 管道查看消息
2. **语言无关**：任何语言都有 JSON 解析器，不需要额外的 protobuf/thrift 编译
3. **流式友好**：每行独立解析，不需要长度前缀或分隔符协议
4. **管道兼容**：Unix 管道天然以换行符分隔，NDJSON 与 shell 管道完美配合

一个微妙的细节——`ndjsonSafeStringify` 会转义 Unicode 行分隔符：

```typescript
// src/cli/ndjsonSafeStringify.ts
// U+2028 (Line Separator) 和 U+2029 (Paragraph Separator) 在 JSON 中合法，
// 但会破坏 NDJSON 的行分隔假设。必须转义。
export function ndjsonSafeStringify(obj: unknown): string {
  return jsonStringify(obj)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
```

### 权限请求的控制流：SDK 模式下最复杂的交互

在交互式 REPL 中，权限检查通过 UI 弹窗完成——用户看到对话框，点击"允许"或"拒绝"。在 SDK 模式中，这个交互通过控制协议实现：

```
CLI 进程                                    SDK 宿主
    │                                          │
    │  query() 执行中，模型请求调用 Bash 工具     │
    │                                          │
    │  hasPermissionsToUseTool() → 需要询问      │
    │                                          │
    │  ┌─ 并行启动 ─────────────────────────┐   │
    │  │                                    │   │
    │  │  ① Hook 评估                       │   │
    │  │  executePermissionRequestHooks()   │   │
    │  │                                    │   │
    │  │  ② SDK 权限请求                    │   │
    │  │  sendRequest({                     │   │
    │  │    subtype: 'can_use_tool',        │   │
    │  │    tool_name: 'Bash',             │   │
    │  │    input: { command: 'ls' },      │──→│  收到 control_request
    │  │    tool_use_id: 'xyz',            │   │  显示权限对话框
    │  │  })                               │   │  用户点击"允许"
    │  │                                    │   │
    │  └────────────────────────────────────┘   │
    │                                          │
    │  Promise.race([hookPromise, sdkPromise]) │
    │                                          │
    │←─────────────────────────────────────────│  发送 control_response
    │  { behavior: 'allow', toolUseID: 'xyz' } │
    │                                          │
    │  工具执行继续...                           │
```

源码中这个竞争逻辑非常精妙：

```typescript
// src/cli/structuredIO.ts — createCanUseTool()

// Race: hook completion vs SDK prompt response.
const winner = await Promise.race([hookPromise, sdkPromise])

if (winner.source === 'hook') {
  if (winner.decision) {
    // Hook 先决定 → 取消 SDK 请求
    sdkPromise.catch(() => {})  // 抑制 AbortError
    hookAbortController.abort()
    return winner.decision
  }
  // Hook 放弃决定 → 等待 SDK 宿主响应
  const sdkResult = await sdkPromise
  return permissionPromptToolResultToPermissionDecision(sdkResult.result, ...)
}

// SDK 宿主先响应 → 使用其结果（Hook 仍在后台运行但结果被忽略）
return permissionPromptToolResultToPermissionDecision(winner.result, ...)
```

这个设计解决了一个实际问题：Hook（如 `PreToolUse` 钩子）和 SDK 宿主的权限对话框是**并行**的。在交互式 CLI 中，Hook 和 UI 弹窗也是并行的——用户可能在 Hook 还在运行时就点击了"允许"。SDK 模式复制了这个行为，确保两种模式的语义一致。

### 重复响应防护

远程场景下（WebSocket 断线重连），同一个 `control_response` 可能被投递多次。StructuredIO 通过 `resolvedToolUseIds` 集合防止重复处理：

```typescript
// 最多追踪 1000 个已解决的 tool_use ID
const MAX_RESOLVED_TOOL_USE_IDS = 1000

private readonly resolvedToolUseIds = new Set<string>()

private trackResolvedToolUseId(request: SDKControlRequest): void {
  if (request.request.subtype === 'can_use_tool') {
    this.resolvedToolUseIds.add(request.request.tool_use_id)
    if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
      // 淘汰最旧的条目（Set 按插入顺序迭代）
      const first = this.resolvedToolUseIds.values().next().value
      if (first !== undefined) {
        this.resolvedToolUseIds.delete(first)
      }
    }
  }
}
```

注释解释了为什么这很重要：

> Duplicate control_response deliveries (e.g. from WebSocket reconnects) arrive after the original was handled, and re-processing them would push duplicate assistant messages into the conversation, causing API 400 errors.

如果不做去重，重复的权限响应会导致重复的 assistant 消息被推入对话，Anthropic API 会返回 400 错误（"tool_use ids must be unique"）。

### RemoteIO：远程传输扩展

`RemoteIO` 继承 `StructuredIO`，将协议层绑定到远程传输（WebSocket/SSE）：

```typescript
// src/cli/remoteIO.ts

export class RemoteIO extends StructuredIO {
  private transport: Transport
  private inputStream: PassThrough
  private ccrClient: CCRClient | null = null

  constructor(streamUrl: string, ...) {
    const inputStream = new PassThrough({ encoding: 'utf8' })
    super(inputStream, ...)  // StructuredIO 从 inputStream 读取

    // 根据 URL 和环境变量选择传输方式
    this.transport = getTransportForUrl(this.url, headers, sessionId, ...)

    // 传输层数据 → 写入 inputStream → StructuredIO 解析
    this.transport.setOnData((data: string) => {
      this.inputStream.write(data)
    })

    // 连接关闭 → 结束输入流 → 触发优雅关闭
    this.transport.setOnClose(() => {
      this.inputStream.end()
    })
  }
}
```

传输选择策略：

```
getTransportForUrl(url, headers, sessionId)
    │
    ├─ CLAUDE_CODE_USE_CCR_V2=true
    │   └─ SSETransport（读：SSE 事件流，写：HTTP POST）
    │
    ├─ SESSION_INGRESS_POST_V2=true
    │   └─ HybridTransport（读：WebSocket，写：HTTP POST 批量）
    │
    └─ 默认
        └─ WebSocketTransport（读写均通过 WebSocket）
```

### CCR v2：云端代码运行时的传输协议

当 Claude Code 作为云端 Worker 运行时（CCR = Cloud Code Runtime），使用更复杂的 CCR v2 协议：

```typescript
// RemoteIO 中的 CCR v2 初始化
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
  this.ccrClient = new CCRClient(this.transport, this.url)

  // 注册内部事件写入器（transcript 持久化）
  setInternalEventWriter((eventType, payload, options) =>
    this.ccrClient!.writeInternalEvent(eventType, payload, options),
  )

  // 注册内部事件读取器（会话恢复）
  setInternalEventReader(
    () => this.ccrClient!.readInternalEvents(),
    () => this.ccrClient!.readSubagentInternalEvents(),
  )

  // 生命周期状态上报
  setCommandLifecycleListener((uuid, state) => {
    this.ccrClient?.reportDelivery(uuid, LIFECYCLE_TO_DELIVERY[state])
  })
  setSessionStateChangedListener((state, details) => {
    this.ccrClient?.reportState(state, details)
  })
}
```

CCR v2 的 API 端点：

| 端点 | 方法 | 用途 |
|------|------|------|
| `{sessionUrl}/worker` | PUT | 注册 Worker |
| `{sessionUrl}/worker/heartbeat` | POST | 心跳保活 |
| `{sessionUrl}/worker/events` | POST | 上传客户端可见事件 |
| `{sessionUrl}/worker/internal-events` | POST | 上传内部事件（transcript） |
| `{sessionUrl}/worker/events/delivery` | POST | 上报消息投递状态 |
| `{sessionUrl}/worker/events/stream` | GET (SSE) | 读取客户端事件流 |
| `{sessionUrl}/worker` | GET | 恢复 Worker 状态 |
| `{sessionUrl}/worker/internal-events` | GET | 恢复内部事件 |

### 设计决策讨论

**为什么 StructuredIO 同时处理数据消息和控制消息？**

一个替代方案是使用两个独立的通道——数据通道传输对话消息，控制通道传输权限请求。但这会引入通道同步问题：权限请求必须在对应的工具调用之后、工具执行之前到达。如果两个通道有不同的延迟，时序可能错乱。

单通道设计保证了消息的**全序**——所有消息按发送顺序到达，不存在跨通道的时序问题。代价是协议解析稍微复杂（需要区分消息类型），但这个复杂度被封装在 StructuredIO 内部。

**为什么 `outbound` 使用 Stream 队列而非直接写入？**

```typescript
// sendRequest() and print.ts both enqueue here; the drain loop is the
// only writer. Prevents control_request from overtaking queued stream_events.
readonly outbound = new Stream<StdoutMessage>()
```

`sendRequest()` 和 `print.ts` 的主循环都可能同时写入输出。如果直接写入 stdout，可能出现消息交错（一个 JSON 对象被另一个打断）。`outbound` 队列确保写入是序列化的——所有消息排队，由单一的 drain 循环按序写出。

**为什么 Bridge 模式需要 keep_alive？**

```typescript
// Bridge-only: fixes Envoy idle timeout on bridge-topology sessions
if (this.isBridge && keepAliveIntervalMs > 0) {
  this.keepAliveTimer = setInterval(() => {
    void this.write({ type: 'keep_alive' })
  }, keepAliveIntervalMs)
}
```

Bridge 模式下，Claude Code 通过 Envoy 代理连接到 claude.ai。Envoy 有空闲超时——如果一段时间没有数据传输，连接会被关闭。`keep_alive` 消息防止这种情况。注释引用了具体的 issue（#21931），说明这是一个实际遇到的生产问题。

---

## 19.5 runHeadless：非交互式运行时编排器

### 面临的问题

有了 QueryEngine（会话引擎）和 StructuredIO（传输协议），还缺一个关键角色：**谁来编排整个非交互式会话的生命周期？**

这个编排器需要处理的问题远比"调用 QueryEngine.submitMessage()"复杂：

1. **会话恢复**：`--resume` 需要从磁盘加载历史消息，重建会话状态
2. **多轮对话**：SDK 模式下，宿主可以持续发送新消息，每条消息触发一轮 Agent 循环
3. **命令队列**：多个消息可能同时到达（用户消息、任务通知、孤儿权限），需要排队处理
4. **MCP 动态管理**：SDK 宿主可以在运行时添加/移除 MCP 服务器
5. **Bridge 集成**：同时连接 SDK 宿主和 claude.ai Bridge，权限请求需要竞争
6. **输出格式**：支持 `text`、`json`、`stream-json` 三种输出格式
7. **优雅关闭**：进程退出前需要刷新 transcript、清理 MCP 连接、等待后台任务

### 解法：`cli/print.ts` 的 `runHeadless()` + `runHeadlessStreaming()`

`cli/print.ts` 是整个 SDK 非交互式路径的顶层编排器。它由两个核心函数组成：

```
runHeadless()                          runHeadlessStreaming()
┌─────────────────────────────┐       ┌──────────────────────────────────┐
│ 外层编排：                    │       │ 内层引擎：                        │
│ • 初始化 StructuredIO/RemoteIO│       │ • 命令队列消费循环                 │
│ • 加载初始消息（resume/fork）  │       │ • 多轮 ask() 调用                 │
│ • 权限函数构造                │       │ • MCP 动态管理                    │
│ • 工具/命令过滤               │       │ • Bridge 消息转发                 │
│ • 输出格式分发                │       │ • 中断/恢复处理                   │
│ • 优雅关闭                   │       │ • 空闲超时管理                    │
│                              │  ←──  │ • yield StdoutMessage 流          │
│ for await (message of        │       │                                   │
│   runHeadlessStreaming(...))  │       │                                   │
│   → 格式化输出到 stdout       │       │                                   │
└─────────────────────────────┘       └──────────────────────────────────┘
```

### 命令队列：多消息并发的核心机制

SDK 模式下，消息不是一个接一个到达的——它们可能同时到达。比如：
- 用户发送了一条新消息
- 同时一个后台 Agent 完成了任务，产生了任务通知
- 同时一个 Cron 定时器触发了一个 tick

这些消息都需要被 Agent 处理，但不能同时执行多个 `ask()` 调用。`runHeadlessStreaming` 使用**命令队列**来序列化这些请求：

```typescript
// src/cli/print.ts — runHeadlessStreaming 内部

const run = async () => {
  if (running) return  // 防止重入
  running = true

  try {
    // 贪婪地消费队列中的命令
    const drainCommandQueue = async () => {
      while ((command = dequeue(isMainThread))) {
        // 批量合并：连续的 prompt 命令合并为一次 ask() 调用
        const batch: QueuedCommand[] = [command]
        if (command.mode === 'prompt') {
          while (canBatchWith(command, peek(isMainThread))) {
            batch.push(dequeue(isMainThread)!)
          }
          if (batch.length > 1) {
            command = {
              ...command,
              value: joinPromptValues(batch.map(c => c.value)),
              uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
            }
          }
        }

        // 执行 ask()
        for await (const message of ask({
          prompt: command.value,
          tools: allTools,
          mcpClients: allMcpClients,
          canUseTool,
          // ...
        })) {
          output.enqueue(message)
          forwardMessagesToBridge()  // 实时转发给 Bridge
        }
      }
    }

    await drainCommandQueue()

    // 如果有活跃的后台 Agent，等待它们完成
    // 然后再次消费队列（Agent 完成会产生任务通知）
    do {
      waitingForAgents = hasActiveInProcessTeammates()
      if (waitingForAgents) {
        await waitForTeammatesToBecomeIdle()
        // 读取 Agent 的未读消息，注入队列
        // ...
      }
      await drainCommandQueue()
    } while (waitingForAgents)

  } finally {
    running = false
    // 空闲超时管理
    idleTimeout.start()
  }
}
```

**批量合并**是一个重要的优化。假设用户在 Agent 执行期间连续发送了 3 条消息，它们会在队列中等待。当 Agent 完成后，这 3 条消息被合并为一次 `ask()` 调用，而非 3 次独立调用。这减少了 API 调用次数和上下文重复。

合并的条件由 `canBatchWith()` 控制：

```typescript
export function canBatchWith(head: QueuedCommand, next: QueuedCommand | undefined): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&           // 只有 prompt 模式可以合并
    next.workload === head.workload &&  // workload 标签必须匹配
    next.isMeta === head.isMeta         // meta 标志必须匹配
  )
}
```

### 初始化控制协议：`initialize` 握手

SDK 宿主在发送第一条用户消息之前，需要通过 `initialize` 控制请求完成握手：

```typescript
// 宿主 → CLI: initialize 请求
{
  "type": "control_request",
  "request_id": "init-001",
  "request": {
    "subtype": "initialize",
    "hooks": {
      "PreToolUse": [{ "matcher": "Bash", "hookCallbackIds": ["hook-1"] }]
    },
    "sdkMcpServers": ["my-custom-server"],
    "jsonSchema": { "type": "object", "properties": { ... } },
    "systemPrompt": "You are a helpful assistant.",
    "agents": { "researcher": { ... } }
  }
}

// CLI → 宿主: initialize 响应
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "init-001",
    "response": {
      "commands": [{ "name": "/help", "description": "..." }, ...],
      "agents": [{ "name": "general-purpose", ... }],
      "models": [{ "id": "claude-sonnet-4-6", ... }],
      "account": { "plan": "pro", ... },
      "output_style": "concise",
      "available_output_styles": ["concise", "verbose", "minimal"]
    }
  }
}
```

`initialize` 握手让 SDK 宿主可以：
- 注册 Hook 回调（如 `PreToolUse` 钩子）
- 声明 SDK MCP 服务器
- 设置 JSON Schema 输出约束
- 覆盖系统提示词
- 定义自定义 Agent

### 输出格式分发

`runHeadless()` 支持三种输出格式，通过 `--output-format` 参数控制：

```typescript
// src/cli/print.ts — runHeadless() 输出分发

for await (const message of runHeadlessStreaming(...)) {
  if (transformToStreamlined) {
    // Streamlined 模式：精简的 SDK 消息格式
    const transformed = transformToStreamlined(message)
    if (transformed) {
      void structuredIO.write(transformed)
    }
  } else if (options.outputFormat === 'stream-json') {
    // stream-json：每条消息立即写出（SDK 标准模式）
    void structuredIO.write(message)
  } else {
    // text/json：收集所有消息，最后统一输出
    if (needsFullArray) messages.push(message)
    lastMessage = message
  }
}

// 最终输出
switch (options.outputFormat) {
  case 'json':
    if (options.verbose) {
      writeToStdout(jsonStringify(messages))  // 完整消息数组
    } else {
      writeToStdout(jsonStringify(lastMessage))  // 仅最终结果
    }
    break
  case 'text':
  default:
    // 提取最终文本结果
    if (lastMessage?.type === 'result' && lastMessage.subtype === 'success') {
      writeToStdout(lastMessage.result)
    }
    break
}
```

| 格式 | 用途 | 输出内容 |
|------|------|---------|
| `text`（默认） | 人类可读的 `-p` 模式 | 仅最终文本结果 |
| `json` | 脚本消费 | 最终结果 JSON（`--verbose` 时为完整消息数组） |
| `stream-json` | SDK 标准模式 | 每条 SDKMessage 实时 NDJSON 流 |

### 消息去重：防止重复处理

远程场景下，同一条消息可能被投递多次（WebSocket 重连、SSE 重放）。`runHeadlessStreaming` 通过 UUID 追踪防止重复处理：

```typescript
// 追踪已接收的消息 UUID
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // 重复消息
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // 容量限制：淘汰最旧的条目
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0, receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // 新消息
}
```

### 设计决策讨论

**为什么 `runHeadless` 和 `runHeadlessStreaming` 分成两个函数？**

`runHeadless` 负责"外壳"——初始化、输出格式化、优雅关闭。`runHeadlessStreaming` 负责"内核"——命令队列、多轮对话、MCP 管理。分离的好处是：

1. `runHeadlessStreaming` 返回 `AsyncIterable<StdoutMessage>`，是一个纯数据流，不关心输出格式
2. `runHeadless` 可以根据 `--output-format` 选择不同的消费策略
3. 测试时可以直接消费 `runHeadlessStreaming` 的输出，不需要解析 stdout

**为什么命令队列使用贪婪消费而非逐条处理？**

逐条处理意味着每条消息都触发一次完整的 `ask()` 调用——包括 System Prompt 构建、API 调用、工具执行。如果 3 条消息在队列中等待，就需要 3 次 API 调用。

贪婪消费 + 批量合并将 3 条消息合并为 1 次 API 调用。这不仅减少了 API 成本，还让模型能看到所有待处理的消息，做出更好的决策。

**为什么需要 `do-while(waitingForAgents)` 循环？**

后台 Agent（`InProcessTeammate`）是异步执行的。当主线程的命令队列清空后，可能还有 Agent 在后台运行。这些 Agent 完成后会产生任务通知，需要被主线程处理。

`do-while` 循环确保：
1. 先消费所有当前命令
2. 如果有活跃 Agent，等待它们完成
3. 读取 Agent 产生的新消息，注入队列
4. 再次消费队列
5. 重复直到没有活跃 Agent

源码中有一段专门处理非交互式模式下 Agent 关闭的提示词：

```typescript
const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user
until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user
</system-reminder>`
```

这揭示了一个有趣的约束：在非交互式模式下，进程退出意味着所有后台 Agent 被杀死。所以必须在退出前确保所有 Agent 优雅关闭。

---

## 19.6 SDK MCP 工具：进程内自定义工具

### 面临的问题

SDK 用户经常需要给 Claude 提供**自定义工具**——比如查询内部数据库、调用私有 API、执行特定的业务逻辑。Claude Code 的工具系统基于 MCP（Model Context Protocol），标准的 MCP 工具通过子进程（stdio）或网络（SSE/HTTP）与 Claude Code 通信。

但 SDK 场景有一个特殊需求：**自定义工具运行在 SDK 宿主进程中，而 Claude Code 运行在另一个子进程中。** 如果用标准的 stdio MCP 传输，就需要再 spawn 一个子进程来运行工具服务器——这意味着三个进程（SDK 宿主 → Claude Code CLI → MCP 工具服务器），增加了复杂度和延迟。

**核心矛盾：MCP 协议假设 Client 和 Server 在不同进程中，但 SDK 工具天然运行在宿主进程中。**

### 解法：SdkControlTransport——跨进程的 MCP 桥接

Claude Code 设计了一对特殊的 MCP Transport 来解决这个问题：

```
SDK 宿主进程                              CLI 子进程
┌──────────────────────┐                ┌──────────────────────────┐
│                      │                │                          │
│  SDK MCP Server      │                │  MCP Client              │
│  (用户自定义工具)     │                │  (Claude Code 内置)       │
│       │              │                │       │                  │
│       ▼              │                │       ▼                  │
│  SdkControlServer    │   stdin/stdout │  SdkControlClient        │
│  Transport           │◄──────────────►│  Transport               │
│  (解包 JSON-RPC)     │   控制协议      │  (包装 JSON-RPC)         │
│                      │                │                          │
└──────────────────────┘                └──────────────────────────┘
```

源码中的注释完整描述了这个架构：

```typescript
// src/services/mcp/SdkControlTransport.ts

/**
 * ## Message Flow
 *
 * ### CLI → SDK (via SdkControlClientTransport)
 * 1. CLI's MCP Client calls a tool → sends JSONRPC request to SdkControlClientTransport
 * 2. Transport wraps the message in a control request with server_name and request_id
 * 3. Control request is sent via stdout to the SDK process
 * 4. SDK's StructuredIO receives the control response and routes it back
 * 5. Transport unwraps the response and returns it to the MCP Client
 *
 * ### SDK → CLI (via SdkControlServerTransport)
 * 1. Query receives control request with MCP message and calls transport.onmessage
 * 2. MCP server processes the message and calls transport.send() with response
 * 3. Transport calls sendMcpMessage callback with the response
 * 4. Query's callback resolves the pending promise with the response
 */
```

CLI 侧的 Transport 实现极其简洁——它只做一件事：把 MCP JSON-RPC 消息包装成控制协议消息，通过 StructuredIO 发送：

```typescript
// CLI 侧：SdkControlClientTransport
export class SdkControlClientTransport implements Transport {
  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,
  ) {}

  async send(message: JSONRPCMessage): Promise<void> {
    // 发送消息并等待响应——跨进程的同步调用
    const response = await this.sendMcpMessage(this.serverName, message)
    // 将响应传回 MCP Client
    if (this.onmessage) {
      this.onmessage(response)
    }
  }
}
```

SDK 侧同样简洁：

```typescript
// SDK 侧：SdkControlServerTransport
export class SdkControlServerTransport implements Transport {
  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void) {}

  async send(message: JSONRPCMessage): Promise<void> {
    // 直接通过回调传回——由 Query 负责路由
    this.sendMcpMessage(message)
  }
}
```

### InProcessTransport：同进程 MCP 通信

除了跨进程的 SdkControlTransport，还有一个更简单的场景：MCP Server 和 Client 运行在**同一个进程**中。这由 `InProcessTransport` 处理：

```typescript
// src/services/mcp/InProcessTransport.ts

class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined

  async send(message: JSONRPCMessage): Promise<void> {
    // 通过 queueMicrotask 异步投递，避免同步调用栈溢出
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }
}

// 创建一对链接的 Transport
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]
}
```

`queueMicrotask` 的使用是一个微妙但重要的细节——如果 `send()` 同步调用 `peer.onmessage()`，而 `onmessage` 又同步调用 `send()`，就会形成无限递归。`queueMicrotask` 将投递推迟到当前微任务完成后，打破了同步递归。

### SDK MCP 工具的注册流程

```typescript
// src/services/mcp/client.ts — setupSdkMcpClients()

export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: SendMcpMessageCallback,
): Promise<{ clients: MCPServerConnection[]; tools: Tool[] }> {
  // 并行连接所有 SDK MCP 服务器
  const results = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]) => {
      // 创建 CLI 侧的 Transport
      const transport = new SdkControlClientTransport(name, sendMcpMessage)

      // 创建标准 MCP Client
      const client = new Client({ name: 'claude-code', ... }, { capabilities: {} })

      // 通过 Transport 连接——握手消息会跨进程到达 SDK 宿主
      await client.connect(transport)

      // 获取工具列表
      const serverTools = await fetchToolsForClient(connectedClient)
      return { client: connectedClient, tools: serverTools }
    }),
  )
  // ...
}
```

### 设计决策讨论

**为什么不直接在 CLI 进程中运行 SDK 工具？**

SDK 工具的 handler 函数定义在 SDK 宿主进程中（比如 Python SDK 的 Python 函数）。CLI 进程是一个独立的 Node.js/Bun 进程，无法直接调用宿主进程中的函数。跨进程的 MCP 桥接是唯一可行的方案。

**为什么复用 MCP 协议而不是自定义 RPC？**

MCP 已经定义了工具发现（`tools/list`）、工具调用（`tools/call`）、资源访问等完整的协议。复用 MCP 意味着：
1. SDK 工具和标准 MCP 工具对 Claude 来说完全一致——同样的工具描述、同样的调用方式
2. 不需要额外的序列化/反序列化逻辑
3. 未来可以无缝迁移到独立进程的 MCP 服务器

---

## 19.7 端到端数据流：一次 SDK 调用的完整旅程

为了将前面所有组件串联起来，让我们追踪一次完整的 SDK 调用——从 Python SDK 发送 `query("List files in /tmp")` 到收到最终结果。

### 阶段 1：SDK 宿主发起调用

```
Python SDK                                    CLI 子进程
    │                                              │
    │  spawn: claude --print -p "List files"       │
    │  --output-format stream-json                 │
    │  --permission-mode bypassPermissions         │
    │──────────────────────────────────────────────→│
    │                                              │
    │  stdin (NDJSON):                             │
    │  {"type":"user","message":{"role":"user",    │
    │   "content":"List files in /tmp"},           │
    │   "session_id":"","parent_tool_use_id":null} │
    │──────────────────────────────────────────────→│
```

### 阶段 2：CLI 进程初始化

```
cli.tsx (bootstrap)
    │
    │  args 不匹配任何快速路径
    ▼
main.tsx
    │  Commander.js 解析 --print 标志
    │  init(): config → auth → policy → analytics
    ▼
cli/print.ts — runHeadless()
    │
    ├─ 创建 StructuredIO(stdin)
    ├─ 加载工具、命令、MCP 客户端
    ├─ 构造 canUseTool 函数
    │   （bypassPermissions 模式 → 大部分工具自动允许）
    ├─ 调用 runHeadlessStreaming()
    │
    ▼
runHeadlessStreaming()
    │
    ├─ 从 StructuredIO.structuredInput 读取用户消息
    ├─ 消息入队: enqueue({ mode: 'prompt', value: "List files in /tmp" })
    ├─ 触发 run()
    │
    ▼
run() → drainCommandQueue()
    │
    ├─ dequeue() → 取出命令
    ├─ 调用 ask()
```

### 阶段 3：QueryEngine 执行

```
ask() → QueryEngine.submitMessage("List files in /tmp")
    │
    ├─ ① fetchSystemPromptParts()
    │   构建 System Prompt（工具描述、CLAUDE.md、环境信息）
    │
    ├─ ② processUserInput({ querySource: 'sdk' })
    │   解析输入（无斜杠命令，纯文本）
    │   → shouldQuery: true
    │
    ├─ ③ recordTranscript(messages)
    │   持久化用户消息到 JSONL
    │
    ├─ ④ yield buildSystemInitMessage(...)
    │   → stdout: {"type":"system","subtype":"init",...}
    │
    ├─ ⑤ 进入 query() 核心循环
    │
    ▼
query() — 第 1 轮
    │
    ├─ 调用 Anthropic Messages API（流式）
    │   → 模型返回: tool_use { name: "Bash", input: { command: "ls /tmp" } }
    │
    ├─ yield assistant message
    │   → stdout: {"type":"assistant","message":{...tool_use...},...}
    │
    ├─ 权限检查: canUseTool("Bash", { command: "ls /tmp" })
    │   → bypassPermissions 模式 → allow
    │
    ├─ 执行 BashTool: ls /tmp
    │   → 输出: "file1.txt\nfile2.txt\n..."
    │
    ├─ yield user message (tool_result)
    │   → stdout: {"type":"user","message":{...tool_result...},...}
    │
    ▼
query() — 第 2 轮
    │
    ├─ 调用 Anthropic Messages API（流式）
    │   → 模型返回: text "Here are the files in /tmp:\n- file1.txt\n..."
    │   → stop_reason: "end_turn"
    │
    ├─ yield assistant message
    │   → stdout: {"type":"assistant","message":{...text...},...}
    │
    └─ 循环结束（end_turn）
```

### 阶段 4：结果合成与输出

```
QueryEngine.submitMessage() 继续
    │
    ├─ isResultSuccessful(lastAssistantMessage, "end_turn") → true
    │
    ├─ yield result message
    │   → stdout: {"type":"result","subtype":"success",
    │              "result":"Here are the files in /tmp:\n...",
    │              "total_cost_usd":0.003,
    │              "num_turns":2,
    │              "permission_denials":[],
    │              "session_id":"abc-123",...}
    │
    ▼
runHeadless() 消费最终消息
    │
    ├─ stream-json 模式: 所有消息已实时写出
    ├─ gracefulShutdownSync(0)  // 成功退出
    │
    ▼
Python SDK 收到所有 NDJSON 消息
    │
    ├─ 解析 type="result" 消息
    ├─ 返回 QueryResult 对象给调用者
    └─ 完成
```

### 关键观察

1. **共享引擎**：整个流程中，`query()` 函数与交互式 REPL 使用的是**同一个函数**。差异仅在于外层的 `QueryEngine`（替代 React 状态管理）和 `StructuredIO`（替代终端 UI）。

2. **流式输出**：SDK 调用者在 Agent 执行过程中就能收到中间消息（assistant、tool_result），不需要等到最终结果。这对于 IDE 集成尤其重要——用户可以实时看到 Claude 在做什么。

3. **终止信号明确**：`result` 消息是唯一的终止信号。SDK 调用者只需要等待 `type === 'result'` 的消息，就知道这轮对话结束了。

4. **权限透明**：即使在 `bypassPermissions` 模式下，权限检查仍然执行（只是自动允许）。`permission_denials` 数组记录了所有被拒绝的权限请求，让调用者知道哪些操作被阻止了。

---

## 19.8 V2 Session API：持久化多轮会话

### 面临的问题

V1 的 `query()` API 是**一次性的**——每次调用创建一个新的 Agent 会话，执行完毕后会话结束。但很多场景需要**持久化的多轮对话**：

1. **IDE 集成**：用户在 VS Code 中与 Claude 对话，关闭窗口后重新打开，希望继续之前的对话
2. **长时间任务**：一个代码审查任务可能跨越多次交互，中间用户可能离开
3. **会话管理**：列出历史会话、搜索特定对话、分叉会话尝试不同方向

### 解法：V2 Session API

V2 API 引入了 `SDKSession` 概念——一个可持久化、可恢复的会话对象：

```typescript
// 创建新会话
const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a code reviewer.',
})

// 第一轮对话
for await (const message of session.sendMessage("Review this PR")) {
  console.log(message)
}

// 第二轮对话（会话状态自动保持）
for await (const message of session.sendMessage("Focus on security issues")) {
  console.log(message)
}

// 恢复已有会话
const resumed = unstable_v2_resumeSession(sessionId, { model: 'claude-sonnet-4-6' })
```

V2 API 的底层实现复用了 `QueryEngine`——`QueryEngine` 本身就是为多轮会话设计的（`submitMessage()` 可以多次调用，状态跨轮次持久化）。V2 API 只是在其上添加了会话持久化和恢复的能力。

### 会话管理 API

```typescript
// 列出会话
const sessions = await listSessions({ dir: '/path/to/project' })

// 获取会话详情
const info = await getSessionInfo(sessionId)

// 读取会话消息
const messages = await getSessionMessages(sessionId, {
  includeSystemMessages: true,
  limit: 100,
})

// 分叉会话（从某个点创建分支）
const fork = await forkSession(sessionId, {
  messageId: 'msg-uuid-to-fork-from',
})

// 重命名/标记会话
await renameSession(sessionId, { title: 'PR Review #123' })
await tagSession(sessionId, { tag: 'code-review' })
```

这些 API 直接操作 Claude Code 的会话存储系统（JSONL transcript 文件），不需要启动 Agent 进程。

---

## 19.9 设计全景：SDK 架构的 Trade-off

### Trade-off 1：子进程模型 vs 库模型

Claude Code SDK 选择了**子进程模型**——SDK 宿主 spawn 一个 Claude Code CLI 子进程，通过 stdin/stdout 通信。

替代方案是**库模型**——将 Claude Code 的核心逻辑编译为一个可 import 的库。

| 维度 | 子进程模型（当前选择） | 库模型 |
|------|----------------------|--------|
| 语言兼容性 | 任何语言都能 spawn 子进程 | 仅 Node.js/Bun |
| 隔离性 | 完全隔离，崩溃不影响宿主 | 共享进程，崩溃可能影响宿主 |
| 版本管理 | CLI 独立更新，SDK 自动获益 | 需要重新编译/发布 |
| 性能 | 进程启动开销 + IPC 延迟 | 零开销函数调用 |
| 调试 | 跨进程调试困难 | 同进程调试简单 |
| 状态管理 | 天然隔离，无共享状态问题 | 需要小心管理全局状态 |

子进程模型的选择与 Claude Code 的**多语言 SDK 战略**一致——Python SDK、Go SDK 等都可以通过同一个子进程协议与 CLI 通信，不需要为每种语言重写核心逻辑。

### Trade-off 2：NDJSON vs 二进制协议

NDJSON 的选择牺牲了性能（JSON 序列化/反序列化开销、文本编码开销），换取了调试友好性和语言无关性。对于 Claude Code 的场景，瓶颈在 API 调用延迟（秒级）而非 IPC 延迟（毫秒级），所以 NDJSON 的性能开销可以忽略。

### Trade-off 3：共享引擎 vs 独立引擎

SDK 模式复用了交互式 REPL 的 `query()` 引擎，而非构建独立的 SDK 引擎。

好处：
- **一致性**：SDK 用户获得与交互式用户完全一致的 Agent 能力
- **维护成本**：只需维护一套核心引擎
- **功能同步**：新功能（如上下文压缩、Stop Hooks）自动对 SDK 可用

代价：
- **复杂度泄漏**：`query()` 中有大量 `isNonInteractiveSession` 分支判断
- **抽象不完美**：某些交互式概念（如 Spinner、UI 弹窗）需要在 SDK 模式中被 stub 掉
- **测试负担**：每个新功能都需要在两种模式下测试

### Trade-off 4：`@alpha` API 的渐进稳定策略

V2 API 使用 `unstable_` 前缀标记不稳定接口，而非语义化版本号。这是一个务实的选择：

- **语义化版本**需要在 breaking change 时发布新的 major 版本，对于快速迭代的 API 来说过于沉重
- **`unstable_` 前缀**让调用者在代码中就能看到风险，不需要查阅 changelog
- 当 API 稳定后，只需要去掉前缀（`unstable_v2_createSession` → `createSession`），这是一个简单的重命名

---

## 19.10 小结

Claude Code 的 SDK 架构回答了一个核心问题：**如何将一个为人类设计的交互式 CLI 转化为可编程的 Agent 运行时？**

答案不是重写，而是**分层抽象**：

1. **类型定义层**（`coreSchemas.ts` → `agentSdkTypes.ts`）：Zod Schema 作为单一真理源，同时生成 TypeScript 类型和运行时校验器
2. **会话引擎层**（`QueryEngine`）：交互式 REPL 的无头替身，复用 `query()` 核心引擎
3. **传输协议层**（`StructuredIO` / `RemoteIO`）：NDJSON 控制协议，统一本地和远程通信
4. **运行时编排层**（`cli/print.ts`）：命令队列、多轮对话、MCP 动态管理、优雅关闭

这个架构的最大优势是**共享核心引擎**——SDK 用户获得的不是一个简化版的 Claude，而是与交互式用户完全一致的 Agent 能力。代价是架构复杂度——`isNonInteractiveSession` 分支遍布代码库，但这个代价被"只维护一套引擎"的收益所抵消。
