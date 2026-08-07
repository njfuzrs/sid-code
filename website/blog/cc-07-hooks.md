---
title: Claude Code 源码解析（七）· Hooks 系统
description: '"Hook"在 Claude Code 中有双重含义——用户如何通过配置实现"每次执行前自动检查"的自动化？React Hooks 又如何驱动 UI 与生命周期？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第七章：Hooks 系统（React Hooks 与用户 Hooks）

> Claude Code 中 "Hook" 一词有双重含义——React Hooks 驱动 UI 与生命周期，用户 Hooks 驱动自动化行为。

## 核心问题

在 Claude Code 的语境中，"Hook" 是一个被严重重载的术语。它至少指代三种完全不同的东西：

1. **React Hooks**（`useXxx`）：React 框架的状态与副作用管理原语，驱动 Ink 终端 UI 的渲染与交互。这是 React 生态的标准用法。

2. **用户 Hooks**（Settings Hooks）：用户在 `settings.json` 中配置的自动化钩子——在特定事件（如工具调用前后、会话结束时）自动执行 shell 命令、LLM 验证、HTTP 请求等。这是 Claude Code 独有的扩展机制。

3. **工具权限 Hooks**（`hooks/toolPermission/`）：工具执行前的权限检查流程，融合了用户 Hooks、分类器、UI 交互等多种决策源的竞争机制。

这三种 "Hook" 解决的是完全不同的问题：

| 维度 | React Hooks | 用户 Hooks | 权限 Hooks |
|------|------------|-----------|-----------|
| **解决的问题** | UI 状态管理与副作用 | 用户自定义自动化行为 | 工具执行的安全控制 |
| **配置方式** | 代码中声明 | settings.json 配置 | 规则 + 分类器 + UI |
| **执行时机** | React 渲染周期 | 特定事件触发 | 工具调用前 |
| **执行环境** | React 渲染线程 | 子进程 / LLM / HTTP | React + 子进程 + LLM |
| **用户可见性** | 不可见（内部实现） | 完全可配置 | 权限弹窗 |

本章的核心矛盾是：**如何在一个统一的事件驱动架构中，同时满足安全性（不能让 LLM 随意执行危险操作）、可扩展性（用户需要自定义自动化行为）和性能（hook 执行不能阻塞主交互循环）？**

Claude Code 的解法是一个**分层的 Hook 架构**——底层是一个通用的事件匹配与执行引擎，上层针对不同场景（权限、通知、停止条件）构建专用的 Hook 编排逻辑。

---

## 7.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code Hook 架构                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              事件源 (Event Sources)                        │   │
│  │                                                           │   │
│  │  工具调用  会话生命周期  用户输入  MCP  文件变更  定时任务  │   │
│  └──────┬───────┬──────────┬───────┬──────┬────────┬────────┘   │
│         │       │          │       │      │        │             │
│         ▼       ▼          ▼       ▼      ▼        ▼             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           事件类型 (26 种 Hook Events)                     │   │
│  │                                                           │   │
│  │  PreToolUse · PostToolUse · Stop · SubagentStop           │   │
│  │  SessionStart · SessionEnd · Setup                        │   │
│  │  UserPromptSubmit · Notification                          │   │
│  │  PreCompact · PostCompact                                 │   │
│  │  PermissionRequest · PermissionDenied                     │   │
│  │  Elicitation · ElicitationResult                          │   │
│  │  CwdChanged · FileChanged · ConfigChange                  │   │
│  │  SubagentStart · TeammateIdle · TaskCreated · TaskCompleted│   │
│  │  InstructionsLoaded · WorktreeCreate · WorktreeRemove     │   │
│  │  StopFailure                                              │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Hook 匹配引擎 (getMatchingHooks)                │   │
│  │                                                           │   │
│  │  配置来源:                                                 │   │
│  │  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐  │   │
│  │  │Settings │ │ Plugin  │ │ Session  │ │  SDK/Callback │  │   │
│  │  │Snapshot │ │ Hooks   │ │ Hooks    │ │  Hooks        │  │   │
│  │  └────┬────┘ └────┬────┘ └────┬─────┘ └──────┬───────┘  │   │
│  │       └───────────┴───────────┴───────────────┘           │   │
│  │                         │                                  │   │
│  │  匹配规则: 事件类型 × 工具名称模式 × if 条件              │   │
│  │  去重规则: 同源同命令去重，跨源不去重                      │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Hook 执行引擎 (executeHooks)                    │   │
│  │                                                           │   │
│  │  执行方式:                                                 │   │
│  │  ┌──────────┐ ┌────────┐ ┌───────┐ ┌──────┐ ┌────────┐  │   │
│  │  │ Command  │ │ Prompt │ │ Agent │ │ HTTP │ │Callback│  │   │
│  │  │(bash/ps) │ │ (LLM)  │ │(Agent)│ │(POST)│ │ (fn)   │  │   │
│  │  └──────────┘ └────────┘ └───────┘ └──────┘ └────────┘  │   │
│  │                                                           │   │
│  │  并行执行 → 超时控制 → 输出解析 → 结果聚合                │   │
│  │                                                           │   │
│  │  退出码语义: 0=成功  2=阻塞错误  其他=非阻塞错误          │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           专用编排层 (Specialized Orchestrators)           │   │
│  │                                                           │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌───────────────────┐   │   │
│  │  │ Permission  │  │  Stop    │  │  Notification     │   │   │
│  │  │ Hooks       │  │  Hooks   │  │  Hooks            │   │   │
│  │  │             │  │          │  │                    │   │   │
│  │  │ 4路竞争:    │  │ 阻塞/   │  │ OS通知/IDE状态/   │   │   │
│  │  │ 用户+Bridge │  │ 继续/   │  │ 速率限制/模型迁移  │   │   │
│  │  │ +Channel    │  │ 停止    │  │                    │   │   │
│  │  │ +Classifier │  │         │  │                    │   │   │
│  │  └─────────────┘  └─────────┘  └───────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

这个架构的关键洞察是：**底层引擎是通用的（任何事件 × 任何执行方式），但上层编排是专用的（权限场景需要竞争机制，停止场景需要阻塞语义，通知场景需要 fire-and-forget）。** 通用引擎提供了统一的匹配、执行、超时、解析能力，专用编排层在此基础上添加场景特定的逻辑。

---

## 7.2 用户 Hooks：配置与类型体系

### 面临的问题

Claude Code 作为一个 LLM 驱动的开发工具，其行为高度动态——模型决定调用什么工具、读写什么文件、执行什么命令。用户需要一种机制来**在这些关键节点插入自定义逻辑**：

- 在模型执行 `git push` 之前，自动运行 lint 检查
- 在模型修改文件后，自动触发测试
- 在会话结束时，自动提交代码
- 在模型请求权限时，根据企业策略自动批准或拒绝
- 在文件变更时，通知外部 CI 系统

这些需求的共同特征是：**事件驱动 + 外部执行 + 结构化反馈**。用户需要告诉 Claude Code "当 X 发生时，执行 Y，并根据 Y 的结果决定 Z"。

核心设计挑战：

1. **配置的表达力 vs 复杂度**：用户需要精确控制"什么时候触发"和"触发什么"，但配置不能太复杂
2. **执行方式的多样性**：有些场景适合 shell 命令，有些适合 LLM 验证，有些适合 HTTP 回调
3. **安全性**：Hook 本质上是"在 LLM 工具链中注入任意代码执行"，必须有严格的信任边界

### 解法：事件 × 匹配器 × 多类型 Hook 的三层配置模型

Claude Code 的用户 Hook 配置采用三层嵌套结构：

```
settings.json
└── hooks                          ← 顶层 hooks 字段
    └── [HookEvent]                ← 26 种事件类型
        └── [HookMatcher]          ← 匹配器（可选的 matcher 模式 + hooks 数组）
            └── [HookCommand]      ← 具体的 hook 定义（4 种类型）
```

一个典型的配置示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'About to run bash command'",
            "if": "Bash(git push*)"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm test",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 26 种 Hook 事件

从 `schemas/hooks.ts` 和 `utils/hooks/hooksConfigManager.ts` 中可以提取出完整的事件清单：

