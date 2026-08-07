---
title: Claude Code 源码解析（五）· Agent 与多任务
description: '单个 Agent 处理复杂任务力不从心，如何派生子代理并行工作？多个 Agent 之间如何隔离状态、共享基础设施、协调分工？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第五章：Agent 与多任务系统（Agent & Task System）

> 从单线程对话到多 Agent 并发——Claude Code 如何实现子代理派生、后台任务和团队协作。

## 核心问题

一个 LLM 驱动的 CLI 工具，最朴素的交互模型是**单线程、同步、一问一答**：用户提问 → 模型思考 → 调用工具 → 返回结果 → 用户再提问。这个模型简单可靠，但面临三个根本性瓶颈：

1. **串行瓶颈。** 当用户要求"搜索整个代码库中所有 API 端点的定义"时，模型只能一个文件一个文件地搜索。如果能同时派出多个"搜索员"并行工作，效率可以提升数倍。

2. **长任务阻塞。** 当模型执行一个耗时 30 秒的 `npm test` 时，整个 REPL 被阻塞——用户无法输入新指令，模型无法做其他工作。如果能把长任务"扔到后台"，主线程继续响应用户，体验会好得多。

3. **上下文窗口限制。** 一个复杂任务（如"重构整个认证模块"）可能需要阅读数十个文件、执行数十次工具调用。所有这些信息堆积在一个对话上下文中，很快就会撑爆 token 预算。如果能把子任务分配给独立的 Agent，每个 Agent 有自己的上下文窗口，就能突破单一上下文的限制。

**核心矛盾：单一对话循环的简单性 vs 复杂任务对并发和隔离的需求。**

Claude Code 的解法是构建一个**分层的 Agent 与任务系统**——在核心对话循环之上，叠加了子代理派生（Subagent）、后台任务（Background Task）、Fork 子代理（Fork Subagent）、协调器模式（Coordinator Mode）和团队协作（Agent Swarms）等多种并发模型。每种模型解决不同场景的问题，但共享同一套任务基础设施。

---

## 5.1 架构总览

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  主对话循环 (QueryEngine)                                        │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  模型返回 tool_use: Agent(...)                                    │
│       │                                                           │
│       ├─ subagent_type 指定? ──→ 选择对应 AgentDefinition         │
│       │   ├─ "Explore"  → 只读搜索 Agent (Haiku 模型)            │
│       │   ├─ "Plan"     → 架构规划 Agent (无写入工具)             │
│       │   ├─ "general-purpose" → 通用 Agent (全工具集)            │
│       │   ├─ "worker"   → Coordinator 工人 Agent                  │
│       │   ├─ 自定义 .md → 用户/项目/插件定义的 Agent              │
│       │   └─ 未指定     → Fork 路径 (继承父上下文)                │
│       │                                                           │
│       ├─ run_in_background?                                       │
│       │   ├─ YES → 注册 LocalAgentTask, 异步执行                  │
│       │   │        父循环立即收到 task_id, 继续工作                │
│       │   │        完成后通过 <task-notification> 通知             │
│       │   └─ NO  → 同步执行, 父循环等待结果                       │
│       │                                                           │
│       ├─ isolation: "worktree"?                                   │
│       │   └─ YES → 创建 git worktree, Agent 在隔离副本中工作      │
│       │                                                           │
│       └─ name + team_name?                                        │
│           └─ YES → 通过 tmux/进程内 spawn 队友 Agent              │
│                                                                   │
│  模型返回 tool_use: Bash({run_in_background: true})               │
│       └─ 注册 LocalShellTask, 后台执行                            │
│          完成后通过 <task-notification> 通知                       │
│                                                                   │
│  模型返回 tool_use: SendMessage({to: "agent-id"})                 │
│       └─ 向运行中的 Agent 发送消息 (续传指令)                     │
│                                                                   │
│  模型返回 tool_use: TaskStop({task_id: "xxx"})                    │
│       └─ 终止后台任务                                             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ LocalShellTask│  │ LocalAgentTask   │  │ RemoteAgentTask  │
│ (后台 Shell)  │  │ (子代理/Fork)    │  │ (远程代理)       │
│              │  │                  │  │                  │
│ • 命令执行    │  │ • 独立对话循环    │  │ • CCR 远程会话    │
│ • 输出捕获    │  │ • 独立上下文窗口  │  │ • 跨机器执行      │
│ • 停滞检测    │  │ • 工具集裁剪      │  │                  │
│ • 磁盘输出    │  │ • 进度追踪        │  │                  │
└──────────────┘  └──────────────────┘  └──────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
                 ┌──────────────────────┐
                 │  Task 基础设施        │
                 │  ────────────────── │
                 │  • 统一状态机         │
                 │  • 磁盘输出持久化     │
                 │  • 通知队列           │
                 │  • 轮询与驱逐         │
                 └──────────────────────┘
```

这个架构的关键洞察是：**所有并发执行单元——无论是后台 Shell 命令、子代理、远程代理还是团队队友——都被统一抽象为 "Task"。** Task 提供了统一的生命周期管理（注册、运行、完成/失败/终止）、统一的输出持久化（磁盘文件）、统一的通知机制（`<task-notification>` XML 消息）。这意味着上层的 AgentTool、BashTool 等不需要各自实现一套后台执行逻辑——它们只需要创建对应类型的 Task，剩下的交给基础设施。

---

## 5.2 Task 抽象：统一的并发执行单元

### 面临的问题

Claude Code 需要管理多种类型的后台执行单元：
- 后台 Shell 命令（`npm test &`）
- 子代理（独立的 LLM 对话循环）
- 远程代理（在另一台机器上运行的 Claude Code 实例）
- 进程内队友（Agent Swarms 中的团队成员）
- 工作流任务（自动化脚本）
- 监控任务（MCP 监控）

这些执行单元的内部实现完全不同，但它们共享相同的生命周期需求：创建、运行、完成/失败/终止、输出捕获、通知父循环。

**如果每种类型各自实现一套生命周期管理，代码会迅速膨胀且难以维护。**

### 解法：Task 类型体系

```typescript
// src/Task.ts — 核心类型定义

export type TaskType =
  | 'local_bash'           // 后台 Shell 命令
  | 'local_agent'          // 子代理 (Subagent)
  | 'remote_agent'         // 远程代理 (CCR)
  | 'in_process_teammate'  // 进程内队友 (Agent Swarms)
  | 'local_workflow'       // 工作流任务
  | 'monitor_mcp'          // MCP 监控任务
  | 'dream'                // Dream 任务

export type TaskStatus =
  | 'pending'    // 已创建，等待启动
  | 'running'    // 正在执行
  | 'completed'  // 成功完成
  | 'failed'     // 执行失败
  | 'killed'     // 被用户/系统终止
```

状态机非常简单：`pending → running → completed | failed | killed`。没有"暂停"、"恢复"等中间状态——这是一个刻意的简化。

```typescript
// 判断任务是否处于终态
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

这个辅助函数在整个系统中被广泛使用：防止向已完成的任务注入消息、触发任务驱逐、清理资源等。

### Task ID：带类型前缀的随机标识符

```typescript
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b',              // b + 8位随机字符
  local_agent: 'a',             // a + 8位随机字符
  remote_agent: 'r',            // r + 8位随机字符
  in_process_teammate: 't',     // t + 8位随机字符
  local_workflow: 'w',          // w + 8位随机字符
  monitor_mcp: 'm',             // m + 8位随机字符
  dream: 'd',                   // d + 8位随机字符
}

// 36^8 ≈ 2.8 万亿种组合，足以抵抗暴力猜测
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}
```

ID 设计有两个巧妙之处：

1. **类型前缀**：通过 ID 的第一个字符就能判断任务类型（`b` = bash, `a` = agent, `r` = remote...），无需查询状态。这在日志、调试、UI 显示中非常方便。

2. **安全性**：注释提到 "36^8 ≈ 2.8 trillion combinations, sufficient to resist brute-force symlink attacks"。Task 的输出文件路径基于 ID 生成，如果 ID 可预测，攻击者可能通过符号链接劫持输出文件。使用 `crypto.randomBytes` 而非 `Math.random` 确保了密码学安全的随机性。

### TaskStateBase：任务状态的公共字段

