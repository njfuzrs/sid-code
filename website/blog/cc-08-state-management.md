---
title: Claude Code 源码解析（八）· 状态管理
description: '对话消息、后台任务、权限配置、MCP 连接、UI 状态……一个终端应用如何管理如此复杂的全局状态而不失控？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第八章：状态管理（State Management）

> 一个终端应用如何管理复杂的全局状态——从对话消息到后台任务到权限配置。

## 核心问题

Claude Code 不是一个简单的 CLI 工具——它是一个运行在终端中的**全功能应用平台**。它同时管理着：

- 对话消息列表（可能包含数百条消息，每条消息可能包含工具调用、代码块、图片等）
- 30+ 后台任务（子代理、Shell 命令、远程会话），每个任务有独立的生命周期
- 权限系统状态（当前模式、规则集、拒绝追踪）
- MCP 连接池（多个外部服务器的连接状态、工具列表、资源列表）
- 插件系统（已加载插件、命令、错误状态）
- UI 状态（展开/折叠、焦点位置、Spinner 提示、Footer 选择）
- 推测执行状态（Speculation）、Bridge 连接状态、远程会话状态……

这些状态有一个根本性的矛盾：

**一部分状态需要驱动 React UI 重渲染（响应式），另一部分状态需要被非 React 代码访问（工具执行、API 调用、遥测上报）。**

如果把所有状态都放进 React 状态树，非 React 代码就无法访问；如果都放在全局变量里，UI 就无法自动响应变化。更复杂的是，子代理（subagent）运行在独立的执行上下文中，它们需要**部分共享**父代理的状态（比如任务列表），但又需要**隔离**另一部分状态（比如消息列表）。

Claude Code 的解法是一个**双层状态架构**：

1. **Bootstrap State**（`bootstrap/state.ts`）：进程级全局单例，非响应式，服务于配置/遥测/会话标识等"基础设施"状态
2. **AppState**（`state/AppStateStore.ts` + `state/store.ts`）：会话级应用状态，响应式，服务于 UI 渲染和业务逻辑

这两层各自解决不同的问题，又通过精心设计的桥接机制协同工作。

---

## 8.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code 状态架构                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Layer 1: Bootstrap State (bootstrap/state.ts)            │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • 进程级单例，模块加载时初始化                             │  │
│  │  • 纯 getter/setter 函数访问                               │  │
│  │  • 无依赖（叶子模块），任何模块可安全 import                │  │
│  │  • 非响应式：变更不触发 UI 重渲染                           │  │
│  │                                                           │  │
│  │  职责：会话 ID、CWD、成本统计、模型配置、遥测计数器、       │  │
│  │       API 请求追踪、Feature Flag 缓存、错误日志            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          │ onChangeAppState() 桥接              │
│                          │ (模型变更 → setMainLoopModelOverride) │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Layer 2: AppState (state/store.ts + AppStateStore.ts)    │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • 会话级，React 渲染引擎挂载时创建                        │  │
│  │  • 函数式更新：setState(prev => next)                      │  │
│  │  • 响应式：通过 useSyncExternalStore 驱动 UI               │  │
│  │  • 支持选择器（selector）精确订阅                           │  │
│  │                                                           │  │
│  │  职责：消息列表、任务状态、权限上下文、MCP 连接、           │  │
│  │       插件状态、UI 状态、推测执行、Bridge 状态              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│              ┌───────────┼───────────┐                          │
│              ▼           ▼           ▼                          │
│         React 组件    非 React 代码   子代理                     │
│        (useAppState)  (store.getState) (隔离的 setState)        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 为什么是两层而不是一层？

这个问题值得深入讨论。

**方案 A：全部放入 AppState（单一状态树）**

优点是状态集中、数据流清晰。但问题在于：

- `bootstrap/state.ts` 中的状态（如 `sessionId`、`totalCostUSD`、遥测计数器）在**模块求值阶段**就需要可用——此时 React 还没有挂载，AppState 还不存在
- 这些状态被**数百个模块**访问（工具执行、API 客户端、遥测上报），如果都通过 React Context 传递，非 React 代码就需要额外的"逃生舱"（escape hatch）
- 遥测计数器每秒可能更新数十次，如果放入响应式状态，会触发大量不必要的 UI 重渲染

**方案 B：全部放入全局变量（无响应式）**

优点是简单直接。但问题在于：

- UI 无法自动响应状态变化——每次状态变更都需要手动通知 UI 刷新
- 没有选择器机制，无法做精确的重渲染优化
- 状态变更缺乏可追踪性（谁改了什么？什么时候改的？）

**Claude Code 的选择：按"是否需要驱动 UI"分层**

- 需要驱动 UI 重渲染的状态 → AppState（响应式）
- 不需要驱动 UI、但需要被广泛访问的"基础设施"状态 → Bootstrap State（非响应式）

这是一个**实用主义的架构决策**——不追求理论上的"单一数据源"纯粹性，而是根据实际的访问模式和性能约束做分层。

---

## 8.2 Store：34 行代码的状态引擎

### 面临的问题

Claude Code 需要一个状态容器来驱动 React UI。市面上有很多选择——Redux、Zustand、Jotai、MobX、Valtio……但 Claude Code 运行在终端（Ink/React），不是浏览器。它面临的约束与 Web 应用不同：

1. **打包体积敏感**：每多一个依赖，启动时就多一份模块加载开销
2. **需要在 React 树外部访问**：工具执行逻辑、API 客户端、headless/SDK 模式都不在 React 组件树中
3. **需要与 `useSyncExternalStore` 兼容**：React 18 的并发特性要求外部 store 遵循特定协议
4. **需要状态变更的 diff 回调**：用于触发副作用（持久化、同步到外部系统）

### 解法：自研微型 Store

Claude Code 没有引入任何状态管理库，而是用 34 行代码实现了一个完整的 Store：