| 事件类型 | 触发时机 | 匹配字段 | 典型用途 |
|---------|---------|---------|---------|
| **工具执行** | | | |
| `PreToolUse` | 工具调用前 | `tool_name` | 输入验证、自动审批 |
| `PostToolUse` | 工具成功后 | `tool_name` | 结果处理、触发测试 |
| `PostToolUseFailure` | 工具失败后 | `tool_name` | 错误处理 |
| `PermissionRequest` | 权限弹窗时 | `tool_name` | 自动审批/拒绝 |
| `PermissionDenied` | 自动模式拒绝后 | `tool_name` | 拒绝后处理 |
| **会话生命周期** | | | |
| `SessionStart` | 会话初始化 | `source` | 环境准备 |
| `SessionEnd` | 会话结束 | `reason` | 清理、提交 |
| `Setup` | 仓库初始化/维护 | `trigger` | 依赖安装 |
| **停止条件** | | | |
| `Stop` | 主代理结束前 | 无 | 验证、测试 |
| `SubagentStop` | 子代理结束前 | `agent_type` | 子任务验证 |
| `StopFailure` | API 错误结束时 | `error` | 错误恢复 |
| **用户输入** | | | |
| `UserPromptSubmit` | 用户提交提示 | 无 | 输入增强 |
| **上下文压缩** | | | |
| `PreCompact` | 压缩前 | `trigger` | 保存上下文 |
| `PostCompact` | 压缩后 | `trigger` | 恢复上下文 |
| **子代理/任务** | | | |
| `SubagentStart` | 子代理启动 | `agent_type` | 子代理配置 |
| `TeammateIdle` | 队友空闲 | 无 | 任务分配 |
| `TaskCreated` | 任务创建 | 无 | 任务追踪 |
| `TaskCompleted` | 任务完成 | 无 | 结果汇总 |
| **MCP/Elicitation** | | | |
| `Elicitation` | MCP 请求用户输入 | `mcp_server_name` | 自动响应 |
| `ElicitationResult` | 用户响应 MCP | `mcp_server_name` | 结果处理 |
| **配置/环境** | | | |
| `ConfigChange` | 设置文件变更 | `source` | 配置同步 |
| `InstructionsLoaded` | CLAUDE.md 加载 | `load_reason` | 指令增强 |
| `CwdChanged` | 工作目录变更 | 无 | 环境切换 |
| `FileChanged` | 监视文件变更 | `file_path` (basename) | 文件监控 |
| **Worktree** | | | |
| `WorktreeCreate` | 创建 worktree | 无 | 隔离环境准备 |
| `WorktreeRemove` | 移除 worktree | 无 | 清理 |
| `Notification` | 通知发送 | `notification_type` | 通知转发 |

### 4 种 Hook 类型

从 `schemas/hooks.ts` 的 `HookCommandSchema` 可以看到，用户可配置的 Hook 有 4 种类型（通过 `type` 字段区分的 discriminated union）：

```typescript
// schemas/hooks.ts
export const HookCommandSchema = lazySchema(() => {
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,   // type: 'command'
    PromptHookSchema,        // type: 'prompt'
    AgentHookSchema,         // type: 'agent'
    HttpHookSchema,          // type: 'http'
  ])
})
```

**1. Command Hook（Shell 命令）**

最基础的 Hook 类型——执行一个 shell 命令，通过退出码和 stdout 传递结果。

```typescript
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),           // shell 命令
  if: IfConditionSchema(),       // 条件过滤（权限规则语法）
  shell: z.enum(SHELL_TYPES).optional(),  // 'bash' | 'powershell'
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),   // spinner 显示文本
  once: z.boolean().optional(),           // 一次性执行
  async: z.boolean().optional(),          // 后台执行
  asyncRewake: z.boolean().optional(),    // 后台执行 + 错误时唤醒模型
})
```

**2. Prompt Hook（LLM 验证）**

用一个小模型（默认 Haiku）来验证操作是否合理。

```typescript
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),            // LLM 提示词，$ARGUMENTS 占位符
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  model: z.string().optional(),  // 模型 ID，默认小快模型
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

**3. Agent Hook（多轮 Agent 验证）**

比 Prompt Hook 更强大——启动一个多轮 Agent，可以使用工具来验证操作。

```typescript
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),            // Agent 的任务描述
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),  // 默认 60s
  model: z.string().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

**4. HTTP Hook（HTTP POST 回调）**

将 Hook 输入 POST 到外部 URL，适合与 CI/CD 系统集成。

```typescript
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),         // POST 目标 URL
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),  // 环境变量白名单
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### 设计决策讨论

**为什么需要 4 种 Hook 类型，而不是只用 Command？**

这是一个**表达力 vs 简单性**的权衡。

Command Hook 是最通用的——理论上你可以用 shell 命令做任何事。但某些场景下，其他类型更自然：

- **Prompt Hook**：当你想让 LLM 判断"这个操作是否合理"时，写一个 shell 脚本来调用 LLM API 是可行的，但直接写一个 prompt 更简洁。而且 Prompt Hook 可以直接访问 Claude Code 的模型配置和认证，不需要用户自己管理 API key。
- **Agent Hook**：当验证逻辑需要多步推理（比如"检查测试是否通过，如果没通过，分析失败原因"）时，单次 LLM 调用不够，需要一个能使用工具的 Agent。
- **HTTP Hook**：当需要与外部系统集成时，shell 命令中的 `curl` 可以做到，但 HTTP Hook 提供了内置的 SSRF 防护、环境变量安全插值、超时控制等，比裸 `curl` 更安全。

**为什么 `if` 条件使用权限规则语法而不是正则表达式？**

```typescript
const IfConditionSchema = lazySchema(() =>
  z.string().optional().describe(
    'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)")'
  ),
)
```

`if` 条件复用了权限系统的规则语法（如 `Bash(git *)`, `Read(*.ts)`）。这个决策有两个好处：

1. **一致性**：用户已经在权限配置中学习了这套语法，Hook 条件复用它降低了学习成本
2. **复用**：权限规则的解析器（`permissionRuleParser`）已经实现了 glob 匹配、工具名称规范化等逻辑，Hook 条件可以直接复用

**为什么 Schema 用 `lazySchema()` 包装？**

```typescript
export const HookCommandSchema = lazySchema(() => {
  // ...
})
```

文件头部的注释解释了原因：

```typescript
// Hook Zod schemas extracted to break import cycles.
// This file contains hook-related schema definitions that were originally
// in src/utils/settings/types.ts. By extracting them here, we break the
// circular dependency between settings/types.ts and plugins/schemas.ts.
```

`lazySchema()` 是一个延迟求值包装器，确保 Schema 在首次使用时才被构建。这解决了两个问题：
- **循环依赖**：Hook Schema 被 settings 和 plugins 两个模块引用，如果在模块顶层求值会形成循环
- **启动性能**：Zod Schema 的构建有一定开销，延迟到首次使用可以减少启动时间

**为什么 `async` 和 `asyncRewake` 是两个独立字段？**

这反映了两种不同的后台执行语义：

- `async: true`：Hook 在后台执行，Claude Code 不等待结果，继续正常流程。适合"通知类"操作（如发送 Slack 消息）。
- `asyncRewake: true`：Hook 在后台执行，但如果退出码为 2（阻塞错误），会**唤醒模型**处理错误。适合"异步验证"场景（如后台运行测试，测试失败时通知模型）。

`asyncRewake` 隐含了 `async`，但语义更强——它建立了一个"后台执行 + 条件回调"的模式。

---

## 7.3 Hook 执行引擎：从事件到结果的完整链路

### 面临的问题

有了配置模型（事件 × 匹配器 × Hook 类型），下一个问题是：**如何高效、安全地执行这些 Hook？**

具体挑战包括：

1. **匹配效率**：26 种事件 × 多个匹配器 × 多个 Hook，每次工具调用都要遍历？
2. **并行 vs 串行**：多个 Hook 匹配同一事件时，应该并行还是串行执行？
3. **结果聚合**：多个 Hook 返回不同的决策（一个 allow，一个 deny），如何合并？
4. **超时控制**：Hook 执行外部命令，可能挂起，如何防止阻塞主循环？
5. **安全边界**：Hook 本质上是执行用户代码，如何确保不在信任建立前执行？
6. **输出协议**：Hook 如何将结构化结果传回 Claude Code？

### 解法：AsyncGenerator + 并行执行 + 退出码协议

Hook 执行引擎的核心是 `utils/hooks.ts` 中的 `executeHooks()` 函数——一个 5000+ 行文件中最关键的异步生成器。

#### 执行流程总览

```
事件触发
  │
  ▼
shouldDisableAllHooksIncludingManaged()  ← 全局禁用检查
  │
  ▼
shouldSkipHookDueToTrust()               ← 安全: 信任检查
  │
  ▼
getMatchingHooks()                        ← 匹配引擎
  │
  ├─ getHooksConfig()                     ← 合并 4 种来源
  │   ├─ Settings Snapshot (用户/项目/本地)
  │   ├─ Registered Hooks (SDK/插件原生)
  │   ├─ Session Hooks (Agent frontmatter/Skill)
  │   └─ Session Function Hooks (结构化输出强制)
  │
  ├─ matchesPattern()                     ← 模式匹配
  ├─ 去重 (hookDedupKey)                  ← 同源同命令去重
  └─ if 条件过滤                           ← 权限规则语法匹配
  │
  ▼
全部是内部 callback?
  ├─ YES → 快速路径 (跳过 JSON/span/progress)  ← 70% 性能提升
  └─ NO  ↓
  │
  ▼
yield 进度消息 (hook_progress)
  │
  ▼
并行执行所有匹配的 Hook
  │
  ├─ Command Hook → execCommandHook()     ← spawn 子进程
  ├─ Prompt Hook  → execPromptHook()      ← LLM 调用
  ├─ Agent Hook   → execAgentHook()       ← 多轮 Agent
  ├─ HTTP Hook    → execHttpHook()        ← HTTP POST
  ├─ Callback     → hook.callback()       ← 直接调用
  └─ Function     → executeFunctionHook() ← 消息级回调
  │
  ▼
结果解析
  ├─ parseHookOutput()                    ← JSON / 纯文本
  ├─ processHookJSONOutput()              ← 结构化字段提取
  └─ 退出码语义: 0=成功, 2=阻塞, 其他=非阻塞错误
  │
  ▼