```typescript
export type TaskStateBase = {
  id: string              // 任务 ID
  type: TaskType          // 任务类型
  status: TaskStatus      // 当前状态
  description: string     // 人类可读的描述
  toolUseId?: string      // 关联的 tool_use block ID
  startTime: number       // 启动时间戳
  endTime?: number        // 结束时间戳
  totalPausedMs?: number  // 总暂停时间
  outputFile: string      // 磁盘输出文件路径
  outputOffset: number    // 已读取的输出偏移量
  notified: boolean       // 是否已通知父循环
}
```

`notified` 字段是一个关键的**幂等性保护**。当任务完成时，系统需要向父对话循环发送一条 `<task-notification>` 消息。但完成事件可能被多个路径触发（正常完成、被 TaskStopTool 终止、进程清理等）。`notified` 标志确保通知只发送一次：

```typescript
// LocalAgentTask.tsx — 原子性检查并设置 notified 标志
let shouldEnqueue = false;
updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
  if (task.notified) {
    return task;  // 已通知，跳过
  }
  shouldEnqueue = true;
  return { ...task, notified: true };
});
if (!shouldEnqueue) return;
```

### Task 接口：最小化的多态

```typescript
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

这个接口极其精简——只有 `kill` 一个方法。源码注释解释了原因：

> spawn/render were never called polymorphically (removed in #22546). All six kill implementations use only setAppState — getAppState/abortController were dead weight.

最初的设计可能有 `spawn`、`render` 等多态方法，但实践中发现只有 `kill` 需要多态分发（因为不同类型的任务终止方式不同：Shell 需要杀进程，Agent 需要 abort 控制器，Remote 需要关闭远程会话）。其他操作都是类型特定的，不需要通过统一接口调用。

**这是一个"接口最小化"的工程决策**——不要为了"对称性"或"未来可能需要"而添加方法。只保留实际被多态调用的方法。

### 设计决策讨论

**为什么不用类继承而用联合类型？**

Task 系统没有使用 `class LocalShellTask extends BaseTask` 这样的继承结构，而是用 TypeScript 的联合类型 + 类型守卫：

```typescript
// tasks/types.ts
export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | ...

// 类型守卫
export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_agent'
}
```

这种方式的优势：
- **序列化友好**：TaskState 存储在 AppState（React 状态树）中，需要是纯数据对象。类实例不能直接序列化/反序列化。
- **不可变更新**：React 的状态更新要求返回新对象（`{ ...task, status: 'completed' }`），类实例的方法绑定在原型链上，展开运算符会丢失方法。
- **类型安全**：TypeScript 的判别联合（discriminated union）通过 `type` 字段提供了编译期的类型缩窄，比 `instanceof` 更可靠。

**为什么 Task 注册表用函数而不是顶层常量？**

```typescript
// src/tasks.ts
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}
```

注释说得很清楚：*"Returns array inline to avoid circular dependency issues with top-level const"*。如果用顶层 `const`，模块求值顺序可能导致某些 Task 还未初始化就被引用。用函数延迟求值，确保调用时所有依赖都已就绪。

---

## 5.3 Task 基础设施：注册、输出、通知、驱逐

Task 抽象定义了"是什么"，而 Task 基础设施解决"怎么运行"。这套基础设施由四个核心模块组成：

### 5.3.1 任务注册与状态更新（framework.ts）

所有任务的状态都存储在 `AppState.tasks`（一个 `Record<string, TaskState>`）中。`framework.ts` 提供了操作这个状态的原子性工具函数：

```typescript
// src/utils/task/framework.ts

// 注册新任务
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    // 如果是替换（resume），保留 UI 持有的状态
    const merged = existing && 'retain' in existing
      ? { ...task, retain: existing.retain, startTime: existing.startTime,
          messages: existing.messages, diskLoaded: existing.diskLoaded,
          pendingMessages: existing.pendingMessages }
      : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })
}

// 原子性更新任务状态（泛型，类型安全）
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) return prev
    const updated = updater(task)
    if (updated === task) return prev  // 引用相同则跳过，避免无意义的 re-render
    return { ...prev, tasks: { ...prev.tasks, [taskId]: updated } }
  })
}
```

`registerTask` 有一个微妙的"替换合并"逻辑：当通过 `SendMessage` 恢复一个已完成的 Agent 时，会创建一个新的 task 对象替换旧的。但如果用户正在查看这个 Agent 的面板（`retain: true`），替换不能丢失 UI 状态。所以 `registerTask` 检测到已有同 ID 任务时，会保留 `retain`、`startTime`、`messages` 等 UI 相关字段。

### 5.3.2 磁盘输出持久化（diskOutput.ts）

每个任务的输出都持久化到磁盘文件，路径为 `<projectTempDir>/<sessionId>/tasks/<taskId>.output`。这个设计解决了两个问题：

1. **内存压力**：长时间运行的 Shell 命令可能产生 GB 级输出，不能全部放在内存中。
2. **跨组件访问**：TaskOutputTool、UI 面板、SDK 事件等多个消费者需要读取输出，磁盘文件是天然的共享介质。

```typescript
// src/utils/task/diskOutput.ts

// 安全常量：O_NOFOLLOW 防止符号链接攻击
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

// 磁盘上限：5GB
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
```

`DiskTaskOutput` 类是输出写入的核心，它使用一个精心设计的**写入队列 + 单线程 drain 循环**来避免内存膨胀：

```typescript
export class DiskTaskOutput {
  #queue: string[] = []
  #bytesWritten = 0
  #capped = false

