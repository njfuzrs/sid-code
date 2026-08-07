---
title: Claude Code 源码解析（三）· 工具系统
description: '如何让 LLM 从"只会聊天"变成"能读写文件、执行命令、搜索代码"？30+ 工具如何统一管理，又如何安全地并发执行？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第三章：工具系统（Tool System）

> 让 LLM 从"只能说"变成"能做事"——Claude Code 如何设计一个安全、可扩展、高性能的工具执行框架？

## 核心问题

LLM 本身只能生成文本。要让它读写文件、执行命令、搜索代码、与外部服务交互，就需要一个**工具系统**——将 LLM 的意图（"我想读取这个文件"）转化为实际的副作用（读取磁盘、返回内容）。

这个问题看似简单——定义一些函数，让 LLM 调用就行。但 Claude Code 面临的工具系统设计挑战远比"定义几个函数"复杂：

1. **规模问题。** 30+ 内置工具、无限数量的 MCP 外部工具、插件工具——工具池可能非常庞大。每个工具的 schema 描述都要占用 token 预算。当工具数量超过阈值，模型的注意力和 token 成本都会成为瓶颈。

2. **安全问题。** 工具直接操作用户的文件系统和 shell。一个错误的 `rm -rf /` 或一个恶意的 `curl | bash` 就可能造成不可逆的损害。工具系统必须在"赋予 LLM 强大能力"和"防止 LLM 造成破坏"之间找到平衡。

3. **并发问题。** 模型经常在一个回复中调用多个工具（比如同时读取 3 个文件）。哪些工具可以安全并发？哪些必须串行？并发执行时如何处理共享状态？

4. **扩展性问题。** 除了内置工具，还需要支持 MCP 协议的外部工具、插件工具、用户自定义 Agent 的工具集裁剪。这些工具来源不同、信任级别不同、生命周期不同，但必须在同一个框架内统一管理。

5. **子代理工具隔离。** 当主代理派生子代理时，子代理应该拥有哪些工具？子代理能否再派生子代理（递归）？不同类型的子代理（同步/异步/协调器/队友）各自的工具集应该如何裁剪？

**核心矛盾：能力的开放性 vs 执行的安全性 vs 系统的可扩展性。**

Claude Code 的解法是一个**分层架构**——用类型系统定义工具契约，用注册表管理工具池，用权限系统控制执行，用编排器协调并发，用策略集约束子代理。

---

## 3.1 架构总览

```
                        ┌─────────────────────────────────────────┐
                        │         Model API Response              │
                        │   content: [{ type: "tool_use", ... }]  │
                        └──────────────────┬──────────────────────┘
                                           │
                                           ▼
                        ┌─────────────────────────────────────────┐
                        │        query.ts — 工具调用检测           │
                        │  从 assistant message 中提取 tool_use    │
                        │  blocks，设置 needsFollowUp = true      │
                        └──────────────────┬──────────────────────┘
                                           │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                   ┌──────────────────┐       ┌──────────────────────┐
                   │ StreamingTool-   │       │    runTools()         │
                   │ Executor         │       │    批量执行模式        │
                   │ (流式执行模式)    │       │    模型响应完成后执行   │
                   └────────┬─────────┘       └──────────┬───────────┘
                            │                            │
                            └─────────────┬──────────────┘
                                          │
                                          ▼
                        ┌─────────────────────────────────────────┐
                        │      canUseTool() — 权限检查             │
                        │  ┌─────────────────────────────────┐    │
                        │  │ 1. 规则匹配 (allow/deny rules)   │    │
                        │  │ 2. 工具自身 checkPermissions()    │    │
                        │  │ 3. 分类器判定 (bashClassifier)    │    │
                        │  │ 4. Hook 执行 (PreToolUse)        │    │
                        │  │ 5. UI 弹窗 (交互式确认)           │    │
                        │  └─────────────────────────────────┘    │
                        │  结果: allow / deny / ask               │
                        └──────────────────┬──────────────────────┘
                                           │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                     allow / updatedInput            deny / cancel
                              │                           │
                              ▼                           ▼
                   ┌──────────────────┐       ┌──────────────────────┐
                   │  tool.call()     │       │  生成 is_error:true   │
                   │  实际执行工具     │       │  的 tool_result       │
                   │  (可能涉及:       │       └──────────────────────┘
                   │   子进程/文件I/O  │
                   │   /网络请求/沙箱) │
                   └────────┬─────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │  ToolResult<T>   │
                   │  {               │
                   │    data: T,      │
                   │    newMessages?, │
                   │    contextModifier? │
                   │  }               │
                   └────────┬─────────┘
                            │
                            ▼
                   ┌──────────────────────────────────────────────┐
                   │  mapToolResultToToolResultBlockParam()       │
                   │  序列化为 API 格式的 tool_result block       │
                   └────────┬─────────────────────────────────────┘
                            │
                            ▼
                   ┌──────────────────────────────────────────────┐
                   │  normalizeMessagesForAPI()                   │
                   │  将 tool_result 包装为 user message          │
                   │  追加到 messages 数组                         │
                   └────────┬─────────────────────────────────────┘
                            │
                            ▼
                   ┌──────────────────────────────────────────────┐
                   │  下一轮 API 调用                              │
                   │  messages: [...prev, assistant(tool_use),    │
                   │             user(tool_result)]               │
                   └──────────────────────────────────────────────┘
```

### 工具池的组装流程

工具不是一个静态列表——它是多个来源动态组装的结果：

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  getAllBaseTools()│   │  MCP 服务器工具   │   │  插件工具        │
│  内置工具注册表   │   │  (运行时发现)     │   │  (DXT/bundled)  │
│  30+ 工具        │   │  动态数量         │   │  动态数量        │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         │    ┌────────────────┴─────────────────────┘
         │    │
         ▼    ▼
┌─────────────────────────────────────────────────────────────┐
│  assembleToolPool(permissionContext, mcpTools)               │
│  ─────────────────────────────────────────────────────────  │
│  1. getTools(permissionContext)                              │
│     - feature flag 门控 (编译期 + 运行时)                     │
│     - isEnabled() 过滤                                       │
│     - REPL 模式工具替换                                       │
│     - SIMPLE 模式工具裁剪                                     │
│  2. filterToolsByDenyRules(mcpTools)                         │
│     - 按 alwaysDeny 规则过滤 MCP 工具                         │
│  3. 排序: 内置工具按名称排序 + MCP 工具按名称排序              │
│     (内置工具作为连续前缀，保证 prompt cache 稳定性)           │
│  4. uniqBy(name): 内置工具优先，名称冲突时内置胜出             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  useMergedTools(initialTools, assembled, mode)              │
│  合并 initialTools（如恢复会话的工具）+ 组装结果               │
│  → 最终的 toolUseContext.options.tools                       │
└─────────────────────────────────────────────────────────────┘
```

这个架构的关键洞察是：**工具池不是静态配置，而是运行时根据上下文动态组装的。** 同一个 Claude Code 实例，在不同的权限模式、不同的 MCP 连接状态、不同的子代理类型下，看到的工具集完全不同。

---

## 3.2 Tool 接口与类型体系

### 面临的问题

一个工具系统需要回答一个根本性的设计问题：**工具的"契约"是什么？**

Claude Code 有 30+ 内置工具，每个工具的输入/输出类型不同、安全特性不同、UI 渲染方式不同、并发行为不同。同时还要支持 MCP 外部工具和插件工具——它们的 schema 在运行时才知道。

如果没有统一的类型契约，每个工具就是一个孤岛，调用方需要为每个工具写特殊处理逻辑。这在 30+ 工具的规模下是不可维护的。

### 解法：`Tool<Input, Output, Progress>` 泛型接口

Claude Code 在 `src/Tool.ts` 中定义了一个**统一的工具接口**，所有工具——无论内置还是外部——都必须实现这个接口：

```typescript
// src/Tool.ts — 核心类型定义（简化）

export type Tool<
  Input extends AnyObject = AnyObject,     // Zod schema，定义输入结构
  Output = unknown,                         // 工具返回的数据类型
  P extends ToolProgressData = ToolProgressData,  // 进度事件类型