结果聚合 (yield AggregatedHookResult)
  ├─ deny > ask > allow (优先级)
  ├─ blockingErrors 收集
  ├─ additionalContexts 合并
  └─ preventContinuation 传播
```

### 核心源码解读

#### 1. 信任检查：安全的第一道防线

```typescript
// utils/hooks.ts:286-296
export function shouldSkipHookDueToTrust(): boolean {
  // In non-interactive mode (SDK), trust is implicit - always execute
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }
  // In interactive mode, ALL hooks require trust
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}
```

源码注释记录了促使这个检查被添加的历史漏洞：

```
Historical vulnerabilities that prompted this check:
- SessionEnd hooks executing when user declines trust dialog
- SubagentStop hooks executing when subagent completes before trust
```

这是一个**集中式安全检查**——不是在每个 Hook 调用点分别检查，而是在执行引擎的入口统一检查。这确保了"当前和未来的所有 Hook"都受到信任保护，不会因为新增 Hook 事件而遗漏检查。

#### 2. 匹配引擎：四源合并 + 模式匹配 + 去重

`getMatchingHooks()` 是匹配引擎的核心，它解决了"哪些 Hook 应该响应这个事件"的问题。

**四源合并**：Hook 配置来自 4 个不同的来源，按优先级合并：

```typescript
// utils/hooks.ts:1492-1566 (简化)
function getHooksConfig(appState, sessionId, hookEvent) {
  // 来源 1: Settings Snapshot（用户/项目/本地/策略）
  const hooks = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  // 来源 2: Registered Hooks（SDK 回调 + 插件原生 Hook）
  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      // 策略限制：managedOnly 模式下跳过插件 Hook
      if (managedOnly && 'pluginRoot' in matcher) continue
      hooks.push(matcher)
    }
  }

  // 来源 3 & 4: Session Hooks（Agent frontmatter + Function Hooks）
  // managedOnly 模式下完全跳过——防止 frontmatter hooks 绕过策略
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent)
    // ... 合并 session hooks 和 function hooks
  }

  return hooks
}
```

**模式匹配**：每种事件类型有不同的匹配字段：

```typescript
// utils/hooks.ts:1616-1670 (简化)
switch (hookInput.hook_event_name) {
  case 'PreToolUse':
  case 'PostToolUse':
    matchQuery = hookInput.tool_name      // 匹配工具名
    break
  case 'SessionStart':
    matchQuery = hookInput.source         // 匹配启动来源
    break
  case 'Notification':
    matchQuery = hookInput.notification_type  // 匹配通知类型
    break
  case 'FileChanged':
    matchQuery = basename(hookInput.file_path)  // 匹配文件名
    break
  // ...
}
```

**去重逻辑**：同一个命令可能在多个配置层级中出现（用户级 + 项目级），需要去重。但去重必须考虑**来源隔离**——两个不同插件的 `${CLAUDE_PLUGIN_ROOT}/hook.sh` 展开后指向不同文件，不应该被去重。

```typescript
// utils/hooks.ts:1453-1455
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}
```

去重键由 `pluginRoot/skillRoot` + `\0` + `命令内容` + `\0` + `if条件` 组成。Settings Hook 的 pluginRoot 为空，所以同一命令在 user/project/local 三个层级中只保留最后一个（`new Map()` 的 last-wins 语义）。

还有一个重要的**快速路径优化**：

```typescript
// utils/hooks.ts:1723-1729
// Fast-path: callback/function hooks don't need dedup (each is unique).
// Skip the 6-pass filter + 4×Map + 4×Array.from below when all hooks are
// callback/function — the common case for internal hooks (44x faster).
if (matchedHooks.every(m => m.hook.type === 'callback' || m.hook.type === 'function')) {
  return matchedHooks
}
```

当所有匹配的 Hook 都是内部回调时（这是最常见的情况——每次工具调用都会触发内部的文件访问追踪和归因 Hook），跳过整个去重流程，性能提升 44 倍。

#### 3. 执行引擎：并行执行 + 内部回调快速路径

`executeHooks()` 是一个 AsyncGenerator，它 yield 进度消息和最终结果：

```typescript
// utils/hooks.ts:1952-2067 (简化)
async function* executeHooks({ hookInput, toolUseID, signal, ... }) {
  // 全局禁用检查
  if (shouldDisableAllHooksIncludingManaged()) return
  // 信任检查
  if (shouldSkipHookDueToTrust()) return

  const matchingHooks = await getMatchingHooks(...)
  if (matchingHooks.length === 0) return

  // ★ 内部回调快速路径
  const userHooks = matchingHooks.filter(h => !isInternalHook(h))
  if (userHooks.length === 0) {
    // 全部是内部 callback → 跳过 span/progress/JSON 处理
    // 测量: 6.01µs → ~1.8µs per PostToolUse hit (-70%)
    for (const { hook } of matchingHooks) {
      if (hook.type === 'callback') {
        await hook.callback(hookInput, toolUseID, signal, ...)
      }
    }
    return  // 不 yield 任何结果
  }

  // ★ 正常路径：yield 进度 → 并行执行 → yield 结果
  // Yield 进度消息
  for (const { hook } of matchingHooks) {
    yield { message: { type: 'progress', data: { type: 'hook_progress', ... } } }
  }

  // 并行执行所有 Hook
  const hookPromises = matchingHooks.map(async function* ({ hook, ... }) {
    if (hook.type === 'callback') { /* ... */ }
    if (hook.type === 'function') { /* ... */ }
    if (hook.type === 'prompt')  { yield execPromptHook(...) }
    if (hook.type === 'agent')   { yield execAgentHook(...) }
    if (hook.type === 'http')    { yield execHttpHook(...) }
    if (hook.type === 'command') { yield execCommandHook(...) }
  })

  // 聚合结果
  for await (const result of all(hookPromises)) {
    // deny > ask > allow 优先级
    // 收集 blockingErrors, additionalContexts 等
    yield aggregatedResult
  }
}
```

**内部回调快速路径**是一个关键优化。每次工具调用（PostToolUse）都会触发内部的文件访问追踪 Hook，如果走完整路径（创建 span、yield 进度消息、JSON 序列化、结果聚合），每次需要 ~6µs。快速路径将其降到 ~1.8µs，减少 70%。考虑到一个会话中可能有数百次工具调用，这个优化的累积效果显著。

#### 4. Command Hook 执行：子进程 + 异步检测 + Prompt 协议

`execCommandHook()` 是最复杂的 Hook 执行器，因为它需要处理：

- **跨平台 Shell 选择**（Bash vs PowerShell，Windows Git Bash）
- **环境变量注入**（项目目录、插件根目录、插件选项）
- **异步 Hook 检测**（首行 JSON 协议）
- **Prompt 请求协议**（Hook 向用户提问）

```typescript
// utils/hooks.ts:747-939 (简化)
async function execCommandHook(hook, hookEvent, hookName, jsonInput, signal, ...) {
  // Shell 选择
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL  // 默认 'bash'
  const isPowerShell = shellType === 'powershell'

  // Windows 路径转换：Bash 需要 POSIX 路径，PowerShell 用原生路径
  const toHookPath = isWindows && !isPowerShell
    ? (p) => windowsPathToPosixPath(p)  // C:\Users\foo → /c/Users/foo
    : (p) => p

  // 插件变量替换
  command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
  command = substituteUserConfigVariables(command, pluginOpts)

  // 环境变量注入
  const envVars = {
    ...subprocessEnv(),
    CLAUDE_PROJECT_DIR: toHookPath(projectDir),
    CLAUDE_PLUGIN_ROOT: toHookPath(pluginRoot),
    CLAUDE_PLUGIN_OPTION_*: ...,  // 插件选项
    CLAUDE_ENV_FILE: ...,         // 仅 SessionStart/Setup/CwdChanged/FileChanged
  }

  // 子进程 spawn
  if (shellType === 'powershell') {
    child = spawn(pwshPath, buildPowerShellArgs(finalCommand), { env, cwd })
  } else {
    const shell = isWindows ? findGitBashPath() : true
    child = spawn(finalCommand, [], { env, cwd, shell })
  }

  // Hook 输入通过 stdin 传递
  child.stdin.write(jsonInput + '\n', 'utf8')
  child.stdin.end()

  // 异步 Hook 检测：首行 {"async": true} → 后台化
  child.stdout.on('data', data => {
    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      const parsed = jsonParse(firstLine)
      if (isAsyncHookJSONOutput(parsed)) {
        executeInBackground(...)  // 转入后台
      }
    }
  })
}
```

**异步 Hook 协议**是一个精巧的设计：Hook 进程可以在 stdout 的第一行输出 `{"async": true}`，告诉 Claude Code "我需要在后台运行，不要等我"。这让 Hook 可以自己决定是同步还是异步执行，而不需要在配置中预先声明。

**Prompt 请求协议**更加有趣：Hook 进程可以在 stdout 中输出符合 `promptRequestSchema` 的 JSON 行，向用户提问。Claude Code 会解析这些行，弹出 UI 让用户选择，然后将响应写回 Hook 进程的 stdin。这建立了一个**双向通信通道**——Hook 不再是单向的"执行并返回"，而是可以与用户交互。

#### 5. 退出码协议与输出解析

Hook 的结果通过两个通道传递：**退出码**和 **stdout**。

**退出码语义**：

| 退出码 | 含义 | 行为 |
|-------|------|------|
| `0` | 成功 | 正常继续，stdout 内容作为附加信息 |
| `2` | 阻塞错误 | 阻止操作继续，stderr 内容反馈给模型 |
| 其他 | 非阻塞错误 | 不阻止操作，stderr 内容仅展示给用户 |

**stdout 解析**：

```typescript
// utils/hooks.ts:399-451
function parseHookOutput(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    return { plainText: stdout }  // 纯文本输出
  }
  // 尝试 JSON 解析 + Zod 校验
  const result = validateHookJson(trimmed)
  if ('json' in result) return result
  // JSON 解析失败 → 降级为纯文本 + 附带校验错误
  return { plainText: stdout, validationError: ... }
}
```

当 stdout 以 `{` 开头时，尝试按 JSON 解析并用 Zod Schema 校验。JSON 输出支持丰富的结构化字段：

```typescript
// types/hooks.ts:50-166 (syncHookResponseSchema)
{
  continue: boolean,           // 是否继续（false = 阻止）
  suppressOutput: boolean,     // 隐藏 stdout
  stopReason: string,          // 停止原因
  decision: 'approve' | 'block',  // 权限决策
  reason: string,              // 决策原因
  systemMessage: string,       // 系统警告消息
  hookSpecificOutput: {        // 事件特定输出
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow' | 'deny' | 'ask',
    updatedInput: { ... },     // 修改工具输入！
    additionalContext: string,  // 注入上下文
  }
}
```

最强大的能力是 `updatedInput`——PreToolUse Hook 可以**修改工具的输入参数**。比如，一个 Hook 可以拦截 `Bash` 工具的调用，将 `git push` 改为 `git push --dry-run`。这赋予了 Hook 不仅仅是"批准/拒绝"的能力，还有"修改"的能力。

### 数据流分析：一次 PreToolUse Hook 的完整生命周期

```
模型返回 tool_use: Bash(command="git push origin main")
  │
  ▼
query.ts: 工具调用分发
  │
  ▼
executePreToolHooks(hookInput={
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main' }
})
  │
  ▼
executeHooks()
  ├─ shouldSkipHookDueToTrust() → false (已接受信任)
  ├─ getMatchingHooks()
  │   ├─ getHooksConfig() → 合并 4 源
  │   ├─ matchQuery = 'Bash'
  │   ├─ matchesPattern('Bash', 'Bash') → true
  │   ├─ if 条件: 'Bash(git push*)' → prepareIfConditionMatcher()
  │   │   └─ permissionRuleValueFromString('Bash(git push*)')
  │   │       → { toolName: 'Bash', ruleContent: 'git push*' }
  │   │       → patternMatcher('git push*') 匹配 'git push origin main' → true
  │   └─ 返回 [{ hook: { type: 'command', command: 'npm test' }, ... }]
  │
  ├─ yield { message: { type: 'progress', data: { type: 'hook_progress' } } }
  │
  ├─ execCommandHook()
  │   ├─ spawn('npm test', { env: { CLAUDE_PROJECT_DIR: ... }, cwd: ... })
  │   ├─ stdin.write(JSON.stringify(hookInput))
  │   ├─ 等待子进程退出
  │   └─ 返回 { stdout: '{"decision":"approve"}', status: 0 }
  │
  ├─ parseHookOutput() → { json: { decision: 'approve' } }
  ├─ processHookJSONOutput() → { permissionBehavior: 'allow' }
  │
  └─ yield { permissionBehavior: 'allow' }
  │
  ▼
工具执行: Bash(command="git push origin main")  ← Hook 批准，继续执行
```

### 设计决策讨论

**为什么用 AsyncGenerator 而不是 Promise？**

`executeHooks()` 返回 `AsyncGenerator<AggregatedHookResult>` 而不是 `Promise<AggregatedHookResult>`。这个选择有两个原因：

1. **流式进度**：Hook 执行可能需要数秒（比如运行测试），用户需要看到进度。AsyncGenerator 允许在执行过程中 yield 进度消息，调用方可以实时更新 UI。
2. **增量结果**：多个 Hook 并行执行时，每个 Hook 完成后立即 yield 其结果，而不是等所有 Hook 都完成。这让调用方可以在第一个 Hook 返回 deny 时立即停止，不必等待其他 Hook。

**为什么 Hook 并行执行而不是串行？**

并行执行是默认行为——所有匹配的 Hook 同时启动。这是因为：

- Hook 之间通常是独立的（一个检查 lint，一个检查测试，一个通知 Slack）
- 串行执行会让总耗时等于所有 Hook 耗时之和，而并行执行只等最慢的那个
- 如果需要串行语义，用户可以在一个 Hook 中串联多个命令

但这也带来了一个问题：多个 Hook 返回冲突的决策怎么办？答案是**deny 优先**——只要有一个 Hook 返回 deny，最终结果就是 deny。这是安全性优先的设计。

**为什么退出码 2 是"阻塞错误"而不是 1？**

这是一个有意的设计选择。退出码 1 是 Unix 中最常见的错误码——几乎所有命令失败都返回 1。如果用 1 表示"阻塞"，那么任何意外失败的 Hook 都会阻塞 Claude Code 的操作，这显然不是用户想要的。

退出码 2 是一个不太常见的值，需要 Hook 脚本**显式返回**。这确保了只有"故意阻塞"才会生效，"意外失败"只会产生非阻塞警告。

**为什么 `hasHookForEvent()` 是一个独立的快速检查？**

```typescript
// utils/hooks.ts:1582-1593
function hasHookForEvent(hookEvent, appState, sessionId): boolean {
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) return true
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) return true
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) return true
  return false
}
```

这是一个**热路径优化**。完整的 `getMatchingHooks()` 需要合并 4 个来源、做模式匹配、去重、if 条件过滤——即使最终结果是"没有匹配的 Hook"。`hasHookForEvent()` 只做最简单的存在性检查，在大多数情况下（用户没有配置 Hook）可以在 O(1) 时间内返回 false，跳过整个匹配流程。

注释中特别说明了它"故意过度近似"——可能返回 false positive（有 matcher 但最终不匹配），但绝不返回 false negative（有匹配但返回 false）。这是一个经典的**布隆过滤器思维**：快速排除不可能的情况，只在可能的情况下才做精确检查。

---

## 7.4 工具权限 Hooks：四路竞争的决策机制

### 面临的问题

当模型请求执行一个需要权限的工具（比如 `Bash(git push)`）时，Claude Code 需要做出一个决策：**允许还是拒绝？**

这个决策看似简单，但实际上涉及多个并发的决策源：

1. **用户**：通过终端 UI 的权限弹窗手动批准/拒绝
2. **Bridge**：通过 IDE（VS Code）或 claude.ai 远程批准/拒绝
3. **Channel**：通过 Telegram/iMessage 等消息渠道批准/拒绝
4. **自动化**：通过 PermissionRequest Hook 或 Bash 分类器自动批准/拒绝

核心矛盾是：**这四个决策源是并发的，任何一个都可能先返回结果。** 如果用户在终端点了"允许"，同时分类器也返回了"允许"，不能执行两次。如果 Hook 返回了"拒绝"，但用户已经点了"允许"，应该以谁为准？

更微妙的是**用户体验问题**：如果分类器能在 200ms 内自动批准，用户根本不需要看到权限弹窗。但如果分类器需要 2 秒，用户已经看到弹窗并准备点击了，此时分类器突然自动批准并关闭弹窗，会让用户感到困惑（"我明明要点的按钮怎么消失了？"）。

### 解法：createResolveOnce + 四路竞争 + 优雅降级

Claude Code 的权限决策系统建立在一个核心原语上：`createResolveOnce`——一个原子性的"竞争获胜"机制。

#### createResolveOnce：原子竞争守卫

```typescript
// hooks/toolPermission/PermissionContext.ts
function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false
  let delivered = false
  return {
    resolve(value: T) {
      if (delivered) return
      delivered = true
      claimed = true
      resolve(value)
    },
    isResolved() {
      return claimed
    },
    claim() {
      if (claimed) return false  // 已被其他人 claim
      claimed = true
      return true  // 我赢了竞争
    },
  }
}
```

这个模式的关键是 `claim()` 方法——它是一个**原子性的 check-and-mark** 操作。在 JavaScript 的单线程事件循环中，`claim()` 保证只有一个调用者能返回 `true`。所有竞争路径在处理结果之前都必须先调用 `claim()`，只有赢得竞争的路径才能继续。

#### 决策流程总览

```
模型请求: Bash(command="git push")
  │
  ▼