  append(content: string): void {
    if (this.#capped) return
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      this.#queue.push(`\n[output truncated: exceeded 5GB disk cap]\n`)
    } else {
      this.#queue.push(content)
    }
    // 触发 drain 循环
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise(resolve => { this.#flushResolve = resolve })
      void track(this.#drain())
    }
  }
}
```

源码中有一段极其精确的注释值得关注：

> This code is extremely precise. You **must not** add an await here!! That will cause memory to balloon as the queue grows.

问题在于：如果在 `#writeAllChunks` 内部 `await`，每个 `await` 会创建一个 Promise reaction 闭包，闭包捕获了当前作用域的变量（包括 Buffer 数据）。当队列很长时，所有 Buffer 都被闭包持有，无法被 GC 回收。解法是把 `await` 提升到调用者 `#drainAllChunks` 中，让 `#writeAllChunks` 返回一个 Promise 但不在内部 await，这样 Buffer 可以在 `appendFile` 完成后立即被 GC。

**这是一个典型的"Node.js 异步内存管理"陷阱**——`await` 的位置不仅影响控制流，还影响 GC 行为。

### 5.3.3 通知机制：`<task-notification>` 与消息队列

当后台任务完成时，需要通知主对话循环。Claude Code 使用一种**XML 结构化消息**作为通知格式：

```xml
<task-notification>
  <task-id>a1b2c3d4e</task-id>
  <tool-use-id>toolu_xxx</tool-use-id>
  <output-file>/tmp/.claude/session123/tasks/a1b2c3d4e.output</output-file>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
</task-notification>
```

这条消息通过 `enqueuePendingNotification` 被推入统一的命令队列（`messageQueueManager.ts`），在主循环的下一个空闲时刻被消费，作为一条 user-role 消息注入到对话中。模型看到这条消息后，就知道某个后台任务完成了，可以读取输出文件获取结果。

通知有两种优先级：
- `'next'`：在当前轮次结束后立即处理（用于 Monitor 任务等需要及时响应的场景）
- `'later'`：在下一个用户输入后处理（用于普通后台 Shell 命令）

### 5.3.4 任务驱逐（Eviction）

任务完成并通知后，其状态对象仍然留在 `AppState.tasks` 中。如果不清理，长时间运行的会话会积累大量已完成的任务状态，浪费内存。

驱逐策略是**双层的**：

```typescript
// 主动驱逐：任务完成 + 已通知 → 立即清理
export function evictTerminalTask(taskId: string, setAppState: SetAppState): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    if (!isTerminalTaskStatus(task.status)) return prev
    if (!task.notified) return prev
    // Panel 宽限期：Agent 任务在面板中显示 30 秒后才驱逐
    if ('retain' in task && (task.evictAfter ?? Infinity) > Date.now()) return prev
    const { [taskId]: _, ...remainingTasks } = prev.tasks
    return { ...prev, tasks: remainingTasks }
  })
}

// 被动驱逐：generateTaskAttachments 轮询时清理
// 作为主动驱逐的安全网
```

Agent 任务有一个特殊的 `PANEL_GRACE_MS = 30_000`（30 秒）宽限期。这是因为 Coordinator 模式下，Agent 完成后其结果可能还在面板中显示，立即驱逐会导致 UI 闪烁。30 秒的宽限期让用户有足够时间查看结果。

---

## 5.4 AgentTool：子代理派生的核心引擎

### 面临的问题

当主对话循环需要"委派"一个子任务时，它面临一系列决策：

1. **选择哪个 Agent？** 系统内置了多种专用 Agent（Explore、Plan、general-purpose），用户和插件还可以自定义 Agent。如何根据 `subagent_type` 参数找到正确的 AgentDefinition？
2. **同步还是异步？** 简单的搜索任务可以同步等待结果；复杂的实现任务应该在后台运行。如何决定？
3. **给子代理什么工具？** 不是所有工具都适合子代理使用——子代理不应该递归创建子代理（防止无限递归），不应该使用 `AskUserQuestion`（后台 Agent 无法与用户交互），不应该使用 `ExitPlanMode`（这是主线程的抽象）。
4. **上下文如何隔离？** 子代理需要自己的消息列表、文件状态缓存、权限上下文，但又需要继承父代理的某些配置（MCP 连接、项目设置等）。

AgentTool 是解决这些问题的中枢。

### AgentDefinition：Agent 的"蓝图"

每个 Agent 类型都由一个 `AgentDefinition` 描述：

```typescript
// src/tools/AgentTool/loadAgentsDir.ts

export type BaseAgentDefinition = {
  agentType: string           // 唯一标识符，如 "Explore", "Plan", "general-purpose"
  whenToUse: string           // 描述何时使用此 Agent（注入到 prompt 中）
  tools?: string[]            // 允许的工具列表（undefined 或 ['*'] 表示全部）
  disallowedTools?: string[]  // 禁止的工具列表
  model?: string              // 模型覆盖（'inherit' 表示继承父模型）
  permissionMode?: PermissionMode  // 权限模式覆盖
  maxTurns?: number           // 最大对话轮次
  mcpServers?: AgentMcpServerSpec[]  // Agent 专属 MCP 服务器
  hooks?: HooksSettings       // Agent 专属 hooks
  omitClaudeMd?: boolean      // 是否省略 CLAUDE.md（节省 token）
  background?: boolean        // 是否强制后台运行
  isolation?: 'worktree' | 'remote'  // 隔离模式
  memory?: AgentMemoryScope   // 持久化记忆范围
  getSystemPrompt: (...) => string   // 系统提示词生成函数
}

// 三种来源
export type AgentDefinition =
  | BuiltInAgentDefinition    // 内置 Agent（source: 'built-in'）
  | CustomAgentDefinition     // 用户/项目/策略定义（source: 'userSettings' | 'projectSettings' | ...）
  | PluginAgentDefinition     // 插件提供（source: 'plugin'）
```

Agent 来源的优先级遵循**后者覆盖前者**的规则：

```typescript
// loadAgentsDir.ts — getActiveAgentsFromList
const agentGroups = [
  builtInAgents,    // 最低优先级
  pluginAgents,
  userAgents,
  projectAgents,
  flagAgents,
  managedAgents,    // 最高优先级（企业管理策略）
]

const agentMap = new Map<string, AgentDefinition>()
for (const agents of agentGroups) {
  for (const agent of agents) {
    agentMap.set(agent.agentType, agent)  // 同名后者覆盖前者
  }
}
```

这意味着企业管理员可以通过 `policySettings` 覆盖任何内置 Agent 的行为——比如强制所有 Agent 使用特定模型，或禁止某些工具。

### 内置 Agent 类型详解

```
┌─────────────────────────────────────────────────────────────────┐
│  内置 Agent 类型                                                 │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  general-purpose (通用)                                           │
│  ├─ 工具: 全部 (tools: ['*'])                                    │
│  ├─ 模型: 默认子代理模型                                         │
│  ├─ 用途: 搜索代码、执行多步任务、研究复杂问题                    │
│  └─ 特点: 无特殊限制，最灵活的 Agent                             │
│                                                                   │
│  Explore (探索)                                                   │
│  ├─ 工具: 只读（禁止 Agent/Edit/Write/NotebookEdit/ExitPlanMode）│
│  ├─ 模型: 外部用户用 Haiku（快速），内部用 inherit                │
│  ├─ 用途: 快速搜索文件、grep 代码、分析架构                      │
│  ├─ 特点: omitClaudeMd=true（省略 CLAUDE.md 节省 token）         │
│  └─ 设计理念: "快进快出"，不需要写入能力                         │
│                                                                   │
│  Plan (规划)                                                      │
│  ├─ 工具: 只读（与 Explore 相同的禁止列表）                      │
│  ├─ 模型: inherit（继承父模型，需要强推理能力）                   │
│  ├─ 用途: 设计实现方案、识别关键文件、考虑架构权衡                │
│  ├─ 特点: omitClaudeMd=true                                      │
│  └─ 设计理念: "只看不动手"，输出实现计划而非代码                  │
│                                                                   │
│  claude-code-guide (指南)                                         │
│  ├─ 用途: 回答关于 Claude Code 本身的使用问题                     │
│  ├─ 特点: 仅在非 SDK 入口点可用                                  │
│  └─ 设计理念: 自助式帮助，不占用主循环上下文                      │
│                                                                   │
│  statusline-setup (状态栏配置)                                    │
│  ├─ 工具: 仅 Read + Edit                                         │
│  └─ 用途: 配置用户的状态栏设置                                    │
│                                                                   │
│  fork (隐式 Fork)                                                 │
│  ├─ 工具: ['*'] + useExactTools（继承父代理的精确工具集）         │
│  ├─ 模型: inherit                                                 │
│  ├─ 权限: bubble（权限提示冒泡到父终端）                          │
│  └─ 特点: 不在 builtInAgents 注册，仅在 Fork 实验开启时触发      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

Explore Agent 的模型选择策略值得注意：

```typescript
// exploreAgent.ts
model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
```

外部用户使用 Haiku（最快最便宜的模型），因为 Explore 只做搜索，不需要强推理能力。内部用户使用 `inherit`（继承父模型），因为内部有 A/B 测试需要控制变量。这是一个**成本 vs 质量**的 trade-off：对于只读搜索任务，用小模型足够了。

### 工具集裁剪：三层过滤

子代理的工具集不是简单地继承父代理的全部工具，而是经过三层过滤：

```typescript
// src/tools/AgentTool/agentToolUtils.ts

export function filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode }): Tools {
  return tools.filter(tool => {
    // 第一层：MCP 工具始终允许
    if (tool.name.startsWith('mcp__')) return true

    // 第二层：全局禁止列表（所有 Agent 都不能用的工具）
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false

    // 第三层：异步 Agent 的白名单限制
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      // 特例：进程内队友可以用 AgentTool 和 Task 工具
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) return true
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) return true
      }
      return false
    }
    return true
  })
}
```

三个禁止列表的设计意图：

| 列表 | 包含的工具 | 设计意图 |
|------|-----------|---------|
| `ALL_AGENT_DISALLOWED_TOOLS` | TaskOutput, ExitPlanMode, EnterPlanMode, AskUserQuestion, TaskStop, Agent（外部用户） | 防止递归、防止后台 Agent 与用户交互 |
| `CUSTOM_AGENT_DISALLOWED_TOOLS` | 同上 | 自定义 Agent 额外限制（目前与上面相同） |
| `ASYNC_AGENT_ALLOWED_TOOLS` | Read, Search, Grep, Glob, Shell, Edit, Write, Skill, ToolSearch... | 异步 Agent 的**白名单**——只允许文件操作和搜索 |

注意异步 Agent 用的是**白名单**而非黑名单。这是一个安全性优先的决策：新增工具默认对异步 Agent 不可用，必须显式加入白名单。这避免了"忘记禁止某个危险工具"的风险。

---

## 5.5 Agent 的生命周期：从派生到完成

### 数据流全景

一个 Agent 从创建到完成，经历以下完整链路：

```
AgentTool.call()
  │
  ├─ 1. 解析 subagent_type → 选择 AgentDefinition
  │     ├─ 指定类型 → 从 activeAgents 中查找
  │     ├─ 未指定 + Fork 实验开启 → FORK_AGENT
  │     └─ 未指定 + Fork 实验关闭 → GENERAL_PURPOSE_AGENT
  │
  ├─ 2. 决定执行模式
  │     shouldRunAsync = run_in_background
  │                    || selectedAgent.background
  │                    || isCoordinatorMode
  │                    || isForkSubagentEnabled
  │                    || isAssistantMode
  │
  ├─ 3. 组装工具集
  │     workerTools = assembleToolPool(workerPermissionContext, mcpTools)
  │     // 独立于父代理的工具集，使用 worker 自己的权限模式
  │
  ├─ 4. 构建系统提示词
  │     ├─ Fork 路径: 继承父代理的 renderedSystemPrompt（字节级一致）
  │     └─ 普通路径: agentDefinition.getSystemPrompt() + enhanceWithEnvDetails
  │
  ├─ 5. 构建初始消息
  │     ├─ Fork 路径: buildForkedMessages(directive, parentAssistantMessage)
  │     │   → [克隆的父 assistant 消息, 占位 tool_results + 指令]
  │     └─ 普通路径: [createUserMessage({ content: prompt })]
  │
  ├─ 6. 可选：创建 git worktree 隔离
  │     if (isolation === 'worktree')
  │       worktreeInfo = await createAgentWorktree(`agent-${agentId}`)
  │
  ├─ 7. 启动 runAgent() 异步生成器
  │     │
  │     ▼
  │   runAgent() — 核心执行循环
  │     ├─ 创建子代理上下文 (createSubagentContext)
  │     │   ├─ 克隆 fileStateCache
  │     │   ├─ 克隆 contentReplacementState
  │     │   ├─ 创建子 AbortController
  │     │   └─ 隔离 denialTrackingState
  │     │
  │     ├─ 初始化 Agent 专属 MCP 服务器
  │     ├─ 注册 Agent 专属 Hooks
  │     ├─ 预加载 Agent 专属 Skills
  │     │
  │     └─ while (true) — 对话循环
  │         ├─ 调用 query() 发送 API 请求
  │         ├─ yield 每条消息给调用者
  │         ├─ 记录 sidechain transcript
  │         ├─ 检查终止条件:
  │         │   ├─ end_turn (模型主动结束)
  │         │   ├─ maxTurns 达到上限
  │         │   └─ abort 信号
  │         └─ 继续下一轮（工具结果 → API → ...）
  │
  └─ 8. 收集结果
        ├─ 异步模式: 注册 LocalAgentTask, 返回 task_id
        │   → 完成后 enqueueAgentNotification → <task-notification>
        └─ 同步模式: 等待所有消息, 返回最终结果