> = {
  readonly name: string
  readonly inputSchema: Input               // Zod schema，用于运行时校验
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具的 JSON Schema

  // ===== 核心生命周期方法 =====
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // ===== 安全与并发标记 =====
  isEnabled(): boolean
  isReadOnly(input): boolean
  isConcurrencySafe(input): boolean
  isDestructive?(input): boolean

  // ===== 模型交互 =====
  description(input, options): Promise<string>
  prompt(options): Promise<string>
  toAutoClassifierInput(input): unknown

  // ===== UI 渲染 =====
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode
  renderToolUseRejectedMessage?(input, options): React.ReactNode
  renderToolUseErrorMessage?(result, options): React.ReactNode

  // ===== 结果序列化 =====
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam

  // ===== 其他 =====
  userFacingName(input): string
  maxResultSizeChars: number
  aliases?: string[]
  searchHint?: string
  shouldDefer?: boolean
  // ... 还有 ~15 个可选方法
}
```

这个接口有 **40+ 个方法/属性**，是整个工具系统中最重要的类型定义。让我们逐层分析它的设计。

### 三个泛型参数的设计意图

```typescript
Tool<Input extends AnyObject, Output, Progress>
```

- **`Input`**：Zod schema 类型。不是普通的 TypeScript 类型，而是一个 Zod schema 对象，既用于编译期类型推导（`z.infer<Input>`），也用于运行时输入校验。这是一个关键决策——**输入校验不是可选的，而是类型系统强制的**。

- **`Output`**：工具返回的数据类型。注意它不是直接返回给模型的格式——`mapToolResultToToolResultBlockParam()` 负责将 `Output` 转换为 API 格式。这种分离让工具可以返回结构化数据（供 UI 渲染），同时生成不同的文本表示（供模型消费）。

- **`Progress`**：进度事件类型。工具执行可能耗时较长（比如 Bash 命令），进度事件让 UI 可以实时展示执行状态。

### ToolResult：工具返回值的三元组

```typescript
export type ToolResult<T> = {
  data: T                    // 工具的实际输出数据
  newMessages?: Message[]    // 工具执行过程中产生的附加消息
  contextModifier?: (context: ToolUseContext) => ToolUseContext  // 上下文修改器
}
```

这个设计值得深入讨论：

**为什么不只返回 `data`？**

因为某些工具的执行会产生**副作用**，这些副作用需要反映到对话状态中：

- `newMessages`：比如 AgentTool 执行子代理后，子代理的对话历史需要作为附加消息注入。FileEditTool 执行后可能需要注入一条系统消息告知文件已修改。

- `contextModifier`：比如 `EnterPlanModeTool` 需要修改权限模式为 plan mode。这个修改器让工具可以在执行后改变后续工具的执行上下文。**注意源码注释：`contextModifier` 只对非并发安全的工具生效**——因为并发执行时，多个工具同时修改上下文会导致竞态条件。

### ToolUseContext：工具执行的"世界观"

```typescript
export type ToolUseContext = {
  // ===== 配置 =====
  options: {
    commands: Command[]
    tools: Tools
    mainLoopModel: string
    mcpClients: MCPServerConnection[]
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    // ...
  }

  // ===== 状态访问 =====
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  messages: Message[]

  // ===== UI 交互 =====
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  sendOSNotification?: (opts) => void

  // ===== 子代理特有 =====
  agentId?: AgentId
  agentType?: string
  setAppStateForTasks?: (f) => void  // 跨代理的基础设施状态共享
  localDenialTracking?: DenialTrackingState

  // ===== 高级特性 =====
  contentReplacementState?: ContentReplacementState
  renderedSystemPrompt?: SystemPrompt
  // ... 还有 ~20 个字段
}
```

`ToolUseContext` 是工具执行时的**完整环境快照**。它包含了工具执行所需的一切：配置、状态、UI 回调、消息历史、中止信号……

### 设计决策讨论

**为什么 `ToolUseContext` 如此庞大（40+ 字段）？**

这是一个典型的**"上下文对象"模式**（Context Object Pattern）。替代方案是让每个工具自己去获取需要的依赖（比如通过全局单例或依赖注入）。但这有两个问题：

1. **子代理隔离**：子代理的 `setAppState` 是 no-op（异步代理不能修改父代理的 UI 状态），`readFileState` 可能是独立的缓存实例。如果工具通过全局单例获取这些依赖，就无法实现子代理隔离。通过 context 传递，每个代理可以有自己的"世界观"。

2. **可测试性**：在测试中，可以构造一个 mock 的 `ToolUseContext`，而不需要 mock 全局状态。

代价是接口膨胀——但源码通过 `ToolUseContext` 的集中定义，至少让这种膨胀是**可见的、可追踪的**。

**为什么 `setAppState` 和 `setAppStateForTasks` 是两个不同的函数？**

源码注释解释得很清楚：

```typescript
/**
 * Always-shared setAppState for session-scoped infrastructure (background
 * tasks, session hooks). Unlike setAppState, which is no-op for async agents
 * (see createSubagentContext), this always reaches the root store so agents
 * at any nesting depth can register/clean up infrastructure that outlives
 * a single turn.
 */
setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
```

异步子代理的 `setAppState` 被设为 no-op，防止子代理意外修改父代理的 UI 状态。但后台任务（如 shell 任务）的注册/清理是**基础设施操作**，必须能穿透到根 store。`setAppStateForTasks` 就是这个"穿透通道"。

这是一个精妙的**权限分层**：UI 状态修改被隔离，基础设施状态修改被共享。

### `buildTool()`：工具的工厂函数

源码中所有工具都不直接实现完整的 `Tool` 接口，而是通过 `buildTool()` 工厂函数创建：

```typescript
// src/Tool.ts

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,   // 默认不安全
  isReadOnly: (_input?: unknown) => false,           // 默认有写操作
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),  // 默认允许
  toAutoClassifierInput: (_input?: unknown) => '',   // 默认跳过分类器
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

**默认值的安全哲学：fail-closed。**

注意默认值的选择：
- `isConcurrencySafe` 默认 `false`——假设不安全，需要工具显式声明安全
- `isReadOnly` 默认 `false`——假设有写操作，需要工具显式声明只读
- `checkPermissions` 默认 `allow`——这看起来矛盾，但实际上权限检查有多层（规则匹配、分类器、Hook、UI 弹窗），`checkPermissions` 只是工具自身的**额外**权限逻辑，默认 allow 意味着"交给通用权限系统处理"

**为什么用工厂函数而不是 class 继承？**

Claude Code 的工具是**纯数据对象**（plain objects），不是 class 实例。这有几个好处：
1. 没有 `this` 绑定问题——工具方法可以被安全地解构和传递
2. 没有继承层次——每个工具是独立的，不存在"基类修改影响所有子类"的风险
3. 更好的 tree-shaking——bundler 可以更容易地消除未使用的工具代码
4. 类型推导更精确——`BuiltTool<D>` 可以精确推导出每个工具的具体类型，而不是退化为基类类型

### 工具的安全标记体系

Tool 接口中有一组布尔标记，构成了工具的**安全元数据**：

```
┌─────────────────────────────────────────────────────────────┐
│                    工具安全标记                               │
│                                                             │
│  isReadOnly(input)          是否只读？                       │
│  ├─ true  → 可以在 plan 模式下自动执行                       │
│  └─ false → plan 模式下需要确认                              │
│                                                             │
│  isConcurrencySafe(input)   是否并发安全？                    │
│  ├─ true  → 可以与其他工具并行执行                            │
│  └─ false → 必须串行执行，contextModifier 才会生效            │
│                                                             │
│  isDestructive(input)       是否不可逆？                      │
│  ├─ true  → 删除/覆盖/发送等不可逆操作                       │
│  └─ false → 可逆或无副作用                                   │
│                                                             │
│  isEnabled()                当前环境是否可用？                │
│  ├─ true  → 工具出现在工具池中                               │
│  └─ false → 工具被过滤掉，模型看不到                          │
│                                                             │
│  requiresUserInteraction()  是否需要用户直接参与？            │
│  ├─ true  → 如 AskUserQuestionTool                          │
│  └─ false → 大多数工具                                       │
│                                                             │
│  interruptBehavior()        用户中断时的行为？                │
│  ├─ 'cancel' → 停止工具，丢弃结果                            │
│  └─ 'block'  → 继续运行，新消息等待（默认）                   │
└─────────────────────────────────────────────────────────────┘
```

这些标记不是装饰性的——它们直接驱动了执行引擎的行为：

- **并发调度器**读取 `isConcurrencySafe` 决定是否并行执行
- **权限系统**读取 `isReadOnly` 决定 plan 模式下是否自动放行
- **安全分类器**读取 `isDestructive` 作为风险评估的输入
- **UI 层**读取 `interruptBehavior` 决定中断按钮的行为

**一个微妙的设计：这些标记接受 `input` 参数。**

这意味着同一个工具，对于不同的输入，可以有不同的安全特性。比如 `BashTool`：
- `ls -la` → `isReadOnly: true`, `isConcurrencySafe: true`
- `rm -rf /tmp/test` → `isReadOnly: false`, `isConcurrencySafe: false`, `isDestructive: true`

安全特性不是工具级别的，而是**调用级别的**。这比简单地把工具标记为"安全"或"危险"要精确得多。

---

## 3.3 工具注册与发现

### 面临的问题

30+ 内置工具不是一个静态列表。不同的构建变体（外部版/内部版/KAIROS 版）、不同的运行时环境（是否启用 LSP、是否有嵌入式搜索工具）、不同的 feature flag 状态，都会影响哪些工具可用。

同时，MCP 外部工具的数量是不确定的——用户可能配置了 0 个 MCP 服务器，也可能配置了 20 个，每个服务器暴露 5-50 个工具。当工具总数超过一定阈值，每个工具的 schema 描述都要占用 token 预算，模型的注意力也会被稀释。

**问题：如何管理一个规模可变、来源多样、需要动态裁剪的工具池？**

### 解法：三层工具注册架构

```
Layer 1: 静态注册 (tools.ts)
  ├─ 无条件导入的核心工具 (import)
  ├─ 编译期门控的工具 (feature() + require)
  ├─ 运行时门控的工具 (process.env + require)
  └─ 延迟加载的工具 (lazy require 打破循环依赖)

Layer 2: 动态过滤 (getTools / assembleToolPool)
  ├─ isEnabled() 过滤
  ├─ deny rules 过滤
  ├─ REPL 模式工具替换
  ├─ SIMPLE 模式裁剪
  └─ 排序 + 去重

Layer 3: 延迟发现 (ToolSearch)
  ├─ 工具数量超阈值时启用
  ├─ 部分工具标记为 deferred
  ├─ 模型通过 ToolSearchTool 按需发现
  └─ 发现的工具通过 tool_reference 持久化
```

### Layer 1：`tools.ts` — 静态注册表

`src/tools.ts` 是所有内置工具的**注册中心**。它的核心函数 `getAllBaseTools()` 返回当前环境下所有可能可用的工具：

```typescript
// src/tools.ts — 简化后的结构

// ===== 无条件导入：核心工具，所有构建变体都包含 =====
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
// ... 还有 ~15 个核心工具

// ===== 运行时门控：仅内部用户可用 =====
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null

// ===== 编译期门控：feature flag 控制 =====
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []

// ===== 延迟加载：打破循环依赖 =====
// tools.ts -> TeamCreateTool -> ... -> tools.ts
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
```

注意这里使用了**三种不同的导入策略**，每种解决不同的问题：

| 策略 | 语法 | 解决的问题 | 示例 |
|------|------|-----------|------|
| 静态 import | `import { X } from '...'` | 核心工具，始终需要 | BashTool, FileReadTool |
| 条件 require | `feature('X') ? require('...') : null` | 编译期消除不需要的代码 | SleepTool, CronTools |
| 延迟 require | `const getX = () => require('...')` | 打破循环依赖 | TeamCreateTool, SendMessageTool |

**为什么条件导入用 `require` 而不是 `import()`？**

`import()` 是异步的，返回 Promise。但 `getAllBaseTools()` 是同步函数——它需要在模块求值阶段就确定工具列表。`require()` 是同步的，可以在条件表达式中使用。