useCanUseTool()
  │
  ├─ hasPermissionsToUseTool() → 'allow' / 'deny' / 'ask'
  │
  ├─ 'allow' → 直接执行
  ├─ 'deny'  → 直接拒绝
  └─ 'ask'   → 进入多路决策
       │
       ├─ Coordinator Worker?
       │   └─ handleCoordinatorPermission()
       │       ├─ await hooks (快速, 本地)
       │       ├─ await classifier (慢, 推理)
       │       └─ 都没结果 → 降级到交互式
       │
       ├─ Swarm Worker?
       │   └─ handleSwarmWorkerPermission()
       │       ├─ await classifier
       │       └─ 转发给 leader 等待决策
       │
       └─ Main Agent → handleInteractivePermission()
            │
            ┌─────────────────────────────────────────┐
            │         四路并发竞争                       │
            │                                          │
            │  Race 1: 本地用户交互                     │
            │  ├─ onAllow() → claim() → resolve        │
            │  ├─ onReject() → claim() → resolve       │
            │  └─ onAbort() → claim() → resolve        │
            │                                          │
            │  Race 2: Bridge (IDE/claude.ai)          │
            │  └─ bridgeCallbacks → claim() → resolve  │
            │                                          │
            │  Race 3: Channel (Telegram/iMessage)     │
            │  └─ channelResponse → claim() → resolve  │
            │                                          │
            │  Race 4: 自动化 (后台)                    │
            │  ├─ PermissionRequest Hook               │
            │  └─ Bash Classifier                      │
            │      └─ claim() → resolve                │
            │                                          │
            │  第一个 claim() 成功的路径获胜             │
            └─────────────────────────────────────────┘