```

### runAgent()：子代理的对话循环

`runAgent()` 是一个 `AsyncGenerator<Message, void>`——它 yield 每条消息给调用者，调用者决定如何处理（同步模式下收集消息，异步模式下更新进度）。

```typescript
// src/tools/AgentTool/runAgent.ts（简化）

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  availableTools,
  ...
}): AsyncGenerator<Message, void> {

  // 1. 创建隔离的子代理上下文
  const subagentContext = createSubagentContext(toolUseContext, {
    agentId,
    readFileState: cloneFileStateCache(toolUseContext.readFileState),
    contentReplacementState: cloneContentReplacementState(...),
    abortController: createChildAbortController(toolUseContext.abortController),
    denialTrackingState: createDenialTrackingState(),
  })

  // 2. 解析工具集
  const { resolvedTools } = resolveAgentTools(agentDefinition, availableTools, isAsync)

  // 3. 初始化 Agent 专属 MCP 服务器
  const { clients: mergedClients, tools: agentMcpTools, cleanup } =
    await initializeAgentMcpServers(agentDefinition, parentClients)

  // 4. 对话循环
  const allMessages = [...initialMessages]
  let turnCount = 0

  while (true) {
    turnCount++
    if (maxTurns && turnCount > maxTurns) break

    // 调用 query() — 与主循环使用相同的 API 调用函数
    for await (const message of query({
      messages: allMessages,
      tools: finalTools,
      systemPrompt,
      ...subagentContext,
    })) {
      if (isRecordableMessage(message)) {
        allMessages.push(message)
        recordSidechainTranscript(agentId, message)  // 持久化到磁盘
        yield message  // 交给调用者
      }
    }

    // 检查终止条件
    const lastAssistant = getLastAssistantMessage(allMessages)
    if (lastAssistant?.message.stop_reason === 'end_turn') break
  }

  // 5. 清理
  await cleanup()  // 关闭 Agent 专属 MCP 服务器
  clearSessionHooks()  // 清除 Agent 专属 hooks
}
```

关键设计决策：

**为什么 runAgent 是 AsyncGenerator 而不是返回 Promise？**

因为调用者需要**流式处理**每条消息。同步模式下，调用者需要实时更新进度 UI（显示 tool use 计数、最近活动等）。异步模式下，调用者需要实时更新 `LocalAgentTaskState.progress`。如果 runAgent 返回 Promise，调用者只能在全部完成后才能获取结果，无法实现实时进度。

**为什么子代理上下文要"克隆"而不是"共享"？**

```typescript
const subagentContext = createSubagentContext(toolUseContext, {
  readFileState: cloneFileStateCache(toolUseContext.readFileState),
  contentReplacementState: cloneContentReplacementState(...),
  denialTrackingState: createDenialTrackingState(),
})
```

三个状态都被克隆或新建：
- `readFileState`（文件内容缓存）：子代理可能读取不同的文件，不应污染父代理的缓存。
- `contentReplacementState`（大型工具结果的替换状态）：子代理的工具结果替换不应影响父代理的 token 预算计算。
- `denialTrackingState`（权限拒绝追踪）：子代理的权限拒绝计数不应累加到父代理上。

但 `abortController` 使用的是 `createChildAbortController`——当父代理被 abort 时，子代理也会被 abort。这是**级联取消**的标准模式。

### 同步 vs 异步：前台/后台的动态切换

AgentTool 最精巧的设计之一是**前台 Agent 可以动态切换到后台**。

```typescript
// AgentTool.tsx — 同步执行路径（简化）

// 注册为前台任务（即使是同步执行）
const registration = registerAgentForeground({
  agentId, description, prompt, selectedAgent, setAppState, toolUseId,
  autoBackgroundMs: getAutoBackgroundMs() || undefined  // 120秒自动后台化
})

const agentIterator = runAgent({ ... })[Symbol.asyncIterator]()

while (true) {
  // 竞速：下一条消息 vs 后台化信号
  const raceResult = await Promise.race([
    agentIterator.next().then(r => ({ type: 'message', result: r })),
    registration.backgroundSignal.then(() => ({ type: 'background' }))
  ])

  if (raceResult.type === 'background') {
    // 用户按了 Escape 或自动后台化触发
    // 将同步 Agent 转为异步 Agent
    runAsyncAgentLifecycle(agentIterator, ...)
    return { data: { status: 'async_launched', agentId, ... } }
  }

  // 正常处理消息...
}
```

这个 `Promise.race` 模式实现了一个优雅的**前台→后台无缝切换**：

1. Agent 启动时注册为前台任务（`registerAgentForeground`）
2. 同步循环中，每次等待下一条消息时，同时监听后台化信号
3. 如果用户按 Escape（或 120 秒自动触发），`backgroundSignal` resolve
4. 同步循环立即退出，把 `agentIterator`（还在运行的 AsyncGenerator）交给 `runAsyncAgentLifecycle`
5. 父循环收到 `async_launched` 结果，继续处理其他事务
6. Agent 在后台继续运行，完成后通过 `<task-notification>` 通知

**这意味着 Agent 的执行不会因为前台/后台切换而中断**——AsyncGenerator 的状态完整保留，只是消费者从同步循环变成了异步生命周期管理器。

### 进度追踪

每个运行中的 Agent 都有实时进度追踪：

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx

export type AgentProgress = {
  toolUseCount: number       // 已执行的工具调用次数
  tokenCount: number         // 已消耗的 token 数
  lastActivity?: ToolActivity  // 最近一次工具活动
  recentActivities?: ToolActivity[]  // 最近 5 次活动
  summary?: string           // AI 生成的进度摘要
}

export type ToolActivity = {
  toolName: string
  input: Record<string, unknown>
  activityDescription?: string  // 如 "Reading src/foo.ts"
  isSearch?: boolean
  isRead?: boolean
}
```

进度信息通过 `updateProgressFromMessage` 从每条 assistant 消息中提取：