更重要的是，当 `feature('X')` 在编译期求值为 `false` 时，整个三元表达式的 true 分支（包括 `require` 调用）会被 bundler 的死代码消除移除。这意味着**被关闭的 feature 对应的工具代码不会出现在最终产物中**。

**为什么 TeamCreateTool 需要延迟加载？**

源码注释说得很清楚：

```typescript
// Lazy require to break circular dependency:
// tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
```

TeamCreateTool 的实现中引用了 `tools.ts` 中的某些导出（比如工具列表），而 `tools.ts` 又导入了 TeamCreateTool。这形成了循环依赖。通过将 `require` 包装在函数中，实际的模块加载被推迟到函数调用时——此时两个模块都已经完成求值，循环被打破。

### `getAllBaseTools()`：工具全集

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 嵌入式搜索工具可用时，跳过 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    // ... 条件工具
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    // ... 更多条件工具
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

一个有趣的细节：`hasEmbeddedSearchTools()` 检查。Anthropic 内部构建版本将 `bfs`/`ugrep` 嵌入到 Bun 二进制中（通过 ARGV0 技巧），shell 中的 `find`/`grep` 被别名到这些快速工具。此时专用的 `GlobTool`/`GrepTool` 就不再需要了——模型可以直接通过 BashTool 使用嵌入式搜索。

### Layer 2：`getTools()` — 动态过滤

`getAllBaseTools()` 返回的是"所有可能的工具"。`getTools()` 在此基础上做进一步过滤：

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 简单模式：只保留 Bash + Read + Edit
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // 协调器模式额外添加 AgentTool + TaskStopTool
    if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 正常模式：过滤特殊工具 + deny rules + REPL 替换 + isEnabled
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // REPL 模式：隐藏被 REPL 包装的原始工具
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool => toolMatchesName(tool, REPL_TOOL_NAME))
    if (replEnabled) {
      allowedTools = allowedTools.filter(tool => !REPL_ONLY_TOOLS.has(tool.name))
    }
  }

  // 最终过滤：只保留 isEnabled() 返回 true 的工具
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

这里有几个值得注意的设计：

**SIMPLE 模式的存在意义。** `CLAUDE_CODE_SIMPLE` 环境变量将工具集裁剪到最小（Bash + Read + Edit）。这用于 SDK 的 `--bare` 模式和某些受限环境。有趣的是，即使在 SIMPLE 模式下，如果同时启用了协调器模式，也会添加 AgentTool——因为协调器需要派生 worker。

**REPL 模式的工具替换。** REPLTool 是一个"透明包装器"——它在 VM 沙箱中运行 Bash/Read/Edit 等工具。当 REPL 模式启用时，原始的 Bash/Read/Edit 被隐藏（模型看不到），只暴露 REPLTool。模型调用 REPLTool，REPLTool 内部再调用原始工具。这实现了**工具级别的沙箱化**，而不需要修改每个工具的实现。

### `assembleToolPool()`：内置 + MCP 的合并

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 排序策略：内置工具作为连续前缀，MCP 工具作为后缀
  // 这保证了 prompt cache 的稳定性
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

**排序策略的 prompt cache 考量。** 源码注释解释了为什么不做全局排序：

> Sort each partition for prompt-cache stability, keeping built-ins as a contiguous prefix. The server's claude_code_system_cache_policy places a global cache breakpoint after the last prefix-matched built-in tool; a flat sort would interleave MCP tools into built-ins and invalidate all downstream cache keys whenever an MCP tool sorts between existing built-ins.

Anthropic API 的 prompt cache 机制会在内置工具的最后一个之后设置缓存断点。如果 MCP 工具被插入到内置工具之间（全局排序会导致这种情况），每次 MCP 工具变化都会使所有下游缓存失效。通过将内置工具和 MCP 工具分别排序后拼接，内置工具部分的缓存键保持稳定。

**`uniqBy('name')` 的冲突解决。** 当内置工具和 MCP 工具同名时，内置工具胜出（因为它在数组前面，`uniqBy` 保留第一个出现的）。这是一个安全决策——防止 MCP 服务器通过注册同名工具来覆盖内置工具的行为。

### Layer 3：ToolSearch — 延迟发现机制

当工具总数很大时（比如连接了多个 MCP 服务器），将所有工具的 schema 都放入 system prompt 会消耗大量 token。ToolSearch 机制通过**延迟加载**解决这个问题。

```
工具数量 < 阈值?
├─ YES → 所有工具直接暴露给模型（标准模式）
└─ NO  → 部分工具标记为 deferred
          ├─ deferred 工具的 schema 不出现在初始 prompt 中
          ├─ 模型看到 ToolSearchTool
          ├─ 模型调用 ToolSearchTool 搜索需要的工具
          ├─ 搜索结果返回 tool_reference blocks
          └─ 后续 API 调用包含已发现的工具 schema
```

#### ToolSearch 的三种模式

```typescript
// src/utils/toolSearch.ts
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'
```

- **`standard`**：禁用 ToolSearch，所有工具直接暴露
- **`tst`**：始终启用 ToolSearch，部分工具延迟加载
- **`tst-auto`**：自动模式——只在延迟工具的 token 开销超过阈值时启用

自动模式的阈值检查：

```typescript
function checkAutoThreshold(deferredTools: Tools, allTools: Tools): boolean {
  // 先尝试精确 token 计数
  const exactCount = countToolDefinitionTokens(deferredTools)
  if (exactCount !== null) {
    return exactCount >= threshold
  }
  // 回退到字符数启发式
  return estimateByCharCount(deferredTools) >= threshold
}
```

#### ToolSearchTool 的搜索机制

ToolSearchTool 支持两种查询模式：

**1. 直接选择模式**：`select:ToolA,ToolB`

```typescript
// 直接按名称选择工具，跳过搜索
if (query.startsWith('select:')) {
  const names = query.slice(7).split(',')
  return resolveToolsByName(names, deferredTools, allTools)
}
```

**2. 关键词搜索模式**：自然语言查询

```typescript
function searchToolsWithKeywords(query: string, tools: Tools): SearchResult[] {
  // 精确名称快速路径
  const exactMatch = tools.find(t => t.name === query)
  if (exactMatch) return [exactMatch]

  // MCP 前缀路径：mcp__server... 匹配
  if (query.startsWith('mcp__')) { ... }

  // 关键词评分
  const terms = parseTerms(query)  // 支持 +required 语法
  return tools
    .map(tool => ({
      tool,
      score: scoreToolMatch(tool, terms)  // 基于名称、searchHint、描述
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
}
```

搜索评分考虑三个维度：
- **工具名称**：解析为单词后匹配（如 `FileEditTool` → `file`, `edit`, `tool`）
- **`searchHint`**：工具定义中的关键词提示（如 NotebookEditTool 的 `searchHint: 'jupyter'`）
- **工具描述**：通过 `tool.prompt()` 获取的完整描述文本（结果被 memoize 缓存）

#### 已发现工具的持久化

搜索结果通过 `tool_reference` blocks 返回给模型：

```typescript
mapToolResultToToolResultBlockParam(matchedNames) {
  return {
    type: 'tool_result',
    content: matchedNames.map(name => ({
      type: 'tool_reference',
      tool_name: name,
    })),
  }
}
```

后续 API 调用时，系统从消息历史中提取已发现的工具：

```typescript
function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  // 扫描所有 tool_result 中的 tool_reference blocks
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_reference') {
        discovered.add(block.tool_name)
      }
    }
  }
  return discovered
}
```

这意味着一旦模型通过 ToolSearch 发现了某个工具，该工具的 schema 会在后续所有 API 调用中包含——不需要每次都重新搜索。

### 设计决策讨论

**为什么不直接限制 MCP 工具数量？**

因为用户可能确实需要大量 MCP 工具。限制数量是一种"削足适履"的做法。ToolSearch 的延迟加载机制让系统可以支持任意数量的工具，同时只为实际使用的工具付出 token 成本。

**为什么 `AskUserQuestionTool` 被标记为 `shouldDefer: true`？**

这是一个有趣的决策。`AskUserQuestionTool` 不是一个"大"工具（schema 不复杂），但它被标记为可延迟。可能的原因是：在大多数对话中，模型不需要向用户提问——只有在需要澄清时才用。将它延迟加载可以减少初始 prompt 的 token 开销，而模型在需要时可以通过 ToolSearch 找到它。

**ToolSearch 的 trade-off 是什么？**

- **收益**：减少初始 prompt 的 token 开销，支持更多工具
- **代价**：模型需要额外一轮 API 调用来发现工具（增加延迟和成本）
- **缓解**：`tst-auto` 模式只在 token 节省足够大时才启用；已发现的工具被持久化，不需要重复搜索

---

## 3.4 工具执行流程深度剖析

### 面临的问题

当模型返回一个包含 `tool_use` block 的响应时，系统需要：

1. **检测**：从流式响应中提取 tool_use blocks
2. **校验**：验证输入是否合法
3. **授权**：检查是否有权限执行
4. **执行**：调用工具的 `call()` 方法
5. **序列化**：将结果转换为 API 格式
6. **回传**：将 tool_result 追加到消息历史，触发下一轮 API 调用

这个流程的复杂性在于：模型可能在一个响应中调用**多个工具**，这些工具可能可以并发执行，也可能必须串行。同时，工具执行可能被用户中断、被权限系统拒绝、或因超时而失败。每种情况都需要生成正确的 tool_result——因为 API 协议要求**每个 tool_use 必须有对应的 tool_result**。

### 完整执行链路

