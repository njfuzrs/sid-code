---
title: Claude Code 源码解析（十六）· IDE 集成与 Bridge
description: 'Claude Code 不只是终端工具——它如何与 VS Code 等 IDE 双向通信，实现选区同步、Diff 预览、诊断信息获取？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十六章：IDE 集成与 Bridge 模式（IDE Integration & Bridge）

> Claude Code 不只是一个 CLI——它如何与 VS Code、Cursor、JetBrains 等 IDE 深度集成，又如何通过 Bridge 协议让 claude.ai 网页端远程操控本地开发环境？

## 核心问题

Claude Code 诞生于终端，但开发者的主战场在 IDE。这带来了一系列深层矛盾：

1. **交互界面的割裂。** 开发者在 VS Code 中写代码，却要切到终端与 Claude 对话。Claude 编辑了文件，开发者看不到实时 diff；开发者在 IDE 中选中了一段代码，Claude 不知道选区内容。两个工具之间存在一道信息鸿沟。

2. **远程操控的需求。** 用户在手机或 claude.ai 网页端发起一个任务，希望 Claude 在本地开发机上执行——读写文件、运行测试、提交代码。但本地机器在 NAT 后面，没有公网 IP，传统的 C/S 架构行不通。

3. **协议统一的挑战。** IDE 扩展（VS Code Extension）、Web 端（claude.ai）、CLI 终端——三种截然不同的客户端，需要与同一个 Claude Code 进程通信。每种客户端的能力、延迟、安全模型都不同。

4. **代码智能的接入。** IDE 内置了 LSP（Language Server Protocol）提供的类型检查、跳转定义、引用查找等能力。Claude 如果能利用这些能力，代码质量会大幅提升。但 LSP 是一个有状态的、面向编辑器的协议，如何让一个 CLI 工具接入？

**Claude Code 的解法是三层架构：**
- **IDE 集成层**：通过 MCP 协议将 IDE 扩展接入为一个 MCP Server，复用已有的 MCP 基础设施
- **Bridge 层**：通过云端中继实现 claude.ai ↔ 本地 Claude Code 的双向通信
- **LSP 层**：内置 LSP Client，直接与语言服务器通信获取代码智能

这三层解决的是不同维度的问题，但共享一个设计哲学：**Claude Code 是中心节点，所有外部系统都通过标准化协议接入。**

---

## 16.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        外部客户端                                    │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────────┐  │
│  │ VS Code  │    │  claude.ai   │    │  JetBrains / Cursor /     │  │
│  │Extension │    │  Web Client  │    │  Windsurf / Chrome Ext    │  │
│  └────┬─────┘    └──────┬───────┘    └────────────┬──────────────┘  │
│       │                 │                          │                 │
└───────┼─────────────────┼──────────────────────────┼─────────────────┘
        │                 │                          │
        │ MCP (SSE/WS)   │ Bridge Protocol          │ MCP (SSE/WS)
        │                 │ (WS/SSE + HTTP POST)     │
        │                 │                          │
┌───────┼─────────────────┼──────────────────────────┼─────────────────┐
│       ▼                 ▼                          ▼                 │
│  ┌─────────┐    ┌──────────────┐    ┌──────────────────┐            │
│  │   MCP   │    │    Bridge    │    │    MCP Client    │            │
│  │ Client  │    │    Layer     │    │   (IDE detect)   │            │
│  │(ide slot)│   │ (v1/v2 core)│    │                  │            │
│  └────┬─────┘    └──────┬───────┘    └────────┬─────────┘            │
│       │                 │                      │                     │
│       ▼                 ▼                      ▼                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │              Claude Code Core (QueryEngine)               │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │       │
│  │  │ Tool Sys │  │ State Mgr│  │ Perm Sys │  │ Context │ │       │
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │       │
│  └──────────────────────────────────────────────────────────┘       │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │   LSP Client     │    │  Language Servers │                       │
│  │  (LSPServer      │───▶│  (TypeScript,    │                       │
│  │   Manager)       │    │   Python, etc.)  │                       │
│  └──────────────────┘    └──────────────────┘                       │
│                                                                     │
│                     Claude Code Process                              │
└─────────────────────────────────────────────────────────────────────┘
```

这个架构有几个关键设计决策值得注意：

**决策 1：IDE 扩展作为 MCP Server 接入，而非自定义协议。** Claude Code 已经有了完整的 MCP 基础设施（连接管理、工具桥接、权限控制）。将 IDE 扩展视为"又一个 MCP Server"，可以零成本复用这些基础设施。IDE 提供的能力（打开文件、显示 diff、获取选区）被暴露为 MCP 工具和通知。

**决策 2：Bridge 是独立的通信层，不走 MCP。** claude.ai 与本地 Claude Code 的通信需求与 IDE 集成完全不同——它需要完整的对话流转发、权限代理、会话管理、崩溃恢复。MCP 协议不适合这种场景，因此 Bridge 有自己的协议栈。

**决策 3：LSP 直接内置，不依赖 IDE。** 即使没有 IDE 连接，Claude Code 也能通过内置 LSP Client 获取代码智能。这保证了 CLI 模式下的代码质量不打折扣。

---

## 16.2 IDE 集成层：把 IDE 变成一个 MCP Server

### 面临的问题

Claude Code 需要与 IDE 双向通信：
- **Claude → IDE**：打开文件、显示 diff、关闭标签页
- **IDE → Claude**：用户选区变化、@提及、日志事件

传统做法是设计一套自定义 IPC 协议。但 Claude Code 已经有了完整的 MCP 基础设施——连接管理、工具发现、通知机制、权限控制。**为什么不把 IDE 扩展当作一个 MCP Server？**

这正是 Claude Code 的做法。IDE 扩展（VS Code Extension / JetBrains Plugin）启动一个本地 SSE 或 WebSocket 服务器，Claude Code 作为 MCP Client 连接上去。IDE 的能力被暴露为 MCP 工具（如 `openDiff`、`closeAllDiffTabs`），IDE 的事件被暴露为 MCP 通知（如 `selection_changed`、`at_mentioned`）。

### IDE 发现机制：Lockfile 协议

第一个问题是：Claude Code 怎么知道哪个 IDE 在运行，以及如何连接？

答案是一个基于文件系统的 **Lockfile 协议**：

```
~/.claude/ide/
├── 12345.lock    ← VS Code 实例，监听端口 12345
├── 23456.lock    ← Cursor 实例，监听端口 23456
└── 34567.lock    ← JetBrains 实例，监听端口 34567
```

每个 IDE 扩展启动时，在 `~/.claude/ide/` 目录下创建一个以端口号命名的 `.lock` 文件，内容是 JSON：

```typescript
// src/utils/ide.ts
type LockfileJsonContent = {
  workspaceFolders?: string[]   // IDE 打开的工作区目录
  pid?: number                  // IDE 进程 PID
  ideName?: string              // IDE 名称（"VS Code", "Cursor" 等）
  transport?: 'ws' | 'sse'     // 传输协议类型
  runningInWindows?: boolean    // 是否在 Windows 上运行（WSL 场景）
  authToken?: string            // 认证令牌
}
```

Claude Code 启动时扫描这些 lockfile，通过以下策略找到"正确的" IDE：

```
┌─────────────────────────────────────────────────────┐
│              IDE 发现流程 (findAvailableIDE)          │
│                                                      │
│  1. cleanupStaleIdeLockfiles()                       │
│     ├─ PID 不存在？删除 lockfile                      │
│     └─ 端口无响应？删除 lockfile                      │
│                                                      │
│  2. 轮询循环（最多 30 秒，每秒一次）                   │
│     │                                                │
│     ▼                                                │
│  3. detectIDEs()                                     │
│     ├─ 读取所有 lockfile（按修改时间排序）              │
│     ├─ 工作区目录匹配：cwd ∈ workspaceFolders?        │
│     ├─ 环境变量端口匹配：CLAUDE_CODE_SSE_PORT?        │
│     ├─ 进程祖先链匹配：IDE PID ∈ ancestors(ppid)?    │
│     └─ 恰好一个匹配 → 返回                           │
│                                                      │
│  4. 无匹配 → 返回 null                               │
└─────────────────────────────────────────────────────┘
```

**为什么用 lockfile 而不是进程扫描？** 进程扫描（`ps aux | grep`）只能告诉你"有一个 VS Code 在运行"，但无法告诉你它监听哪个端口、打开了哪些目录。Lockfile 是 IDE 扩展主动注册的结构化信息，包含了连接所需的一切。

**为什么要轮询 30 秒？** 因为 Claude Code 可能在 IDE 扩展之前启动（比如用户先开终端再开 VS Code），或者扩展需要几秒钟初始化。30 秒的轮询窗口确保了即使启动顺序不确定，也能最终连接上。

**为什么要求"恰好一个匹配"？** 如果用户同时打开了两个 VS Code 窗口，且工作区目录有重叠，Claude Code 无法确定应该连接哪个。此时退回到手动选择（`/ide` 命令），避免连错。

源码中有一个精妙的优化——**进程祖先链检查被延迟到工作区匹配之后**：

```typescript
// src/utils/ide.ts — detectIDEs()
// PID ancestry check: when running in a supported IDE's built-in terminal,
// ensure this lockfile's IDE is actually our parent process. This
// disambiguates when multiple IDE windows have overlapping workspace folders.
// Runs AFTER the workspace check so non-matching lockfiles skip it entirely —
// previously this shelled out once per lockfile and dominated CPU profiles
// during findAvailableIDE() polling.
if (needsAncestryCheck) {
  const portMatchesEnv = envPort !== null && lockfileInfo.port === envPort
  if (!portMatchesEnv) {
    if (!lockfileInfo.pid || !isProcessRunning(lockfileInfo.pid)) {
      continue
    }
    if (process.ppid !== lockfileInfo.pid) {
      const ancestors = await getAncestors()
      if (!ancestors.has(lockfileInfo.pid)) {
        continue
      }
    }
  }
}
```

进程祖先链检查需要多次 `ps` 调用（最多 10 次），在 `findAvailableIDE()` 每秒轮询的场景下，这个开销曾经在 CPU profile 中占据主导地位。将它移到工作区匹配之后，大多数不匹配的 lockfile 在目录检查阶段就被过滤掉了，祖先链检查几乎不会触发。

### 自动连接与 MCP 注册

IDE 发现完成后，`useIDEIntegration` Hook 将 IDE 信息注册为一个动态 MCP Server 配置：

```typescript
// src/hooks/useIDEIntegration.tsx
setDynamicMcpConfig(prev => {
  if (prev?.ide) {
    return prev  // 已有 IDE 连接，不重复添加
  }
  return {
    ...prev,
    ide: {
      type: ide.url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
      url: ide.url,
      ideName: ide.name,
      authToken: ide.authToken,
      ideRunningInWindows: ide.ideRunningInWindows,
      scope: 'dynamic' as const,
    },
  }
})
```

注意 `type` 字段：`ws-ide` 和 `sse-ide` 是 MCP 连接管理器识别的特殊类型，它们告诉 MCP 基础设施使用 WebSocket 或 SSE 传输连接到 IDE 扩展。

自动连接的触发条件是一个"或"链：

```typescript
const autoConnectEnabled =
  (globalConfig.autoConnectIde ||        // 用户配置开启
   autoConnectIdeFlag ||                  // CLI 参数 --ide
   isSupportedTerminal() ||               // 在 IDE 内置终端中运行
   process.env.CLAUDE_CODE_SSE_PORT ||    // 环境变量指定端口
   ideToInstallExtension ||               // 正在安装扩展
   isEnvTruthy(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)) &&  // 环境变量强制开启
  !isEnvDefinedFalsy(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE) // 环境变量未强制关闭