```typescript
// state/store.ts — 完整源码，一字不差

type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // ← 关键：引用相等则跳过
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

这 34 行代码是整个 AppState 系统的地基。让我们逐一分析它的设计决策。

### 设计决策 1：为什么 `setState` 接受函数而不是值？

```typescript
setState: (updater: (prev: T) => T) => void
// 而不是：
setState: (next: T) => void
```

函数式更新（`prev => next`）解决了一个经典的并发问题：**过期闭包（stale closure）**。

在 Claude Code 中，多个异步操作可能同时修改状态——一个工具执行完成、一个 MCP 连接状态变化、一个后台任务更新进度。如果 `setState` 接受值，调用者必须先 `getState()` 获取当前状态，然后计算新状态，再 `setState(newState)`。但在 `getState()` 和 `setState()` 之间，状态可能已经被其他操作修改了，导致更新基于过期的状态。

函数式更新保证 `prev` 始终是**调用时刻的最新状态**，消除了竞态条件。

### 设计决策 2：`Object.is` 的短路优化

```typescript
if (Object.is(next, prev)) return
```

这一行看似简单，实际上是整个渲染性能的关键。

`Object.is` 做的是**引用相等**检查（不是深比较）。这意味着：

- 如果 updater 返回了同一个对象引用（`prev => prev`），不会触发任何 listener
- 如果 updater 创建了新对象但内容相同（`prev => { ...prev }`），**仍然会触发** listener

这个设计要求所有 updater 遵循一个约定：**如果没有实际变更，必须返回 `prev` 本身**。这是一个"约定优于配置"的选择——不做深比较（性能开销大），而是依赖调用者的正确行为。

在实际代码中，这个约定被广泛遵守。例如 `state/teammateViewHelpers.ts` 中：

```typescript
export function enterTeammateView(taskId, setAppState) {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    // ... 各种检查 ...

    // 如果不需要任何变更，返回 prev 本身（不触发重渲染）
    if (!needsSwitch && !needsRetain && !needsViewMode) {
      return prev
    }

    // 有变更时才创建新对象
    return { ...prev, viewingAgentTaskId: taskId, ... }
  })
}
```

### 设计决策 3：`onChange` 回调——副作用的统一出口

```typescript
onChange?.({ newState: next, oldState: prev })
```

Store 本身是纯粹的——它只管状态的存取和订阅。但状态变更往往需要触发副作用（持久化到磁盘、同步到外部系统、清除缓存）。

`onChange` 回调提供了一个**集中的副作用出口**。它在状态更新后、listener 通知前被调用，接收新旧状态的 diff。这个设计有几个好处：

1. **副作用与 Store 解耦**：Store 不知道也不关心副作用的内容
2. **所有状态变更都经过同一个出口**：不会遗漏任何变更
3. **可以做 diff 比较**：只在特定字段变化时触发特定副作用

在 Claude Code 中，这个 `onChange` 就是 `onChangeAppState.ts`（8.5 节会详细分析）。

### 设计决策 4：为什么不用 Zustand？

这是一个值得讨论的问题。Zustand 的核心 API 与这个 Store 几乎一模一样——`getState`、`setState`、`subscribe`。事实上，Claude Code 的 Store 可以看作是 Zustand 的**最小子集**。

不用 Zustand 的可能原因：

1. **零依赖**：Zustand 虽然小（~1KB），但它仍然是一个外部依赖，需要安装、版本管理、安全审计
2. **不需要 Zustand 的额外功能**：middleware、devtools、persist、immer 集成——这些 Claude Code 都不需要
3. **完全可控**：34 行代码，团队中每个人都能完全理解，不存在"库的行为与预期不符"的风险
4. **`onChange` 回调**：Zustand 的 `subscribe` 可以实现类似功能，但 `onChange` 作为构造参数更加显式

这是一个典型的 **"当你只需要一把螺丝刀时，不要引入整个工具箱"** 的工程决策。

### 数据流：setState 的完整链路

```
调用者 (React 组件 / 工具执行 / API 回调)
  │
  │  store.setState(prev => ({ ...prev, verbose: true }))
  │
  ▼
setState 内部:
  ├─ ① 捕获 prev = 当前 state
  ├─ ② 计算 next = updater(prev)
  ├─ ③ Object.is(next, prev) ? → 相等则 return（短路）
  ├─ ④ state = next（原子替换）
  ├─ ⑤ onChange({ newState, oldState })
  │     └─ onChangeAppState():
  │         ├─ 权限模式变更 → 通知 CCR/SDK
  │         ├─ 模型变更 → 持久化到 settings
  │         ├─ verbose 变更 → 持久化到 global config
  │         └─ settings 变更 → 清除 auth 缓存
  └─ ⑥ 通知所有 listeners
        └─ React 的 useSyncExternalStore 收到通知
            └─ 调用 selector，Object.is 比较选中值
                ├─ 选中值未变 → 不重渲染
                └─ 选中值已变 → 触发组件重渲染
```

---

## 8.3 AppState：全局状态树的类型设计

### 面临的问题

AppState 是 Claude Code 中最大的单一类型定义——它包含 80+ 个字段，涵盖了应用运行时的几乎所有可变状态。设计这样一个巨型状态树面临几个核心挑战：

1. **不可变性保证**：React 的渲染优化依赖引用相等检查，如果状态被意外 mutate，UI 会出现不一致
2. **类型安全**：80+ 个字段中混合了 `DeepImmutable` 的纯数据和包含函数/可变引用的运行时对象
3. **循环依赖**：AppState 引用了 `TaskState`、`Tool`、`Command`、`Plugin` 等类型，这些类型又可能反向引用 AppState
4. **初始化复杂性**：某些字段的默认值依赖运行时计算（如权限模式取决于是否是 teammate）

### 解法：`DeepImmutable` 分区 + 类型交叉

AppState 的类型定义采用了一个精巧的结构——**将状态分为"可深度冻结"和"不可深度冻结"两个区域**：

```typescript
// state/AppStateStore.ts

export type AppState = DeepImmutable<{
  // ═══ 区域 1：纯数据，可以被 DeepImmutable 包裹 ═══
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  expandedView: 'none' | 'tasks' | 'teammates'
  toolPermissionContext: ToolPermissionContext
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  replBridgeEnabled: boolean
  // ... 约 40 个纯数据字段
}> & {
  // ═══ 区域 2：包含函数/可变引用，排除在 DeepImmutable 之外 ═══
  tasks: { [taskId: string]: TaskState }           // TaskState 包含 AbortController
  agentNameRegistry: Map<string, AgentId>          // Map 不兼容 DeepImmutable
  mcp: { clients: MCPServerConnection[], ... }     // 包含连接对象
  plugins: { enabled: LoadedPlugin[], ... }        // 包含运行时插件实例
  sessionHooks: SessionHooksState                  // Map 类型
  speculation: SpeculationState                    // 包含 abort() 函数和可变 ref
  activeOverlays: ReadonlySet<string>              // Set 类型
  replContext?: { vmContext: vm.Context, ... }      // VM 上下文
  // ... 约 40 个运行时字段
}
```

这个 `DeepImmutable<{...}> & {...}` 的交叉类型设计有几个好处：

- **区域 1** 中的字段在类型层面被强制为只读——任何试图直接修改的代码都会在编译期报错
- **区域 2** 中的字段保持原始类型——因为 `TaskState` 包含 `AbortController`（有方法）、`SpeculationState` 包含 `abort()` 函数和可变 `ref`，这些无法被 `DeepImmutable` 正确处理
- 两个区域通过 `&`（交叉类型）合并为一个统一的 `AppState` 类型

### AppState 的领域分区

从业务角度看，AppState 的 80+ 个字段可以分为以下几个领域：

```
AppState
├── 核心配置
│   ├── settings: SettingsJson          # 合并后的设置
│   ├── verbose: boolean                # 详细输出模式
│   ├── mainLoopModel: ModelSetting     # 当前模型
│   ├── thinkingEnabled: boolean        # 思考模式
│   └── fastMode: boolean              # 快速模式
│
├── 权限系统
│   ├── toolPermissionContext            # 权限模式 + 规则 + bypass 状态
│   └── denialTracking                   # 拒绝追踪（连续拒绝降级）
│
├── 任务与代理
│   ├── tasks: { [id]: TaskState }       # 所有后台任务
│   ├── agentNameRegistry: Map           # Agent 名称 → ID 映射
│   ├── foregroundedTaskId               # 前台任务
│   ├── viewingAgentTaskId               # 正在查看的代理
│   └── viewSelectionMode                # 视图选择模式
│
├── MCP 与插件
│   ├── mcp: { clients, tools, commands, resources }
│   └── plugins: { enabled, disabled, commands, errors }
│
├── UI 状态
│   ├── expandedView: 'none'|'tasks'|'teammates'
│   ├── footerSelection: FooterItem|null
│   ├── spinnerTip: string
│   ├── activeOverlays: Set<string>
│   └── notifications / elicitation
│
├── Bridge / 远程
│   ├── replBridge*: 10+ 个字段          # IDE Bridge 连接状态
│   ├── remoteSessionUrl                 # 远程会话
│   └── remoteConnectionStatus           # 远程连接状态
│
├── 推测执行
│   ├── speculation: SpeculationState    # 推测执行状态机
│   ├── speculationSessionTimeSavedMs    # 累计节省时间
│   └── promptSuggestion                 # 提示建议
│
└── 其他
    ├── fileHistory                       # 文件历史快照
    ├── attribution                       # 提交归因
    ├── todos                             # 待办列表
    ├── inbox                             # 收件箱（团队消息）
    ├── teamContext / standaloneAgentContext
    └── computerUseMcpState              # Computer Use 状态