```
Model API Response (streaming)
  │
  │  for await (const message of callModel({...}))
  ▼
┌─────────────────────────────────────────────────────────────┐
│  queryLoop() — src/query.ts                                 │
│                                                             │
│  ① 流式接收 assistant message                               │
│  ② 提取 tool_use blocks:                                    │
│     msgToolUseBlocks = message.content                      │
│       .filter(c => c.type === 'tool_use')                   │
│  ③ 设置 needsFollowUp = true                               │
│                                                             │
│  ④ 选择执行模式:                                             │
│     ┌─ StreamingToolExecutor (流式执行)                      │
│     │  工具在模型还在输出时就开始执行                          │
│     │  streamingToolExecutor.addTool(block, message)        │
│     │                                                       │
│     └─ runTools() (批量执行)                                 │
│        模型输出完成后统一执行                                  │
│                                                             │
│  ⑤ 消费工具结果:                                             │
│     for await (const update of toolUpdates) {               │
│       yield update.message          // → UI 渲染            │
│       toolResults.push(             // → 下一轮 API 调用     │
│         ...normalizeMessagesForAPI([update.message])         │
│       )                                                     │
│     }                                                       │
│                                                             │
│  ⑥ 递归下一轮:                                               │
│     messages: [...prev, ...assistantMsgs, ...toolResults]   │
└─────────────────────────────────────────────────────────────┘
```

### 两种执行模式：流式 vs 批量

这是一个重要的架构决策。`query.ts` 支持两种工具执行模式：

**流式执行（StreamingToolExecutor）**

```
模型输出:  [text...] [tool_use_1] [text...] [tool_use_2] [text...] [end]
                        │                      │
                        ▼                      ▼
工具执行:          tool_1 开始执行         tool_2 开始执行
                   ──────────────────     ──────────────
                        │                      │
模型输出结束:            │                      │
                        ▼                      ▼
                   tool_1 完成             tool_2 完成
                        │                      │
                        └──────────┬───────────┘
                                   ▼
                            收集所有结果
```

当 `config.gates.streamingToolExecution` 启用时，工具在模型还在输出时就开始执行。这可以显著减少端到端延迟——模型输出和工具执行的时间重叠了。

**批量执行（runTools）**

```
模型输出:  [text...] [tool_use_1] [text...] [tool_use_2] [text...] [end]
                                                                     │
                                                                     ▼
工具执行:                                                    tool_1, tool_2
                                                             同时或顺序执行
```

模型输出完全结束后，所有 tool_use blocks 被收集，然后统一执行。

**两种模式的 trade-off：**

| 维度 | 流式执行 | 批量执行 |
|------|---------|---------|
| 延迟 | 更低（重叠执行） | 更高（串行等待） |
| 复杂度 | 更高（需要处理部分结果） | 更低（简单的批处理） |
| 正确性风险 | 工具可能基于不完整的 assistant message 执行 | 工具看到完整的 assistant message |
| 中止处理 | 需要处理"模型还在输出但工具已完成"的状态 | 简单——模型输出完成后才开始 |

`query.ts` 通过统一的异步迭代器接口抽象了这两种模式：

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

// 无论哪种模式，消费方式相同
for await (const update of toolUpdates) {
  // ...
}
```

### 并发执行策略

当模型在一个响应中调用多个工具时，系统需要决定哪些可以并发执行。决策依据是工具的 `isConcurrencySafe(input)` 标记：

```
模型返回: [tool_use: Read("a.ts"), tool_use: Read("b.ts"), tool_use: Edit("c.ts")]
                │                        │                        │
                ▼                        ▼                        ▼
         isConcurrencySafe?      isConcurrencySafe?       isConcurrencySafe?
              true                    true                     false
                │                        │                        │
                └────────┬───────────────┘                        │
                         ▼                                        │
                   并行执行 Read("a.ts")                           │
                   和 Read("b.ts")                                │
                         │                                        │
                         ▼ (两个都完成后)                           │
                                                                  ▼
                                                          串行执行 Edit("c.ts")
```

关键规则：
- **所有并发安全的工具**可以同时执行
- **非并发安全的工具**必须等待前面的工具完成后才执行
- **`contextModifier` 只对非并发安全的工具生效**——因为并发执行时无法保证修改顺序

### 权限检查：`canUseTool()` 的多层防线

每个工具在执行前都要经过 `canUseTool()` 检查。这个函数实现了一个**多层决策链**：

```
canUseTool(tool, input, context, assistantMessage, toolUseID)
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 强制决策 (forceDecision)                          │
│  如果调用方提供了强制决策，直接使用                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ 无强制决策
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: hasPermissionsToUseTool()                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2a. 规则匹配                                        │   │
│  │     alwaysAllow / alwaysDeny / alwaysAsk rules      │   │
│  │     来源: settings.json, CLAUDE.md, 运行时添加       │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ 2b. 工具自身 checkPermissions()                     │   │
│  │     工具特有的权限逻辑                               │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ 2c. 权限模式判定                                    │   │
│  │     default: 大多数工具需要确认                      │   │
│  │     plan: 只读工具自动放行                           │   │
│  │     bypassPermissions: 全部自动放行                  │   │
│  └─────────────────────────────────────────────────────┘   │
│  返回: allow / deny / ask                                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       allow         deny          ask
          │            │            │
          │            │            ▼
          │            │   ┌────────────────────────────┐
          │            │   │ Layer 3: 自动化检查         │
          │            │   │ ├─ 协调器权限处理           │
          │            │   │ ├─ Swarm worker 权限处理    │
          │            │   │ └─ Bash 推测分类器          │
          │            │   │   (2秒内等待高置信度结果)    │
          │            │   └────────────┬───────────────┘
          │            │                │ 未自动解决
          │            │                ▼
          │            │   ┌────────────────────────────┐
          │            │   │ Layer 4: 交互式 UI          │
          │            │   │ 弹出权限确认对话框           │
          │            │   │ 用户选择: 允许/拒绝/始终允许 │
          │            │   └────────────────────────────┘
          │            │
          ▼            ▼
    执行工具      生成 is_error
    tool.call()   tool_result
```

**Bash 推测分类器的 2 秒窗口**是一个精妙的优化：当权限判定为 `ask` 时，系统不会立即弹出 UI 对话框，而是先等待最多 2 秒，看推测分类器是否能给出高置信度的 `allow` 结果。如果能，就跳过 UI 弹窗，直接执行。这减少了用户被频繁打断的次数，同时保持了安全性（只有高置信度才自动放行）。

### 错误安全不变量：每个 tool_use 必须有 tool_result

API 协议要求消息历史中的每个 `tool_use` block 都必须有对应的 `tool_result`。如果工具执行失败、被中止、或因任何原因无法完成，系统仍然需要生成一个 `tool_result`。

`query.ts` 通过 `yieldMissingToolResultBlocks()` 保证这个不变量：

```typescript
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const msg of assistantMessages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_result',
          tool_use_id: block.id,
          content: errorMessage,
          is_error: true,
        }
      }
    }
  }
}
```

这个函数在以下场景被调用：
- 模型输出被中止（abort）
- 工具执行过程中发生未捕获异常
- 流式执行器在模型输出中断后需要清理

**这是一个防御性编程的典范**——即使在最极端的错误场景下，消息历史的结构完整性也不会被破坏。

### 工具结果的序列化与回传

工具执行完成后，结果需要经过两次转换才能回到模型：

```
tool.call() 返回
  │
  │  ToolResult<T> = { data: T, newMessages?, contextModifier? }
  │
  ▼
tool.mapToolResultToToolResultBlockParam(data, toolUseID)
  │
  │  ToolResultBlockParam = {
  │    type: 'tool_result',
  │    tool_use_id: string,
  │    content: string | ContentBlock[],
  │    is_error?: boolean,
  │  }
  │
  ▼
normalizeMessagesForAPI([toolResultMessage], tools)
  │
  │  将 tool_result 包装为 UserMessage
  │  过滤掉 UI-only 的系统消息
  │  处理 content replacement (大结果持久化)
  │
  ▼
追加到 messages 数组，作为下一轮 API 调用的输入
```

**为什么需要两次转换？**

第一次转换（`mapToolResultToToolResultBlockParam`）是**工具特定的**——每个工具知道如何将自己的输出序列化为模型可理解的格式。比如 FileReadTool 返回文件内容，BashTool 返回 stdout/stderr。

第二次转换（`normalizeMessagesForAPI`）是**全局的**——它处理所有工具共有的关注点：消息格式规范化、大结果的磁盘持久化（`ContentReplacementState`）、UI-only 消息的过滤等。

这种分离让每个工具只需要关心自己的序列化逻辑，而不需要了解消息规范化的全局规则。

### 大结果处理：`maxResultSizeChars` 与磁盘持久化

当工具返回的结果超过 `maxResultSizeChars` 时，结果会被持久化到磁盘，模型收到的是一个摘要 + 文件路径：

```typescript
// Tool 接口中的定义
maxResultSizeChars: number
// FileReadTool: Infinity（永远不持久化——避免 Read→file→Read 循环）
// BashTool: 有限值（大输出持久化到 tool-results 目录）
```

FileReadTool 的 `maxResultSizeChars` 被设为 `Infinity`，源码注释解释了原因：

> Set to Infinity for tools whose output must never be persisted (e.g. Read, where persisting creates a circular Read→file→Read loop and the tool already self-bounds via its own limits).

如果 FileReadTool 的结果被持久化到文件，模型可能会尝试读取那个文件，触发另一次 FileReadTool 调用，其结果又被持久化……形成无限循环。FileReadTool 通过自身的 token 限制和行数限制来控制输出大小，不需要外部持久化机制。

---

## 3.5 BashTool 深度解析

### 面临的问题

BashTool 是 Claude Code 中**最强大也最危险**的工具。它让 LLM 可以执行任意 shell 命令——这意味着它可以做任何事：安装依赖、运行测试、编译代码、操作 Git、甚至删除整个文件系统。

这种"无限能力"带来了一系列独特的工程挑战：

1. **安全边界**：如何防止 LLM 执行危险命令（`rm -rf /`、`curl malicious.sh | bash`），同时不过度限制合法操作？
2. **沙箱隔离**：如何在不影响正常开发工作流的前提下，限制命令的文件系统和网络访问？
3. **超时与后台**：编译可能需要几分钟，测试可能需要更长。如何处理长时间运行的命令？
4. **输出管理**：命令输出可能是几行，也可能是几万行。如何在不丢失关键信息的前提下控制输出大小？
5. **状态追踪**：命令可能改变工作目录（`cd`）、设置环境变量。如何在无状态的 shell 调用之间维护这些状态？

### BashTool 的分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  BashTool.tsx — 编排层                                       │
│  输入校验 / 权限协调 / 结果解释 / 大输出持久化                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────────────┐
         ▼             ▼                     ▼
┌──────────────┐ ┌──────────────┐  ┌──────────────────────┐
│ bashPermi-   │ │ readOnly-    │  │ shouldUseSandbox()   │
│ ssions.ts    │ │ Validation.ts│  │ 沙箱决策             │
│ 权限判定      │ │ 只读快速路径  │  │                      │
└──────────────┘ └──────────────┘  └──────────┬───────────┘
                                              │
┌─────────────────────────────────────────────┼───────────────┐
│  Shell.ts — 执行层                           │               │
│  ┌───────────────────────────────────────────┼─────────┐    │
│  │  exec(command, signal, shell, options)     │         │    │
│  │  ├─ 构建 shell 命令字符串                   │         │    │
│  │  ├─ 可选: SandboxManager.wrapWithSandbox() ◄─────────┘    │
│  │  ├─ child_process.spawn()                              │    │
│  │  ├─ TaskOutput 流式输出捕获                             │    │
│  │  ├─ 超时 / 后台化处理                                   │    │
│  │  └─ cwd 追踪与更新                                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  sandbox-adapter.ts — 沙箱适配层                             │
│  ├─ 将 Claude Code 设置转换为 sandbox-runtime 配置           │
│  ├─ 文件系统限制 (allowWrite/denyWrite/allowRead/denyRead)  │
│  ├─ 网络限制 (allowedDomains/deniedDomains)                 │
│  ├─ Git bare-repo 文件清理 (防 hook 逃逸)                    │
│  └─ Worktree 主仓库路径检测                                  │
└─────────────────────────────────────────────────────────────┘
```