```

**设计决策：为什么用"或"链而不是默认开启？** 自动连接 IDE 有副作用——它会启动 MCP 连接、注册通知处理器、可能触发扩展安装。对于纯 CLI 用户（在独立终端中使用），这些都是不必要的开销。只有当有明确信号表明用户在 IDE 环境中时，才自动连接。

### 扩展自动安装

Claude Code 不仅能发现 IDE，还能自动安装自己的 IDE 扩展：

```typescript
// src/utils/ide.ts — initializeIdeIntegration()
const shouldAutoInstall = getGlobalConfig().autoInstallIdeExtension ?? true
if (!isEnvTruthy(process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL) && shouldAutoInstall) {
  const ideType = ideToInstallExtension ?? getTerminalIdeType()
  if (ideType) {
    if (isVSCodeIde(ideType)) {
      // 检查是否已安装 → 安装/更新 → 触发 onboarding
      void isIDEExtensionInstalled(ideType).then(async isAlreadyInstalled => {
        void maybeInstallIDEExtension(ideType)
          .then(status => {
            onInstallationComplete(status)
            if (status?.installed) {
              // 安装成功后重新搜索 IDE
              void findAvailableIDE().then(onIdeDetected)
            }
            if (!isAlreadyInstalled && status?.installed === true &&
                !hasIdeOnboardingDialogBeenShown()) {
              onShowIdeOnboarding()  // 首次安装，显示引导对话框
            }
          })
      })
    }
  }
}
```

安装过程调用 IDE 的 CLI 命令（如 `code --force --install-extension anthropic.claude-code`），并且会比较版本号——如果已安装的扩展版本低于当前 Claude Code 版本，会自动更新。

**为什么 JetBrains 不自动安装？** 因为 JetBrains 的插件安装不支持通过 CLI 完成（原生构建限制），只能引导用户从 Marketplace 手动下载。这是一个务实的妥协。

### IDE 通信：选区同步、Diff 展示、@提及

连接建立后，Claude Code 通过 MCP 通知机制接收 IDE 事件：

**选区同步（`useIdeSelection`）：**

```typescript
// src/hooks/useIdeSelection.ts
ideClient.client.setNotificationHandler(
  SelectionChangedSchema(),  // Zod schema 验证
  notification => {
    const { start, end } = notification.params.selection
    let lineCount = end.line - start.line + 1
    // 如果光标在行首（character === 0），不计入该行
    if (end.character === 0) {
      lineCount--
    }
    onSelect({ lineCount, lineStart: start.line, text, filePath })
  },
)
```

当用户在 IDE 中选中代码时，扩展发送 `selection_changed` 通知，Claude Code 实时更新选区信息。这让用户可以说"解释我选中的这段代码"而不需要手动复制粘贴。

**Diff 展示（`useDiffInIDE`）：**

当 Claude 编辑文件时，可以在 IDE 中打开一个 diff 视图，让用户直观地看到变更：

```typescript
// src/hooks/useDiffInIDE.ts — showDiffInIDE()
// 1. 通过 RPC 在 IDE 中打开 diff 标签页
await callIdeRpc('openDiff', {
  filePath: convertedPath,
  oldContent: originalContent,
  newContent: editedContent,
  tabId: tabId,
}, ideClient)