```typescript
export function updateProgressFromMessage(
  tracker: ProgressTracker, message: Message, ...
): void {
  if (message.type !== 'assistant') return

  // Token 计数：input_tokens 取最新值（API 累计），output_tokens 累加
  tracker.latestInputTokens = usage.input_tokens + cache_creation + cache_read
  tracker.cumulativeOutputTokens += usage.output_tokens

  // 工具活动：从 content blocks 中提取
  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++
      tracker.recentActivities.push({
        toolName: content.name,
        input: content.input,
        activityDescription: resolveActivityDescription?.(content.name, content.input),
      })
    }
  }

  // 保持最近 5 条活动
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift()
  }
}
```

Token 计数的处理有一个微妙之处：`input_tokens` 在 Claude API 中是**累计值**（包含所有历史上下文），而 `output_tokens` 是**当前轮次值**。所以 input 取最新值，output 累加。

---

## 5.6 LocalShellTask：后台 Shell 任务

### 面临的问题

当用户要求执行一个可能耗时较长的 Shell 命令（如 `npm test`、`cargo build`）时，同步等待会阻塞整个对话循环。但"后台执行"远不只是加个 `&`——需要解决一系列问题：

1. **输出捕获**：后台命令的 stdout/stderr 必须被完整捕获，否则模型无法看到结果。
2. **前台→后台切换**：有些命令启动时看起来很快，但实际运行很久。需要支持"先前台等一下，超时了就自动后台化"。
3. **停滞检测**：命令可能卡在等待用户输入（如 `Do you want to continue? [y/n]`），需要检测并通知模型。
4. **资源保护**：后台命令可能产生 GB 级输出，需要防止磁盘爆满。

### LocalShellTaskState：状态定义

```typescript
// src/tasks/LocalShellTask/guards.ts

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash'              // 保留 'local_bash' 以向后兼容
  command: string                  // 执行的命令
  result?: {
    code: number                   // 退出码
    interrupted: boolean           // 是否被中断
  }
  completionStatusSentInAttachment: boolean  // 完成状态是否已通过附件发送
  shellCommand: ShellCommand | null          // 底层进程包装器
  unregisterCleanup?: () => void             // 清理注册句柄
  cleanupTimeoutId?: NodeJS.Timeout          // 清理超时
  lastReportedTotalLines: number             // 上次报告的输出行数
  isBackgrounded: boolean                    // false=前台, true=后台
  agentId?: AgentId                          // 发起此任务的 Agent
  kind?: BashTaskKind                        // 'bash' | 'monitor'
}
```

`shellCommand` 字段直接持有进程引用。这意味着 **TaskState 不是纯数据**——它包含活跃的系统资源。这是一个实用主义的选择：虽然违反了"状态应为纯数据"的理想，但避免了维护一个独立的 `taskId → process` 映射表。

### 四种后台化路径

```
Shell 命令的后台化有四种触发路径:

┌─────────────────────────────────────────────────────────┐
│  路径 1: 显式后台化                                       │
│  用户设置 run_in_background: true                        │
│  → 立即调用 spawnBackgroundTask()                        │
│  → 命令从一开始就在后台运行                               │
│                                                           │
│  路径 2: 超时自动后台化                                    │
│  shouldAutoBackground=true + 命令超时                     │
│  → 前台运行 → 超时触发 → startBackgrounding()            │
│  → 转为后台，主循环继续                                    │
│                                                           │
│  路径 3: Assistant 模式自动后台化                           │
│  SDK 使用场景，命令超过 ASSISTANT_BLOCKING_BUDGET_MS       │
│  → 自动后台化，避免 SDK 调用者长时间等待                   │
│                                                           │
│  路径 4: 前台注册 → 动态后台化                             │
│  registerForeground() 注册前台任务                         │
│  → 运行中用户按 Escape                                    │
│  → backgroundExistingForegroundTask() 转后台              │
└─────────────────────────────────────────────────────────┘
```

路径 4 与 5.5 节讨论的 Agent 前台→后台切换使用相同的模式——`Promise.race` 竞速。

### ShellCommand 的后台化状态转换

当命令从前台切换到后台时，`ShellCommand` 对象经历一次关键的状态转换：

```typescript
// src/utils/ShellCommand.ts — background()

background(taskId: string): void {
  if (this.#status !== 'running') return

  this.#backgroundTaskId = taskId
  this.#status = 'backgrounded'

  // 1. 清理前台监听器（超时、abort）
  this.#cleanupListeners()

  // 2. 根据模式切换输出通道
  if (this.#outputMode === 'file') {
    // 文件模式：启动磁盘大小看门狗
    this.#startSizeWatchdog()
  } else {
    // 管道模式：将内存缓冲区溢出到磁盘
    this.#spillToDisk()
  }
}
```

**文件模式 vs 管道模式**是一个重要的区分：

| 模式 | stdout/stderr 流向 | 适用场景 | 内存开销 |
|------|-------------------|---------|---------|
| 文件模式 | 直接写入文件 fd，绕过 JavaScript | 普通 bash 命令 | 几乎为零 |
| 管道模式 | 通过 `writeStdout()`/`writeStderr()` 进入 TaskOutput | Hooks 执行 | 8MB 内存上限 |

文件模式的"绕过 JavaScript"设计值得强调——stdout/stderr 通过 `child_process.spawn` 的 `stdio` 选项直接绑定到文件描述符，数据从子进程到磁盘的路径不经过 Node.js 事件循环，避免了大量输出时的 GC 压力。

### 停滞检测（Stall Detection）

后台命令最危险的场景是**卡在交互式提示符**上——命令等待用户输入 `y/n`，但用户看不到提示（因为命令在后台），导致永远等下去。

```typescript
// src/tasks/LocalShellTask/LocalShellTask.tsx — startStallWatchdog()

const STALL_CHECK_INTERVAL_MS = 5_000   // 每 5 秒检查一次
const STALL_THRESHOLD_MS = 45_000        // 45 秒无输出增长则告警
const STALL_TAIL_BYTES = 1024            // 读取末尾 1KB

function startStallWatchdog(taskId, outputFile): () => void {
  let lastSize = 0
  let lastGrowth = Date.now()

  const interval = setInterval(async () => {
    const stat = await fs.stat(outputFile)

    if (stat.size > lastSize) {
      lastSize = stat.size
      lastGrowth = Date.now()      // 有新输出，重置计时
      return
    }

    if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return

    // 45 秒无新输出，读取末尾内容
    const tail = await readTail(outputFile, STALL_TAIL_BYTES)

    // 检查是否像交互式提示符
    if (looksLikePrompt(tail)) {
      enqueuePendingNotification({
        tag: 'task-notification',
        content: `Command appears blocked waiting for input...`,
        taskId,
      })
    }
  }, STALL_CHECK_INTERVAL_MS)

  return () => clearInterval(interval)  // 返回取消函数
}
```

`looksLikePrompt()` 的匹配模式覆盖了常见的交互式提示：

```typescript
const PROMPT_PATTERNS = [
  /\(y\/n\)/i, /\[y\/n\]/i, /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i, /Continue\?/i, /Overwrite\?/i,
]
```

### Kill：进程树终止

```typescript
// src/tasks/LocalShellTask/killShellTasks.ts

export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  updateTaskState(taskId, setAppState, task => {
    if (task.status !== 'running' || !isLocalShellTask(task)) return task

    task.shellCommand?.kill()          // treeKill(pid, 'SIGKILL')
    task.shellCommand?.cleanup()       // 清理流监听器
    task.unregisterCleanup?.()         // 从清理注册表中移除

    return {
      ...task,
      status: 'killed',
      notified: true,                  // 防止重复通知
      shellCommand: null,              // 释放进程引用
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)         // 异步清理磁盘
}
```

注意使用 `treeKill` 而非简单的 `process.kill`——因为 Shell 命令可能产生子进程（如 `npm test` 启动 Jest，Jest 启动多个 worker），必须终止整个进程树。

还有一个 `killShellTasksForAgent()` 函数，当 Agent 结束时批量终止该 Agent 发起的所有后台 Shell 任务，防止孤儿进程泄漏。

---

## 5.7 SendMessageTool：Agent 间通信

### 面临的问题

当系统中存在多个并发 Agent 时，它们之间需要通信：