```

#### 交互式处理器：四路竞争的实现

`interactiveHandler.ts` 是最复杂的权限处理器，它同时启动四个竞争路径：

**Race 1: 本地用户交互**

```typescript
// interactiveHandler.ts (简化)
const onAllow = async (permUpdates, updatedInput) => {
  if (!claim()) return  // 原子竞争：如果已被其他路径 claim，直接返回
  const decision = await ctx.handleUserAllow(permUpdates, updatedInput)
  resolveOnce.resolve(decision)
}

const onReject = (feedback) => {
  if (!claim()) return
  resolveOnce.resolve(ctx.buildDeny('user_reject', feedback))
}
```

**Race 2: Bridge（IDE 远程批准）**

```typescript
// interactiveHandler.ts (简化)
if (bridgeCallbacks) {
  const unsubscribe = bridgeCallbacks.onPermissionResponse(response => {
    if (!claim()) return  // 原子竞争
    if (response.action === 'allow') {
      resolveOnce.resolve(ctx.handleUserAllow(...))
    } else {
      resolveOnce.resolve(ctx.buildDeny('user_reject', ...))
    }
  })
  // 发送权限请求到 Bridge
  bridgeCallbacks.sendPermissionRequest(request)
}
```

**Race 3: Channel（消息渠道）**

```typescript
// interactiveHandler.ts (简化)
if (channelCallbacks) {
  // 通过 MCP 发送权限请求到 Telegram/iMessage
  channelCallbacks.sendPermissionRequest(request)
  channelCallbacks.onPermissionResponse(response => {
    if (!claim()) return  // 原子竞争
    resolveOnce.resolve(...)
  })
}
```

**Race 4: 自动化（后台 Hook + 分类器）**

```typescript
// interactiveHandler.ts (简化)
// 后台运行，不阻塞 UI
void (async () => {
  // 先检查是否已经有人赢了
  if (resolveOnce.isResolved()) return

  // 运行 PermissionRequest hooks
  const hookResult = await ctx.runHooks(...)
  if (hookResult) {
    if (!claim()) return
    resolveOnce.resolve(hookResult)
    return
  }

  // 运行 Bash 分类器（仅在用户未交互时）
  if (!userInteracted && !resolveOnce.isResolved()) {
    const classifierResult = await ctx.tryClassifier(...)
    if (classifierResult) {
      if (!claim()) return
      // ★ 分类器批准后的优雅过渡
      // 显示 checkmark 动画，然后关闭弹窗
      // 终端聚焦时等 3 秒，非聚焦时等 1 秒
      await showCheckmarkTransition(...)
      resolveOnce.resolve(classifierResult)
    }
  }
})()
```

#### 分类器的优雅过渡：防止"按钮消失"

分类器自动批准时有一个精心设计的 UX 细节：

```
分类器返回 "allow"
  │
  ▼
显示 ✓ checkmark 指示器（替换 spinner）
  │
  ├─ 终端聚焦 → 等待 3 秒（用户可能正在看弹窗）
  └─ 终端非聚焦 → 等待 1 秒（用户不在看，快速通过）
  │
  ▼
关闭权限弹窗，继续执行
```

为什么区分聚焦/非聚焦？因为如果用户正在看终端（聚焦），弹窗突然消失会让人困惑——需要足够的时间让用户看到 checkmark 并理解"这是自动批准的"。如果用户不在看终端（非聚焦），快速通过即可。

还有一个 200ms 的"优雅期"：用户开始与弹窗交互后（比如按了方向键），会设置 `userInteracted` 标志。但这个标志不是立即生效的——有 200ms 的延迟，防止用户"刚碰到键盘"就取消了分类器。

#### Coordinator 处理器：先等自动化，再问用户

Coordinator 模式（多 Agent 协调器）采用了不同的策略——**先等自动化检查完成，再决定是否弹窗**：

```typescript
// coordinatorHandler.ts (简化)
async function handleCoordinatorPermission(params) {
  // 1. 先等 hooks（快速，本地）
  const hookResult = await ctx.runHooks(...)
  if (hookResult) return hookResult

  // 2. 再等分类器（慢，推理）
  const classifierResult = await ctx.tryClassifier(...)
  if (classifierResult) return classifierResult

  // 3. 都没结果 → 返回 null，降级到交互式弹窗
  return null
}
```

这与交互式处理器的"四路竞争"不同——Coordinator 是**串行等待**。为什么？

因为 Coordinator 管理多个子 Agent，如果每个子 Agent 都弹权限窗口，用户会被淹没。Coordinator 的策略是：**尽量自动化解决，实在不行才问用户。** 串行等待确保了自动化检查有足够时间完成，减少了不必要的用户交互。

### 数据流分析：一次权限决策的完整生命周期

```
模型返回: tool_use Bash(command="rm -rf /tmp/test")
  │
  ▼
useCanUseTool(tool=Bash, input={command:"rm -rf /tmp/test"})
  │
  ├─ hasPermissionsToUseTool()
  │   ├─ 检查 alwaysAllow 规则 → 无匹配
  │   ├─ 检查 alwaysDeny 规则 → 无匹配
  │   └─ 返回 'ask'
  │
  ├─ 非 Coordinator, 非 Swarm → 主 Agent 路径
  │
  ├─ 投机性分类器检查 (2s 超时)
  │   └─ Promise.race([classifierCheck, timeout(2000)])
  │       └─ 分类器未在 2s 内返回 → 超时
  │
  └─ handleInteractivePermission()
       │
       ├─ 创建 createResolveOnce(resolve)
       │
       ├─ 推送 ToolUseConfirm 到 UI 队列
       │   └─ 用户看到: "Allow Bash(rm -rf /tmp/test)? [y/n]"
       │
       ├─ Race 1: 用户按下 'n' (拒绝)
       │   └─ onReject() → claim() → true (赢得竞争!)
       │       └─ resolve(buildDeny('user_reject'))
       │
       ├─ Race 4: 分类器返回 (晚于用户)
       │   └─ claim() → false (已被 Race 1 claim)
       │       └─ 直接返回，不做任何事
       │
       └─ 最终决策: deny (用户拒绝)
            │
            ▼
       logPermissionDecision()
            ├─ logEvent('tengu_tool_use_rejected_in_prompt')
            ├─ OTel counter: tool_permission_decision{decision=deny}
            └─ toolUseContext.toolDecisions.set(toolUseID, decision)
```

### 设计决策讨论

**为什么用"竞争"而不是"优先级队列"？**

一个替代方案是：先等 Hook，再等分类器，最后才问用户。这样可以避免竞争的复杂性。但问题是：

- Hook 可能需要 5 秒（运行测试）
- 分类器可能需要 2 秒（LLM 推理）
- 用户可能在 0.5 秒内就做出决定

如果串行等待，用户要等 7 秒才能看到弹窗。竞争模式下，弹窗立即显示，用户可以随时决定，同时自动化检查在后台运行。如果自动化先完成，弹窗自动关闭；如果用户先决定，自动化结果被丢弃。

这是一个**延迟 vs 复杂度**的权衡：竞争模式更复杂，但用户感知延迟最低。

**为什么 `claim()` 不用锁？**

JavaScript 是单线程的——`claim()` 中的 `if (claimed) return false; claimed = true; return true;` 在一个事件循环 tick 内原子执行，不需要锁。这是 JavaScript 并发模型的一个优势：只要不 `await`，代码就是原子的。

`claim()` 的关键是它在 `await` 之前调用——每个竞争路径在做任何异步操作之前先 `claim()`，确保"检查 + 标记"是原子的。如果把 `claim()` 放在 `await` 之后，两个路径可能同时通过检查。

**为什么权限日志是集中式的？**

`permissionLogging.ts` 提供了一个统一的 `logPermissionDecision()` 入口，所有决策源（Hook、用户、分类器、配置）都通过它记录。这确保了：

1. **遥测一致性**：所有决策都有相同的事件格式和属性
2. **OTel 计数器**：可以按 `decision × source × tool_name` 维度聚合
3. **代码编辑工具的语言检测**：Edit/Write/NotebookEdit 工具的决策会额外记录目标文件的编程语言

---

## 7.5 Stop Hooks：对话结束时的验证与反馈循环

### 面临的问题

当模型认为任务完成、准备结束对话时（`end_turn`），用户可能希望在"真正结束"之前做一些验证：

- 运行测试套件，确保代码修改没有破坏现有功能
- 检查 lint 规则，确保代码风格一致
- 验证构建是否成功
- 检查是否遗漏了某些文件的修改

如果验证失败，用户希望模型**继续工作**而不是结束。这就需要一个"结束前拦截"机制——Stop Hooks。

核心挑战是：Stop Hooks 的结果有三种语义，需要精确区分：

1. **阻塞错误**（blocking error）：验证失败，模型应该看到错误信息并继续修复
2. **阻止继续**（prevent continuation）：Hook 明确要求停止，不再继续对话
3. **正常通过**：验证成功，对话正常结束

### 解法：AsyncGenerator 编排 + 三态返回值

Stop Hooks 的编排逻辑在 `query/stopHooks.ts` 的 `handleStopHooks()` 中实现。它是一个 AsyncGenerator，在对话循环的 `end_turn` 分支中被调用。

#### 执行流程

```
模型返回 end_turn（认为任务完成）
  │
  ▼