// 2. 等待用户操作（保存/关闭/拒绝）
// 3. 如果用户在 IDE 中修改了内容，重新计算 edit
```

这个功能还处理了 WSL 场景下的路径转换——Claude Code 在 WSL 中运行，但 IDE 在 Windows 上运行，文件路径需要从 `/mnt/c/...` 转换为 `C:\...`。

**@提及（`useIdeAtMentioned`）：**

用户在 IDE 中通过 @mention 引用代码位置，扩展发送 `at_mentioned` 通知，Claude Code 记录文件路径和行范围，在后续对话中作为上下文使用。

### 连接状态监控

`useIdeConnectionStatus` Hook 提供了简洁的连接状态查询：

```typescript
// src/hooks/useIdeConnectionStatus.ts
export function useIdeConnectionStatus(mcpClients?: MCPServerConnection[]): IdeConnectionResult {
  return useMemo(() => {
    const ideClient = mcpClients?.find(client => client.name === 'ide')
    if (!ideClient) return { status: null, ideName: null }

    const ideName = config.type === 'sse-ide' || config.type === 'ws-ide'
      ? config.ideName : null

    if (ideClient.type === 'connected') return { status: 'connected', ideName }
    if (ideClient.type === 'pending')   return { status: 'pending', ideName }
    return { status: 'disconnected', ideName }
  }, [mcpClients])
}
```

四种状态：`null`（无 IDE 配置）、`pending`（正在连接）、`connected`（已连接）、`disconnected`（断开）。UI 层根据这个状态显示连接指示器。

### 支持的 IDE 矩阵

Claude Code 支持的 IDE 分为两大家族：

| 家族 | IDE | 自动检测 | 自动安装扩展 | 传输协议 |
|------|-----|---------|-------------|---------|
| VS Code 系 | VS Code | ✅ | ✅ | SSE/WS |
| VS Code 系 | Cursor | ✅ | ✅ | SSE/WS |
| VS Code 系 | Windsurf | ✅ | ✅ | SSE/WS |
| JetBrains 系 | IntelliJ IDEA | ✅ | ❌ | SSE/WS |
| JetBrains 系 | PyCharm | ✅ | ❌ | SSE/WS |
| JetBrains 系 | WebStorm | ✅ | ❌ | SSE/WS |
| JetBrains 系 | GoLand | ✅ | ❌ | SSE/WS |
| JetBrains 系 | Android Studio | ✅ | ❌ | SSE/WS |
| JetBrains 系 | Aqua/Gateway/Fleet | ❌* | ❌ | SSE/WS |

*Aqua、Gateway、Fleet 的进程关键词太通用（容易误匹配），因此不自动检测，需要用户手动配置。

### 小结：IDE 集成的设计哲学

IDE 集成层的核心设计哲学是 **"IDE 是可选的增强，不是必需的依赖"**：

1. **零侵入**：Claude Code 不修改 IDE 的任何配置，只通过 lockfile 被动发现
2. **渐进增强**：没有 IDE 连接时，所有功能正常工作；有 IDE 连接时，获得选区同步、diff 展示等增强
3. **复用 MCP**：不发明新协议，IDE 扩展就是一个 MCP Server，复用已有的连接管理、工具调用、通知机制
4. **容错优先**：IDE 断开不影响 Claude Code 运行，所有 RPC 调用都有 try-catch 包裹

---

## 16.3 Bridge 层：让 claude.ai 远程操控本地开发环境

### 面临的问题

用户在 claude.ai 网页端（或手机端）输入一条指令："帮我修复这个 bug"。这条指令需要在用户的本地开发机上执行——读写文件、运行测试、提交代码。但本地机器在 NAT/防火墙后面，没有公网 IP。

这是一个经典的 **NAT 穿透** 问题，但 Claude Code 选择了一个更简单、更可靠的方案：**云端中继（Cloud Relay）**。

```
┌──────────┐         ┌──────────────────┐         ┌──────────────┐
│ claude.ai│ ──────▶ │  Anthropic Cloud  │ ◀────── │  本地 Claude  │
│ Web/Mobile│        │  (CCR / Session   │         │  Code 进程    │
│          │ ◀────── │   Ingress)        │ ──────▶ │  (Bridge)     │
└──────────┘         └──────────────────┘         └──────────────┘
   用户输入              消息中继                    工具执行
   结果展示              会话管理                    文件读写
   权限决策              认证鉴权                    命令运行
```

本地 Claude Code 主动向云端建立长连接（WebSocket 或 SSE），云端将用户消息转发到本地，本地执行后将结果回传。这避免了 NAT 穿透的复杂性，代价是所有通信都经过云端中继。

### 两代 Bridge 架构：v1（Environment-based）vs v2（Environment-less）

Bridge 经历了一次重大架构演进。理解这两代架构的差异，是理解 Bridge 代码复杂性的关键。

**v1 架构（Environment-based）：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    v1: Environment-based                         │
│                                                                  │
│  本地 Claude Code                    Anthropic Cloud              │
│  ┌──────────────┐                   ┌──────────────────┐        │
│  │ bridgeMain   │ ── register ────▶ │ Environments API │        │
│  │              │ ◀── env_id ────── │                  │        │
│  │              │                   │                  │        │
│  │  poll loop ──│ ── poll ────────▶ │  (work queue)    │        │
│  │              │ ◀── WorkResponse──│                  │        │
│  │              │                   └──────────────────┘        │
│  │              │                                                │
│  │  spawn child │ ── ack ─────────▶ Session Ingress             │
│  │  ┌────────┐  │                   ┌──────────────────┐        │
│  │  │ claude │  │ ◀═══ WS/SSE ════▶ │  WebSocket /     │        │
│  │  │ (child)│  │    (双向消息流)     │  SSE Endpoint    │        │
│  │  └────────┘  │                   └──────────────────┘        │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
```

v1 的流程是：
1. **注册环境**：`registerBridgeEnvironment()` 向 Environments API 注册，获得 `environment_id`
2. **轮询工作**：`pollForWork()` 长轮询等待用户发起会话
3. **确认工作**：收到 `WorkResponse` 后，`acknowledgeWork()` 确认接收
4. **派生子进程**：spawn 一个新的 `claude` 子进程处理会话
5. **双向通信**：子进程通过 WebSocket/SSE 与 Session Ingress 双向通信
6. **心跳续租**：`heartbeatWork()` 定期续租，防止服务端回收