```

### `getDefaultAppState()`：初始化的微妙之处

```typescript
// state/AppStateStore.ts

export function getDefaultAppState(): AppState {
  // ① 延迟 require 打破循环依赖
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')

  // ② 根据运行时上下文决定初始权限模式
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    // ...
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,  // ← 动态计算的初始值
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),  // ← 运行时决定
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    speculation: IDLE_SPECULATION_STATE,
    activeOverlays: new Set<string>(),
    // ...
  }
}
```

这里有两个值得注意的设计决策：

**为什么用 `require()` 而不是 `import`？**

```typescript
const teammateUtils =
  require('../utils/teammate.js') as typeof import('../utils/teammate.js')
```

这是一个**打破循环依赖**的经典手法。`AppStateStore.ts` 被几乎所有模块 import，如果它在顶层 import `teammate.ts`，而 `teammate.ts` 又（直接或间接地）import 了 `AppStateStore.ts`，就会形成循环。`require()` 是延迟执行的——只在 `getDefaultAppState()` 被调用时才解析依赖，此时所有模块都已经完成求值，循环不再是问题。

**为什么权限模式的初始值需要动态计算？**

因为 Claude Code 的进程可能以不同的身份启动：
- 普通用户启动 → `'default'` 模式
- 作为 teammate 被 spawn，且要求 plan mode → `'plan'` 模式

这个决策不能在编译期做出，必须在运行时根据进程的启动参数判断。

### 设计决策讨论：为什么是一个巨型对象而不是多个小 Store？

一个常见的替代方案是将 AppState 拆分为多个独立的 Store：

```typescript
// 替代方案：多 Store
const permissionStore = createStore<PermissionState>(...)
const taskStore = createStore<TaskState>(...)
const mcpStore = createStore<MCPState>(...)
const uiStore = createStore<UIState>(...)
```

Claude Code 选择单一 Store 的原因可能是：

1. **原子性更新**：某些操作需要同时修改多个领域的状态（比如切换权限模式时，需要同时更新 `toolPermissionContext` 和通知 Bridge）。单一 Store 保证这些变更是原子的——一次 `setState` 调用，一次 `onChange` 回调，一次 listener 通知。多 Store 方案需要额外的协调机制。

2. **简单的 diff 逻辑**：`onChangeAppState` 可以在一个函数中比较所有字段的变化。如果是多 Store，每个 Store 都需要自己的 onChange，副作用逻辑会分散。

3. **子代理隔离更简单**：子代理只需要一个 `setAppState` 函数（可以是 no-op 或受限版本），而不是多个 Store 的多个 setState。

trade-off 是：**AppState 类型定义很大（450+ 行），每次 setState 都会创建一个新的顶层对象**。但由于 `Object.is` 短路和 selector 精确订阅，这个开销在实践中是可接受的。

---

## 8.4 React 集成层：AppState.tsx

### 面临的问题

Store 是一个纯 TypeScript 对象，与 React 无关。但 Claude Code 的 UI 是用 React（Ink）渲染的，需要解决几个问题：

1. **如何让 React 组件访问 Store？** — 需要某种依赖注入机制
2. **如何让组件在状态变化时自动重渲染？** — 需要订阅机制
3. **如何避免不必要的重渲染？** — 需要精确的选择器（selector）
4. **如何让非 React 代码也能访问 Store？** — 不能完全依赖 React Context

### 解法：Context + useSyncExternalStore + Selector

`state/AppState.tsx` 是 Store 与 React 之间的桥接层。它的核心设计可以用一句话概括：**Context 只传递 Store 引用（稳定不变），组件通过 selector 订阅状态切片。**

```
┌─────────────────────────────────────────────────────┐
│  AppStateProvider                                    │
│  ┌───────────────────────────────────────────────┐  │
│  │  AppStoreContext.Provider value={store}        │  │
│  │  (store 引用永不变化 → Provider 永不触发重渲染) │  │
│  │                                                │  │
│  │  ┌─────────────┐  ┌─────────────┐             │  │
│  │  │ Component A  │  │ Component B  │             │  │
│  │  │ useAppState  │  │ useAppState  │             │  │
│  │  │ (s=>s.verbose)│  │ (s=>s.tasks) │             │  │
│  │  │              │  │              │             │  │
│  │  │ 只在 verbose │  │ 只在 tasks   │             │  │
│  │  │ 变化时重渲染 │  │ 变化时重渲染 │             │  │
│  │  └─────────────┘  └─────────────┘             │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  同时：                                              │
│  ┌───────────────────────────────────────────────┐  │
│  │  非 React 代码（工具执行、API 客户端）          │  │
│  │  直接使用 store.getState() / store.setState()  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### AppStateProvider：Store 的创建与注入

```typescript
// state/AppState.tsx — 源码还原（从编译产物反推）

export const AppStoreContext = React.createContext<AppStateStore | null>(null)
const HasAppStateContext = React.createContext<boolean>(false)

export function AppStateProvider({
  children,
  initialState,
  onChangeAppState,
}: Props): React.ReactNode {
  // ① 防止嵌套：不允许在 AppStateProvider 内部再套一个
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error(
      'AppStateProvider can not be nested within another AppStateProvider',
    )
  }

  // ② Store 只创建一次，永不重建
  // useState 的初始化函数只在首次渲染时执行
  const [store] = useState(() =>
    createStore<AppState>(
      initialState ?? getDefaultAppState(),
      onChangeAppState,
    ),
  )

  // ③ 挂载时检查：bypass 权限模式是否应该被禁用
  // 处理竞态条件：远程设置可能在 React 挂载前就加载完成
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (
      toolPermissionContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(
          prev.toolPermissionContext,
        ),
      }))
    }
  }, [])

  // ④ 监听外部设置文件变化，同步到 AppState
  const onSettingsChange = useEffectEvent((source: SettingSource) =>
    applySettingsChange(source, store.setState),
  )
  useSettingsChange(onSettingsChange)

  // ⑤ 嵌套 Provider：Mailbox（消息队列）+ Voice（语音，ant-only）
  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

几个关键设计决策值得展开：

**为什么 Store 引用永不变化？**

```typescript
const [store] = useState(() => createStore(...))
```

`useState` 的初始化函数只在组件首次渲染时执行一次。之后无论 `AppStateProvider` 因为什么原因重渲染，`store` 始终是同一个引用。这意味着 `AppStoreContext.Provider` 的 `value` 永远不变，**Provider 永远不会因为 value 变化而触发子树重渲染**。

这是一个关键的性能优化——所有的重渲染都由 `useSyncExternalStore` 驱动，而不是由 Context 变化驱动。Context 只是一个"查找 Store 在哪里"的机制，不参与状态变更的传播。

**为什么要防止嵌套？**

```typescript
if (hasAppStateContext) {
  throw new Error('AppStateProvider can not be nested...')
}
```

嵌套的 AppStateProvider 会创建两个独立的 Store，内层组件会访问内层 Store 而看不到外层 Store 的状态。这几乎肯定是 bug，所以直接抛错。`HasAppStateContext` 是一个专门用于检测嵌套的 Context——它的值只有 `true`/`false`，与 Store 无关。

**VoiceProvider 的条件加载**

```typescript
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children  // 透传，零开销
```

语音功能只在内部版本（ant）中可用。外部构建通过 `feature('VOICE_MODE')` 编译期门控，将 `VoiceProvider` 替换为一个透传组件，避免加载语音相关的模块。

### useAppState：精确订阅的核心 Hook

```typescript
// state/AppState.tsx