handleStopHooks()
  │
  ├─ ① 保存缓存安全参数（仅主线程）
  │     └─ saveCacheSafeParams() — 供 /btw 命令和 SDK 使用
  │
  ├─ ② 模板任务分类（仅 CLAUDE_JOB_DIR 环境）
  │     └─ classifyAndWriteState() — 60s 超时
  │
  ├─ ③ 后台服务（fire-and-forget，非 bare 模式）
  │     ├─ executePromptSuggestion()  — 提示建议
  │     ├─ executeExtractMemories()   — 记忆提取
  │     └─ executeAutoDream()         — 自动梦境
  │
  ├─ ④ Computer Use 清理（仅主线程）
  │
  ├─ ⑤ 执行 Stop/SubagentStop Hooks ← 核心
  │     │
  │     for await (result of executeStopHooks(...))
  │     │
  │     ├─ progress 消息 → yield 到 UI
  │     ├─ blockingError → 创建 userMessage, yield
  │     ├─ preventContinuation → yield attachment, 标记停止
  │     └─ aborted → 返回 { preventContinuation: true }
  │
  ├─ ⑥ 创建摘要消息（hookCount > 0 时）
  │     └─ createStopHookSummaryMessage()
  │
  ├─ ⑦ Teammate Hooks（仅队友模式）
  │     ├─ TaskCompleted hooks（每个进行中的任务）
  │     └─ TeammateIdle hooks
  │
  └─ 返回 { blockingErrors, preventContinuation }
```

#### 三态返回值的语义

```typescript
// query/stopHooks.ts:60-63
type StopHookResult = {
  blockingErrors: Message[]      // 阻塞错误列表
  preventContinuation: boolean   // 是否阻止继续
}
```

这两个字段的组合产生三种语义：

| blockingErrors | preventContinuation | 含义 | 对话循环行为 |
|---------------|--------------------|----|-----------|
| `[]` | `false` | 验证通过 | 正常结束对话 |
| `[msg1, ...]` | `false` | 验证失败 | 将错误注入消息列表，模型继续修复 |
| `[]` | `true` | Hook 要求停止 | 强制结束，不再继续 |

**关键区别**：`blockingErrors` 是"模型应该修复的问题"，`preventContinuation` 是"不要再继续了"。前者触发反馈循环（模型看到错误并尝试修复），后者终止循环。

#### 核心源码解读

Stop Hooks 的结果处理逻辑：

```typescript
// query/stopHooks.ts:200-295 (简化)
for await (const result of generator) {
  // 进度消息 → 直接 yield 到 UI
  if (result.message) {
    yield result.message
  }

  // 阻塞错误 → 创建 userMessage 反馈给模型
  if (result.blockingError) {
    const userMessage = createUserMessage({
      content: getStopHookMessage(result.blockingError),
      isMeta: true,  // 隐藏 UI 显示，但模型可见
    })
    blockingErrors.push(userMessage)
    yield userMessage
  }

  // 阻止继续 → 标记并创建追踪附件
  if (result.preventContinuation) {
    preventedContinuation = true
    stopReason = result.stopReason || 'Stop hook prevented continuation'
    yield createAttachmentMessage({
      type: 'hook_stopped_continuation',
      message: stopReason,
      hookName: 'Stop',
      // ...
    })
  }

  // 中断检测 → 用户按了 Ctrl+C
  if (toolUseContext.abortController.signal.aborted) {
    return { blockingErrors: [], preventContinuation: true }
  }
}
```

注意 `isMeta: true` 的使用——阻塞错误消息被标记为 meta，这意味着它在 UI 中不直接显示（避免干扰用户），但会被注入到消息列表中供模型读取。模型看到这些错误后，会尝试修复问题并再次尝试结束。

#### Teammate 的级联 Hook

当 Claude Code 运行在 Teammate 模式（多 Agent 协作）时，Stop Hooks 之后还会执行两类额外的 Hook：

```
Stop Hooks 通过
  │
  ├─ isTeammate() → true
  │
  ├─ TaskCompleted Hooks（每个进行中的任务）
  │   └─ 通知协调器"我完成了任务 X"
  │
  └─ TeammateIdle Hooks
      └─ 通知协调器"我空闲了，可以接新任务"
```

这建立了一个**任务完成 → 空闲通知**的协议，让协调器知道何时可以分配新任务。

### 设计决策讨论

**为什么 Stop Hooks 的错误处理是"优雅降级"而不是"快速失败"？**

```typescript
// query/stopHooks.ts:456-472
} catch (error) {
  logEvent('tengu_stop_hook_error', { duration: durationMs })
  yield createSystemMessage(`Stop hook failed: ${errorMessage(error)}`, 'warning')
  return { blockingErrors: [], preventContinuation: false }
}
```

当 Stop Hook 本身抛出异常时，`handleStopHooks` 不会阻塞对话——它记录错误、显示警告、然后返回"正常通过"。这是因为 Stop Hook 是用户自定义的外部代码，它的失败不应该阻止 Claude Code 的正常运行。如果 Hook 脚本有 bug 导致崩溃，用户仍然可以正常使用 Claude Code。

**为什么后台服务（记忆提取、提示建议）在 Stop Hooks 之前执行？**

```typescript
// query/stopHooks.ts:136-157
if (!isBareMode()) {
  void executePromptSuggestion(stopHookContext)    // fire-and-forget
  void extractMemoriesModule.executeExtractMemories(...)  // fire-and-forget
  void executeAutoDream(stopHookContext, ...)       // fire-and-forget
}
```

这些后台服务是 fire-and-forget 的——它们不阻塞 Stop Hooks 的执行。放在前面是为了**尽早启动**，让它们与 Stop Hooks 并行执行。如果放在 Stop Hooks 之后，它们要等 Stop Hooks 完成（可能数秒）才能开始。

---

## 7.6 Session Hooks 与 Hook 来源隔离

### 面临的问题

用户 Hooks 配置在 `settings.json` 中，是**持久化的、全局的**。但有些 Hook 需要是**临时的、会话级的**：

- Agent frontmatter 中定义的 Hook：只在该 Agent 的生命周期内有效
- Skill 激活时注册的 Hook：只在 Skill 使用期间有效
- 结构化输出强制 Hook：只在特定 Agent 会话中有效
- SDK 回调 Hook：只在当前 SDK 调用中有效

更关键的是**隔离问题**：当多个 Agent 并行运行时，Agent A 注册的 Hook 不应该影响 Agent B。如果一个验证 Agent 注册了"Stop 时检查测试"的 Hook，这个 Hook 不应该在主 Agent 的 Stop 事件中触发。

### 解法：Map-based 会话隔离 + 高效变更通知

`utils/hooks/sessionHooks.ts` 实现了会话级 Hook 的管理。

#### 核心数据结构

```typescript
// utils/hooks/sessionHooks.ts
type SessionStore = {
  hooks: Partial<Record<HookEvent, SessionDerivedHookMatcher[]>>
  functionHooks: Partial<Record<HookEvent, FunctionHookMatcher[]>>
}

// 使用 Map 而非 Record——关键的性能决策
type SessionHooksState = Map<string, SessionStore>
```

为什么用 `Map` 而不是 `Record`？源码注释给出了详细解释：

```typescript
// Map.set() 是 O(1)，返回 prev 意味着零监听器触发
// Record + spread 是 O(N²)，会触发 ~30 个 store 监听器
// 在高并发工作流中（parallel() 生成 N 个 schema-mode agents），
// 这个差异很关键
```

在多 Agent 并发场景下，每个 Agent 启动时都会注册 Session Hook。如果用 `Record`（即普通对象），每次注册都需要 `{ ...prev, [sessionId]: newStore }`，这会创建一个新对象并触发所有 store 监听器。用 `Map`，`map.set(sessionId, store)` 是原地修改，O(1) 且不触发监听器。

#### 会话隔离机制

```
AppState.sessionHooks: Map<sessionId, SessionStore>
  │
  ├─ "main-session-id"
  │   └─ hooks: { Stop: [...], PreToolUse: [...] }
  │
  ├─ "agent-abc-123"  (子 Agent A)
  │   └─ hooks: { SubagentStop: [...] }
  │
  └─ "agent-def-456"  (子 Agent B)
      └─ hooks: { SubagentStop: [...] }