1. **Coordinator 需要给 Worker 追加指令**：Worker Agent 完成第一轮任务后，Coordinator 需要基于结果发送后续指令，而不是重新派生一个新 Agent（那样会丢失 Worker 的上下文）。
2. **团队成员需要互相协调**：在 Swarm 模式下，多个 Teammate 需要共享发现、协调分工。
3. **跨会话通信**：远程 Agent 或其他 Claude Code 实例之间需要消息传递。
4. **已停止的 Agent 需要被唤醒**：一个已完成的 Agent 收到新消息时，应该能自动恢复执行。

### 消息路由架构

```
SendMessageTool.call({ to, message, summary })
  │
  ├─ 收件人解析
  │   ├─ "teammate-name"     → 团队内队友（按名称查找）
  │   ├─ "*"                 → 广播给所有队友
  │   ├─ "uds:/path/socket"  → 本地 UDS 套接字（跨进程）
  │   └─ "bridge:session_id" → 远程 Bridge 会话（跨机器）
  │
  ├─ 消息类型判断
  │   ├─ string              → 纯文本消息
  │   └─ StructuredMessage   → 结构化消息
  │       ├─ shutdown_request     → 请求队友关闭
  │       ├─ shutdown_response    → 回复关闭请求
  │       └─ plan_approval_response → 回复计划审批
  │
  └─ 投递方式
      ├─ 进程内队友 → queuePendingMessage() 注入消息队列
      ├─ tmux/iTerm2 队友 → writeToMailbox() 写入文件信箱
      ├─ 已停止的 Agent → resumeAgentBackground() 自动唤醒
      ├─ UDS → sendToUdsSocket() 通过 Unix 域套接字发送
      └─ Bridge → postInterClaudeMessage() 通过 HTTP 发送
```

### 关键设计：自动唤醒已停止的 Agent

```typescript
// src/tools/SendMessageTool/SendMessageTool.ts（简化）

// 如果目标 Agent 已停止，自动在后台恢复它
if (isTerminalTaskStatus(targetTask.status)) {
  const resumeResult = await resumeAgentBackground({
    agentId: targetAgentId,
    message: messageContent,
    toolUseContext,
  })
  return { data: { status: 'resumed', agentId: targetAgentId, ... } }
}
```

这个设计的意义在于：Coordinator 不需要关心 Worker 是否已经停止——它只管发消息，系统自动处理唤醒。这简化了 Coordinator 的逻辑，让它可以把 Agent 当作"始终可达"的服务来使用。

### 结构化消息：协议级通信

纯文本消息适合传递指令和结果，但某些场景需要**语义化的消息**——接收方需要根据消息类型做出不同的处理：

```typescript
type StructuredMessage =
  | { type: 'shutdown_request', reason?: string }
  | { type: 'shutdown_response', request_id: string, approve: boolean, reason?: string }
  | { type: 'plan_approval_response', request_id: string, approve: boolean, feedback?: string }
```

结构化消息只在**团队内部**使用，不支持跨会话发送。这是一个安全边界——结构化消息可以触发自动行为（如关闭 Agent），不应该暴露给外部。

### 广播机制

当 `to` 参数为 `"*"` 时，消息会被广播给团队中的所有活跃队友：

```typescript
if (to === '*') {
  const teammates = getRunningTeammatesSorted(appState)
  const results = await Promise.all(
    teammates.map(t => deliverMessage(t.agentId, message))
  )
  return { data: { type: 'broadcast', delivered: results.length } }
}
```

广播适用于 Leader 向所有 Worker 下达统一指令的场景，如"所有人停止当前任务"或"项目需求变更，请重新检查你的工作"。

---

## 5.8 Coordinator 模式：多 Agent 协调器

### 面临的问题

当任务足够复杂（如"重构整个认证模块"），一个 Agent 的上下文窗口不够用。即使有子代理，也存在问题：

1. **谁来分解任务？** 子代理只能执行被分配的子任务，但"如何分解"本身需要高层次的理解。
2. **如何协调并行？** 多个子代理同时编辑文件可能产生冲突。
3. **如何综合结果？** 子代理各自返回结果，需要有人把碎片拼成完整图景。

Coordinator 模式的核心思想是：**将主对话循环的角色从"执行者"切换为"协调者"**——它不直接执行任务，而是派生 Worker Agent、分配任务、监控进度、综合结果。

### 模式切换

```typescript
// src/coordinator/coordinatorMode.ts

export function isCoordinatorMode(): boolean {
  return getSessionMode() === 'coordinator'
}
```

Coordinator 模式通过 session mode 激活。激活后，整个对话循环的行为发生变化：
- 所有 Agent 调用默认异步执行（`shouldRunAsync = true`）
- 系统提示词切换为 Coordinator 专用版本
- Worker 的工具集被限制为安全子集

### Coordinator 的工作流

Coordinator 的系统提示词定义了一个严格的四阶段工作流：

```
┌─────────────────────────────────────────────────────┐
│  Phase 1: Research（研究）                            │
│  ─────────────────────                               │
│  • 派生 Explore Agent 并行搜索代码库                   │
│  • 理解现有架构和依赖关系                              │
│  • 可以同时派多个 Worker 探索不同方向                   │
│                                                       │
│  Phase 2: Synthesis（综合）                            │
│  ─────────────────────                               │
│  • Coordinator 自己阅读 Worker 的发现                  │
│  • 制定具体的实现规范（spec）                          │
│  • 关键：Worker 看不到 Coordinator 的对话              │
│  • 所以规范必须是自包含的                              │
│                                                       │
│  Phase 3: Implementation（实现）                       │
│  ─────────────────────────                            │
│  • 按规范派生 Worker 执行代码修改                      │
│  • 写入操作必须串行化（同一文件不能并行编辑）           │
│  • 不同文件的修改可以并行                              │
│                                                       │
│  Phase 4: Verification（验证）                         │
│  ────────────────────────                             │
│  • 派生 Worker 运行测试                                │
│  • 可以与实现阶段并行（边写边测）                      │
│  • 测试失败 → 回到实现阶段修复                         │
└─────────────────────────────────────────────────────┘
```

### Worker 通知模型

当 Worker 完成任务，Coordinator 收到的通知包含结构化的结果信息：

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed</status>
  <summary>Agent "Refactor auth middleware" completed</summary>
  <result>{Worker 的最终文本响应}</result>
  <usage>
    <total_tokens>45230</total_tokens>
    <tool_uses>12</tool_uses>
    <duration_ms>34500</duration_ms>
  </usage>
</task-notification>
```

`<result>` 字段是 Worker 最终 assistant 消息的纯文本内容（去掉 tool_use blocks），让 Coordinator 可以直接阅读结果而不需要用 TaskOutputTool 去读磁盘文件。

### Worker 上下文构建

Coordinator 的系统提示词中包含 Worker 可用工具的描述，帮助 Coordinator 理解 Worker 的能力边界：

```typescript
// coordinatorMode.ts — getCoordinatorUserContext()