/**
 * Subscribe to a slice of AppState. Only re-renders when the selected value
 * changes (compared via Object.is).
 *
 * Do NOT return new objects from the selector -- Object.is will always see
 * them as changed. Instead, select an existing sub-object reference.
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()

  const get = () => {
    const state = store.getState()
    const selected = selector(state)

    // 内部构建的开发期检查：禁止 selector 返回整个 state
    if ("external" === 'ant' && state === selected) {
      throw new Error(
        `Your selector returned the original state, which is not allowed.`
      )
    }

    return selected
  }

  return useSyncExternalStore(store.subscribe, get, get)
}
```

这个 Hook 的工作原理：

1. `useSyncExternalStore` 是 React 18 提供的官方 API，用于订阅外部 Store
2. 每当 Store 的任何 listener 被通知（即 `setState` 被调用），React 会调用 `get()` 获取新的选中值
3. React 用 `Object.is` 比较新旧选中值——如果相同，**不触发重渲染**
4. 只有选中值确实变化时，组件才会重渲染

这意味着：

```typescript
// 好的用法：只在 verbose 变化时重渲染
const verbose = useAppState(s => s.verbose)

// 好的用法：选择已有的子对象引用
const { text, promptId } = useAppState(s => s.promptSuggestion)

// 坏的用法：每次都创建新对象，导致每次 setState 都重渲染！
const info = useAppState(s => ({ verbose: s.verbose, model: s.mainLoopModel }))
//                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                新对象，Object.is 永远返回 false
```

源码注释中的警告 `"Do NOT return new objects from the selector"` 就是针对这个陷阱。内部构建甚至有一个运行时检查——如果 selector 返回了整个 state 对象，直接抛错。

### useSetAppState 与 useAppStateStore：写入与直接访问

```typescript
// 只获取 setState，不订阅任何状态
// 返回稳定引用，使用此 Hook 的组件永远不会因状态变化而重渲染
export function useSetAppState() {
  return useAppStore().setState
}

// 获取整个 Store（用于传递给非 React 代码）
export function useAppStateStore() {
  return useAppStore()
}
```

`useSetAppState` 的设计意图是：**有些组件只需要修改状态，不需要读取状态**。比如一个"切换 verbose 模式"的按钮，它只需要 `setState`，不需要知道当前是否 verbose。使用 `useSetAppState` 可以避免不必要的订阅。

### useAppStateMaybeOutsideOfProvider：安全的可选访问

```typescript
const NOOP_SUBSCRIBE = () => () => {}

export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    () => store ? selector(store.getState()) : undefined,
  )
}
```

这个 Hook 解决了一个实际问题：**某些组件可能在 AppStateProvider 内部渲染，也可能在外部渲染**。比如错误边界组件、日志组件等。普通的 `useAppState` 在 Provider 外部会抛错，而这个 Hook 会优雅地返回 `undefined`。

### 数据流：从 Store 创建到组件渲染

```
main.tsx / App.tsx
  │
  │  <AppStateProvider
  │    initialState={...}
  │    onChangeAppState={onChangeAppState}
  │  >
  │
  ▼
AppStateProvider 内部:
  ├─ useState(() => createStore(initialState, onChangeAppState))
  │   └─ Store 创建，state = initialState
  │
  ├─ useEffect: 检查 bypass 权限竞态
  │
  ├─ useSettingsChange: 监听设置文件变化
  │
  └─ <AppStoreContext.Provider value={store}>
       │
       ├─ <ComponentA>
       │   useAppState(s => s.verbose)
       │   └─ useSyncExternalStore(store.subscribe, () => selector(store.getState()))
       │       └─ 订阅 store，selector 返回 s.verbose
       │
       └─ <ComponentB>
           useSetAppState()
           └─ 获取 store.setState，不订阅
           │
           │  用户点击按钮 → setState(prev => ({ ...prev, verbose: !prev.verbose }))
           │
           ▼
         Store.setState:
           ├─ Object.is 检查 → 不同
           ├─ state = next
           ├─ onChangeAppState({ newState, oldState })
           │   └─ verbose 变化 → saveGlobalConfig({ verbose })
           └─ 通知 listeners
               ├─ ComponentA 的 useSyncExternalStore 被触发
               │   └─ selector(newState) = !verbose → 与旧值不同 → 重渲染
               └─ ComponentB 没有订阅 → 不受影响
```

---

## 8.5 onChangeAppState：副作用的集中枢纽

### 面临的问题

AppState 的变更不仅仅影响 UI——很多状态变更需要触发"外部世界"的副作用：

- 权限模式变化 → 需要通知 CCR（Claude Code Remote）和 SDK 状态流
- 模型变更 → 需要持久化到 `~/.claude/settings.local.json`
- verbose/expandedView 变更 → 需要持久化到全局配置
- settings 变更 → 需要清除认证缓存、重新应用环境变量

这些副作用散布在应用的各个角落。如果每个修改状态的地方都自己负责触发副作用，就会出现两个问题：

1. **遗漏**：某个修改路径忘记触发副作用，导致状态不一致
2. **重复**：多个修改路径重复实现相同的副作用逻辑

源码注释中有一段精彩的"考古记录"，描述了这个问题的真实历史：

```typescript
// Prior to this block, mode changes were relayed to CCR by only 2 of 8+
// mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK
// mode only) and a manual notify in the set_permission_mode handler.
// Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest
// dialog options, the /plan slash command, rewind, the REPL bridge's
// onSetPermissionMode — mutated AppState without telling CCR, leaving
// external_metadata.permission_mode stale and the web UI out of sync
// with the CLI's actual mode.
```

翻译：在引入集中式副作用处理之前，权限模式有 8+ 个修改路径，但只有 2 个路径会通知 CCR。其他 6 个路径（Shift+Tab 切换、退出 Plan 模式对话框、/plan 命令、回退、Bridge 回调等）都会修改 AppState 但不通知 CCR，导致 Web UI 与 CLI 的实际模式不同步。

### 解法：Store 的 `onChange` 回调作为统一拦截点

```typescript
// state/onChangeAppState.ts — 完整源码

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // ═══ 副作用 1：权限模式同步 ═══
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR 不能接收内部模式名（bubble、ungated auto），需要先"外部化"
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan 标记：只在首次进入时发送 true，否则发送 null（删除键）
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    // SDK 状态流始终接收原始模式（它有自己的过滤逻辑）
    notifyPermissionModeChanged(newMode)
  }

  // ═══ 副作用 2：模型持久化 ═══
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      // 清除：从 settings 中移除，重置 bootstrap 覆盖
      updateSettingsForSource('userSettings', { model: undefined })
      setMainLoopModelOverride(null)
    } else {
      // 设置：写入 settings，更新 bootstrap 覆盖
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  // ═══ 副作用 3：expandedView 持久化 ═══
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    // 只在实际值不同时写入，避免无谓的磁盘 I/O
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // ═══ 副作用 4：verbose 持久化 ═══
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    saveGlobalConfig(current => ({ ...current, verbose: newState.verbose }))
  }

  // ═══ 副作用 5：tmux 面板可见性持久化（ant-only）═══
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      saveGlobalConfig(current => ({
        ...current,
        tungstenPanelVisible: newState.tungstenPanelVisible,
      }))
    }
  }

  // ═══ 副作用 6：settings 变更 → 缓存失效 + 环境变量重应用 ═══
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // env 变更是 additive-only：新增/覆盖，不删除
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
```

### 设计决策分析

**为什么权限模式需要"外部化"？**

```typescript
const prevExternal = toExternalPermissionMode(prevMode)
const newExternal = toExternalPermissionMode(newMode)
```

Claude Code 内部有一些"过渡性"权限模式（如 `bubble`、`ungated auto`），这些模式对外部系统（CCR、Web UI）没有意义。`toExternalPermissionMode` 将它们映射为标准模式（如 `default`、`plan`、`auto`）。

更微妙的是：如果内部模式从 `default` → `bubble` → `default`，外部化后两次都是 `default`，所以 CCR 不需要被通知。这就是为什么要先外部化再比较——避免向 CCR 发送无意义的"变更"通知。

**为什么模型变更要同时写入 settings 和 bootstrap state？**

```typescript
updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
setMainLoopModelOverride(newState.mainLoopModel)
```

这里涉及两个不同的持久化层：

- `updateSettingsForSource` → 写入 `~/.claude/settings.local.json`，跨会话持久化
- `setMainLoopModelOverride` → 更新 `bootstrap/state.ts` 中的内存状态，供当前会话的非 React 代码读取

这是**双层状态架构的桥接点**——AppState 的变更通过 `onChangeAppState` 同步到 Bootstrap State。

**为什么 settings 变更要清除认证缓存？**

```typescript
if (newState.settings !== oldState.settings) {
  clearApiKeyHelperCache()
  clearAwsCredentialsCache()
  clearGcpCredentialsCache()
}
```

因为 settings 中可能包含 API Key、AWS 凭证、GCP 凭证的配置。当用户通过 `/config` 命令或直接编辑 settings 文件修改了这些配置时，缓存的旧凭证必须被清除，否则后续的 API 调用仍然会使用旧凭证。

**为什么环境变量重应用是 "additive-only"？**

```typescript
// This is additive-only: new vars are added, existing may be overwritten,
// nothing is deleted
if (newState.settings.env !== oldState.settings.env) {
  applyConfigEnvironmentVariables()
}
```

因为 `process.env` 是一个全局可变对象，删除环境变量可能影响已经读取并缓存了该变量的模块。additive-only 策略更安全——只添加新变量或覆盖已有变量，不删除任何变量。

### `externalMetadataToAppState`：反向桥接

```typescript
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}
```

这个函数是 `onChangeAppState` 的**逆操作**——当 worker 重启时，需要从 CCR 的外部元数据恢复 AppState。它返回一个 `setState` updater 函数，可以直接传给 `store.setState()`。

这形成了一个双向同步回路：

```
AppState 变更 ──→ onChangeAppState ──→ CCR external_metadata
                                            │
CCR external_metadata ──→ externalMetadataToAppState ──→ AppState 恢复
```

---

## 8.6 Bootstrap State：进程级全局单例

### 面临的问题

在 8.1 节中我们提到了双层架构的第一层——Bootstrap State。现在深入分析它面临的具体问题：

1. **模块求值阶段的状态需求**：很多模块在顶层 `const` 中捕获状态值（如 `const cwd = getCwd()`），这发生在 React 挂载之前，AppState 还不存在
2. **跨模块的广泛访问**：`sessionId`、`cwd`、`totalCostUSD` 等状态被数百个模块访问——工具执行、API 客户端、遥测上报、日志记录、会话管理……
3. **循环依赖风险**：如果状态定义在某个"高层"模块中（如 `main.tsx`），底层模块 import 它就会形成循环
4. **高频更新但不需要 UI 响应**：遥测计数器、API 请求追踪等状态每秒可能更新数十次，不应该触发 UI 重渲染

### 解法：低依赖的全局状态模块

`bootstrap/state.ts` 是一个 **1758 行**的大文件，但它的设计原则极其简单：

```typescript
// bootstrap/state.ts

// ═══ 警告注释 ═══
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// ═══ 类型定义：~260 行 ═══
type State = {
  originalCwd: string
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  isInteractive: boolean
  sessionId: SessionId
  // ... 约 80 个字段
}

// ═══ 初始化：~170 行 ═══
// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State {
  let resolvedCwd = ''
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      resolvedCwd = rawCwd.normalize('NFC')  // CloudStorage EPERM fallback
    }
  }
  return {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    sessionId: randomUUID() as SessionId,
    // ... 所有字段的默认值
  }
}

// ═══ 全局单例：1 行 ═══
// AND ESPECIALLY HERE
const STATE: State = getInitialState()

// ═══ Getter/Setter 函数：~1300 行 ═══
export function getSessionId(): SessionId { return STATE.sessionId }
export function getCwd(): string { return STATE.cwd }
export function setCwd(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
  resetSettingsCache()  // 副作用：cwd 变化时清除设置缓存
}
// ... 200+ 个 getter/setter
```

注意源码中的三条警告注释——它们的语气逐渐加强：

1. `"DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE"` — 在类型定义前
2. `"ALSO HERE - THINK THRICE BEFORE MODIFYING"` — 在初始化函数前
3. `"AND ESPECIALLY HERE"` — 在全局单例声明前

这些注释是**架构护栏**——全局可变状态是已知的维护性杀手，团队显然希望严格控制它的增长。

### Bootstrap State 的领域分区

```
Bootstrap State (~80 个字段)
├── 会话标识
│   ├── sessionId: SessionId              # UUID，每次会话唯一
│   ├── parentSessionId: SessionId        # 父会话（plan mode → 实现）
│   ├── originalCwd: string               # 启动时的工作目录
│   ├── projectRoot: string               # 项目根目录（跨 worktree 稳定）
│   └── cwd: string                       # 当前工作目录（可变）
│
├── 成本与用量
│   ├── totalCostUSD: number              # 累计 API 成本
│   ├── totalAPIDuration: number          # 累计 API 耗时
│   ├── totalToolDuration: number         # 累计工具执行耗时
│   ├── totalLinesAdded/Removed: number   # 代码变更统计
│   ├── modelUsage: { [model]: Usage }    # 按模型的 token 用量
│   └── turnXxxDurationMs/Count           # 每轮的细粒度指标
│
├── 遥测基础设施
│   ├── meter: Meter                      # OpenTelemetry Meter
│   ├── sessionCounter: AttributedCounter # 会话计数器
│   ├── costCounter: AttributedCounter    # 成本计数器
│   ├── tokenCounter: AttributedCounter   # Token 计数器
│   ├── loggerProvider: LoggerProvider     # 日志 Provider
│   └── tracerProvider: TracerProvider     # 追踪 Provider
│
├── 模型与配置
│   ├── mainLoopModelOverride: ModelSetting  # 用户指定的模型
│   ├── initialMainLoopModel: ModelSetting   # 会话开始时的模型
│   ├── isInteractive: boolean               # 交互式 vs headless
│   ├── clientType: string                   # 'cli' / 'claude-vscode' 等
│   └── flagSettingsPath: string             # --settings 标志路径
│
├── API 请求追踪
│   ├── lastAPIRequest: Params               # 最后一次 API 请求参数
│   ├── lastAPIRequestMessages: Messages     # 最后一次请求的消息
│   ├── lastMainRequestId: string            # 用于缓存驱逐提示
│   └── lastApiCompletionTimestamp: number   # 用于缓存 TTL 关联
│
├── Prompt Cache 优化
│   ├── promptCache1hAllowlist: string[]     # 1h TTL 白名单
│   ├── promptCache1hEligible: boolean       # 用户是否有资格
│   ├── afkModeHeaderLatched: boolean        # AFK 模式 header 锁存
│   ├── fastModeHeaderLatched: boolean       # 快速模式 header 锁存
│   └── cacheEditingHeaderLatched: boolean   # 缓存编辑 header 锁存
│
├── 会话级标志
│   ├── sessionBypassPermissionsMode         # 会话级权限绕过
│   ├── sessionTrustAccepted                 # 会话级信任（不持久化）
│   ├── hasExitedPlanMode                    # 是否退出过 plan 模式
│   ├── scheduledTasksEnabled                # 定时任务是否启用
│   └── sessionPersistenceDisabled           # 是否禁用会话持久化
│
└── 缓存与临时状态
    ├── systemPromptSectionCache: Map        # System Prompt 段落缓存
    ├── planSlugCache: Map                   # 会话 ID → 词汇 slug
    ├── invokedSkills: Map                   # 已调用的 Skills
    ├── agentColorMap: Map                   # Agent 颜色分配
    └── inMemoryErrorLog: Array              # 最近错误日志（最多 100 条）
```

### 关键设计模式：Getter/Setter 而非直接导出

Bootstrap State 不直接导出 `STATE` 对象，而是通过 getter/setter 函数暴露每个字段：

```typescript
// ❌ 不是这样（直接导出可变对象）
export const STATE = getInitialState()

// ✅ 而是这样（通过函数间接访问）
const STATE: State = getInitialState()  // 模块私有

export function getCwd(): string { return STATE.cwd }
export function setCwd(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
  resetSettingsCache()  // ← 可以附加副作用
}
```

这个设计有三个好处：

1. **可以附加副作用**：`setCwd` 在修改 cwd 时自动清除设置缓存（因为设置的解析依赖 cwd）
2. **可以做输入规范化**：`setCwd` 自动对路径做 NFC 规范化
3. **可以控制访问粒度**：某些字段只有 getter 没有 setter（只读），某些字段有特殊的更新逻辑

### 累加器模式：高频更新的优化

对于高频更新的计数器，Bootstrap State 提供了专门的累加函数：

```typescript
export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}
```

这些函数一次调用更新多个相关字段，保证了**逻辑一致性**——不会出现 `totalToolDuration` 更新了但 `turnToolCount` 没更新的情况。

### 会话切换：`switchSession` 与 `regenerateSessionId`

```typescript
export const sessionSwitched = createSignal<SessionId>()

export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  STATE.planSlugCache.delete(STATE.sessionId)  // 清理旧会话的缓存
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)  // 通知所有订阅者
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId  // 记录父子关系
  }
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}
```

这里有一个有趣的设计——`sessionSwitched` 是一个 **Signal**（信号），而不是回调。Signal 是一个轻量级的发布-订阅机制，允许任何模块订阅会话切换事件，而不需要知道 Bootstrap State 的内部实现。

`regenerateSessionId` 的 `setCurrentAsParent` 选项用于 plan mode → 实现模式的切换：plan mode 在一个会话中完成规划，然后生成新的会话 ID 开始实现，同时记录父会话 ID 以便追踪会话谱系。

### 设计决策讨论

**为什么 Bootstrap State 是模块级单例而不是类实例？**

```typescript
// 当前方案：模块级单例
const STATE: State = getInitialState()
export function getCwd() { return STATE.cwd }

// 替代方案：类实例
export class BootstrapState {
  private state: State
  getCwd() { return this.state.cwd }
}
export const bootstrapState = new BootstrapState()
```

模块级单例的优势在于：

1. **导入更简洁**：`import { getCwd } from 'bootstrap/state'` vs `import { bootstrapState } from 'bootstrap/state'; bootstrapState.getCwd()`
2. **Tree-shaking 友好**：未使用的 getter/setter 可以被 bundler 消除；类实例的方法无法被消除
3. **无 `this` 绑定问题**：函数导出不存在 `this` 丢失的风险

**"DO NOT ADD MORE STATE HERE" 的实际效果如何？**

从源码来看，Bootstrap State 已经有 ~80 个字段，而且还在增长（很多字段的注释中有 PR 编号，说明是后来添加的）。这个警告更多是一个**速度减速带**——它不能阻止添加新状态，但它迫使开发者在添加前思考："这个状态真的需要是全局的吗？能不能放在 AppState 里？能不能放在局部变量里？"

**Bootstrap State vs AppState 的边界在哪里？**

从源码中可以观察到一个模式：

| 特征 | Bootstrap State | AppState |
|------|----------------|----------|
| 生命周期 | 进程级（从启动到退出） | 会话级（React 挂载到卸载） |
| 访问方式 | 函数调用（`getCwd()`） | Hook（`useAppState(s => s.cwd)`）或 `store.getState()` |
| 响应式 | 否 | 是（驱动 UI 重渲染） |
| 主要消费者 | 工具执行、API 客户端、遥测 | React 组件、权限 UI、任务面板 |
| 更新频率 | 高（遥测计数器每秒数十次） | 中（用户交互驱动） |
| 依赖关系 | 叶子模块（无业务依赖） | 依赖大量业务类型 |

有一个有趣的重叠：`mainLoopModel` 同时存在于两层——AppState 中的 `mainLoopModel` 是"权威源"（驱动 UI），Bootstrap State 中的 `mainLoopModelOverride` 是"镜像"（供非 React 代码读取）。`onChangeAppState` 负责保持两者同步。

---

## 8.7 状态选择器与派生状态

### 面临的问题

AppState 是一个扁平的大对象，但 UI 组件经常需要的是**派生数据**——比如"当前正在查看的 teammate 任务"需要从 `viewingAgentTaskId` 和 `tasks` 两个字段联合计算。如果每个组件都自己做这个计算，会导致：

1. **逻辑重复**：多个组件重复相同的查找/过滤逻辑
2. **类型不安全**：每个组件都需要自己做类型守卫（type guard）
3. **性能陷阱**：如果在 `useAppState` 的 selector 中创建新对象，会导致每次 setState 都触发重渲染

### 解法：纯函数选择器

`state/selectors.ts` 提供了一组纯函数选择器，用于从 AppState 派生计算值：

```typescript
// state/selectors.ts

/**
 * 获取当前正在查看的 teammate 任务
 * 防御性编程：任何一步查找失败都返回 undefined
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState
  if (!viewingAgentTaskId) return undefined
  const task = tasks[viewingAgentTaskId]
  if (!task) return undefined
  if (!isInProcessTeammateTask(task)) return undefined
  return task
}

/**
 * 确定用户输入应该路由到哪个代理
 * 返回判别联合类型，调用者可以安全地 switch
 */