```

每个 Agent 有自己的 sessionId，Hook 按 sessionId 隔离。当执行引擎查询 Hook 时，只查询当前 sessionId 对应的 Session Hooks：

```typescript
// utils/hooks.ts:1541-1550 (getHooksConfig 中)
const sessionHooks = getSessionHooks(appState, sessionId, hookEvent)
  .get(hookEvent)
```

#### Agent Frontmatter Hook 的注册

当一个 Agent 定义了 frontmatter hooks 时（比如 Explore Agent 定义了 SubagentStop hook），这些 Hook 在 Agent 启动时被注册为 Session Hooks：

```typescript
// utils/hooks/registerFrontmatterHooks.ts (简化)
export function registerFrontmatterHooks(
  agentDefinition,
  sessionId,
  appState,
) {
  for (const [event, matchers] of Object.entries(agentDefinition.hooks)) {
    // 关键：Stop → SubagentStop 转换
    // Agent 的 "Stop" hook 实际上是 "SubagentStop"
    const actualEvent = event === 'Stop' ? 'SubagentStop' : event

    for (const matcher of matchers) {
      addSessionHook(appState, sessionId, actualEvent, matcher)
    }
  }
}
```

注意 `Stop → SubagentStop` 的转换——Agent frontmatter 中写 `Stop` 更自然（"当我停止时"），但在执行引擎中，子 Agent 的停止事件是 `SubagentStop`，不是 `Stop`。这个转换确保了 Agent 的 Hook 只在自己停止时触发，不会干扰主 Agent 的 Stop 事件。

#### Skill Hook 的 `once` 语义

Skill 注册的 Hook 支持 `once: true` 标志——执行一次后自动移除：

```typescript
// utils/hooks/registerSkillHooks.ts (简化)
export function registerSkillHooks(skill, sessionId, appState) {
  for (const [event, matchers] of Object.entries(skill.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.once) {
          // 包装原始 hook，执行后自动移除
          const wrappedHook = {
            ...hook,
            command: hook.command,  // 保留原始命令
            // 执行后通过 removeSessionHook 移除
          }
          addSessionHook(appState, sessionId, event, {
            matcher: matcher.matcher,
            hooks: [wrappedHook],
          })
        }
      }
    }
  }
}
```

`once` 语义适用于"初始化类"的 Hook——比如 Skill 激活时运行一次环境检查，之后不再需要。

---

## 7.7 HTTP Hooks 与 SSRF 防护

### 面临的问题

HTTP Hooks 允许用户将 Hook 输入 POST 到外部 URL。这带来了一个严重的安全风险：**SSRF（Server-Side Request Forgery）**。

如果攻击者能控制 Hook 的 URL（比如通过恶意的项目级 settings.json），他们可以让 Claude Code 向内网服务发送请求——访问 AWS 元数据服务（`169.254.169.254`）、内网 API、本地服务等。

### 解法：四层防御

HTTP Hook 的安全防护是多层的：

```
HTTP Hook 请求
  │
  ▼
Layer 1: URL 允许列表 (allowedHttpHookUrls)
  │ 未配置 = 无限制; [] = 全部阻止; 非空 = 必须匹配
  │
  ▼
Layer 2: 环境变量安全插值
  │ 仅 allowedEnvVars 中的变量被插值
  │ 其他变量替换为空字符串
  │ 清理 CR/LF/NUL 防止 CRLF 注入
  │
  ▼
Layer 3: SSRF 防护 (ssrfGuardedLookup)
  │ DNS 解析后验证 IP 地址
  │ 阻止私有网段 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  │ 阻止链路本地 (169.254.0.0/16 — AWS 元数据!)
  │ 允许 loopback (127.0.0.1 — 本地开发)
  │ 使用代理时跳过（代理执行 DNS）
  │
  ▼
Layer 4: 沙箱代理 (Sandbox Proxy)
  │ 通过沙箱网络代理发送请求
  │ 代理强制域名允许列表
  │
  ▼
发送 HTTP POST 请求
```

#### SSRF 防护的核心实现

```typescript
// utils/hooks/ssrfGuard.ts (简化)
const BLOCKED_IPV4_RANGES = [
  { prefix: '0.',        bits: 8  },   // "this" network
  { prefix: '10.',       bits: 8  },   // 私有
  { prefix: '100.64.',   bits: 10 },   // CGNAT (含阿里云 100.100.100.200)
  { prefix: '169.254.',  bits: 16 },   // 链路本地 (AWS 元数据!)
  { prefix: '172.16.',   bits: 12 },   // 私有
  { prefix: '192.168.',  bits: 16 },   // 私有
]

// 注意：127.0.0.0/8 (loopback) 被允许——本地开发需要

export function ssrfGuardedLookup(hostname, options, callback) {
  // 1. IP 字面量直接验证
  if (isIPAddress(hostname)) {
    if (isBlockedAddress(hostname)) {
      callback(new Error(`Blocked: ${hostname} is a private address`))
      return
    }
  }

  // 2. DNS 解析后验证所有地址
  dns.lookup(hostname, options, (err, addresses) => {
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) {
        callback(new Error(`Blocked: ${hostname} resolves to private ${addr}`))
        return
      }
    }
    callback(null, addresses)
  })
}
```

**为什么允许 loopback（127.0.0.1）？**

因为本地开发是 HTTP Hook 的主要使用场景之一——用户可能在本地运行一个 webhook 服务器来处理 Hook 事件。阻止 loopback 会让这个场景无法工作。

**为什么阻止 169.254.0.0/16？**

这是 AWS EC2 实例元数据服务的地址（`169.254.169.254`）。如果 Claude Code 运行在 EC2 实例上，SSRF 攻击可以通过这个地址获取实例的 IAM 凭证、安全组信息等敏感数据。这是 SSRF 攻击最常见的目标。

#### 环境变量安全插值

HTTP Hook 的 headers 支持环境变量插值，但有严格的安全控制：

```json
{
  "type": "http",
  "url": "https://api.example.com/hook",
  "headers": {
    "Authorization": "Bearer $MY_TOKEN"
  },
  "allowedEnvVars": ["MY_TOKEN"]
}
```

只有在 `allowedEnvVars` 中显式列出的变量才会被插值。未列出的变量（如 `$HOME`、`$AWS_SECRET_ACCESS_KEY`）会被替换为空字符串，防止意外泄露敏感环境变量。

此外，插值后的 header 值会被清理 CR/LF/NUL 字节，防止 CRLF 注入攻击（攻击者通过注入换行符来伪造 HTTP 头部）。

---

## 7.8 React Hooks 一览：UI 与生命周期的驱动力

### 面临的问题

前面几节讨论的都是"用户 Hooks"——用户配置的自动化钩子。但 Claude Code 中还有另一类 "Hook"：**React Hooks**（`useXxx`）。

Claude Code 是一个基于 React + Ink 的终端应用。React Hooks 驱动了它的 UI 渲染、状态管理、副作用处理和生命周期管理。`src/hooks/` 目录下有 90+ 个 React Hook 文件，覆盖了应用的方方面面。

这些 React Hooks 不是本章的重点（它们更多是 React 框架的标准用法），但有几个与"用户 Hooks"系统深度集成的 React Hook 值得特别关注。

### 关键 React Hooks 分类

#### 权限相关

| Hook | 文件 | 职责 |
|------|------|------|
| `useCanUseTool` | `hooks/useCanUseTool.tsx` | 工具权限决策的顶层编排（7.4 节详述） |
| `useSettings` | `hooks/useSettings.ts` | 读取合并后的设置（包含 Hook 配置） |
| `useSettingsChange` | `hooks/useSettingsChange.ts` | 监听设置变更，触发 ConfigChange Hook |

#### 对话循环相关

| Hook | 文件 | 职责 |
|------|------|------|
| `useCommandQueue` | `hooks/useCommandQueue.ts` | 命令队列管理（权限弹窗排队） |
| `useQueueProcessor` | `hooks/useQueueProcessor.ts` | 队列消费（处理权限决策） |
| `useCancelRequest` | `hooks/useCancelRequest.ts` | 取消请求（中断 Hook 执行） |

#### 任务相关

| Hook | 文件 | 职责 |
|------|------|------|
| `useTasksV2` | `hooks/useTasksV2.ts` | 任务列表管理（TaskCompleted Hook 的触发源） |
| `useBackgroundTaskNavigation` | `hooks/useBackgroundTaskNavigation.ts` | 后台任务导航 |

#### 输入相关

| Hook | 文件 | 职责 |
|------|------|------|
| `useTextInput` | `hooks/useTextInput.ts` | 文本输入处理（UserPromptSubmit Hook 的触发源） |
| `usePasteHandler` | `hooks/usePasteHandler.ts` | 粘贴处理 |

#### MCP 与插件相关

| Hook | 文件 | 职责 |
|------|------|------|
| `useMergedTools` | `hooks/useMergedTools.ts` | 合并内置工具 + MCP 工具 + 插件工具 |
| `useMergedCommands` | `hooks/useMergedCommands.ts` | 合并内置命令 + 插件命令 |
| `useManageMCPConnections` | `hooks/useManageMCPConnections.ts` | MCP 连接管理 |

#### 通知相关（`hooks/notifs/`）

通知 Hooks 是一组 React Hook，负责在特定条件下向用户显示通知。它们遵循统一的模式：

```typescript
// 典型的通知 Hook 模式
function useXxxNotification() {
  const { addNotification, removeNotification } = useNotifications()
  const someState = useSomeState()

  useEffect(() => {
    if (shouldShowNotification(someState)) {
      addNotification({
        key: 'unique-key',           // 去重键
        text: 'Notification text',
        priority: 'medium',          // low | medium | high | immediate
        timeoutMs: 5000,             // 自动消失
      })
    } else {
      removeNotification('unique-key')
    }
  }, [someState])
}
```

| Hook | 职责 |
|------|------|
| `useIDEStatusIndicator` | IDE 连接状态通知 |
| `useMcpConnectivityStatus` | MCP 服务器连接状态 |
| `useRateLimitWarningNotification` | API 速率限制警告 |
| `useModelMigrationNotifications` | 模型弃用通知 |
| `usePluginAutoupdateNotification` | 插件自动更新通知 |
| `useStartupNotification` | 会话启动消息 |
| `useInstallMessages` | 插件/依赖安装状态 |
| `useTeammateShutdownNotification` | 队友离线通知 |

### 设计决策讨论

**为什么通知 Hooks 是 React Hooks 而不是用户 Hooks？**

通知 Hooks（`hooks/notifs/`）是 React 组件级的 Hook，不是用户可配置的 Hook。这是因为：

1. **它们响应的是内部状态变化**（MCP 连接断开、速率限制触发），不是用户可预见的事件
2. **它们的输出是 UI 通知**，不是 shell 命令或 HTTP 请求
3. **它们需要访问 React 上下文**（`useNotifications`、`useAppState`），这在用户 Hook 的子进程环境中不可用

但用户 Hook 系统中也有 `Notification` 事件——当通知被发送时，用户可以配置 Hook 来响应。这建立了一个**桥接**：React 通知 Hook 产生通知 → 通知触发 `Notification` 用户 Hook → 用户 Hook 可以转发到 Slack/邮件等外部系统。

---

## 7.9 Hook 配置来源与策略控制

### 面临的问题

Hook 配置可以来自多个来源：用户全局设置、项目设置、本地设置、企业策略、插件、Skill、Agent frontmatter、SDK 回调……当这些来源冲突时，谁优先？企业管理员如何确保用户不能绕过安全策略？

### 解法：快照 + 策略门控

#### Hook 配置快照

`utils/hooks/hooksConfigSnapshot.ts` 在启动时捕获 Hook 配置的快照：

```typescript
// 启动时
captureHooksConfigSnapshot()
  └─ 读取所有设置来源的 hooks 配置
  └─ 合并为一个快照
  └─ 存储在内存中