### 命令执行的完整生命周期

```
1. 模型调用 BashTool({ command: "npm test", timeout: 30000 })
   │
   ▼
2. 输入校验
   ├─ Zod schema 校验
   ├─ detectBlockedSleepPattern() — 阻止无意义的 sleep 轮询
   └─ modeValidation — 检查当前模式是否允许 Bash
   │
   ▼
3. 权限检查 (bashPermissions.ts)
   ├─ 解析命令前缀: getSimpleCommandPrefix("git commit -m 'fix'") → "git commit"
   ├─ 规则匹配: 用户是否配置了 alwaysAllow("Bash(git commit *)")?
   ├─ 只读检查: checkReadOnlyConstraints() — ls/cat/grep 等可自动放行
   ├─ 路径校验: pathValidation — 命令是否操作了允许的路径?
   ├─ sed 校验: sedValidation — sed 写操作需要额外确认
   └─ 分类器: bashClassifier (如果启用)
   │
   ▼
4. 沙箱决策 (shouldUseSandbox.ts)
   ├─ 全局沙箱是否启用?
   ├─ 命令是否在排除列表中?
   ├─ 用户是否显式禁用沙箱 (dangerouslyDisableSandbox)?
   └─ 策略是否允许非沙箱执行?
   │
   ▼
5. Shell 执行 (Shell.ts → exec())
   ├─ 构建完整 shell 命令 (包含 cwd 追踪脚本)
   ├─ 如果沙箱: SandboxManager.wrapWithSandbox(command)
   ├─ child_process.spawn(shell, ['-c', wrappedCommand])
   ├─ stdout/stderr → TaskOutput (合并为单一流)
   ├─ 超时处理:
   │   ├─ 超时 + 允许后台化 → 转为后台任务
   │   └─ 超时 + 不允许后台化 → 终止进程
   └─ 进程退出 → 返回 ExecResult
   │
   ▼
6. 结果处理 (BashTool.tsx → call())
   ├─ 解释退出码和输出
   ├─ 沙箱违规注解 (如果有)
   ├─ cwd 更新/重置
   ├─ 大输出持久化 (> maxResultSizeChars → 写入 tool-results/)
   ├─ 输出截断 (formatOutput)
   └─ 返回 ToolResult<BashOutput>
```

### 命令安全分类：多层防御

BashTool 的权限检查不是简单的黑白名单，而是一个**多层分类系统**：

**Layer 1：结构化解析**

命令不是用正则表达式匹配的，而是通过 AST 解析器（`src/utils/bash/parser.ts`、`src/utils/bash/ast.ts`）进行结构化分析。这让系统可以理解复合命令的结构：

```bash
# 解析器能正确处理这些情况：
timeout 10 git status          # 剥离 timeout 包装，识别为 "git status"
cd /tmp && rm -rf *            # 识别为两个命令：cd + rm
echo "rm -rf /" | cat          # 识别 rm 在管道中，不是直接执行
VAR=value git push             # 剥离环境变量前缀
```

**Layer 2：只读快速路径**

`readOnlyValidation.ts` 实现了一个**允许快速路径**——如果命令被判定为纯只读，可以跳过用户确认直接执行：

```typescript
function checkReadOnlyConstraints(input, compoundCommandHasCd): boolean {
  // 纯读取命令可以自动放行
  // 但有大量防御性检查：
  // - git 命令可能触发 hooks（不是只读的！）
  // - cd && git ... 可能利用 bare-repo 触发恶意 hook
  // - 进程替换 <() 可能有副作用
  // - heredoc 可能包含危险内容
}
```

这里有一个特别值得注意的安全考量：**Git 命令不一定是只读的**。即使是 `git status`，如果当前目录被恶意设置为一个 bare repository，Git 可能执行 hooks 中的任意代码。`readOnlyValidation.ts` 对 Git 相关命令有专门的防护逻辑。

**Layer 3：路径校验**

`pathValidation.ts` 检查命令是否操作了允许范围内的路径。比如，如果用户配置了只允许在项目目录内写入，那么 `echo "test" > /etc/passwd` 会被拦截。

**Layer 4：sed 特殊处理**

`sedValidation.ts` 和 `sedEditParser.ts` 对 `sed` 命令做了特殊处理。`sed -i` 是一个文件编辑操作，但它通过 BashTool 而不是 FileEditTool 执行。系统会解析 sed 命令的编辑意图，并在权限确认时展示预览。

更有趣的是 `applySedEdit()` 函数——当用户批准了一个 sed 编辑后，系统**不是执行 sed 命令**，而是直接在内存中应用编辑。这确保了用户在权限对话框中看到的预览与实际执行的结果完全一致。

### 沙箱机制

沙箱是 BashTool 安全架构的最后一道防线。它通过 `@anthropic-ai/sandbox-runtime` 实现，`sandbox-adapter.ts` 是 Claude Code 与沙箱运行时之间的适配层。

```
Claude Code 设置                    sandbox-runtime 配置
┌─────────────────┐                ┌─────────────────────┐
│ alwaysAllow:     │                │ filesystem:          │
│   Write(~/proj/) │  ──转换──→    │   allowWrite:        │
│ alwaysDeny:      │                │     - ~/proj/        │
│   Write(/etc/)   │                │   denyWrite:         │
│                  │                │     - /etc/          │
│ allowedDomains:  │                │     - .claude/       │
│   - npm.org      │                │ network:             │
│                  │                │   allowedDomains:    │
│ cwd: ~/proj      │                │     - npm.org        │
└─────────────────┘                └─────────────────────┘
```

沙箱的关键安全加固：

**1. Git bare-repo 文件清理**

```typescript
// sandbox-adapter.ts
scrubBareGitRepoFiles() {
  // 删除可疑的 bare-repo 文件：HEAD, objects, refs, hooks, config
  // 防止恶意仓库通过 git hooks 实现沙箱逃逸
}
```

这是一个针对特定攻击向量的防御：攻击者可以在项目目录中植入 bare Git repository 文件，当 Claude Code 执行 `git` 命令时，Git 会识别这些文件并执行其中的 hooks——即使在沙箱内，hooks 也可能利用沙箱的允许路径进行恶意操作。

**2. 敏感路径保护**

```typescript
// 始终拒绝写入的路径
denyWrite: [
  '.claude/settings.json',     // 防止修改自身配置
  '.claude/settings.local.json',
  '.claude/skills/',           // 防止注入恶意 skill
]
```

**3. Worktree 感知**

```typescript
detectWorktreeMainRepoPath(cwd) {
  // 如果当前目录是 git worktree，
  // 需要额外授权对主仓库 .git 目录的写入
  // 否则 git commit 等操作会失败
}
```

### 超时与后台执行

BashTool 支持三种超时/后台模式：

```
┌─────────────────────────────────────────────────────────────┐
│  模式 1: 显式后台                                            │
│  input: { command: "npm test", run_in_background: true }    │
│  → 立即创建后台 shell 任务，返回 taskId                       │
│  → 模型可以通过 TaskOutputTool 查看输出                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  模式 2: 超时自动后台化                                       │
│  input: { command: "make build", timeout: 120000 }          │
│  → 前台执行，超时后自动转为后台任务                            │
│  → 模型收到 "命令已转为后台执行" 的通知                        │
│  → 适用于编译等"可能很快也可能很慢"的命令                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  模式 3: KAIROS 模式自动后台化                                │
│  在 Assistant 模式下，前台命令运行超过 15 秒                   │
│  → 自动转为后台，保持主代理响应性                              │
│  → 防止长命令阻塞用户交互                                     │
└─────────────────────────────────────────────────────────────┘
```

**为什么需要"超时自动后台化"而不是直接杀死进程？**

因为很多开发命令的执行时间是不确定的。`npm install` 可能 5 秒完成，也可能 2 分钟。如果超时就杀死，用户需要手动重新执行。自动后台化让命令继续运行，同时释放主对话循环，模型可以做其他事情，稍后通过 `TaskOutputTool` 检查结果。

### 输出管理：三层截断

```
Layer 1: Shell.ts — 流式输出
  └─ TaskOutput 捕获 stdout+stderr（合并为单一流，保持时序）
  └─ 如果输出文件 > 64MB，截断源文件

Layer 2: BashTool.tsx — 结果截断
  └─ EndTruncatingAccumulator 保持有界输出
  └─ formatOutput(): 超过 maxLength 时截断，附加 "[N lines truncated]"
  └─ 大输出持久化到 tool-results/ 目录

Layer 3: UI.tsx — 显示截断
  └─ 按行数和字符数截断显示
  └─ 用户可以展开查看完整输出
```