export type ActiveAgentForInput =
  | { type: 'leader' }                                    // 主代理
  | { type: 'viewed'; task: InProcessTeammateTaskState }   // 正在查看的 teammate
  | { type: 'named_agent'; task: LocalAgentTaskState }     // 命名代理

export function getActiveAgentForInput(appState: AppState): ActiveAgentForInput {
  // 优先级 1：进程内 teammate
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) return { type: 'viewed', task: viewedTask }

  // 优先级 2：本地代理
  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') return { type: 'named_agent', task }
  }

  // 默认：主代理
  return { type: 'leader' }
}
```

### 设计决策：为什么选择器接受 `Pick<AppState, ...>` 而不是完整的 `AppState`？

```typescript
function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
)
```

`Pick` 类型有两个好处：

1. **文档化依赖**：类型签名明确告诉读者"这个函数只依赖这两个字段"
2. **测试友好**：测试时只需要构造包含两个字段的对象，不需要构造完整的 AppState

### teammateViewHelpers：状态变更的封装

`state/teammateViewHelpers.ts` 提供了一组更高层的状态变更函数，封装了 teammate 视图切换的复杂逻辑：

```typescript
// state/teammateViewHelpers.ts

// 进入 teammate 视图
export function enterTeammateView(taskId, setAppState): void {
  setAppState(prev => {
    // 1. 查找目标任务和当前查看的任务
    // 2. 如果从另一个 agent 切换过来，释放旧 agent（清除消息、设置驱逐时间）
    // 3. 如果目标是 local_agent，设置 retain=true（阻止驱逐、启用流式追加）
    // 4. 如果不需要任何变更，返回 prev（不触发重渲染）
    // 5. 返回新状态
  })
}