**v2 架构（Environment-less）：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    v2: Environment-less                          │
│                                                                  │
│  本地 Claude Code                    Anthropic Cloud              │
│  ┌──────────────┐                   ┌──────────────────┐        │
│  │ remoteBridge │ ── POST /bridge ─▶│ Code Sessions    │        │
│  │ Core         │ ◀── worker_jwt ───│ API              │        │
│  │              │                   │                  │        │
│  │              │ ── POST /worker/ ▶│ CCR v2 Worker    │        │
│  │              │    register        │ Endpoints        │        │
│  │              │                   │                  │        │
│  │  SSE read ◀──│ ◀═══ SSE ════════│ /worker/events   │        │
│  │  CCR write ──│ ══ POST events ══▶│ (stream)         │        │
│  │              │                   └──────────────────┘        │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
```

v2 跳过了整个 Environments API 层：
1. **直接获取 JWT**：`POST /bridge` 用 OAuth token 换取 `worker_jwt`
2. **注册 Worker**：`POST /worker/register` 注册工作节点
3. **SSE 读取**：通过 SSE 流接收用户消息
4. **HTTP POST 写入**：通过 `POST /worker/events` 发送响应

**为什么要从 v1 演进到 v2？**

| 维度 | v1 | v2 |
|------|----|----|
| 初始化步骤 | register → poll → ack → spawn → connect（5步） | POST /bridge → register → connect（3步） |
| 进程模型 | 父进程轮询 + 子进程执行 | 单进程直连 |
| 延迟 | 轮询间隔（2s-10min）+ 子进程启动 | 即时连接 |
| 复杂度 | 环境生命周期管理、工作队列、子进程管理 | 直接 JWT 交换 |
| 多会话 | 原生支持（worktree/same-dir 模式） | REPL 单会话 |

v2 的核心优势是 **更低的延迟和更简单的架构**。但 v1 仍然保留用于 `claude remote-control` 命令（独立 bridge 服务器模式），因为它支持多会话并发。

两代架构通过 GrowthBook feature flag 控制切换：

```typescript
// src/bridge/bridgeEnabled.ts
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}
```

### Bridge 启动流程：层层设防的准入检查

Bridge 的启动不是简单的"连接服务器"，而是一个层层设防的准入检查链。这个设计反映了 Remote Control 功能的高风险性——它允许远程执行本地命令，任何一个环节出错都可能导致安全问题或糟糕的用户体验。

```
┌─────────────────────────────────────────────────────────────────┐
│              initReplBridge() 启动检查链                         │
│                                                                  │
│  ① 编译期门控: feature('BRIDGE_MODE')                            │
│     └─ 构建时死代码消除，外部构建完全移除 Bridge 代码              │
│                                                                  │
│  ② 运行时 GrowthBook 门控: isBridgeEnabledBlocking()            │
│     └─ 服务端控制的灰度开关，可随时关闭                           │
│                                                                  │
│  ③ OAuth 认证检查: getBridgeAccessToken()                        │
│     └─ 必须有 claude.ai 订阅的 OAuth token                       │
│                                                                  │
│  ④ 组织策略检查: isPolicyAllowed('allow_remote_control')         │
│     └─ 企业管理员可禁用 Remote Control                            │
│                                                                  │
│  ⑤ Token 有效性检查: checkAndRefreshOAuthTokenIfNeeded()         │
│     └─ 主动刷新过期 token，避免 401 风暴                          │
│                                                                  │
│  ⑥ 跨进程退避: bridgeOauthDeadExpiresAt / deadFailCount          │
│     └─ 同一个死 token 被 3 个进程发现后，后续进程直接跳过          │
│                                                                  │
│  ⑦ 版本下限检查: checkBridgeMinVersion()                         │
│     └─ 服务端可强制要求最低客户端版本                              │
│                                                                  │
│  ⑧ 组织 UUID 获取: getOrganizationUUID()                        │
│     └─ v1 注册和 v2 归档都需要                                    │
│                                                                  │
│  ⑨ v1/v2 分支: isEnvLessBridgeEnabled()                         │
│     └─ GrowthBook 控制走哪条路径                                  │
│                                                                  │
│  全部通过 → 建立连接                                              │
│  任一失败 → 返回 null，onStateChange('failed', reason)           │
└─────────────────────────────────────────────────────────────────┘
```

其中第 ⑥ 步的"跨进程退避"机制值得深入分析。这是一个精巧的分布式退避策略：

```typescript
// src/bridge/initReplBridge.ts
// 跨进程退避：如果同一个死 token 已被 3 个进程发现，直接跳过
const cfg = getGlobalConfig()
if (
  cfg.bridgeOauthDeadExpiresAt != null &&
  (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
  getClaudeAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt
) {
  return null  // 不再尝试
}
```

**问题场景**：用户的 OAuth refresh token 失效了（密码修改、组织变更等），但 access token 的 `expiresAt` 还在。每个新启动的 Claude Code 进程都会尝试刷新 token → 失败 → 用过期 token 调 API → 401。Datadog 监控显示单个 IP 每天产生 2,879 次这样的 401。

**解法**：用 `expiresAt` 作为 token 的"指纹"。第一个进程发现 token 死了，写入 `bridgeOauthDeadExpiresAt` 和 `bridgeOauthDeadFailCount=1`。第二、第三个进程递增计数。第四个进程看到 count≥3，直接跳过。当用户重新登录（`/login`），新 token 有新的 `expiresAt`，计数自动失效。

这个设计的巧妙之处在于：**不需要显式的"清除"操作**——新 token 的 `expiresAt` 天然不同，旧的退避记录自动失效。

### Bridge 消息协议

Bridge 的消息协议基于 SDK 消息格式（`SDKMessage`），是一个以 `type` 字段为判别式的联合类型。消息分为三大类：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Bridge 消息流                                  │
│                                                                  │
│  claude.ai ──────────────────────────────────▶ 本地 Claude Code  │
│  (Inbound)                                                       │
│  ┌─────────────────┐                                             │
│  │ user            │  用户输入的 prompt                           │
│  │ control_request │  服务端控制指令                               │
│  │   ├─ initialize │    初始化会话                                │
│  │   ├─ set_model  │    切换模型                                  │
│  │   ├─ interrupt  │    中断当前操作                               │
│  │   ├─ set_permission_mode │  切换权限模式                       │
│  │   └─ can_use_tool│   权限决策响应                              │
│  │ control_response│  权限请求的用户回复                           │
│  └─────────────────┘                                             │
│                                                                  │
│  本地 Claude Code ──────────────────────────▶ claude.ai          │
│  (Outbound)                                                      │
│  ┌─────────────────┐                                             │
│  │ assistant       │  Claude 的回复（含 tool_use blocks）         │
│  │ user            │  回显（用于去重）                             │
│  │ tool_result     │  工具执行结果                                │
│  │ result          │  会话完成（success/error）                   │
│  │ control_response│  对 control_request 的响应                   │
│  │ keep_alive      │  心跳帧（防止代理回收连接）                   │
│  └─────────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
```

消息过滤是一个关键设计点——不是所有内部消息都应该转发到 Bridge：

```typescript
// src/bridge/bridgeMessaging.ts
export function isEligibleBridgeMessage(m: Message): boolean {
  // 虚拟消息（REPL 内部调用）仅用于显示，不转发
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command')
  )
}
```

只有 `user`、`assistant` 和斜杠命令产生的 `system` 消息会被转发。`tool_result`、`progress` 等内部消息被过滤掉——它们是 REPL 内部的"噪音"，Bridge/SDK 消费者只需要看到最终的工具使用和结果摘要。

### 消息去重：BoundedUUIDSet

Bridge 通信中有一个棘手的问题：**消息回显和重放导致的重复**。

场景 1：本地 Claude Code 发送一条 `user` 消息到服务端，服务端将它广播给所有连接的客户端——包括发送者自己。如果不去重，本地会收到自己发出的消息的回显。

场景 2：传输层断开重连后，服务端可能重放历史消息（从上次的 sequence number 开始）。如果不去重，已经处理过的消息会被再次处理。

Claude Code 用一个精巧的数据结构解决这个问题——`BoundedUUIDSet`：

```typescript
// src/bridge/bridgeMessaging.ts
// FIFO 环形缓冲区，O(capacity) 内存，O(1) 查找和插入
export class BoundedUUIDSet {
  private set = new Set<string>()
  private ring: string[]
  private cursor = 0

  constructor(private capacity: number) {
    this.ring = new Array(capacity)
  }

  add(uuid: string): void {
    if (this.set.size >= this.capacity) {
      // 环形缓冲区满了，移除最老的 UUID
      const evicted = this.ring[this.cursor]!
      this.set.delete(evicted)
    }
    this.ring[this.cursor] = uuid
    this.set.add(uuid)
    this.cursor = (this.cursor + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }
}
```

**为什么不用普通 Set？** 因为 Bridge 是长生命周期的——一个 `claude remote-control` 进程可能运行数天。如果用普通 Set 存储所有见过的 UUID，内存会无限增长。`BoundedUUIDSet` 用环形缓冲区限制容量，最老的 UUID 被自动淘汰。

消息入站路由使用两个独立的 `BoundedUUIDSet`：

```typescript
// src/bridge/bridgeMessaging.ts — handleIngressMessage()
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,    // 我们发出的消息的 UUID
  recentInboundUUIDs: BoundedUUIDSet,   // 我们收到的消息的 UUID
  onInboundMessage,
  onPermissionResponse,
  onControlRequest,
): void {
  const parsed = normalizeControlMessageKeys(jsonParse(data))

  // control_response 不是 SDKMessage，优先检查
  if (isSDKControlResponse(parsed)) {
    onPermissionResponse?.(parsed)
    return
  }

  // control_request 从服务端发来（initialize, set_model, can_use_tool）
  if (isSDKControlRequest(parsed)) {
    onControlRequest?.(parsed)
    return
  }

  if (!isSDKMessage(parsed)) return

  // 去重：跳过我们自己发出的消息的回显
  const uuid = parsed.uuid
  if (uuid && recentPostedUUIDs.has(uuid)) return

  // 去重：跳过已经处理过的重放消息
  if (uuid && recentInboundUUIDs.has(uuid)) return
  if (uuid) recentInboundUUIDs.add(uuid)

  onInboundMessage?.(parsed)
}
```

### 传输层抽象：ReplBridgeTransport

Bridge 的传输层面临一个典型的"多实现统一接口"问题：v1 用 HybridTransport（WebSocket 读 + HTTP POST 写），v2 用 SSETransport（SSE 读）+ CCRClient（HTTP POST 写）。上层的 Bridge 核心逻辑不应该关心底层用的是哪种传输。

`ReplBridgeTransport` 接口统一了这两种实现：

```typescript
// src/bridge/replBridgeTransport.ts
export type ReplBridgeTransport = {
  // 基础读写
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void

  // 连接状态
  isConnectedStatus(): boolean
  getStateLabel(): string

  // 事件回调
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  setOnConnect(callback: () => void): void
  connect(): void

  // SSE 序列号（v2 用于断线续传，v1 返回 0）
  getLastSequenceNum(): number

  // 丢弃批次计数（检测静默丢包）
  readonly droppedBatchCount: number

  // v2 专有：状态上报、元数据上报、投递确认
  reportState(state: SessionState): void
  reportMetadata(metadata: Record<string, unknown>): void
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void

  // v2 专有：写队列排空
  flush(): Promise<void>
}
```

**为什么 v1 的 `getLastSequenceNum()` 返回 0？** 因为 v1 的 WebSocket 不使用 SSE 序列号——断线重连时，服务端通过自己的消息游标（cursor）来决定从哪里重放。而 v2 的 SSE 使用 `Last-Event-ID` 头来告诉服务端"我收到了哪些消息"，所以需要跟踪序列号。

传输层切换发生在 Bridge 重连时——旧传输的序列号被传递给新传输，确保不丢消息：

```typescript
// 传输层切换时的序列号传递（概念代码）
const lastSeq = oldTransport.getLastSequenceNum()
const newTransport = await createV2ReplTransport({
  sessionUrl,
  ingressToken,
  sessionId,
  initialSequenceNum: lastSeq,  // 从旧传输的位置继续
})
```

### 崩溃恢复：Bridge Pointer

Bridge 进程可能因为各种原因崩溃——OOM、系统重启、用户误杀。崩溃后，用户希望能恢复之前的会话，而不是从头开始。

Claude Code 用一个 **Bridge Pointer** 文件实现崩溃恢复：

```
~/.claude/bridge-pointer.json
{
  "sessionId": "session_abc123",
  "environmentId": "env_xyz789",
  "source": "repl",
  "updatedAt": 1711900000000   // 定期刷新的时间戳
}
```

```typescript
// src/bridge/bridgePointer.ts
// 写入时机：会话创建成功后立即写入
// 刷新频率：定期更新 mtime（作为存活信号）
// TTL：4 小时（匹配服务端的 BRIDGE_LAST_POLL_TTL）
// 恢复：`claude --continue` 读取 pointer，通过 --session-id 恢复
```

**为什么用 4 小时 TTL？** 这与服务端的 `BRIDGE_LAST_POLL_TTL` 对齐。如果 Bridge 进程超过 4 小时没有心跳，服务端会认为它已死亡并回收资源。此时本地的 pointer 也应该失效，避免尝试恢复一个已被服务端清理的会话。

一个有趣的细节是 `readBridgePointerAcrossWorktrees()`——它会在多个 git worktree 中搜索最新的 pointer。这是因为在 worktree 模式下，每个会话可能在不同的 worktree 目录中运行，pointer 文件的位置也不同。

### Flush Gate：历史消息的有序投递

当 Bridge 连接建立时，需要将本地已有的对话历史同步到服务端（这样 claude.ai 上能看到之前的对话）。但同时，用户可能正在输入新消息。如果历史消息和新消息交错投递，服务端会收到乱序的消息流。

`FlushGate` 是一个简单的状态机，解决这个问题：

```
┌──────────┐    历史消息投递完成    ┌──────────┐
│  GATING  │ ──────────────────▶ │  OPEN    │
│          │                      │          │
│ 新消息入队 │                      │ 新消息直接发送│
└──────────┘                      └──────────┘
```

在 `GATING` 状态下，新消息被缓冲到队列中。历史消息全部投递完成后，切换到 `OPEN` 状态，队列中的消息被依次发送，后续新消息直接发送。

**为什么不简单地等历史消息发完再接受新消息？** 因为 Bridge 连接建立和历史消息投递是异步的，用户不应该被阻塞。FlushGate 让用户可以立即开始输入，同时保证消息的有序性。

### 权限代理：远程权限决策

Bridge 模式下有一个独特的权限问题：Claude 在本地执行工具时需要用户确认，但用户在 claude.ai 网页端。权限请求需要从本地转发到网页端，用户在网页端做出决策后，再转发回本地。

```
本地 Claude Code          Anthropic Cloud          claude.ai
     │                         │                       │
     │ ── control_request ───▶ │ ── 权限弹窗 ────────▶ │
     │    (can_use_tool)       │                       │
     │                         │                       │ 用户点击
     │                         │                       │ "允许"
     │ ◀── control_response ── │ ◀── 权限决策 ──────── │
     │    (behavior: 'allow')  │                       │
     │                         │                       │
     ▼ 执行工具                 │                       │
```

```typescript
// src/bridge/bridgePermissionCallbacks.ts
type PermissionResponseEvent = {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>  // { behavior: 'allow' | 'deny', ... }
  }
}
```

权限决策可以携带额外信息——比如 `updatedInput`（用户修改了工具输入）和 `updatedPermissions`（用户更新了权限规则）。这让网页端用户拥有与本地终端用户相同的权限控制能力。

---

## 16.4 CLI 传输层：可插拔的网络协议栈

### 面临的问题

Bridge 需要在本地 Claude Code 和云端之间建立可靠的双向通信。但"可靠"在网络世界中意味着要处理大量边界情况：

- 网络断开（WiFi 切换、VPN 重连、笔记本合盖休眠）
- 代理服务器超时回收空闲连接
- 服务端重启导致连接断开
- 消息丢失和乱序
- 背压（本地产生消息的速度超过网络发送速度）

Claude Code 的 `src/cli/transports/` 目录实现了一套可插拔的传输协议栈，提供了三种传输实现和两种事件上传器。

### 传输实现矩阵

```
┌─────────────────────────────────────────────────────────────────┐
│                    传输层选择逻辑                                 │
│                                                                  │
│  transportUtils.ts:                                              │
│                                                                  │
│  CLAUDE_CODE_USE_CCR_V2?                                         │
│  ├─ YES → SSETransport (读) + CCRClient (写)                    │
│  └─ NO                                                           │
│       CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2?                   │
│       ├─ YES → HybridTransport (WS 读 + HTTP POST 写)           │
│       └─ NO  → WebSocketTransport (WS 双向)                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**为什么需要三种传输？** 这是一个渐进演化的结果：

1. **WebSocketTransport**（最早）：经典的 WebSocket 双向通信。简单直接，但 WebSocket 在某些企业代理后面不稳定。
2. **HybridTransport**（过渡）：读用 WebSocket，写用 HTTP POST。HTTP POST 穿透代理更可靠，且支持批量发送。
3. **SSETransport + CCRClient**（最新，v2）：读用 SSE（Server-Sent Events），写用 HTTP POST。SSE 比 WebSocket 更简单，且天然支持 `Last-Event-ID` 断线续传。

### WebSocketTransport：重连与心跳

WebSocketTransport 是最基础的传输实现（`WebSocketTransport.ts`，约 28KB），但它处理的边界情况最多：

```
┌─────────────────────────────────────────────────────────────────┐
│              WebSocketTransport 状态机                            │
│                                                                  │
│  ┌──────────┐  connect()  ┌────────────┐  onopen   ┌─────────┐ │
│  │CONNECTING│ ──────────▶ │ WS handshake│ ────────▶ │CONNECTED│ │
│  └──────────┘             └────────────┘           └────┬────┘ │
│       ▲                                                  │      │
│       │                   ┌────────────┐  onerror/      │      │
│       │  指数退避重连      │RECONNECTING│  onclose       │      │
│       └───────────────── │            │ ◀──────────────┘      │
│                           └────────────┘                        │
│                                │                                │
│                    10 分钟重连预算耗尽                             │
│                                │                                │
│                                ▼                                │
│                          ┌──────────┐                           │
│                          │  CLOSED  │                           │
│                          └──────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

关键设计点：

- **指数退避重连**：1s → 2s → 4s → ... → 30s（上限），带随机抖动
- **10 分钟重连预算**：超过 10 分钟无法重连，放弃并关闭
- **Ping/Pong 心跳**：每 10 秒发送 ping，检测连接存活
- **Keep-alive 帧**：每 5 分钟发送空帧，防止代理回收空闲连接
- **系统休眠检测**：检测笔记本合盖/休眠，唤醒后立即重连
- **消息缓冲与重放**：断线期间的消息存入环形缓冲区，重连后重放
- **永久关闭码**：1002（协议错误）、4001（认证失败）、4003（会话过期）不重试

### SSETransport：断线续传

SSETransport（`SSETransport.ts`，约 24KB）利用 SSE 协议的天然优势实现更可靠的读取：

```typescript
// SSE 协议天然支持断线续传：
// 每个事件都有一个 id（序列号）
// 重连时发送 Last-Event-ID 头，服务端从该位置继续推送

// 关键配置：
// - 存活超时：45 秒（服务端每 15 秒发送 keepalive）
// - 去重集合：维护 1000 条目的去重集，检测重复帧
// - 重连退避：1s → 30s，带抖动
// - 永久 HTTP 码：401、403、404 不重试
```

**为什么 SSE 比 WebSocket 更适合读取？**

1. **天然的断线续传**：`Last-Event-ID` 是 SSE 协议的标准特性，不需要自己实现消息游标
2. **更好的代理兼容性**：SSE 是普通的 HTTP 长连接，几乎所有代理都支持
3. **更简单的错误处理**：HTTP 状态码直接告诉你是认证失败（401）还是资源不存在（404）

### CCRClient：v2 的写入与生命周期管理

CCRClient（`ccrClient.ts`，约 33KB）是 v2 架构中最复杂的组件，管理 Worker 的完整生命周期：

```
┌─────────────────────────────────────────────────────────────────┐
│                    CCRClient 职责                                │
│                                                                  │
│  1. Worker 注册: POST /worker/register                          │
│  2. 心跳: POST /worker/heartbeat (每 20s)                       │
│  3. 状态上报: PUT /worker (idle/working/requires_action)        │
│  4. 事件写入:                                                    │
│     ├─ 客户端事件: POST /worker/events (前端可见)                │
│     └─ 内部事件: POST /worker/internal-events (转录/压缩)       │
│  5. 投递确认: POST /worker/events/{id}/delivery                 │
│  6. 流事件合并: text_delta 累积为 full-so-far 快照               │
│  7. Epoch 管理: 409 冲突 = 更新的 worker 取代了我们               │
│  8. 认证失败处理: 连续 10 次 401/403 后退出                      │
│  9. Token 过期检测: 检查 JWT exp 声明                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**流事件合并（Stream Event Coalescing）** 是一个重要的优化：Claude 的流式响应会产生大量 `text_delta` 事件（每个 token 一个）。如果每个 delta 都单独发送，网络开销巨大。CCRClient 将连续的 `text_delta` 合并为"full-so-far"快照——不发送增量，而是发送到目前为止的完整文本。这样即使中间的某些事件丢失，接收端也能正确显示完整内容。

### SerialBatchEventUploader：有序批量上传

事件写入使用 `SerialBatchEventUploader`（约 9KB），它解决了一个微妙的并发问题：

```
┌─────────────────────────────────────────────────────────────────┐
│           SerialBatchEventUploader 工作模式                      │
│                                                                  │
│  enqueue(event1) ──┐                                             │
│  enqueue(event2) ──┤  批量累积                                   │
│  enqueue(event3) ──┘  (maxBatchSize / maxBatchBytes)             │
│                       │                                          │
│                       ▼                                          │
│                  ┌──────────┐                                    │
│                  │ POST 请求 │ ← 同一时刻最多 1 个在途请求        │
│                  └──────────┘                                    │
│                       │                                          │
│                  成功? │                                          │
│                  ├─ YES → 发送下一批                              │
│                  └─ NO  → 指数退避重试                            │
│                          (maxConsecutiveFailures 后丢弃)          │
│                                                                  │
│  背压: enqueue() 在队列满时阻塞                                   │
│  队列上限: maxQueueSize = 100,000                                │
└─────────────────────────────────────────────────────────────────┘
```

**为什么限制"同一时刻最多 1 个在途请求"？** 因为 HTTP POST 不保证有序到达。如果同时发送两个 POST，后发的可能先到，导致服务端收到乱序的事件流。串行化确保了事件的全局有序性。

**为什么有 `maxConsecutiveFailures` 丢弃机制？** 在极端网络故障下，如果无限重试，队列会无限增长直到 OOM。设置一个失败上限（比如 10 次），超过后丢弃当前批次，继续处理后续事件。这是一个"有损但不崩溃"的降级策略。

---

## 16.5 LSP 集成：让 CLI 也能拥有代码智能

### 面临的问题

IDE 之所以强大，很大程度上是因为 LSP（Language Server Protocol）提供的代码智能——类型检查、跳转定义、查找引用、自动补全。Claude Code 作为一个 CLI 工具，天然没有这些能力。

但 Claude 在编辑代码时，如果能获得 LSP 的反馈（比如"你刚才的修改引入了一个类型错误"），代码质量会大幅提升。问题是：

1. **LSP 是有状态的协议**：语言服务器需要知道哪些文件被打开了、文件内容是什么、项目配置在哪里。这与 Claude Code 的"无状态工具调用"模型不匹配。
2. **LSP 服务器种类繁多**：TypeScript 用 `tsserver`，Python 用 `pyright`，Rust 用 `rust-analyzer`……每种语言的服务器配置和行为都不同。
3. **启动开销大**：LSP 服务器需要索引整个项目，启动时间从几秒到几十秒不等。不能每次工具调用都重启。

Claude Code 的解法是内置一个完整的 LSP Client 层（`src/services/lsp/`），管理多个语言服务器的生命周期，并将诊断信息异步投递给 Claude。

### LSP 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    LSP 集成架构                                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              LSPServerManager (单例)                   │       │
│  │  ┌─────────────────┐  ┌─────────────────┐            │       │
│  │  │ LSPServerInstance│  │ LSPServerInstance│  ...       │       │
│  │  │ (TypeScript)     │  │ (Python)         │            │       │
│  │  │  ┌───────────┐  │  │  ┌───────────┐  │            │       │
│  │  │  │ LSPClient  │  │  │  │ LSPClient  │  │            │       │
│  │  │  │ (JSON-RPC) │  │  │  │ (JSON-RPC) │  │            │       │
│  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │            │       │
│  │  └────────┼────────┘  └────────┼────────┘            │       │
│  │           │ stdio              │ stdio                │       │
│  └───────────┼────────────────────┼──────────────────────┘       │
│              ▼                    ▼                               │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │   tsserver        │  │   pyright         │                     │
│  │   (子进程)        │  │   (子进程)        │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                  │
│  诊断信息流:                                                      │
│  Language Server ──publishDiagnostics──▶ passiveFeedback         │
│                                          ──▶ LSPDiagnosticRegistry│
│                                               ──▶ 异步附件投递    │
│                                                    ──▶ Claude    │
└─────────────────────────────────────────────────────────────────┘
```

### 三层架构：Client → Instance → Manager

**LSPClient**（`LSPClient.ts`）：最底层，负责 JSON-RPC 通信。

```typescript
// 通过 stdio 与 LSP 服务器通信
// 启动子进程 → 建立 JSON-RPC 连接 → 发送请求/接收响应
// 处理进程崩溃和错误
```

**LSPServerInstance**（`LSPServerInstance.ts`）：管理单个 LSP 服务器的生命周期。

```
┌─────────────────────────────────────────────────────────────────┐
│           LSPServerInstance 状态机                                │
│                                                                  │
│  ┌─────────┐  start()  ┌──────────┐  初始化完成  ┌─────────┐   │
│  │ stopped │ ────────▶ │ starting │ ──────────▶ │ running │   │
│  └─────────┘           └──────────┘             └────┬────┘   │
│       ▲                      │                        │         │
│       │                      │ 超时/错误               │ 崩溃    │
│       │                      ▼                        ▼         │
│       │                ┌──────────┐              ┌────────┐    │
│       └────────────── │  error   │              │ restart │    │
│         重试次数未超限  └──────────┘              └────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

关键设计：
- **懒启动**：服务器在第一次被请求时才启动，不在 Claude Code 启动时启动
- **自动重试**：对于 "content modified" 等瞬态错误，自动重试请求
- **可配置的重启上限**：崩溃后自动重启，但有最大重启次数限制
- **健康检查**：发送请求前检查服务器是否健康

**LSPServerManager**（`LSPServerManager.ts`）：管理多个 LSP 服务器实例。

```typescript
// 核心职责：
// 1. 根据文件扩展名路由请求到正确的 LSP 服务器
// 2. 懒启动：第一次使用时才启动对应的服务器
// 3. 文件生命周期同步：didOpen / didChange / didSave / didClose
// 4. 处理来自服务器的 workspace/configuration 请求
// 5. 优雅关闭所有服务器
```

**为什么用文件扩展名路由而不是 MIME 类型？** 因为 LSP 服务器的配置通常按文件扩展名定义（比如 `.ts` → TypeScript 服务器，`.py` → Python 服务器）。这是最简单、最可靠的路由策略。

### 诊断信息投递：LSPDiagnosticRegistry

LSP 服务器会主动推送诊断信息（错误、警告），但 Claude 不能被诊断信息淹没。`LSPDiagnosticRegistry` 负责去重和限流：

```
┌─────────────────────────────────────────────────────────────────┐
│           LSPDiagnosticRegistry 处理流程                          │
│                                                                  │
│  Language Server ── publishDiagnostics ──▶                       │
│                                                                  │
│  1. 批内去重：同一批次中的重复诊断只保留一个                       │
│  2. 跨轮次去重：LRU 缓存记录已投递的诊断，避免重复                │
│  3. 严重度排序：Error > Warning > Info > Hint                    │
│  4. 数量限制：                                                    │
│     ├─ 每个文件最多 10 条诊断                                    │
│     └─ 总计最多 30 条诊断                                        │
│  5. 异步投递：通过附件系统（attachment）投递给 Claude              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**为什么用异步附件而不是直接注入消息？** 因为诊断信息是"被动反馈"——它们在 Claude 编辑文件后由 LSP 服务器异步产生，不在 Claude 的请求-响应循环中。通过附件系统投递，可以在下一轮对话中自然地呈现给 Claude，而不打断当前的工具执行流程。

**为什么限制每个文件 10 条、总计 30 条？** 这是一个 token 预算的考量。每条诊断信息包含文件路径、行号、错误描述，大约消耗 50-100 tokens。30 条诊断就是 1500-3000 tokens，已经是一个不小的上下文开销。更多的诊断信息边际收益递减——Claude 通常只需要知道最严重的几个错误就能修复问题。

### 被动反馈机制：passiveFeedback

`passiveFeedback.ts` 将 LSP 的 `textDocument/publishDiagnostics` 通知转换为 Claude 可消费的格式：

```typescript
// src/services/lsp/passiveFeedback.ts
// 1. 注册 publishDiagnostics 通知处理器
// 2. 将 LSP 严重度转换为 Claude 格式
// 3. 处理 URI → 文件路径转换（file:// URIs）
// 4. 每个服务器独立的错误追踪（连续失败计数）
// 5. 单个服务器的处理器失败不影响其他服务器
```

**错误隔离** 是一个重要的设计原则：如果 TypeScript 服务器的诊断处理器崩溃了，Python 服务器的诊断仍然正常工作。每个服务器有独立的连续失败计数器，超过阈值后静默禁用该服务器的诊断，而不是让整个 LSP 系统崩溃。

### LSP 配置来源

LSP 服务器的配置来自插件系统：

```typescript
// src/services/lsp/config.ts
// 从已启用的插件中加载 LSP 服务器配置
// 并行处理多个插件
// 单个插件加载失败不影响其他插件
```

这意味着 LSP 支持是可扩展的——第三方插件可以注册自己的 LSP 服务器配置，为 Claude Code 添加新语言的代码智能支持。

### 全局单例与懒初始化

LSP 系统使用全局单例模式（`manager.ts`），并且完全懒初始化：

```typescript
// src/services/lsp/manager.ts
// 初始化状态：not-started → pending → success / failed
// 懒初始化：启动期间不初始化，第一次使用时才启动
// 代数计数器（generation counter）：插件刷新时使旧的初始化失效
// Bare 模式检测：脚本模式下跳过 LSP（无交互式编辑）
```

**为什么用代数计数器？** 当用户执行 `/reload-plugins` 时，LSP 配置可能变化。代数计数器确保旧的初始化结果被丢弃，新的配置被重新加载。如果没有这个机制，旧的 LSP 服务器实例会继续运行，使用过时的配置。

---

## 16.6 `claude remote-control`：独立 Bridge 服务器模式

### 面临的问题

前面讨论的 REPL Bridge（16.3 节）是"附着式"的——它附着在一个已有的 Claude Code REPL 会话上，将该会话的消息同步到 claude.ai。但还有一个更强大的使用场景：**用户不在本地终端前，只通过 claude.ai 网页端远程操控开发机**。

这需要一个独立运行的 Bridge 服务器——它不依赖 REPL，而是自己管理会话的完整生命周期：接收用户请求、派生 Claude Code 子进程、转发消息、管理多个并发会话。

这就是 `claude remote-control`（也接受 `claude rc`、`claude bridge` 等别名）命令的作用。

### 启动入口：Bootstrap 快速路径

`claude remote-control` 在 bootstrap 层（`entrypoints/cli.tsx`）有一条专用的快速路径：

```typescript
// src/entrypoints/cli.tsx
if (feature('BRIDGE_MODE') && (
  args[0] === 'remote-control' || args[0] === 'rc' ||
  args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge'
)) {
  // 1. 认证检查：必须有 claude.ai OAuth token
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    exitWithError(BRIDGE_LOGIN_ERROR)
  }
  // 2. GrowthBook 门控检查
  const disabledReason = await getBridgeDisabledReason()
  if (disabledReason) exitWithError(`Error: ${disabledReason}`)
  // 3. 版本下限检查
  const versionError = checkBridgeMinVersion()
  if (versionError) exitWithError(versionError)
  // 4. 组织策略检查
  if (!isPolicyAllowed('allow_remote_control')) {
    exitWithError("Error: Remote Control is disabled by your organization's policy.")
  }
  // 5. 启动 Bridge 主循环
  await bridgeMain(args.slice(1))
}
```

注意这是一条 **快速路径**——它不加载完整的 `main.tsx`（React/Ink/Tools/Commands），只动态导入 Bridge 需要的模块。这让 `claude remote-control` 的启动时间远低于完整 REPL。

### 多会话模式：SpawnMode

`bridgeMain` 支持三种会话派生模式（`SpawnMode`）：

```typescript
// src/bridge/types.ts
type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
```

```
┌─────────────────────────────────────────────────────────────────┐
│                    三种 SpawnMode 对比                            │
│                                                                  │
│  single-session:                                                 │
│  ┌──────────┐                                                    │
│  │ Bridge   │ ── spawn ──▶ 1 个 claude 子进程                   │
│  │          │              会话结束 → Bridge 退出                 │
│  └──────────┘                                                    │
│  适用：一次性任务，用完即走                                        │
│                                                                  │
│  worktree:                                                       │
│  ┌──────────┐              ┌─ claude (worktree-1/)               │
│  │ Bridge   │ ── spawn ──▶ ├─ claude (worktree-2/)               │
│  │ (持久)   │              └─ claude (worktree-3/)               │
│  └──────────┘              每个会话独立的 git worktree            │
│  适用：多人协作，互不干扰                                         │
│                                                                  │
│  same-dir:                                                       │
│  ┌──────────┐              ┌─ claude (cwd/)                      │
│  │ Bridge   │ ── spawn ──▶ ├─ claude (cwd/)                      │
│  │ (持久)   │              └─ claude (cwd/)                      │
│  └──────────┘              所有会话共享同一目录（可能冲突）         │
│  适用：快速原型，不在意隔离                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**worktree 模式的隔离机制**：每个新会话创建一个独立的 git worktree（`git worktree add`），会话结束后自动清理。这确保了多个并发会话不会互相踩踏文件。代价是每个 worktree 需要额外的磁盘空间（git 的 worktree 共享 `.git` 目录，所以开销主要是工作区文件的副本）。

### 会话生命周期管理

`sessionRunner.ts` 负责派生和管理子进程：

```
┌─────────────────────────────────────────────────────────────────┐
│              会话生命周期 (SessionHandle)                         │
│                                                                  │
│  spawn()                                                         │
│    │                                                             │
│    ├─ 创建子进程: claude --session-id <id> --sdk-url <url>       │
│    ├─ 注册 stdout 监听器（活动追踪）                              │
│    ├─ 注册 stderr 环形缓冲区（错误诊断）                          │
│    └─ 返回 SessionHandle                                         │
│                                                                  │
│  SessionHandle:                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ sessionId: string          会话 ID                    │       │
│  │ done: Promise<Status>      完成信号                    │       │
│  │ kill(): void               优雅终止                    │       │
│  │ forceKill(): void          强制终止                    │       │
│  │ activities: Activity[]     活动环形缓冲区（最近 ~10）  │       │
│  │ currentActivity: Activity  当前活动                    │       │
│  │ accessToken: string        会话令牌                    │       │
│  │ lastStderr: string[]       最近 stderr 行              │       │
│  │ writeStdin(data): void     向子进程写入                │       │
│  │ updateAccessToken(t): void 更新令牌                    │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                  │
│  活动追踪:                                                       │
│  子进程 stdout 中的工具调用被解析为活动摘要：                      │
│  "Editing src/foo.ts" / "Reading package.json" / "Running tests" │
│  这些摘要显示在 Bridge 的状态面板中                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Bridge UI：终端状态面板

`bridgeUI.ts` 和 `bridgeStatusUtil.ts` 实现了一个精致的终端状态面板：

```
┌─────────────────────────────────────────────────────────────────┐
│  ╭──────────────────────────────────────────────────────────╮   │
│  │  🔗 Remote Control                                       │   │
│  │  https://claude.ai/code?bridge=env_abc123                │   │
│  │                                                          │   │
│  │  ┌─────────┐                                             │   │
│  │  │ QR Code │  ← 手机扫码直接连接                         │   │
│  │  └─────────┘                                             │   │
│  │                                                          │   │
│  │  repo: my-project (main)                                 │   │
│  │  Sessions: 1 of 3 (worktree mode)                        │   │
│  │                                                          │   │
│  │  • session_abc: "Fix login bug" — Editing src/auth.ts    │   │
│  │  • session_def: "Add tests" — Running jest               │   │
│  ╰──────────────────────────────────────────────────────────╯   │
└─────────────────────────────────────────────────────────────────┘
```

状态面板包含：
- **连接 URL**：用户可以在浏览器中打开，或扫描 QR 码
- **仓库信息**：当前仓库名和分支
- **会话列表**：每个活跃会话的标题和当前活动
- **Shimmer 动画**：空闲时的呼吸灯效果，表示 Bridge 在等待连接
- **OSC 8 终端超链接**：支持的终端中，URL 可以直接点击

### 会话标题的智能推导

Bridge 会话在 claude.ai 上需要一个标题（显示在会话列表中）。标题推导有一个精心设计的优先级链：

```
优先级（从高到低）：
1. 用户显式命名: claude remote-control "Fix login bug"
2. /rename 命令: 用户在会话中执行 /rename
3. 第 1 条消息推导: deriveTitle(firstMessage) → 占位标题
4. 第 1 条消息 Haiku 生成: generateSessionTitle(firstMessage) → 异步升级
5. 第 3 条消息重新生成: generateSessionTitle(fullConversation) → 更准确
6. 随机 slug 兜底: "remote-control-graceful-unicorn"
```

**为什么在第 3 条消息时重新生成？** 第 1 条消息的标题可能不够准确（比如用户只说了"帮我看看这个"），到第 3 条消息时，对话的主题已经明确，生成的标题会更有意义。

**为什么用 Haiku 模型生成标题？** 标题生成是一个低优先级的装饰性任务，不值得用 Opus/Sonnet。Haiku 足够快（<1s）且足够好，不会阻塞主对话流程。

---

## 16.7 Chrome 集成：浏览器自动化

### 面临的问题

除了 IDE 集成，Claude Code 还有一个独特的集成方向——**浏览器**。用户可能需要 Claude 帮忙调试网页、填写表单、截取页面内容。这需要 Claude Code 能够与 Chrome 浏览器通信。

Claude Code 通过 Chrome Native Messaging 协议实现了这个集成（`src/utils/claudeInChrome/`）。

### 架构

```
┌──────────────┐     Native Messaging     ┌──────────────────┐
│ Chrome       │ ◀═══════════════════════▶ │ chromeNativeHost │
│ Extension    │     (stdin/stdout)        │ (子进程)          │
└──────────────┘                           └────────┬─────────┘
                                                    │ Socket/Pipe
                                                    ▼
                                           ┌──────────────────┐
                                           │ MCP Server        │
                                           │ (mcpServer.ts)    │
                                           └────────┬─────────┘
                                                    │ MCP Protocol
                                                    ▼
                                           ┌──────────────────┐
                                           │ Claude Code       │
                                           │ (MCP Client)      │
                                           └──────────────────┘
```

Chrome Extension 通过 Native Messaging 与一个本地的 Native Host 进程通信。Native Host 通过 Socket/Pipe 连接到一个 MCP Server，Claude Code 作为 MCP Client 连接到这个 Server。

**为什么不直接用 WebSocket 连接 Chrome Extension？** 因为 Chrome Extension 的安全模型限制了它只能通过 Native Messaging 与本地进程通信。Native Messaging 使用 stdin/stdout，消息格式是长度前缀的 JSON。这是 Chrome 的标准机制，不需要额外的网络端口。

`setupClaudeInChrome()` 负责安装 Native Host manifest 和配置 MCP Server。它支持多种 Chromium 浏览器：Chrome、Brave、Arc、Edge 等。

---

## 16.8 设计决策总结与 Trade-off 分析

### 决策 1：IDE 扩展作为 MCP Server

| 维度 | 选择 | 替代方案 | Trade-off |
|------|------|---------|-----------|
| 协议 | MCP | 自定义 IPC | 复用已有基础设施 vs 更灵活的定制 |
| 发现 | Lockfile | mDNS/Bonjour | 简单可靠 vs 自动发现无需文件系统 |
| 连接 | SSE/WS | Unix Socket | 跨平台兼容 vs 更低延迟 |

**结论**：MCP 复用是正确的选择。IDE 集成的需求（工具调用、通知、连接管理）与 MCP 完美匹配，避免了维护两套协议栈的成本。

### 决策 2：云端中继 vs NAT 穿透

| 维度 | 云端中继 | NAT 穿透（STUN/TURN） | P2P（WebRTC） |
|------|---------|---------------------|--------------|
| 可靠性 | 高（标准 HTTPS） | 中（依赖 NAT 类型） | 低（需要信令服务器） |
| 延迟 | 中（经过云端） | 低（直连） | 低（直连） |
| 隐私 | 消息经过云端 | 消息不经过第三方 | 消息不经过第三方 |
| 实现复杂度 | 低 | 高 | 很高 |

**结论**：云端中继是务实的选择。Claude Code 的消息本身就需要发送到 Anthropic API 进行推理，所以"消息经过云端"不是额外的隐私成本。而可靠性和实现简单性的优势是决定性的。

### 决策 3：v1/v2 共存 vs 一步到位

Claude Code 选择了渐进迁移——v1 和 v2 通过 GrowthBook feature flag 共存，而不是一次性切换到 v2。

**优势**：
- 灰度发布，风险可控
- v1 的多会话能力在 v2 中尚未实现，不能直接替换
- 出问题可以秒级回滚

**代价**：
- 代码复杂度翻倍（两套传输、两套初始化、两套配置）
- 测试矩阵膨胀
- 新功能需要在两条路径上都实现

这是一个典型的"短期复杂度换长期安全性"的 trade-off。

### 决策 4：LSP 内置 vs 依赖 IDE

| 维度 | 内置 LSP Client | 依赖 IDE 的 LSP |
|------|----------------|----------------|
| 独立性 | CLI 模式下也能工作 | 必须连接 IDE |
| 一致性 | 所有环境行为一致 | 依赖 IDE 的 LSP 配置 |
| 维护成本 | 需要自己管理 LSP 服务器生命周期 | IDE 已经管理好了 |
| 功能完整性 | 只支持诊断（被动反馈） | 完整的 LSP 功能 |

**结论**：内置 LSP Client 保证了 CLI 模式下的代码质量底线。但它只实现了 LSP 的一个子集（主要是诊断信息），完整的 LSP 功能（跳转定义、查找引用等）通过 IDE 集成获得。这是一个"80/20"的务实选择。

---

## 16.9 关键源码索引

| 模块 | 路径 | 职责 |
|------|------|------|
| IDE 检测与集成 | `src/utils/ide.ts` | IDE 发现、lockfile 协议、扩展安装 |
| IDE 集成 Hook | `src/hooks/useIDEIntegration.tsx` | 自动连接 IDE |
| IDE 选区同步 | `src/hooks/useIdeSelection.ts` | 跟踪 IDE 选区变化 |
| IDE 连接状态 | `src/hooks/useIdeConnectionStatus.ts` | 监控连接状态 |
| IDE Diff 展示 | `src/hooks/useDiffInIDE.ts` | 在 IDE 中打开 diff |
| IDE @提及 | `src/hooks/useIdeAtMentioned.ts` | 处理 @mention 通知 |
| Bridge 类型定义 | `src/bridge/types.ts` | 协议类型、接口定义 |
| Bridge 消息处理 | `src/bridge/bridgeMessaging.ts` | 消息路由、去重、过滤 |
| Bridge 传输抽象 | `src/bridge/replBridgeTransport.ts` | v1/v2 统一传输接口 |
| Bridge 启动（REPL） | `src/bridge/initReplBridge.ts` | REPL 模式 Bridge 初始化 |
| Bridge 启动（独立） | `src/bridge/bridgeMain.ts` | 独立 Bridge 服务器 |
| Bridge v2 核心 | `src/bridge/remoteBridgeCore.ts` | 环境无关的 v2 实现 |
| Bridge 门控 | `src/bridge/bridgeEnabled.ts` | 功能开关与准入检查 |
| Bridge 崩溃恢复 | `src/bridge/bridgePointer.ts` | 崩溃恢复指针 |
| Bridge 会话管理 | `src/bridge/createSession.ts` | 会话创建、归档、标题更新 |
| Bridge 子进程管理 | `src/bridge/sessionRunner.ts` | 子进程派生与活动追踪 |
| WebSocket 传输 | `src/cli/transports/WebSocketTransport.ts` | WS 双向通信 |
| SSE 传输 | `src/cli/transports/SSETransport.ts` | SSE 读取 |
| Hybrid 传输 | `src/cli/transports/HybridTransport.ts` | WS 读 + POST 写 |
| CCR v2 客户端 | `src/cli/transports/ccrClient.ts` | Worker 生命周期管理 |
| 批量上传器 | `src/cli/transports/SerialBatchEventUploader.ts` | 有序批量事件上传 |
| LSP Client | `src/services/lsp/LSPClient.ts` | JSON-RPC 通信 |
| LSP 服务器实例 | `src/services/lsp/LSPServerInstance.ts` | 单个 LSP 服务器生命周期 |
| LSP 服务器管理 | `src/services/lsp/LSPServerManager.ts` | 多 LSP 服务器路由 |
| LSP 诊断注册表 | `src/services/lsp/LSPDiagnosticRegistry.ts` | 诊断去重与限流 |
| LSP 被动反馈 | `src/services/lsp/passiveFeedback.ts` | 诊断通知处理 |
| Chrome 集成 | `src/utils/claudeInChrome/` | Chrome Native Messaging |