**为什么 stdout 和 stderr 合并为单一流？**

因为在实际的命令输出中，stdout 和 stderr 是交错的。如果分开捕获，就会丢失时序信息。比如编译器的警告（stderr）和编译进度（stdout）交替出现，合并流保持了它们的原始顺序。

### 设计决策讨论

**为什么 BashTool 不直接使用 FileEditTool 的权限系统？**

因为 Bash 命令的安全分析比文件编辑复杂得多。FileEditTool 的权限模型是"对哪个文件做什么操作"，而 BashTool 的权限模型是"这个命令可能做什么"——后者需要理解命令的语义，而不仅仅是操作的目标。

这就是为什么 BashTool 有自己的一整套安全基础设施：AST 解析器、只读验证器、路径验证器、sed 验证器、沙箱适配器。这些组件共同构成了一个**命令级别的安全分析框架**，而不是简单的路径级别的访问控制。

**为什么 `bashClassifier` 在当前构建中是禁用的？**

源码中 `bashClassifier.ts` 存在但返回 `matches: false`。这表明分类器是一个**集成点**——架构上预留了位置，但实际的分类逻辑可能依赖于外部服务或模型，在开源版本中被禁用。实际的安全决策由解析器/验证器/沙箱三层防御承担。

---

## 3.6 FileEditTool 深度解析

### 面临的问题

让 LLM 编辑文件是 Claude Code 最核心的能力之一。但"编辑文件"这个看似简单的操作，隐藏着大量工程挑战：

1. **精确性问题**：LLM 需要指定"编辑什么"和"改成什么"。如果用行号定位，模型容易数错行；如果用 AST 定位，需要为每种语言实现解析器。如何设计一个既精确又通用的编辑机制？

2. **并发安全问题**：用户可能在 Claude Code 编辑文件的同时手动修改了同一个文件。如何检测并防止覆盖用户的修改？

3. **编码问题**：文件可能是 UTF-8、UTF-16LE、使用 LF 或 CRLF 换行。编辑操作必须保持原始编码和换行风格。

4. **安全问题**：编辑操作可能针对敏感文件（如 `.claude/settings.json`），恶意编辑可能修改 Claude Code 自身的配置。

### 解法：基于字符串匹配的精确编辑

Claude Code 选择了一个出人意料的简单方案：**精确子字符串替换**。

```typescript
// FileEditTool 的输入 schema
inputSchema: z.object({
  file_path: z.string(),
  old_string: z.string(),   // 要替换的精确文本
  new_string: z.string(),   // 替换后的文本
  replace_all: z.boolean().default(false),  // 是否替换所有匹配
})
```

不是行号，不是 AST 节点，不是 diff patch——就是**精确的字符串匹配和替换**。

这个设计看起来"原始"，但它有几个关键优势：

- **语言无关**：不需要为每种编程语言实现解析器
- **精确无歧义**：字符串要么匹配要么不匹配，没有"差一行"的问题
- **模型友好**：LLM 擅长生成精确的文本片段，不擅长计算行号
- **可验证**：用户可以直接看到 old_string 和 new_string，判断编辑是否正确

**trade-off**：当文件中有多个相同的字符串时，需要提供更多上下文来唯一定位。这就是 `replace_all` 参数的用途——如果确实要替换所有匹配，显式声明。

### 编辑的完整验证链

FileEditTool 的 `validateInput()` 实现了一个**14 步验证链**，每一步都有明确的安全或正确性目的：

```
validateInput(input, context)
  │
  ├─ ① expandPath(file_path)
  │     路径规范化，防止 ~、相对路径、分隔符不一致
  │
  ├─ ② checkTeamMemSecrets(path, new_string)
  │     阻止向团队记忆文件中写入密钥
  │
  ├─ ③ old_string === new_string?
  │     拒绝无操作编辑（浪费 token）
  │
  ├─ ④ matchingRuleForInput(path, 'edit', 'deny')
  │     检查文件系统 deny 规则
  │
  ├─ ⑤ UNC 路径检查 (\\server\share)
  │     Windows: 跳过文件系统操作，防止 NTLM 凭据泄露
  │     （仅探测 UNC 路径就可能触发 SMB 认证）
  │
  ├─ ⑥ stat(file) → 文件大小 > 1GiB?
  │     拒绝编辑超大文件
  │
  ├─ ⑦ 读取文件内容，检测编码 (UTF-8 / UTF-16LE BOM)
  │     规范化 CRLF → LF 用于比较
  │
  ├─ ⑧ 文件存在性语义:
  │     ├─ 文件不存在 + old_string 为空 → 创建新文件 ✓
  │     ├─ 文件不存在 + old_string 非空 → 拒绝 ✗
  │     ├─ 文件存在 + old_string 为空 + 文件非空 → 拒绝 ✗
  │     └─ 文件存在 + old_string 为空 + 文件为空 → 写入 ✓
  │
  ├─ ⑨ .ipynb 文件?
  │     拒绝，引导使用 NotebookEditTool
  │
  ├─ ⑩ readFileState.get(path) 存在?
  │     必须先读取文件才能编辑（防止盲写）
  │     isPartialView? → 拒绝（只看了部分不能编辑全文）
  │
  ├─ ⑪ 文件修改时间 > 缓存时间戳?
  │     文件在读取后被外部修改 → 拒绝（防止覆盖用户修改）
  │     例外：全文读取 + 内容未变 → 允许（仅 mtime 变化）
  │
  ├─ ⑫ findActualString(file, old_string)
  │     在文件中查找匹配（支持引号规范化）
  │     未找到 → 拒绝
  │
  ├─ ⑬ 匹配数 > 1 且 replace_all = false?
  │     歧义匹配 → 拒绝，要求提供更多上下文或使用 replace_all
  │
  └─ ⑭ validateInputForSettingsFileEdit(path, simulatedContent)
        如果是 Claude Code 设置文件，模拟编辑结果并验证合法性
```

### FileStateCache：读写协调的核心机制

FileEditTool 安全性的核心在于 `FileStateCache`——一个 LRU 缓存，记录了模型"看到"的每个文件的状态：

```typescript
// src/utils/fileStateCache.ts

type FileState = {
  content: string       // 读取时的文件内容
  timestamp: number     // 读取时的文件 mtime
  offset?: number       // 读取的起始行（如果是部分读取）
  limit?: number        // 读取的行数限制
  isPartialView?: boolean  // 是否是部分视图（如 CLAUDE.md 的精简版）
}

// LRU 缓存，路径规范化，最大 25MB
class FileStateCache extends LRUCache<string, FileState> {
  get(path: string): FileState | undefined {
    return super.get(normalize(path))
  }
  set(path: string, state: FileState): this {
    return super.set(normalize(path), state)
  }
}
```

这个缓存建立了一个关键的**读写协调协议**：

```
FileReadTool.call()                    FileEditTool.validateInput()
  │                                      │
  │ 读取文件内容                          │ 检查缓存
  │ 记录 mtime                           │ ├─ 缓存不存在? → 拒绝
  │ 存入 FileStateCache                  │ │   "必须先读取文件"
  │   {                                  │ ├─ isPartialView? → 拒绝
  │     content: "...",                  │ │   "只看了部分不能编辑"
  │     timestamp: 1234567890,           │ ├─ 当前 mtime > 缓存 mtime? → 拒绝
  │     offset: undefined,               │ │   "文件已被外部修改"
  │     limit: undefined,                │ └─ 通过 → 允许编辑
  │   }                                  │
  │                                      │
  ▼                                      ▼
FileEditTool.call()
  │
  │ 执行编辑
  │ 更新 FileStateCache
  │   {
  │     content: "编辑后的内容",
  │     timestamp: 新的 mtime,
  │     offset: undefined,    // ← 重要：编辑后视为全文已知
  │     limit: undefined,
  │   }
  │
  ▼
后续 FileReadTool.call()
  │
  │ 检查缓存：同路径 + 同 mtime?
  │ ├─ YES → 返回 "file_unchanged"（去重优化）
  │ └─ NO  → 重新读取
```

**为什么编辑后将 `offset` 设为 `undefined`？**

编辑后，缓存中存储的是完整的编辑后内容。将 `offset` 设为 `undefined` 表示"模型现在知道整个文件的内容"。但这不会触发 FileReadTool 的去重逻辑——因为去重检查要求 `existingState.offset !== undefined`。这个微妙的区分确保了：

- 编辑后的缓存不会被误认为是一次"读取"
- 后续的 FileReadTool 调用会重新读取文件（因为编辑可能改变了文件内容）
- 但 FileEditTool 的验证仍然可以使用缓存来检测外部修改

### 引号规范化：处理 LLM 的"创意"

LLM 有时会将直引号（`""`）替换为弯引号（`""`），或反过来。如果严格匹配，这些编辑会失败。FileEditTool 通过引号规范化解决这个问题：

```typescript
// src/tools/FileEditTool/utils.ts

function findActualString(fileContent: string, searchString: string): string | null {
  // 1. 先尝试精确匹配
  if (fileContent.includes(searchString)) {
    return searchString
  }

  // 2. 规范化引号后重试
  const normalizedFile = normalizeQuotes(fileContent)
  const normalizedSearch = normalizeQuotes(searchString)
  const index = normalizedFile.indexOf(normalizedSearch)

  if (index !== -1) {
    // 返回文件中的原始子串（保持原始引号风格）
    return fileContent.substring(index, index + normalizedSearch.length)
  }

  return null
}
```

配套的 `preserveQuoteStyle()` 函数确保替换文本也使用文件的原始引号风格：

```typescript
function preserveQuoteStyle(oldString, actualOldString, newString): string {
  // 如果匹配是通过引号规范化成功的，
  // 将 newString 中的引号替换为文件中使用的引号风格
  // 支持：弯双引号、弯单引号、缩写撇号
}
```

这个设计体现了一个重要原则：**工具应该适应 LLM 的行为特征，而不是要求 LLM 完美**。引号混淆是 LLM 的已知行为，工具层面的容错比在 prompt 中反复强调"不要改变引号"更可靠。