// 退出 teammate 视图
export function exitTeammateView(setAppState): void {
  setAppState(prev => {
    // 1. 清除 viewingAgentTaskId 和 viewSelectionMode
    // 2. 如果之前查看的是 retained local_agent，释放它
  })
}

// 停止或关闭 agent
export function stopOrDismissAgent(taskId, setAppState): void {
  setAppState(prev => {
    // running → abort（通过 AbortController）
    // terminal → dismiss（设置 evictAfter=0 立即隐藏）
  })
}
```

这里有一个精巧的**内存管理机制**——`retain` / `release` / `evictAfter`：

```
Agent 任务生命周期中的内存管理:

  创建 ──→ 运行中 ──→ 完成/失败
   │         │           │
   │         │           └─ evictAfter = Date.now() + 30s
   │         │              (30 秒后从 tasks 中移除)
   │         │
   │    用户点击查看
   │         │
   │         ▼
   │    retain = true     ← 阻止驱逐，加载磁盘消息
   │    evictAfter = undefined
   │         │
   │    用户退出查看
   │         │
   │         ▼
   │    release():
   │    ├─ retain = false
   │    ├─ messages = undefined  ← 释放内存
   │    ├─ diskLoaded = false
   │    └─ evictAfter = now + 30s (如果已完成)
   │
   └─ 用户点击关闭
        evictAfter = 0  ← 立即隐藏