// 设置变更时
updateHooksConfigSnapshot()
  └─ 重新读取并更新快照

// 执行时
getHooksConfigFromSnapshot()
  └─ 返回当前快照
```

快照机制确保了 Hook 配置在会话期间是**一致的**——即使用户在会话中修改了 settings.json，已经运行的 Hook 不会突然改变行为。

#### 企业策略门控

企业管理员可以通过两个策略控制 Hook 行为：

```
allowManagedHooksOnly: true
  └─ 只允许策略/托管设置中的 Hook 运行
  └─ 用户/项目/本地/插件/Agent frontmatter 的 Hook 全部被跳过

disableAllHooks: true
  └─ 禁用所有 Hook（包括托管的）
  └─ 最严格的模式
```

这些策略在 `getHooksConfig()` 中被检查：

```typescript
// utils/hooks.ts:1516-1538 (简化)
const managedOnly = shouldAllowManagedHooksOnly()

// 注册的 Hook（SDK/插件）
if (managedOnly && 'pluginRoot' in matcher) {
  continue  // 跳过插件 Hook
}

// Session Hook（Agent frontmatter/Skill）
if (!managedOnly && appState !== undefined) {
  // 只在非 managedOnly 模式下合并 session hooks
}
```

### 配置来源优先级

```
优先级（从高到低）:
  │
  ├─ 企业策略 (MDM / remoteManagedSettings)
  │   └─ allowManagedHooksOnly / disableAllHooks
  │
  ├─ Settings Snapshot（合并后的设置）
  │   ├─ 项目设置 (.claude/settings.json)
  │   ├─ 用户本地设置 (~/.claude/settings.local.json)
  │   └─ 用户全局设置 (~/.claude/settings.json)
  │
  ├─ Registered Hooks（运行时注册）
  │   ├─ SDK 回调 Hook
  │   └─ 插件原生 Hook
  │
  └─ Session Hooks（会话级）
      ├─ Agent frontmatter Hook
      ├─ Skill Hook
      └─ 结构化输出强制 Hook
```

---

## 7.10 总结：Hook 系统的设计哲学

回顾整个 Hook 系统，可以提炼出几个贯穿始终的设计哲学：

### 1. 事件驱动 + 声明式配置

用户不需要理解 Claude Code 的内部实现——只需要声明"当 X 发生时，执行 Y"。26 种事件覆盖了 LLM 工具链的完整生命周期，从工具调用到会话结束到文件变更。

### 2. 安全性是不可妥协的

- **信任检查**：所有 Hook 在执行前都要通过 `shouldSkipHookDueToTrust()` 检查
- **SSRF 防护**：HTTP Hook 有四层防御（URL 允许列表、环境变量清理、IP 地址验证、沙箱代理）
- **企业策略**：`allowManagedHooksOnly` 和 `disableAllHooks` 提供了企业级控制
- **退出码 2 的显式阻塞**：只有故意返回退出码 2 才能阻塞操作，意外失败不会阻塞

### 3. 性能优化在热路径上

- **内部回调快速路径**：跳过 JSON/span/progress 处理，性能提升 70%
- **`hasHookForEvent()` 快速检查**：O(1) 排除无 Hook 的事件
- **Map-based Session Hooks**：O(1) 变更，避免 O(N²) 的对象复制
- **延迟 JSON 序列化**：`getJsonInput()` 只在需要时序列化一次

### 4. 竞争优于串行

权限决策的四路竞争模式是整个 Hook 系统中最精巧的设计——它用 `createResolveOnce` 的原子竞争守卫，在保证正确性的前提下最小化用户感知延迟。

### 5. 优雅降级优于快速失败

Hook 是用户自定义的外部代码，它的失败不应该阻塞 Claude Code 的核心功能。无论是 Stop Hook 异常、HTTP Hook 超时还是分类器失败，系统都会降级到下一个可用的决策路径，而不是崩溃。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `utils/hooks.ts` | Hook 执行引擎（5000+ 行） | `executeHooks()`, `getMatchingHooks()`, `execCommandHook()`, `parseHookOutput()`, `processHookJSONOutput()` |
| `schemas/hooks.ts` | Hook Zod Schema 定义 | `HookCommandSchema`, `HookMatcherSchema`, `HooksSchema` |
| `types/hooks.ts` | Hook TypeScript 类型 | `HookCallback`, `HookResult`, `AggregatedHookResult`, `hookJSONOutputSchema` |
| `hooks/toolPermission/PermissionContext.ts` | 权限决策上下文 | `createPermissionContext()`, `createResolveOnce()` |
| `hooks/toolPermission/handlers/interactiveHandler.ts` | 交互式权限处理（四路竞争） | `handleInteractivePermission()` |
| `hooks/toolPermission/handlers/coordinatorHandler.ts` | Coordinator 权限处理 | `handleCoordinatorPermission()` |
| `hooks/toolPermission/handlers/swarmWorkerHandler.ts` | Swarm Worker 权限处理 | `handleSwarmWorkerPermission()` |
| `hooks/toolPermission/permissionLogging.ts` | 权限决策日志 | `logPermissionDecision()` |
| `hooks/useCanUseTool.tsx` | 权限决策顶层编排 | `useCanUseTool()` |
| `query/stopHooks.ts` | Stop Hook 编排 | `handleStopHooks()` |
| `utils/hooks/sessionHooks.ts` | 会话级 Hook 管理 | `addSessionHook()`, `getSessionHooks()`, `clearSessionHooks()` |
| `utils/hooks/hooksConfigSnapshot.ts` | Hook 配置快照 | `captureHooksConfigSnapshot()`, `shouldAllowManagedHooksOnly()` |
| `utils/hooks/execPromptHook.ts` | Prompt Hook 执行器 | `execPromptHook()` |
| `utils/hooks/execAgentHook.ts` | Agent Hook 执行器 | `execAgentHook()` |
| `utils/hooks/execHttpHook.ts` | HTTP Hook 执行器 | `execHttpHook()` |
| `utils/hooks/ssrfGuard.ts` | SSRF 防护 | `ssrfGuardedLookup()`, `isBlockedAddress()` |
| `utils/hooks/AsyncHookRegistry.ts` | 异步 Hook 注册表 | `registerPendingAsyncHook()`, `checkForAsyncHookResponses()` |
| `utils/hooks/hookEvents.ts` | Hook 事件广播 | `emitHookStarted()`, `emitHookResponse()` |
| `utils/hooks/registerFrontmatterHooks.ts` | Agent frontmatter Hook 注册 | `registerFrontmatterHooks()` |
| `utils/hooks/registerSkillHooks.ts` | Skill Hook 注册 | `registerSkillHooks()` |
| `hooks/notifs/*.tsx` | 通知 React Hooks（18 个） | `useIDEStatusIndicator()`, `useMcpConnectivityStatus()` 等 |