export function getCoordinatorUserContext(tools, mcpClients, skills): string {
  const workerToolNames = [
    'Bash', 'FileRead', 'FileEdit', 'Agent', 'SendMessage', 'TaskStop',
    ...mcpToolNames,
    ...skillNames,
  ]

  return `Workers have access to: ${workerToolNames.join(', ')}\n` +
         `MCP servers available: ${mcpServerDescriptions}\n` +
         `Skills available: ${skillDescriptions}`
}
```

### 关键设计决策

**为什么 Worker 看不到 Coordinator 的对话？**

Worker 有独立的上下文窗口，不共享 Coordinator 的消息历史。这意味着 Coordinator 给 Worker 的指令必须**自包含**——包含所有必要的上下文信息。

这是一个有意为之的限制：
- **优点**：Worker 的上下文窗口不会被 Coordinator 的元对话"污染"，可以专注于具体任务。
- **缺点**：Coordinator 需要花 token 把上下文信息复制到指令中。
- **权衡**：对于复杂任务，上下文隔离的好处（更大的有效工作区间）超过了重复传递上下文的开销。

**为什么写入操作要串行化？**

Coordinator 的提示词明确要求"写入同一文件的操作不能并行"。这是因为 Claude Code 的 FileEditTool 基于字符串匹配进行编辑——如果两个 Worker 同时编辑同一个文件，一个 Worker 的编辑可能改变文件内容，导致另一个 Worker 的匹配字符串找不到。这不是理论风险，而是实践中的真实问题。

**何时用 SendMessage 续传，何时派生新 Agent？**

Coordinator 的提示词给出了明确的决策标准：当后续任务与之前的任务有大量上下文重叠时，用 SendMessage 续传（保留 Worker 的上下文）；当后续任务是全新的方向时，派生新 Agent（干净的上下文窗口）。

---

## 5.9 Agent Swarms：团队协作系统

### 面临的问题

Coordinator 模式解决了"一个调度者 + 多个 Worker"的场景，但它有一个根本限制：**Worker 之间不能直接通信**——所有信息必须经过 Coordinator 中转。这在需要紧密协作的场景中效率很低（例如，前端 Worker 需要知道后端 Worker 定义了什么 API 接口）。

Agent Swarms（又称团队模式）是更进一步的协作模型：

1. **点对点通信**：队友之间可以直接发消息，不需要经过 Leader 中转。
2. **持久存在**：队友是长期运行的实体，不是执行完就销毁的一次性 Agent。
3. **共享任务列表**：团队共享一个 Task 列表（文件系统上的 `.claude/tasks/` 目录），实现分布式任务管理。
4. **多种执行后端**：队友可以在 tmux pane、iTerm2 tab、或同一进程内运行。

### 三种执行后端

```
┌─────────────────────────────────────────────────────────┐
│  Swarm 执行后端                                          │
│                                                           │
│  1. Tmux Backend                                         │
│     ├─ 每个队友在独立的 tmux pane 中运行                  │
│     ├─ Leader 占 30% 左侧，队友占 70% 右侧               │
│     ├─ 通过 tmux send-keys 发送启动命令                   │
│     ├─ 优点：完全进程隔离，可独立 crash                    │
│     └─ 缺点：需要 tmux，启动开销较大                      │
│                                                           │
│  2. iTerm2 Backend                                       │
│     ├─ 每个队友在 iTerm2 的独立 tab 中运行                │
│     ├─ 通过 iTerm2 CLI (`it2`) 控制                      │
│     └─ 优点：macOS 原生体验                               │
│                                                           │
│  3. In-Process Backend                                   │
│     ├─ 队友在同一 Node.js 进程中运行                      │
│     ├─ 通过 AsyncLocalStorage 实现上下文隔离              │
│     ├─ 共享 API 客户端、MCP 连接等资源                    │
│     ├─ 优点：零启动开销，资源共享效率高                    │
│     └─ 缺点：一个队友 crash 可能影响其他队友              │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

后端选择的抽象层设计值得关注：

```typescript
// src/utils/swarm/backends/types.ts

// 低层接口：终端 pane 操作
interface PaneBackend {
  createTeammatePaneInSwarmView(config): Promise<string>  // 返回 paneId
  sendCommandToPane(paneId, command): Promise<void>
  setPaneBorderColor(paneId, color): Promise<void>
  killPane(paneId): Promise<void>
  rebalancePanes(): Promise<void>
  // ...
}

// 高层接口：队友生命周期
interface TeammateExecutor {
  spawn(config): Promise<SpawnResult>
  sendMessage(agentId, message): Promise<void>
  terminate(agentId): Promise<void>     // 优雅关闭
  kill(agentId): Promise<void>          // 强制终止
  isActive(agentId): boolean
}
```

`PaneBackendExecutor` 是一个适配器，将 `PaneBackend` 适配为 `TeammateExecutor` 接口。`InProcessBackend` 则直接实现 `TeammateExecutor`。这种分层让添加新的执行后端只需要实现一个接口。

### InProcessTeammateTask：进程内队友

进程内队友是最轻量的协作模型，所有队友共享同一个 Node.js 进程：

```typescript
// src/tasks/InProcessTeammateTask/types.ts

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // 身份
  agentId: AgentId                    // 格式：name@teamName
  agentName: string
  teamName: string
  color: string                       // 终端显示颜色

  // 执行配置
  prompt: string                      // 初始指令
  model?: string                      // 模型覆盖
  selectedAgent: AgentDefinition      // Agent 定义
  planModeRequired?: boolean          // 是否需要 Plan 模式

  // 对话状态
  messages: Message[]                 // 最近的对话消息
  pendingMessages: string[]           // 待注入的消息队列
  progress?: AgentProgress            // 实时进度

  // 生命周期
  isIdle: boolean                     // 是否处于空闲状态
  shutdownRequested?: boolean         // 是否收到关闭请求
  onIdleCallback?: () => void         // 空闲时的回调
}

// 内存优化：UI 最多保留 50 条消息
const TEAMMATE_MESSAGES_UI_CAP = 50
```

`agentId` 的格式是 `name@teamName`（如 `frontend-dev@my-team`），这是一个**确定性 ID**——同一团队中同名的队友总是有相同的 ID，便于 SendMessage 寻址。

### 上下文隔离：AsyncLocalStorage

进程内队友最大的挑战是**在单进程中实现上下文隔离**。多个队友共享同一个事件循环，但它们需要各自独立的：
- 工作目录（cwd）
- 权限上下文
- 对话历史
- Abort 控制器

解法是使用 Node.js 的 `AsyncLocalStorage`：

```typescript
// src/utils/swarm/spawnInProcess.ts（概念简化）

export async function spawnInProcessTeammate(config, context) {
  const agentId = `${config.name}@${config.teamName}`  // 确定性 ID

  // 创建独立的 AbortController（不链接到父级！）
  const abortController = new AbortController()

  // 创建 TeammateContext
  const teammateContext = {
    agentId,
    name: config.name,
    teamName: config.teamName,
    abortController,
    // ... 其他隔离状态
  }

  // 通过 AsyncLocalStorage 注入上下文
  // 队友内部的所有异步操作都能通过 getTeammateContext() 获取正确的上下文
  return asyncLocalStorage.run(teammateContext, () => {
    return startInProcessTeammate(config, context)
  })
}
```

注意 `abortController` 是**独立的，不链接到父级**。这与子代理不同——子代理的 abort 是级联的（父 abort → 子 abort），但团队队友是独立实体，Leader 被中断不应该自动终止所有队友。

### 权限同步：Leader Permission Bridge

进程内队友需要获取工具执行权限，但权限确认 UI 在 Leader 的终端上。解法是一个**权限桥接机制**：

```
队友需要权限
  │
  ├─ 1. 尝试分类器自动批准（安全的只读操作）
  │     → 自动批准 → 直接执行
  │
  ├─ 2. 如果 Leader Permission Bridge 可用
  │     → 直接使用 Leader 的 ToolUseConfirm 对话框
  │     → 用户在 Leader 终端上看到审批弹窗
  │     → 审批结果直接返回给队友
  │
  └─ 3. 如果 Bridge 不可用（pane-based 后端）
        → 写入 permission_request 到 Leader 信箱
        → Leader 轮询信箱发现请求
        → 用户在 Leader 终端上审批
        → Leader 写入 permission_response 到队友信箱
        → 队友轮询信箱获取结果
```

进程内后端的优势在路径 2 体现得最明显：因为共享进程空间，权限桥接是零延迟的函数调用，而 pane-based 后端需要通过文件信箱进行异步轮询。

### Team 创建与管理

```typescript
// src/tools/TeamCreateTool/TeamCreateTool.ts（简化）

// 创建团队时的操作：
// 1. 在 ~/.claude/teams/{team-name}/ 创建 config.json
// 2. 在 ~/.claude/tasks/{team-name}/ 创建任务目录
// 3. 注册 TeamContext 到 AppState
// 4. 将当前 Agent 标记为 Leader

// TeamFile 配置结构
type TeamFile = {
  name: string
  leadAgentId: string
  leadSessionId?: string       // 用于其他进程发现 Leader
  members: Array<{
    agentId: string
    name: string
    agentType: string
    model?: string
    prompt: string
    color: string
    planModeRequired?: boolean
    cwd: string
    worktreePath?: string      // Git worktree 隔离路径
    backendType: BackendType   // 'tmux' | 'iterm2' | 'in-process'
    isActive: boolean
    mode?: PermissionMode      // 独立的权限模式
  }>
}
```

每个队友可以有自己的**权限模式**（`mode` 字段）——这意味着 Leader 可以设为 `default`（需要确认），而某些信任的队友可以设为 `bypassPermissions`（自动执行）。权限模式是**按队友独立控制**的，不是全局统一的。

### 设计决策讨论

**为什么需要三种执行后端？**