### 反序列化支持：处理模型输出的 sanitization

LLM 的输出有时会被 API 层 sanitize（比如将 `<function_results>` 替换为 `<fnr>`）。`normalizeFileEditInput()` 函数处理这种情况：

```typescript
function normalizeFileEditInput(oldString, newString, fileContent) {
  // 如果 oldString 在文件中找不到，尝试反序列化：
  // <fnr> → <function_results>
  // <n>   → <name>
  // \n\nH: → \n\nHuman:
  // 等等
  //
  // 同时对 newString 应用相同的反序列化
}
```

### Diff 生成与展示

编辑完成后，FileEditTool 生成 diff 用于 UI 展示和权限确认：

```typescript
// src/tools/FileEditTool/utils.ts

function getPatchForEdits(originalContent, edits): string {
  let updatedFile = originalContent

  for (const edit of edits) {
    // 安全检查：后续编辑的 old_string 不能是前一个编辑的 new_string 的子串
    // 防止编辑链中的歧义
    if (previousNewStrings.some(ns => ns.includes(edit.oldString))) {
      throw new Error('Ambiguous edit chain')
    }

    updatedFile = updatedFile.replace(edit.oldString, edit.newString)
  }

  // 生成 unified diff（tab → spaces 用于显示）
  return getPatchFromContents(originalContent, updatedFile)
}
```

**为什么 diff 中将 tab 转换为 spaces？**

源码注释说这是"仅用于显示"——终端中 tab 的宽度不确定，转换为 spaces 可以保证 diff 在任何终端中都有一致的对齐。实际写入文件时使用的是原始内容，不受此转换影响。

### 设计决策讨论

**为什么选择字符串匹配而不是行号或 AST？**

| 方案 | 优势 | 劣势 |
|------|------|------|
| 行号 | 简单直接 | LLM 经常数错行；文件修改后行号失效 |
| AST | 语义精确 | 需要为每种语言实现解析器；不支持非代码文件 |
| Diff patch | 标准格式 | LLM 生成的 diff 经常格式错误；上下文行可能过时 |
| **字符串匹配** | **语言无关；LLM 友好；可验证** | **需要唯一性；大文件中可能有重复** |

字符串匹配的"唯一性要求"看起来是个限制，但实际上它是一个**安全特性**——如果模型不确定要编辑哪个位置，系统会拒绝而不是猜测。这比"猜错了编辑了错误的位置"要好得多。

**"必须先读取才能编辑"的设计意图是什么？**

这个约束不仅仅是为了防止盲写——它建立了一个**因果链**：

1. 模型读取文件 → 理解当前内容
2. 模型基于理解生成编辑 → old_string 来自实际内容
3. 系统验证 old_string 仍然匹配 → 确保文件未被修改
4. 执行编辑 → 结果可预测

如果跳过第 1 步，模型可能基于过时的记忆或猜测生成 old_string，导致编辑失败或编辑错误的位置。

**`isPartialView` 为什么阻止编辑？**

如果模型只看到了文件的部分内容（比如通过 `offset`/`limit` 参数读取了中间几行），它可能不了解文件的完整结构。在这种情况下允许编辑是危险的——模型可能不知道它的编辑会影响文件的其他部分。

特别是对于自动注入的 CLAUDE.md 文件（`isPartialView: true`），系统会剥离注释和 frontmatter 后注入。如果允许基于这个精简版本编辑，模型可能会意外删除被剥离的内容。

---

## 3.7 AgentTool 与子代理工具过滤

### 面临的问题

AgentTool 让主代理可以派生子代理来处理复杂任务。但子代理不应该拥有和主代理完全相同的工具集——这会带来几个问题：

1. **递归风险**：如果子代理可以调用 AgentTool，它就能派生孙代理，孙代理再派生曾孙代理……无限递归会耗尽资源。
2. **权限泄露**：主代理的某些工具（如 `AskUserQuestionTool`）需要 UI 交互，但异步子代理没有 UI——调用这些工具会导致挂起。
3. **职责混乱**：子代理不应该能修改主代理的计划（`ExitPlanModeTool`）、管理后台任务（`TaskStopTool`）、或执行其他"元操作"。
4. **不同类型的子代理需要不同的工具集**：同步子代理、异步子代理、协调器 worker、进程内队友——每种角色的能力边界不同。

### 解法：多层工具过滤策略

```
主代理工具池 (30+ 工具)
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: ALL_AGENT_DISALLOWED_TOOLS (硬性禁止)              │
│  所有子代理都不能使用的工具:                                   │
│  ├─ TaskOutputTool      (后台任务管理是主代理的职责)           │
│  ├─ ExitPlanModeTool    (计划模式是主代理的状态)               │
│  ├─ EnterPlanModeTool   (同上)                               │
│  ├─ AskUserQuestionTool (子代理没有 UI)                       │
│  ├─ TaskStopTool        (任务管理是主代理的职责)               │
│  └─ AgentTool           (防止递归，除非 USER_TYPE=ant)        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 角色特定过滤                                       │
│                                                             │
│  异步子代理 → ASYNC_AGENT_ALLOWED_TOOLS (白名单模式)          │
│    只允许: Read/Write/Edit/Bash/Glob/Grep/WebFetch/          │
│           WebSearch/Notebook/Skill/ToolSearch/Worktree       │
│                                                             │
│  协调器 worker → COORDINATOR_MODE_ALLOWED_TOOLS              │
│    只允许: Agent/TaskStop/SendMessage/SyntheticOutput        │
│                                                             │
│  进程内队友 → 额外允许:                                       │
│    AgentTool + TaskCreate/Get/List/Update + SendMessage      │
│    + CronTools (如果启用)                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Agent 定义级过滤                                   │
│  每个 Agent 可以声明:                                        │
│  ├─ tools: ['Bash', 'Read', 'Grep']  (白名单)               │
│  ├─ disallowedTools: ['WebFetch']     (黑名单)               │
│  └─ tools: ['*']                      (允许所有)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
              子代理最终工具集
```

### `filterToolsForAgent()`：硬性过滤

```typescript
// src/tools/AgentTool/agentToolUtils.ts — 简化

function filterToolsForAgent(
  tools: Tools,
  isAsync: boolean,
  isBuiltIn: boolean,
  isInProcessTeammate: boolean,
): Tools {
  return tools.filter(tool => {
    // MCP 工具始终允许通过
    if (tool.isMcp) return true

    // 硬性禁止列表
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      // 例外：进程内队友可以使用 AgentTool
      if (isInProcessTeammate && tool.name === AGENT_TOOL_NAME) return true
      // 例外：进程内队友的额外工具
      if (isInProcessTeammate && IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) return true
      return false
    }

    // 自定义 Agent 的额外禁止列表
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false

    // 异步子代理：白名单模式
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return false

    return true
  })
}
```

注意 MCP 工具的特殊待遇——它们**始终通过**硬性过滤。这是因为 MCP 工具是用户显式配置的外部工具，系统不应该替用户决定子代理能否使用它们。

### `resolveAgentTools()`：Agent 定义级过滤

```typescript
function resolveAgentTools(
  agentDefinition: AgentDefinition,
  availableTools: Tools,
  isAsync: boolean,
): { resolvedTools: Tools; invalidToolSpecs: string[] } {
  // Step 1: 硬性过滤
  let filtered = filterToolsForAgent(availableTools, isAsync, ...)

  // Step 2: 应用 disallowedTools
  if (agentDefinition.disallowedTools) {
    filtered = filtered.filter(t => !agentDefinition.disallowedTools.includes(t.name))
  }

  // Step 3: 应用 tools 白名单
  if (!agentDefinition.tools || agentDefinition.tools.includes('*')) {
    return { resolvedTools: filtered, invalidToolSpecs: [] }
  }

  // 解析显式工具列表，支持 "Agent(explore, plan)" 语法
  return resolveExplicitToolList(agentDefinition.tools, filtered)
}
```

Agent 定义中的 `tools` 字段支持一种特殊语法：`Agent(explore, plan)`。这表示"允许 AgentTool，但只能派生 explore 和 plan 类型的子代理"。这种语法让 Agent 定义可以精确控制递归派生的范围。

### Fork 模式：工具集的完全继承

当启用 fork 实验时，省略 `subagent_type` 会创建一个**fork 子代理**——它继承父代理的完整工具集和系统提示：

```typescript
// src/tools/AgentTool/AgentTool.tsx — fork 路径

if (isForkMode) {
  return runAgent({
    availableTools: toolUseContext.options.tools,  // 父代理的完整工具集
    useExactTools: true,                           // 跳过 resolveAgentTools
    // ...
  })
}
```

`useExactTools: true` 告诉 `runAgent` 跳过所有工具过滤逻辑，直接使用传入的工具数组。这是为了**prompt cache 稳定性**——fork 子代理的系统提示和工具定义必须与父代理字节级一致，才能命中 API 的 prompt cache。如果经过 `resolveAgentTools` 过滤，工具顺序或内容可能发生微小变化，导致 cache miss。

**防递归保护**：fork 模式通过两个机制防止无限递归：
1. `isInForkChild(messages)` 检查消息历史中是否存在 fork 标记
2. `toolUseContext.options.querySource` 检查是否已经在 fork 子代理中

### Worker 工具池的独立组装

一个重要的架构决策：**worker 的工具池是独立组装的，不受父代理工具限制的影响。**

```typescript
// src/tools/AgentTool/AgentTool.tsx — worker 工具组装

// Worker 工具池独立于父代理
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)

// 传给 runAgent
runAgent({
  availableTools: workerTools,  // 不是 toolUseContext.options.tools
  // ...
})
```

源码注释明确说明了这个设计意图：workers 不受父代理的工具限制影响。这意味着即使父代理因为某些原因（比如 SIMPLE 模式）只有 3 个工具，它派生的 worker 仍然可以拥有完整的工具集。

**为什么这样设计？**

因为父代理和 worker 的角色不同。父代理可能是一个协调器（只需要 Agent + TaskStop），但它派生的 worker 需要实际执行任务（需要 Bash + Read + Edit + ...）。如果 worker 继承父代理的工具限制，协调器模式就无法工作。