```

这个机制解决了一个实际问题：**后台任务的消息可能很大（数百条），不能一直保留在内存中**。只有当用户正在查看某个任务时，才加载它的消息（`retain = true`）；用户切走后，释放消息并设置延迟驱逐。

### 循环依赖的处理

`teammateViewHelpers.ts` 中有两个有趣的"内联"处理：

```typescript
// 内联常量，避免从 framework.ts 导入（会通过 BackgroundTasksDialog 形成循环）
const PANEL_GRACE_MS = 30_000

// 内联类型守卫，避免从 LocalAgentTask 导入（同样的循环问题）
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null &&
    'type' in task && task.type === 'local_agent'
}
```

这是一个**务实的循环依赖处理**——与其引入复杂的延迟加载或模块重组，不如直接内联一个常量和一个简单的类型守卫。代价是需要手动保持同步（注释中说 "Keep in sync with PANEL_GRACE_MS there"），但对于一个常量和一个 4 行函数来说，这个代价是可接受的。

---

## 8.8 子代理的状态隔离

### 面临的问题

Claude Code 支持子代理（subagent）——主代理可以通过 AgentTool 派生子代理来并行处理任务。子代理面临一个核心的状态管理问题：

**子代理需要读取父代理的部分状态（如权限配置、工具列表），但不能修改父代理的 UI 状态（如消息列表、Spinner 提示）。**

如果子代理可以随意修改 AppState，多个并发子代理的状态更新会互相干扰，导致 UI 混乱。但如果完全隔离，子代理就无法注册后台任务、无法更新共享的基础设施状态。

### 解法：默认隔离 + 显式共享通道

子代理的状态隔离通过 `createSubagentContext()`（`utils/forkedAgent.ts`）实现。核心原则是：**默认隔离一切，调用者显式 opt-in 共享。**

```
┌─────────────────────────────────────────────────────────┐
│  父代理 (Main Agent)                                     │
│                                                          │
│  AppState Store ◄──── setAppState (正常写入)              │
│       │                                                  │
│       │ getAppState (读取)                                │
│       │                                                  │
│  ┌────┼──────────────────────────────────────────────┐   │
│  │    ▼  子代理 (Subagent)                            │   │
│  │                                                    │   │
│  │  getAppState ──→ 包装版本:                          │   │
│  │    • 异步代理: 自动注入 shouldAvoidPermissionPrompts │   │
│  │    • 同步代理: 直接使用父代理的 getAppState          │   │
│  │                                                    │   │
│  │  setAppState ──→ 默认: () => {} (no-op)            │   │
│  │    • 同步代理可 opt-in 共享父代理的 setAppState      │   │
│  │                                                    │   │
│  │  setAppStateForTasks ──→ 始终连接到根 Store          │   │
│  │    • 用于注册/清理后台任务、Shell 进程               │   │
│  │    • 即使 setAppState 是 no-op，这个通道也畅通       │   │
│  │                                                    │   │
│  │  隔离的状态:                                        │   │
│  │    • readFileState: 克隆自父代理                     │   │
│  │    • abortController: 新建，链接到父代理             │   │
│  │    • localDenialTracking: 独立的拒绝计数器           │   │
│  │    • contentReplacementState: 克隆                   │   │
│  │    • 各种 Set/Map: 全部新建                          │   │
│  │                                                    │   │
│  │  No-op 的回调:                                      │   │
│  │    • setInProgressToolUseIDs                         │   │
│  │    • updateFileHistoryState                          │   │
│  │    • addNotification                                 │   │
│  │    • setToolJSX                                      │   │
│  │    • setStreamMode                                   │   │
│  └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### `setAppStateForTasks`：关键的共享通道

这是子代理状态隔离中最精妙的设计。源码注释说得很清楚：

```typescript
// Tool.ts — ToolUseContext 定义

/**
 * Always-shared setAppState for session-scoped infrastructure (background
 * tasks, session hooks). Unlike setAppState, which is a no-op for async
 * agents (see createSubagentContext), this always reaches the root store
 * so agents at any nesting depth can register/clean up infrastructure
 * that outlives a single turn.
 */
setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
```

问题场景：一个异步子代理执行 BashTool，启动了一个后台 Shell 进程。这个进程需要被注册到 AppState 的 `tasks` 中，否则：

1. 用户看不到这个后台进程
2. 进程无法被 TaskStopTool 终止
3. 进程在父代理退出时不会被清理（变成僵尸进程）

但子代理的 `setAppState` 是 no-op——它无法写入 AppState。

`setAppStateForTasks` 解决了这个问题：它**始终连接到根 Store**，无论嵌套多深。子代理通过这个通道注册后台任务，任务信息直接写入根 AppState，用户可以在 UI 中看到并管理这些任务。

```typescript
// forkedAgent.ts — createSubagentContext

setAppStateForTasks:
  parentContext.setAppStateForTasks ?? parentContext.setAppState,
```

这行代码的含义：如果父代理有 `setAppStateForTasks`（说明父代理本身也是子代理），就继续传递；否则使用父代理的 `setAppState`（说明父代理是根代理）。这样无论嵌套多少层，`setAppStateForTasks` 始终指向根 Store。

### 同步 vs 异步子代理的区别

```typescript
// runAgent.ts — 创建子代理上下文

const agentToolUseContext = createSubagentContext(toolUseContext, {
  // 同步代理共享父代理的 setAppState（它们的 UI 更新直接反映在父代理的界面中）
  shareSetAppState: !isAsync,
  // 两种代理都贡献响应长度指标
  shareSetResponseLength: true,
  // ...
})
```