这看起来是过度工程化，但每种后端解决不同的约束：
- **Tmux**：最成熟、最可靠的方案，但要求用户安装 tmux。适合 Linux 服务器和熟悉终端的用户。
- **iTerm2**：macOS 上的原生体验，不需要额外安装。但只在 iTerm2 终端中可用。
- **In-Process**：零依赖、零开销。适合 SDK 调用场景（没有终端）和需要极低延迟的场景。

实际上，`InProcessBackend` 是一个"fallback"——当 tmux 和 iTerm2 都不可用时，系统会自动降级到进程内模式。

**文件信箱 vs 进程内消息传递**

Pane-based 后端通过**文件信箱**通信（每个队友有一个文件，其他人向文件追加消息），而 In-Process 后端通过**内存队列**传递消息。文件信箱的优势是跨进程可靠性——即使一个队友进程崩溃重启，信箱中未读的消息不会丢失。但文件信箱有延迟（轮询间隔），In-Process 的内存队列是即时的。

---

## 5.10 任务输出与停止：TaskOutputTool 与 TaskStopTool

### TaskOutputTool：读取后台任务输出

当主对话循环需要获取后台任务的结果时，使用 TaskOutputTool。它的核心设计是**阻塞等待 + 超时**：

```typescript
// src/tools/TaskOutputTool/TaskOutputTool.tsx（简化）

Input: {
  task_id: string          // 要读取的任务 ID
  block: boolean = true    // 是否阻塞等待完成
  timeout: number = 30000  // 最大等待时间（ms）
}

Output: {
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  task: TaskOutput | null
}
```

阻塞模式下，TaskOutputTool 以 100ms 间隔轮询任务状态，直到任务完成或超时：

```typescript
// 阻塞等待任务完成
while (block && !isTerminalTaskStatus(task.status)) {
  if (Date.now() - startTime > timeout) {
    return { data: { retrieval_status: 'timeout', task: currentSnapshot } }
  }
  await sleep(100)  // 100ms 轮询间隔
  task = getTaskState(taskId, getAppState)
}
```

**为什么用轮询而不是事件驱动？**

因为 TaskOutputTool 的执行上下文是工具调用——它需要返回一个 `ToolResult`。在工具执行期间，无法注册事件监听器然后 yield 控制权。轮询是工具执行模型下的唯一选择。100ms 的间隔平衡了响应性（用户不需要等很久）和 CPU 开销（每秒只做 10 次状态检查）。

**Agent 任务 vs Shell 任务的输出处理差异**：

| 任务类型 | 输出来源 | 返回内容 |
|---------|---------|---------|
| `local_bash` | 磁盘输出文件 | stdout + stderr + exitCode |
| `local_agent` | 内存中的 `result` 字段 | Agent 最终文本响应（非完整 transcript） |
| `remote_agent` | 磁盘输出文件 | 远程会话的命令输出 |

Agent 任务优先返回 `result`（最终答案的纯文本提取），而非完整的对话 transcript。这避免了将内部 tool_use blocks 暴露给调用者——调用者只关心结论，不关心 Agent 的推理过程。

### TaskStopTool：终止后台任务

```typescript
// src/tools/TaskStopTool/TaskStopTool.ts（简化）

Input: {
  task_id?: string    // 任务 ID
  shell_id?: string   // 兼容旧版（已废弃）
}
```

TaskStopTool 的实现非常简洁——它只是一个**路由器**，根据任务类型调用对应的 `kill` 方法：

```typescript
// 查找任务
const task = getTaskState(taskId, getAppState)
if (!task || !isRunningStatus(task.status)) {
  return { data: { error: 'Task not found or not running' } }
}

// 查找 Task 类型对应的 kill 实现
const taskType = getAllTasks().find(t => t.type === task.type)
await taskType.kill(taskId, setAppState)

return { data: { message: 'Task stopped', task_id: taskId } }
```

不同类型任务的终止方式：

| 任务类型 | 终止方式 |
|---------|---------|
| `local_bash` | `treeKill(pid, 'SIGKILL')` 终止进程树 |
| `local_agent` | `abortController.abort()` 触发级联取消 |
| `remote_agent` | 关闭远程会话连接 |
| `in_process_teammate` | `abortController.abort()` + 清理 TeammateContext |

这就是为什么 `Task` 接口只保留了 `kill` 一个多态方法——它是唯一需要根据类型做不同处理的操作。

---

## 5.11 全章回顾：从简单到复杂的演进路径

### 并发模型的演进谱系

Claude Code 的多任务系统不是一次设计出来的，从源码结构可以看出明显的**渐进演进**痕迹：

```
Level 0: 同步单线程
  用户 → 模型 → 工具 → 模型 → 用户
  │ 问题：长任务阻塞
  ▼
Level 1: 后台 Shell (LocalShellTask)
  主循环 ──→ 后台 Shell ──→ <task-notification>
  │ 问题：只能后台 Shell，不能后台 LLM 对话
  ▼
Level 2: 子代理 (AgentTool + LocalAgentTask)
  主循环 ──→ 子代理（独立对话循环）──→ <task-notification>
  │ 问题：子代理是一次性的，不能续传
  ▼
Level 3: 消息传递 (SendMessageTool)
  主循环 ←──→ 子代理（双向通信，可续传）
  │ 问题：只有上下级关系，没有平等协作
  ▼
Level 4: 协调器 (Coordinator Mode)
  协调器 ──→ Worker 1 ──→ 结果
           ├→ Worker 2 ──→ 结果
           └→ Worker 3 ──→ 结果
  │ 问题：Worker 之间不能直接通信
  ▼
Level 5: 团队 (Agent Swarms)
  Leader ←──→ Teammate A ←──→ Teammate B
    ↑                              ↑
    └──────────────────────────────┘
  点对点通信，共享任务列表，持久化队友
```

每一层都建立在前一层的基础设施之上：
- Level 2 复用了 Level 1 的 Task 状态管理和通知机制
- Level 3 复用了 Level 2 的 Agent 运行时
- Level 4 复用了 Level 3 的消息传递
- Level 5 复用了 Level 4 的协调概念，增加了更灵活的后端

### 核心 Trade-offs

| 维度 | 选择 | 代价 | 收益 |
|------|------|------|------|
| Task 状态存储 | React AppState（内存） | 不支持跨进程共享 | 与 UI 天然集成，状态变更自动触发 re-render |
| 任务输出 | 磁盘文件 | I/O 开销 | 无内存压力，支持 GB 级输出 |
| 通知格式 | XML 结构化消息 | 占用对话 token | 模型原生可理解，无需额外解析工具 |
| 子代理上下文 | 克隆隔离 | 不能共享文件缓存的更新 | 并发安全，无竞态条件 |
| 工具集过滤 | 异步 Agent 白名单 | 新工具默认不可用 | 安全优先，防止遗漏 |
| 前台→后台 | AsyncGenerator + Promise.race | 实现复杂 | 无缝切换，零数据丢失 |
| Swarm 后端 | 三种后端 + 抽象层 | 维护成本高 | 适应不同环境，优雅降级 |
| 队友权限 | Leader Bridge 桥接 | 架构复杂度 | 用户只在一个终端确认，体验统一 |

### 统一 Task 抽象的价值

回到本章开头的核心问题——为什么要将 Shell、Agent、Remote、Teammate 统一为 Task？

**答案在于基础设施复用。** 以下能力只需实现一次，所有任务类型都能受益：

- **输出持久化**（`DiskTaskOutput`）：不管是 Shell 的 stdout 还是 Agent 的 transcript，都写入同格式的磁盘文件。
- **通知机制**（`<task-notification>`）：不管是谁完成了，都通过同一条通路通知主循环。
- **进度追踪**（`generateTaskAttachments`）：不管是什么类型的任务，都能在 system prompt 的 `<task-statuses>` 附件中展示。
- **生命周期管理**（`registerTask` → `updateTaskState` → `evictTerminalTask`）：状态机是统一的。
- **清理保障**（`registerCleanup`）：进程退出时的资源释放是统一的。

如果每种任务类型各自实现这些能力，代码量至少翻倍，而且修复 `DiskTaskOutput` 的内存泄漏问题时只能修复一处，其他实现可能继续泄漏。

**统一抽象的本质不是"优雅"，而是"维护成本"。** 当系统有 7 种任务类型时，统一抽象让 bug 修复和功能增强只需要改一处，而不是七处。