### 内置 Agent 类型与工具集

Claude Code 预定义了几种内置 Agent 类型，每种有不同的工具集和行为：

```
┌─────────────────────────────────────────────────────────────┐
│  general-purpose (通用)                                      │
│  工具: 所有可用工具（经过标准过滤）                             │
│  用途: 复杂的多步骤任务                                       │
│  特点: 最灵活，能力最强                                       │
├─────────────────────────────────────────────────────────────┤
│  Explore (探索)                                              │
│  工具: 只读工具 (Read/Glob/Grep/WebFetch/WebSearch 等)       │
│  禁止: Agent/ExitPlanMode/Edit/Write/NotebookEdit            │
│  用途: 代码库探索和研究                                       │
│  特点: 快速、安全、不会修改任何文件                             │
├─────────────────────────────────────────────────────────────┤
│  Plan (规划)                                                 │
│  工具: 只读工具（同 Explore）                                 │
│  禁止: Agent/ExitPlanMode/Edit/Write/NotebookEdit            │
│  用途: 设计实现方案                                           │
│  特点: 专注于分析和规划，不执行                                │
├─────────────────────────────────────────────────────────────┤
│  claude-code-guide (指南)                                    │
│  工具: Glob/Grep/Read/WebFetch/WebSearch                     │
│  用途: 回答关于 Claude Code 本身的问题                         │
│  特点: 工具集最小，专注于信息检索                               │
├─────────────────────────────────────────────────────────────┤
│  statusline-setup (状态栏配置)                                │
│  工具: Read/Edit                                             │
│  用途: 配置用户的状态栏设置                                    │
│  特点: 极度受限，只能读写配置文件                               │
└─────────────────────────────────────────────────────────────┘
```

### Agent 定义的加载与发现

除了内置 Agent，用户可以在 `.claude/agents/` 目录中定义自定义 Agent：

```typescript
// src/tools/AgentTool/loadAgentsDir.ts

interface AgentDefinition {
  name: string
  description: string
  tools?: string[]              // 工具白名单
  disallowedTools?: string[]    // 工具黑名单
  permissionMode?: PermissionMode
  mcpServers?: AgentMcpServerSpec[]  // Agent 专属 MCP 服务器
  background?: boolean          // 是否默认后台运行
  isolation?: 'worktree' | 'remote'  // 隔离模式
}
```

自定义 Agent 可以声明自己的 MCP 服务器——这些服务器只在该 Agent 运行时启动，Agent 结束后关闭。这实现了**Agent 级别的服务隔离**。

### 设计决策讨论

**为什么默认禁止子代理调用 AgentTool（递归派生）？**

无限递归是一个真实的风险——模型可能陷入"派生子代理来解决问题，子代理又派生子代理"的循环。禁止递归是最安全的默认值。

但 Anthropic 内部版本（`USER_TYPE === 'ant'`）允许递归，因为内部用户可能需要更复杂的多层代理架构。进程内队友也允许递归，因为队友模式本身就是一个多代理协作框架。

**为什么异步子代理用白名单而同步子代理用黑名单？**

异步子代理在后台运行，没有 UI 交互能力。如果用黑名单，可能遗漏某个需要 UI 的工具，导致子代理挂起。白名单更安全——只允许已知安全的工具。

同步子代理在前台运行，可以通过父代理的 UI 进行交互。黑名单足够——只需要排除明确不适合子代理的工具。

**fork 模式为什么要牺牲工具过滤来换取 cache 稳定性？**

这是一个典型的**性能 vs 安全**的 trade-off。fork 子代理继承父代理的完整工具集，意味着它可能拥有一些"不应该有"的工具。但 fork 模式的核心价值是**共享 prompt cache**——父代理和 fork 子代理使用相同的系统提示和工具定义，API 可以复用缓存的 KV 状态，显著减少首 token 延迟。

如果为了安全而过滤工具，cache 就会失效，fork 模式的性能优势就消失了。Claude Code 选择了性能，同时通过防递归保护来限制风险。

---

## 3.8 设计哲学总结

回顾整个工具系统的架构，可以提炼出几个贯穿始终的设计哲学：

### 哲学一：安全特性是调用级别的，不是工具级别的

传统的工具权限系统通常将工具标记为"安全"或"危险"。Claude Code 的做法更精细——同一个工具（如 BashTool），对于不同的输入有不同的安全特性。`isReadOnly(input)`、`isConcurrencySafe(input)`、`isDestructive(input)` 都接受 `input` 参数。

这意味着 `ls -la` 和 `rm -rf /` 虽然都通过 BashTool 执行，但它们在权限系统中被完全不同地对待。这种**输入感知的安全模型**比工具级别的标记精确得多，也更符合实际使用场景。

### 哲学二：适应 LLM 的行为特征，而不是要求 LLM 完美

FileEditTool 的引号规范化、反序列化支持、字符串匹配（而非行号）——这些设计都体现了同一个原则：**工具层面的容错比 prompt 层面的约束更可靠**。

LLM 会混淆直引号和弯引号、会数错行号、会输出被 sanitize 的文本。与其在 system prompt 中反复强调"不要这样做"，不如在工具实现中优雅地处理这些情况。

### 哲学三：fail-closed 的默认值

`buildTool()` 的默认值选择体现了**安全优先**的哲学：
- `isConcurrencySafe` 默认 `false`（假设不安全）
- `isReadOnly` 默认 `false`（假设有写操作）
- `interruptBehavior` 默认 `'block'`（假设不能中断）

每个工具必须**显式声明**自己是安全的、只读的、可中断的。忘记声明的后果是"过度保守"（多问一次用户确认），而不是"过度宽松"（执行了不该执行的操作）。

### 哲学四：工具池是动态的，不是静态的

工具池不是一个写死的列表，而是根据以下因素动态组装的：
- 编译期 feature flags（`feature('KAIROS')`）
- 运行时环境变量（`process.env.USER_TYPE`）
- 权限规则（`alwaysDeny` rules）
- 运行模式（SIMPLE / REPL / Coordinator）
- MCP 服务器连接状态
- 子代理类型和角色
- 工具数量阈值（ToolSearch 启用条件）

这种动态性让同一个代码库可以服务于完全不同的使用场景——从最小化的 SDK bare 模式（3 个工具）到完整的交互式 REPL（30+ 内置 + 无限 MCP 工具）。

### 哲学五：每个 tool_use 必须有 tool_result

这是一个**协议级别的不变量**，贯穿了整个执行流程。无论工具执行成功、失败、被拒绝、被中止、还是因超时而终止，系统都会生成一个 `tool_result`。`yieldMissingToolResultBlocks()` 是这个不变量的最后防线——即使在最极端的错误场景下，消息历史的结构完整性也不会被破坏。

这个不变量的重要性在于：它让对话循环可以**无条件地继续**。模型不需要处理"tool_use 没有对应 tool_result"的异常情况，简化了模型的推理负担。

---

## 3.9 关键源码索引

| 文件路径 | 职责 | 章节 |
|---------|------|------|
| `src/Tool.ts` | Tool 泛型接口定义、ToolUseContext、ToolResult、buildTool() | 3.2 |
| `src/tools.ts` | 工具注册表、getAllBaseTools()、getTools()、assembleToolPool() | 3.3 |
| `src/query.ts` | 对话循环中的工具调用检测、执行调度、结果收集 | 3.4 |
| `src/hooks/useCanUseTool.tsx` | 权限检查的多层决策链 | 3.4 |
| `src/hooks/useMergedTools.ts` | 内置工具 + MCP 工具 + 插件工具的合并 | 3.3 |
| `src/constants/tools.ts` | 子代理工具策略集（禁止/允许列表） | 3.7 |
| `src/tools/BashTool/BashTool.tsx` | BashTool 编排层 | 3.5 |
| `src/tools/BashTool/bashPermissions.ts` | Bash 命令权限判定 | 3.5 |
| `src/tools/BashTool/readOnlyValidation.ts` | 只读命令快速路径 | 3.5 |
| `src/tools/BashTool/shouldUseSandbox.ts` | 沙箱决策 | 3.5 |
| `src/tools/BashTool/prompt.ts` | BashTool 的模型提示词生成 | 3.5 |
| `src/utils/Shell.ts` | Shell 命令执行引擎 | 3.5 |
| `src/utils/sandbox/sandbox-adapter.ts` | 沙箱适配层 | 3.5 |
| `src/utils/bash/parser.ts` | Bash 命令 AST 解析器 | 3.5 |
| `src/utils/bash/ast.ts` | Bash AST 节点定义 | 3.5 |
| `src/tools/FileEditTool/FileEditTool.ts` | FileEditTool 主实现 | 3.6 |
| `src/tools/FileEditTool/utils.ts` | 编辑工具函数（匹配、引号规范化、diff） | 3.6 |
| `src/tools/FileReadTool/FileReadTool.ts` | FileReadTool 主实现 | 3.6 |
| `src/tools/FileWriteTool/FileWriteTool.ts` | FileWriteTool 主实现 | 3.6 |
| `src/utils/fileStateCache.ts` | 文件状态 LRU 缓存 | 3.6 |
| `src/tools/AgentTool/AgentTool.tsx` | AgentTool 编排与生命周期 | 3.7 |
| `src/tools/AgentTool/runAgent.ts` | 子代理执行引擎 | 3.7 |
| `src/tools/AgentTool/agentToolUtils.ts` | 子代理工具过滤与解析 | 3.7 |
| `src/tools/AgentTool/forkSubagent.ts` | Fork 子代理实现 | 3.7 |
| `src/tools/AgentTool/loadAgentsDir.ts` | Agent 定义加载与发现 | 3.7 |
| `src/tools/AgentTool/builtInAgents.ts` | 内置 Agent 类型注册 | 3.7 |
| `src/tools/ToolSearchTool/ToolSearchTool.ts` | 延迟工具搜索 | 3.3 |
| `src/utils/toolSearch.ts` | ToolSearch 模式判定与工具发现 | 3.3 |
| `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` | 用户交互工具 | 3.3 |
| `src/utils/permissions/bashClassifier.ts` | Bash 命令分类器（集成点） | 3.5 |