| 特性 | 同步子代理 | 异步子代理 |
|------|-----------|-----------|
| `setAppState` | 共享父代理的（可写入 AppState） | no-op（不能写入 AppState） |
| `getAppState` | 直接使用父代理的 | 包装版本（注入 `shouldAvoidPermissionPrompts`） |
| `setAppStateForTasks` | 连接到根 Store | 连接到根 Store |
| `abortController` | 可选共享 | 独立（父 abort 传播到子，子 abort 不影响父） |
| `localDenialTracking` | 共享父代理的 | 独立（因为 setAppState 是 no-op，无法写入全局拒绝计数） |

### 异步子代理的权限提示回避

```typescript
// forkedAgent.ts

const getAppState = overrides?.shareAbortController
  ? parentContext.getAppState
  : () => {
      const state = parentContext.getAppState()
      if (state.toolPermissionContext.shouldAvoidPermissionPrompts) {
        return state
      }
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          shouldAvoidPermissionPrompts: true,
        },
      }
    }
```

异步子代理在后台运行，用户看不到它的执行过程。如果它弹出权限确认对话框，用户会感到困惑——"这个对话框是哪来的？"。所以异步子代理的 `getAppState` 被包装为自动注入 `shouldAvoidPermissionPrompts: true`，让权限系统跳过交互式确认，改用分类器自动决策。

---

## 8.9 会话持久化

### 面临的问题

用户可能在一个长对话中途关闭 Claude Code，之后通过 `claude --resume` 恢复。这要求某些状态能够跨会话持久化。但 AppState 有 80+ 个字段，不可能（也不应该）全部持久化——很多字段是运行时临时状态（如 MCP 连接、Spinner 提示、推测执行状态）。

### 解法：事件溯源（Event Sourcing）而非状态快照

Claude Code 的会话持久化**不是**"序列化 AppState → 写入磁盘 → 反序列化恢复"。它采用的是**事件溯源**模式：

```
持久化（写入）:
  会话过程中，关键事件被追加写入 JSONL 文件:
  ├─ 对话消息（UserMessage、AssistantMessage、ToolResult）
  ├─ 文件历史快照（file-history-snapshot）
  ├─ 归因快照（attribution-snapshot）
  ├─ 上下文折叠快照（context-collapse-snapshot）
  └─ 会话元数据（title、tag、agent、mode、worktree、PR 信息）

恢复（读取）:
  从 JSONL 文件重建状态:
  ├─ 消息列表 → 直接恢复
  ├─ 文件历史快照 → 重建 fileHistory 状态
  ├─ 会话元数据 → 恢复到 Project 单例和 AppState
  └─ 其他运行时状态 → 使用默认值（MCP 重连、权限重新初始化等）
```

### 持久化存储位置

```
~/.claude/
├── history.jsonl                          # 全局输入历史（所有项目共享）
├── projects/
│   └── <sanitized-project-path>/
│       ├── <sessionId>.jsonl              # 会话转录（消息 + 元数据）
│       └── ...
├── file-history/
│   └── <sessionId>/
│       └── <hash>@v<version>              # 文件备份（用于 rewind）
└── ...
```

### 什么被持久化，什么不被持久化

| 状态 | 持久化？ | 存储位置 | 恢复方式 |
|------|---------|---------|---------|
| 对话消息 | 是 | session JSONL | 直接加载 |
| 文件历史快照 | 是 | session JSONL + file-history/ | 从快照重建 |
| 会话标题/标签 | 是 | session JSONL | 恢复到 Project 单例 |
| Agent 名称/颜色 | 是 | session JSONL | 恢复到 AppState |
| 权限模式 | 是 | session JSONL (mode) | 恢复到 AppState |
| Worktree 状态 | 是 | session JSONL | 恢复 worktree |
| 模型选择 | 是 | settings.local.json | 从设置加载 |
| 成本统计 | 是 | 项目配置 | `restoreCostStateForSession` |
| MCP 连接 | 否 | — | 重新连接 |
| 插件状态 | 否 | — | 重新加载 |
| 推测执行 | 否 | — | 重置为 idle |
| Bridge 连接 | 否 | — | 重新建立 |
| UI 状态 | 否 | — | 使用默认值 |
| 后台任务 | 否 | — | 已终止 |

### 设计决策：为什么是事件溯源而不是状态快照？

1. **增量写入**：JSONL 格式支持追加写入，每条消息只写一次。状态快照需要每次变更都重写整个文件。
2. **部分恢复**：用户可能只想恢复消息列表，不想恢复权限模式。事件溯源允许选择性重建。
3. **审计追踪**：JSONL 文件本身就是完整的会话记录，可以用于调试、分享（`/share` 命令）、分析。
4. **容错性**：如果写入中途崩溃，最多丢失最后一条记录。状态快照如果写入中途崩溃，整个文件可能损坏。

---

## 8.10 总结：状态管理的设计哲学

回顾整个状态管理系统，可以提炼出几个贯穿始终的设计哲学：

### 1. 按访问模式分层，而非按领域分层

Bootstrap State 和 AppState 的分界线不是"配置 vs UI"或"全局 vs 局部"，而是**"是否需要驱动 React 重渲染"**。这是一个以消费者需求为导向的分层策略。

### 2. 最小化自研，最大化控制

34 行的 Store 实现、纯函数选择器、手动的 `onChange` 回调——没有引入任何状态管理库。这不是 NIH（Not Invented Here）综合症，而是对"我们到底需要什么"的清醒认识。当需求足够简单时，自研的代价（34 行代码）远低于引入外部依赖的代价（版本管理、API 学习、行为不可控）。

### 3. 副作用集中化

`onChangeAppState` 是所有状态变更副作用的**唯一出口**。这解决了一个在大型应用中极其常见的问题——"状态变更的副作用散布在各处，某些路径遗漏了某些副作用"。源码注释中的"考古记录"（8 个修改路径中只有 2 个通知了 CCR）生动地说明了这个问题的严重性。

### 4. 默认隔离，显式共享

子代理的状态隔离策略是"默认一切 no-op，需要共享的显式 opt-in"。这是**最小权限原则**在状态管理中的体现——宁可多隔离一些（导致某些功能需要额外的共享通道），也不要少隔离（导致并发子代理互相干扰）。

### 5. 事件溯源优于状态快照

会话持久化采用 JSONL 追加写入而非 AppState 序列化。这不仅是技术选择，更是对"什么值得持久化"的深思熟虑——不是所有运行时状态都值得跨会话保留，只有对话内容和关键元数据才是真正有价值的。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `state/store.ts` | 通用 Store 工厂（34 行） | `createStore()`, `Store<T>` |
| `state/AppStateStore.ts` | AppState 类型定义与默认值 | `AppState`, `getDefaultAppState()`, `SpeculationState` |
| `state/AppState.tsx` | React 集成层（Context + Hooks） | `AppStateProvider`, `useAppState()`, `useSetAppState()` |
| `state/onChangeAppState.ts` | 状态变更副作用集中处理 | `onChangeAppState()`, `externalMetadataToAppState()` |
| `state/selectors.ts` | 纯函数选择器 | `getViewedTeammateTask()`, `getActiveAgentForInput()` |
| `state/teammateViewHelpers.ts` | Teammate 视图状态变更 | `enterTeammateView()`, `exitTeammateView()`, `stopOrDismissAgent()` |
| `bootstrap/state.ts` | 进程级全局状态单例 | `getCwd()`, `getSessionId()`, `switchSession()`, 200+ getter/setter |
| `utils/forkedAgent.ts` | 子代理上下文创建与隔离 | `createSubagentContext()` |
| `history.ts` | 输入历史持久化 | `addToHistory()`, `getHistory()` |
| `utils/sessionStorage.ts` | 会话转录存储 | `getTranscriptPath()`, `restoreSessionMetadata()` |
| `utils/conversationRecovery.ts` | 会话恢复 | `loadConversationForResume()` |
