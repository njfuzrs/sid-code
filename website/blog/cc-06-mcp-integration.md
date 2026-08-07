---
title: Claude Code 源码解析（六）· MCP 集成
description: 'Claude Code 不可能内置所有工具，如何通过标准化协议让外部服务（GitHub、数据库、Slack 等）无缝接入 LLM 工具链？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第六章：MCP 集成（Model Context Protocol）

> Claude Code 如何通过 MCP 协议将外部工具、资源和服务无缝接入 LLM 工具链？

## 核心问题

Claude Code 内置了 30+ 工具（BashTool、FileEditTool、GrepTool……），但这远远不够。用户的工作场景千差万别——有人需要查数据库，有人需要操作 Slack，有人需要调用内部 API。如果每个需求都要等 Anthropic 官方实现一个内置工具，扩展速度将成为瓶颈。

**核心矛盾：内置工具的能力有限性 vs 用户场景的无限多样性。**

这个问题有几种经典解法：

1. **插件系统**：让第三方编写 JavaScript/TypeScript 插件，直接加载到进程中。问题是安全性——第三方代码在同一进程中运行，可以访问所有内存和文件系统。
2. **Webhook/HTTP API**：让用户部署 HTTP 服务，Claude Code 通过 HTTP 调用。问题是没有标准协议——每个服务的接口格式不同，需要逐个适配。
3. **标准化协议 + 进程隔离**：定义一个标准的工具描述和调用协议，外部工具运行在独立进程中，通过标准协议通信。

Claude Code 选择了第三种——**MCP（Model Context Protocol）**。MCP 是 Anthropic 提出的开放协议，定义了 LLM 应用（Client）与外部工具服务（Server）之间的标准通信方式。Claude Code 作为 MCP Client，可以连接任意数量的 MCP Server，将它们暴露的工具无缝融入 LLM 的工具链。

但"接入一个协议"远比听起来复杂。Claude Code 面临的工程挑战包括：

1. **多传输层支持**：MCP Server 可能通过 stdio（本地子进程）、SSE、HTTP、WebSocket 甚至进程内通信连接，每种传输层的连接管理、错误处理、认证方式完全不同。
2. **连接生命周期管理**：Server 可能启动失败、中途断开、需要认证、被企业策略禁止——每种状态都需要处理。
3. **工具名称冲突**：多个 Server 可能暴露同名工具，需要命名空间隔离。
4. **安全与信任**：项目级 `.mcp.json` 可能被恶意仓库注入危险的 Server 配置，需要审批机制。
5. **性能**：MCP 连接不应阻塞启动，Server 指令不应破坏 prompt cache。
6. **企业管控**：企业客户需要控制哪些 MCP Server 可以使用，哪些必须禁止。

---

## 6.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code (MCP Client)                     │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  配置层       │  │  连接管理层   │  │  工具桥接层            │  │
│  │              │  │              │  │                       │  │
│  │ config.ts    │→│ client.ts    │→│ MCPTool.ts            │  │
│  │ (多源配置合并) │  │ (连接/重连)   │  │ (MCP→内置工具格式)    │  │
│  │              │  │              │  │                       │  │
│  │ .mcp.json    │  │ MCPConnection│  │ useMergedTools.ts     │  │
│  │ settings.json│  │ Manager.tsx  │  │ (合并内置+MCP工具)     │  │
│  │ enterprise   │  │              │  │                       │  │
│  │ claude.ai    │  │ useManageMCP │  │ normalization.ts      │  │
│  │ plugins      │  │ Connections  │  │ (名称规范化)           │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         │                  │                    │                 │
│         │                  │                    ▼                 │
│         │                  │          ┌──────────────────┐       │
│         │                  │          │  System Prompt    │       │
│         │                  │          │  注入层           │       │
│         │                  │          │                  │       │
│         │                  │          │ prompts.ts       │       │
│         │                  │          │ mcpInstructions  │       │
│         │                  │          │ Delta.ts         │       │
│         │                  │          └──────────────────┘       │
│         │                  │                    │                 │
│  ┌──────┴──────┐  ┌───────┴────────┐           │                 │
│  │ 安全层      │  │  认证层         │           │                 │
│  │             │  │               │           │                 │
│  │ mcpServer   │  │ auth.ts       │           │                 │
│  │ Approval    │  │ (OAuth/XAA)   │           │                 │
│  │ (项目审批)   │  │               │           │                 │
│  │             │  │ elicitation   │           │                 │
│  │ config.ts   │  │ Handler.ts    │           │                 │
│  │ (策略过滤)   │  │               │           │                 │
│  └─────────────┘  └───────────────┘           │                 │
└───────────────────────────────────────────────┼─────────────────┘
                                                │
                    ┌───────────────────────────┼──────────────┐
                    │          传输层            │              │
                    │                           ▼              │
                    │  ┌─────────┐ ┌─────┐ ┌──────┐ ┌─────┐  │
                    │  │ stdio   │ │ SSE │ │ HTTP │ │ WS  │  │
                    │  │(子进程)  │ │     │ │      │ │     │  │
                    │  └────┬────┘ └──┬──┘ └──┬───┘ └──┬──┘  │
                    │       │         │       │        │      │
                    │  ┌────┴────┐ ┌──┴──────┴────┐ ┌─┴───┐  │
                    │  │InProcess│ │ SDK Control  │ │IDE  │  │
                    │  │Transport│ │ Transport    │ │SSE/ │  │
                    │  │(进程内)  │ │ (SDK 控制)   │ │WS   │  │
                    │  └─────────┘ └─────────────┘ └─────┘  │
                    └──────────────────────────────────────────┘
                                        │
                                        ▼
                    ┌──────────────────────────────────────────┐
                    │           MCP Servers (外部)              │
                    │                                          │
                    │  [Slack]  [GitHub]  [DB]  [Chrome]  ...  │
                    └──────────────────────────────────────────┘
```

这个架构的关键洞察是**分层解耦**：配置层负责"连接哪些 Server"，连接管理层负责"如何连接和维护"，工具桥接层负责"如何让 LLM 使用"，安全层负责"是否允许"。每一层都可以独立演进，互不干扰。

---

## 6.2 配置与发现：连接哪些 Server？

### 面临的问题

MCP Server 的配置来源极其多样。一个用户可能同时有：
- 全局配置的 Server（`~/.claude.json` 中的 `mcpServers`）
- 项目级共享的 Server（`.mcp.json`，提交到 Git）
- 本地私有的 Server（`~/.claude.json` 中按项目路径隔离的配置）
- 企业强制的 Server（MDM 管理的 `managed-mcp.json`）
- claude.ai 同步的 Server（Web 端配置的 connector）
- 插件提供的 Server（DXT 插件自带的 MCP Server）
- 命令行动态传入的 Server（`--mcp-config`）

这些来源之间可能存在**冲突**（同名 Server）、**重复**（插件和手动配置指向同一个进程）、**安全风险**（恶意仓库注入的 `.mcp.json`）。

**核心问题：如何从多个来源合并出一份一致的、安全的 Server 配置？**

### 解法：分层合并 + 签名去重 + 策略过滤

配置解析的核心逻辑在 `services/mcp/config.ts` 中。整个流程可以概括为：

```
配置来源                    合并策略                     最终配置
─────────                  ────────                    ────────
enterprise (MDM)     ──┐
                       ├─→ addScopeToServers()  ──┐
user (全局)          ──┤   (标记来源 scope)        │
                       │                          │
local (项目私有)     ──┤                          ├─→ 策略过滤 ──→ 环境变量展开
                       │                          │   (allowlist/   (${VAR} 替换)
project (.mcp.json)  ──┤                          │    denylist)          │
                       │                          │                       ▼
plugins (插件)       ──┤── dedupPluginMcpServers() │                    最终配置
                       │   (签名去重)              │
claude.ai (Web)      ──┘── dedupClaudeAiMcpServers()
```

#### 配置 Scope 体系

每个 Server 配置都带有一个 `scope` 标记，表明它来自哪里：

```typescript
// services/mcp/types.ts
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',       // 本地私有配置（~/.claude.json 中按项目隔离）
    'user',        // 用户全局配置（~/.claude.json）
    'project',     // 项目共享配置（.mcp.json）
    'dynamic',     // 命令行动态传入 / 插件提供
    'enterprise',  // 企业 MDM 管理
    'claudeai',    // claude.ai Web 端同步
    'managed',     // 远程托管设置
  ]),
)
```

`scope` 的作用不仅是标记来源，还影响安全策略。比如 `project` scope 的 Server 需要经过用户审批（因为 `.mcp.json` 可能被恶意仓库注入），而 `user` scope 的 Server 不需要（用户自己配置的）。

#### 签名去重：解决"同一个 Server 被配置了两次"

一个常见场景：用户手动在 `settings.json` 中配置了 Slack MCP Server，同时安装了一个 Slack 插件，插件也自带了同一个 Slack MCP Server。如果两个都连接，LLM 会看到两套完全相同的工具，浪费 token 且造成混淆。

解法是**基于签名的去重**：

```typescript
// services/mcp/config.ts
export function getMcpServerSignature(config: McpServerConfig): string | null {
  const cmd = getServerCommandArray(config)
  if (cmd) {
    return `stdio:${jsonStringify(cmd)}`  // stdio: 按命令+参数去重
  }
  const url = getServerUrl(config)
  if (url) {
    return `url:${unwrapCcrProxyUrl(url)}`  // remote: 按 URL 去重
  }
  return null  // sdk 类型无法去重
}
```

签名的设计很巧妙：
- **stdio Server**：用 `command + args` 数组的 JSON 序列化作为签名。两个配置如果启动的是同一个命令，就是同一个 Server。
- **远程 Server**：用 URL 作为签名。`unwrapCcrProxyUrl()` 还会处理 CCR 代理 URL——当 claude.ai connector 通过代理转发时，提取原始 vendor URL 进行比较。
- **SDK Server**：无法去重（没有命令也没有 URL），直接保留。

去重的优先级是：**手动配置 > 插件 > claude.ai connector**。这反映了一个设计原则——用户的显式意图优先级最高。

```typescript
// 插件去重：手动配置的 Server 优先
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): { servers, suppressed } {
  // 先建立手动配置的签名索引
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }
  // 插件 Server 如果签名匹配手动配置，则被抑制
  for (const [name, config] of Object.entries(pluginServers)) {
    const sig = getMcpServerSignature(config)
    const manualDup = manualSigs.get(sig)
    if (manualDup !== undefined) {
      suppressed.push({ name, duplicateOf: manualDup })
      continue  // 跳过，不加入最终配置
    }
    // ...
  }
}
```

#### 环境变量展开

MCP Server 配置中的字符串值支持 `${VAR}` 和 `${VAR:-default}` 语法：

```typescript
// services/mcp/envExpansion.ts
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = process.env[varName]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(varName)
    return match  // 保留原始文本，便于调试
  })
  return { expanded, missingVars }
}
```

展开发生在**策略过滤之后**——这是一个安全考量。如果先展开再过滤，恶意配置可以通过环境变量绕过 URL 白名单（比如 `url: "${EVIL_URL}"`，展开后变成一个不在白名单中的 URL，但过滤时还是原始模板）。

### 设计决策讨论

**为什么 `.mcp.json` 需要审批而 `settings.json` 不需要？**

`.mcp.json` 是项目级文件，会被提交到 Git。这意味着当你 `git clone` 一个仓库时，仓库作者可以在 `.mcp.json` 中配置任意 MCP Server。如果自动连接，恶意仓库可以让你的 Claude Code 连接到攻击者控制的 Server，进而通过 MCP 工具执行任意命令。

审批逻辑在 `utils.ts` 的 `getProjectMcpServerStatus()` 中：

```typescript
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getSettings_DEPRECATED()
  // 已明确拒绝
  if (settings?.disabledMcpjsonServers?.some(...)) return 'rejected'
  // 已明确批准 或 全局批准所有项目 Server
  if (settings?.enabledMcpjsonServers?.some(...) ||
      settings?.enableAllProjectMcpServers) return 'approved'
  // bypass 模式下自动批准（用户已接受风险）
  if (hasSkipDangerousModePermissionPrompt() &&
      isSettingSourceEnabled('projectSettings')) return 'approved'
  // 非交互模式下自动批准（SDK/-p 模式）
  if (getIsNonInteractiveSession() &&
      isSettingSourceEnabled('projectSettings')) return 'approved'
  return 'pending'  // 需要用户审批
}
```

审批 UI 在 `services/mcpServerApproval.tsx` 中，通过 Ink 渲染一个对话框，让用户逐个或批量审批 pending 状态的 Server。

**为什么企业 MCP 配置存在时禁止用户添加 Server？**

```typescript
if (doesEnterpriseMcpConfigExist()) {
  throw new Error(
    `Cannot add MCP server: enterprise MCP configuration is active
     and has exclusive control over MCP servers`,
  )
}
```

这是企业安全策略的体现。当 IT 部门通过 MDM 部署了 `managed-mcp.json`，意味着他们想要**完全控制**哪些 MCP Server 可以使用。允许用户自行添加会绕过这个控制。

---

## 6.3 连接管理：多传输层 + 生命周期状态机

### 面临的问题

MCP Server 可以通过多种方式运行：
- **stdio**：作为本地子进程，通过 stdin/stdout 通信（最常见）
- **SSE**：通过 Server-Sent Events 长连接
- **HTTP**：通过 Streamable HTTP（MCP 2025-03-26 规范）
- **WebSocket**：通过 WebSocket 双向通信
- **进程内**：直接在 Claude Code 进程中运行（特殊优化）
- **IDE 专用**：通过 SSE/WebSocket 连接 IDE 扩展
- **SDK 控制**：通过 Agent SDK 的控制通道
- **claude.ai 代理**：通过 Anthropic 的代理服务转发

每种传输层的连接建立、错误处理、认证方式、重连策略都不同。同时，一个 Server 在其生命周期中会经历多种状态——连接中、已连接、认证失败、连接失败、已禁用。

**核心问题：如何用统一的抽象管理这些差异巨大的连接？**

### 解法：状态机 + 传输层工厂 + React Hook 驱动的生命周期

#### 连接状态机

每个 MCP Server 连接都是一个有限状态机，定义在 `services/mcp/types.ts` 中：

```
                    ┌──────────┐
                    │ pending  │ ←── 初始状态 / 重连中
                    └────┬─────┘
                         │ connectToServer()
                    ┌────▼─────┐
               ┌────┤connecting├────┐
               │    └──────────┘    │
               │                    │
          成功 │              失败  │
               │                    │
          ┌────▼─────┐    ┌────────▼────────┐
          │connected │    │   failed        │
          └────┬─────┘    └────────┬────────┘
               │                   │
          断开 │              重连? │
               │                   │
               │    ┌──────────┐   │
               └───►│ pending  │◄──┘ (远程传输自动重连)
                    └──────────┘

          ┌──────────┐         ┌──────────┐
          │needs-auth│         │ disabled │
          └──────────┘         └──────────┘
          (OAuth 认证失败)      (用户手动禁用)
```

这五种状态用 TypeScript 的联合类型精确建模：

```typescript
// services/mcp/types.ts
export type MCPServerConnection =
  | ConnectedMCPServer    // 已连接：持有 Client 实例、capabilities、instructions
  | FailedMCPServer       // 连接失败：持有错误信息
  | NeedsAuthMCPServer    // 需要认证：等待用户完成 OAuth 流程
  | PendingMCPServer      // 连接中/重连中：持有重连进度
  | DisabledMCPServer     // 已禁用：用户主动关闭
```

每种状态携带的数据不同——`ConnectedMCPServer` 持有 `Client` 实例和 `capabilities`，`PendingMCPServer` 持有 `reconnectAttempt` 进度，`FailedMCPServer` 持有 `error` 信息。这种设计让类型系统强制调用者处理每种状态，避免在未连接的 Server 上调用工具。

#### 传输层工厂：connectToServer()

`client.ts` 中的 `connectToServer()` 是一个 memoized 的异步工厂函数，根据 Server 配置的 `type` 字段选择对应的传输层：

```typescript
// services/mcp/client.ts（简化）
export const connectToServer = memoize(
  async (name: string, serverRef: ScopedMcpServerConfig): Promise<MCPServerConnection> => {
    let transport

    if (serverRef.type === 'sse') {
      // SSE: 创建 AuthProvider + SSEClientTransport
      const authProvider = new ClaudeAuthProvider(name, serverRef)
      transport = new SSEClientTransport(new URL(serverRef.url), {
        authProvider,
        fetch: wrapFetchWithTimeout(
          wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider)
        ),
        // ...
      })
    } else if (serverRef.type === 'http') {
      // HTTP Streamable: StreamableHTTPClientTransport
      transport = new StreamableHTTPClientTransport(new URL(serverRef.url), { ... })
    } else if (serverRef.type === 'ws') {
      // WebSocket: 自定义 WebSocketTransport
      const wsClient = new WebSocket(serverRef.url, { protocols: ['mcp'], ... })
      transport = new WebSocketTransport(wsClient)
    } else if (isClaudeInChromeMCPServer(name)) {
      // 进程内: InProcessTransport（避免 spawn 325MB 子进程）
      const [clientTransport, serverTransport] = createLinkedTransportPair()
      inProcessServer = createClaudeForChromeMcpServer(context)
      await inProcessServer.connect(serverTransport)
      transport = clientTransport
    } else if (serverRef.type === 'stdio' || !serverRef.type) {
      // stdio: StdioClientTransport（最常见）
      transport = new StdioClientTransport({
        command: serverRef.command,
        args: serverRef.args,
        env: { ...subprocessEnv(), ...serverRef.env },
        stderr: 'pipe',  // 防止 Server 的 stderr 污染 UI
      })
    }

    // 创建 MCP Client 并连接
    const client = new Client(
      { name: 'claude-code', version: MACRO.VERSION },
      { capabilities: { roots: {}, elicitation: {} } },
    )

    // 带超时的连接
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject('timeout'), 30000)),
    ])

    return { name, type: 'connected', client, capabilities, instructions, ... }
  },
  getServerCacheKey,  // memoize key: name + JSON(config)
)
```

几个值得注意的设计细节：

**1. 进程内传输（InProcessTransport）**

Chrome MCP Server 和 Computer Use MCP Server 使用了一种特殊的优化——不 spawn 子进程，而是在 Claude Code 进程内直接运行 Server：

```typescript
// services/mcp/InProcessTransport.ts
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined

  async send(message: JSONRPCMessage): Promise<void> {
    // 通过 queueMicrotask 异步投递，避免同步请求/响应导致栈溢出
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }
}

export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]  // [clientTransport, serverTransport]
}
```

为什么要这样做？源码注释说得很清楚：

```typescript
// Run the Chrome MCP server in-process to avoid spawning a ~325 MB subprocess
```

Chrome MCP Server 如果作为独立进程运行，需要加载完整的 Node.js 运行时（~325MB）。通过进程内传输，Server 直接复用 Claude Code 的运行时，节省了巨大的内存开销和启动时间。

`queueMicrotask` 的使用也很精妙——如果 `send()` 同步调用 `peer.onmessage()`，在请求/响应模式下会导致调用栈无限增长（A.send → B.onmessage → B.send → A.onmessage → ...）。异步投递打断了这个同步链。

**2. fetch 包装链**

远程传输（SSE/HTTP）的 fetch 函数经过了多层包装：

```
原始 fetch
  └─→ createFetchWithInit()          // MCP SDK: 合并默认 RequestInit
      └─→ wrapFetchWithStepUpDetection()  // 检测 OAuth step-up 403
          └─→ wrapFetchWithTimeout()       // 每个请求独立 60s 超时
```

`wrapFetchWithTimeout()` 的实现特别值得关注：

```typescript
// services/mcp/client.ts
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    // GET 请求不设超时——MCP 中 GET 是长连接 SSE 流
    if (method === 'GET') return baseFetch(url, init)

    // 用 setTimeout 而非 AbortSignal.timeout()
    // 因为 Bun 中 AbortSignal.timeout 的内部 timer 只在 GC 时释放，
    // 每个请求会泄漏 ~2.4KB 原生内存，持续 60s
    const controller = new AbortController()
    const timer = setTimeout(
      c => c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      60000, controller,
    )
    timer.unref?.()  // 不阻止进程退出
    // ...
  }
}
```

这里有两个关键决策：
- **GET 请求不设超时**：因为 MCP SSE 传输中，GET 是长连接的事件流，设 60s 超时会杀死它。
- **用 setTimeout 替代 AbortSignal.timeout()**：这是一个 Bun 运行时的内存泄漏规避。注释详细解释了原因。

**3. 批量连接与并发控制**

```typescript
// services/mcp/client.ts
export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}

function getRemoteMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 20
}
```

本地 stdio Server 的并发连接数默认为 3（因为每个都要 spawn 子进程，过多会导致系统资源紧张），远程 Server 默认为 20（只是网络连接，开销小得多）。

#### React Hook 驱动的生命周期管理

连接管理的核心是 `useManageMCPConnections` Hook（`services/mcp/useManageMCPConnections.ts`）。这个 Hook 是整个 MCP 子系统的"大脑"——它监听配置变化、驱动连接建立、处理断开重连、同步状态到 AppState。

```typescript
// services/mcp/useManageMCPConnections.ts（简化）
export function useManageMCPConnections(
  dynamicMcpConfig, isStrictMcpConfig
) {
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  // 批量状态更新：16ms 窗口内的多个 Server 更新合并为一次 setAppState
  const MCP_BATCH_FLUSH_MS = 16
  const pendingUpdatesRef = useRef<PendingUpdate[]>([])

  const updateServer = useCallback((update) => {
    pendingUpdatesRef.current.push(update)
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(flushPendingUpdates, MCP_BATCH_FLUSH_MS)
    }
  }, [])

  // 连接成功后的回调
  const onConnectionAttempt = useCallback(({ client, tools, commands, resources }) => {
    updateServer({ ...client, tools, commands, resources })

    if (client.type === 'connected') {
      // 注册 elicitation handler
      registerElicitationHandler(client.client, client.name, setAppState)

      // 设置断开重连
      client.client.onclose = () => {
        if (configType !== 'stdio' && configType !== 'sdk') {
          // 远程传输：指数退避重连（1s → 2s → 4s → 8s → 16s，最多 5 次）
          void reconnectWithBackoff()
        } else {
          // stdio/sdk：标记为 failed（本地进程崩溃无法自动恢复）
          updateServer({ ...client, type: 'failed' })
        }
      }
    }
  }, [])

  // ...
}
```

**批量状态更新**是一个重要的性能优化。当用户配置了 10 个 MCP Server 时，它们的连接回调可能在短时间内密集到达。如果每个回调都触发一次 `setAppState`，会导致 10 次 React 重渲染。通过 16ms 的批量窗口，这些更新被合并为 1-2 次。

**重连策略的差异化**也值得注意：
- **stdio Server**（本地子进程）：不自动重连。子进程崩溃通常意味着配置错误或 Server 本身有 bug，自动重连只会反复失败。
- **远程 Server**（SSE/HTTP/WS）：指数退避自动重连。网络断开是暂时性的，自动重连是合理的。退避参数：初始 1s，最大 30s，最多 5 次。

### 设计决策讨论

**为什么 `connectToServer` 用 memoize？**

```typescript
export const connectToServer = memoize(
  async (name, serverRef) => { ... },
  getServerCacheKey,  // key = name + JSON(config)
)
```

memoize 确保对同一个 Server 配置不会发起重复连接。当多个组件同时请求连接同一个 Server 时（比如 REPL 初始化和 MCP 命令面板同时触发），它们会共享同一个连接 Promise。

但源码中有一条有趣的 TODO 注释：

```typescript
// TODO (ollie): The memoization here increases complexity by a lot,
// and im not sure it really improves performance
```

这暗示 memoize 带来的缓存失效复杂性（重连时需要手动清除缓存、配置变更时需要比较 key）可能不值得它带来的去重收益。这是一个典型的"过早优化 vs 简单性"的 trade-off。

**为什么连接管理用 React Hook 而不是普通的 Service 类？**

Claude Code 的 UI 是 React + Ink 驱动的。MCP 连接状态需要实时反映在 UI 上（状态栏显示连接数、`/mcp` 命令显示各 Server 状态）。用 React Hook 管理连接，状态变更自然触发 UI 重渲染，不需要额外的事件订阅机制。

但这也带来了一个约束：连接管理逻辑必须在 React 组件树内运行。`MCPConnectionManager` 组件就是为此存在的——它是一个纯逻辑组件（Provider），不渲染任何 UI，只提供连接管理的 Context：

```typescript
// services/mcp/MCPConnectionManager.tsx
export function MCPConnectionManager({ children, dynamicMcpConfig, isStrictMcpConfig }) {
  const { reconnectMcpServer, toggleMcpServer } = useManageMCPConnections(
    dynamicMcpConfig, isStrictMcpConfig,
  )
  return (
    <MCPConnectionContext.Provider value={{ reconnectMcpServer, toggleMcpServer }}>
      {children}
    </MCPConnectionContext.Provider>
  )
}
```

---

## 6.4 工具桥接：从 MCP Tool 到 LLM 可用的内置工具

### 面临的问题

MCP Server 通过 `tools/list` 方法暴露工具，返回的是 MCP 协议格式的工具描述（名称、描述、JSON Schema）。但 Claude Code 的内置工具系统有自己的 `Tool` 接口——包含权限检查、进度上报、UI 渲染、并发安全标记等 MCP 协议中不存在的概念。

**核心问题：如何把 MCP 工具"翻译"成 Claude Code 内置工具格式，同时保留 MCP 的灵活性？**

### 解法：MCPTool 模板 + 运行时属性覆盖

Claude Code 的做法非常巧妙——定义一个 `MCPTool` **模板对象**，然后在运行时为每个 MCP 工具创建一个副本，覆盖其中的关键属性。

#### MCPTool 模板

```typescript
// tools/MCPTool/MCPTool.ts
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // 占位，运行时覆盖
  async description() { return '' }, // 占位，运行时覆盖
  async prompt() { return '' },      // 占位，运行时覆盖
  async call() { return { data: '' } }, // 占位，运行时覆盖
  inputSchema: z.object({}).passthrough(), // 接受任意输入
  maxResultSizeChars: 100_000,
  async checkPermissions() {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  // ...
})
```

注意 `inputSchema` 用了 `z.object({}).passthrough()`——这意味着**接受任意 JSON 对象**。因为 MCP 工具的输入 schema 由 Server 定义，Claude Code 不做校验，直接透传给 Server。

#### 运行时工具实例化

真正的魔法发生在 `client.ts` 的 `fetchToolsForClient()` 中。它从 MCP Server 获取工具列表后，为每个工具创建一个 `MCPTool` 的"变体"：

```typescript
// services/mcp/client.ts — fetchToolsForClient()（简化）
export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    const result = await client.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )

    return result.tools.map((tool): Tool => {
      const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
      return {
        ...MCPTool,                          // 继承模板的所有属性
        name: fullyQualifiedName,            // 覆盖：mcp__serverName__toolName
        mcpInfo: { serverName: client.name, toolName: tool.name },
        isMcp: true,
        async description() { return tool.description ?? '' },
        async prompt() {
          const desc = tool.description ?? ''
          return desc.length > 2048
            ? desc.slice(0, 2048) + '… [truncated]'
            : desc
        },
        inputJSONSchema: tool.inputSchema,   // 使用 Server 定义的 schema
        isConcurrencySafe() {
          return tool.annotations?.readOnlyHint ?? false
        },
        isReadOnly() {
          return tool.annotations?.readOnlyHint ?? false
        },
        isDestructive() {
          return tool.annotations?.destructiveHint ?? false
        },
        async call(args, context, _canUseTool, parentMessage, onProgress) {
          // 实际调用 MCP Server 的 tools/call
          const connectedClient = await ensureConnectedClient(client)
          const mcpResult = await callMCPToolWithUrlElicitationRetry({
            client: connectedClient,
            tool: tool.name,
            args,
            signal: context.abortController.signal,
            // ...
          })
          return { data: mcpResult.content }
        },
      }
    })
  },
  { maxSize: 20 },  // LRU 缓存，最多 20 个 Server
)
```

这里有几个关键设计点值得展开。

#### 命名空间：`mcp__serverName__toolName`

MCP 工具的命名遵循 `mcp__<normalizedServerName>__<normalizedToolName>` 的格式。这个命名规范解决了两个问题：

1. **多 Server 同名工具冲突**：两个 Server 都可能暴露名为 `search` 的工具，命名空间隔离后变成 `mcp__github__search` 和 `mcp__slack__search`。
2. **与内置工具区分**：所有 MCP 工具都以 `mcp__` 前缀开头，权限系统可以据此区分内置工具和外部工具。

名称规范化逻辑在 `normalization.ts` 中：

```typescript
// services/mcp/normalization.ts
export function normalizeNameForMCP(name: string): string {
  // 将所有非法字符替换为下划线（API 要求 ^[a-zA-Z0-9_-]{1,64}$）
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  // claude.ai Server 额外处理：合并连续下划线、去除首尾下划线
  // 防止与 __ 分隔符冲突
  if (name.startsWith('claude.ai ')) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
```

`mcpStringUtils.ts` 提供了反向解析：

```typescript
// services/mcp/mcpStringUtils.ts
export function mcpInfoFromString(toolString: string): {
  serverName: string; toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) return null
  // 工具名中的 __ 被保留（join 回去）
  const toolName = toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}
```

源码注释坦诚地指出了一个已知限制：如果 Server 名称本身包含 `__`，解析会出错。但实际中 Server 名称很少包含双下划线，这是一个可接受的 trade-off。

#### MCP Tool Annotations 的映射

MCP 2025-03-26 规范引入了 Tool Annotations——Server 可以声明工具的行为特征。Claude Code 将这些 annotation 映射到内置工具系统的对应概念：

| MCP Annotation | Claude Code 属性 | 作用 |
|---|---|---|
| `readOnlyHint: true` | `isConcurrencySafe()` / `isReadOnly()` | 标记为只读，可并发执行 |
| `destructiveHint: true` | `isDestructive()` | 标记为破坏性，权限系统更严格 |
| `openWorldHint: true` | `isOpenWorld()` | 标记为开放世界操作 |

这个映射让 Claude Code 的权限系统和并发调度器能够理解 MCP 工具的行为特征，而不需要 Server 了解 Claude Code 的内部概念。

#### 工具描述截断

```typescript
const MAX_MCP_DESCRIPTION_LENGTH = 2048

async prompt() {
  const desc = tool.description ?? ''
  return desc.length > MAX_MCP_DESCRIPTION_LENGTH
    ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
    : desc
}
```

源码注释解释了为什么需要截断：

```
OpenAPI-generated MCP servers have been observed dumping 15-60KB of endpoint
docs into tool.description; this caps the p95 tail without losing the intent.
```

一些 MCP Server（特别是从 OpenAPI 自动生成的）会把完整的 API 文档塞进工具描述，导致 system prompt 膨胀。2048 字符的上限是一个经验值——足以描述工具的用途和参数，但不会浪费 token。

#### 工具合并：useMergedTools

MCP 工具最终需要和内置工具合并，形成 LLM 可用的完整工具列表。这个合并在 `hooks/useMergedTools.ts` 中完成：

```typescript
// hooks/useMergedTools.ts
export function useMergedTools(
  initialTools: Tools,    // 启动时的初始工具（内置 + 早期 MCP）
  mcpTools: Tools,        // 动态发现的 MCP 工具
  toolPermissionContext: ToolPermissionContext,
): Tools {
  return useMemo(() => {
    // assembleToolPool: 内置工具 + MCP deny-rule 过滤 + 去重
    const assembled = assembleToolPool(toolPermissionContext, mcpTools)
    // mergeAndFilterTools: 合并 initialTools 和 assembled，去重
    return mergeAndFilterTools(initialTools, assembled, toolPermissionContext.mode)
  }, [initialTools, mcpTools, toolPermissionContext])
}
```

合并过程中有一个重要的过滤——**IDE 工具白名单**：

```typescript
// services/mcp/client.ts
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
function isIncludedMcpTool(tool: Tool): boolean {
  return !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
}
```

IDE MCP Server 可能暴露大量工具，但 Claude Code 只使用其中两个。这避免了 LLM 被不相关的 IDE 工具分散注意力。

#### UI 折叠分类

MCP 工具的 UI 渲染有一个精巧的优化——`classifyForCollapse.ts` 维护了一个**巨大的白名单**（数百个工具名），将常见 MCP Server 的工具分类为 "search" 或 "read"：

```typescript
// tools/MCPTool/classifyForCollapse.ts
const SEARCH_TOOLS = new Set([
  'slack_search_public', 'search_code', 'search_repositories',
  'search_issues', 'brave_web_search', // ... 数百个
])
const READ_TOOLS = new Set([
  'slack_read_channel', 'get_file_contents', 'git_status',
  'git_diff', 'list_tables', // ... 数百个
])
```

被分类为 search/read 的工具在 UI 中会被折叠显示（类似内置的 GrepTool、FileReadTool），减少终端输出的噪音。未知工具名不折叠（保守策略）。

这个白名单覆盖了 Slack、GitHub、Linear、Datadog、Sentry、Notion、Gmail、Google Drive、Jira、Confluence、Asana、Grafana、PagerDuty、Stripe 等数十个主流 MCP Server。维护成本不低，但用户体验收益显著。

### 设计决策讨论

**为什么用"模板 + 覆盖"而不是"工厂函数"？**

`{ ...MCPTool, name: ..., call: ... }` 这种 spread 覆盖模式比工厂函数更简单——不需要定义新的类或构造函数，直接利用 JavaScript 的对象展开语义。MCPTool 模板提供了所有 MCP 工具共享的默认行为（UI 渲染、权限检查、结果截断判定），每个实例只需覆盖差异化的部分。

**为什么 `inputSchema` 用 passthrough 而不是用 Server 返回的 JSON Schema？**

MCP 工具的 `inputJSONSchema` 确实被设置到了工具实例上（用于 LLM 生成正确的参数），但 Zod 层面的 `inputSchema` 用了 `passthrough`。这是因为 MCP Server 返回的 JSON Schema 可能包含 Zod 不支持的特性（如 `$ref`、`oneOf` 等），强行转换可能导致合法输入被拒绝。Claude Code 选择信任 LLM 的输出和 Server 的校验，不在中间层做额外校验。

---

## 6.5 System Prompt 注入：MCP 指令如何进入 LLM 上下文

### 面临的问题

MCP Server 在连接握手时可以返回 `instructions`——一段自然语言文本，告诉 LLM 如何使用该 Server 的工具和资源。比如 Slack MCP Server 可能返回："使用 slack_send_message 时，请先用 slack_search_channels 确认频道存在"。

这些指令需要注入到 LLM 上下文中，让模型在每次对话时都能看到。但这带来了一个性能问题：

**MCP Server 的连接是异步的、延迟的。** 用户开始对话时，某些 Server 可能还没连接完成。如果 Server 在第 3 轮对话时才连接成功，它的 instructions 需要在第 4 轮才出现。这意味着 **system prompt 在对话过程中会发生变化**。

而 Claude API 有一个重要的性能特性——**prompt caching**。如果 system prompt 的前缀不变，API 可以复用之前的 KV cache，大幅降低延迟和成本。但如果 MCP 指令导致 system prompt 每轮都变，prompt cache 就会被频繁击穿。

**核心矛盾：MCP 指令的动态性 vs prompt cache 的稳定性需求。**

### 解法：两种策略 + 运行时切换

Claude Code 实现了两种 MCP 指令注入策略，通过 feature flag 切换：

#### 策略一：System Prompt 内联（传统方式）

```typescript
// constants/prompts.ts
DANGEROUS_uncachedSystemPromptSection(
  'mcp_instructions',
  () => isMcpInstructionsDeltaEnabled()
    ? null  // delta 模式启用时跳过
    : getMcpInstructionsSection(mcpClients),
  'MCP servers connect/disconnect between turns',
),
```

`DANGEROUS_uncachedSystemPromptSection` 这个名字本身就是一个警告——它标记这个 section 是**不可缓存的**，每轮都会重新计算。当 MCP Server 连接/断开时，这个 section 的内容会变化，导致 prompt cache 失效。

指令的渲染格式：

```typescript
// constants/prompts.ts
function getMcpInstructions(mcpClients: MCPServerConnection[]): string | null {
  const clientsWithInstructions = mcpClients
    .filter(c => c.type === 'connected' && c.instructions)
  if (clientsWithInstructions.length === 0) return null

  const instructionBlocks = clientsWithInstructions
    .map(client => `## ${client.name}\n${client.instructions}`)
    .join('\n\n')

  return `# MCP Server Instructions\n\n` +
    `The following MCP servers have provided instructions...\n\n` +
    instructionBlocks
}
```

这种方式简单直接，但有明显的性能代价：每当一个新 Server 连接成功，下一轮对话的 system prompt 就会变化，prompt cache 被击穿。

#### 策略二：Delta Attachment（增量通知）

这是更优的方案，通过 `utils/mcpInstructionsDelta.ts` 实现：

```typescript
// utils/mcpInstructionsDelta.ts
export function isMcpInstructionsDeltaEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return false
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_basalt_3kr', false)
  )
}
```

Delta 模式的核心思想是：**不在 system prompt 中放 MCP 指令，而是在对话消息流中插入"增量通知"**。当一个新 Server 连接成功时，它的 instructions 作为一条 `mcp_instructions_delta` attachment 消息插入到对话历史中。

```typescript
// utils/mcpInstructionsDelta.ts
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  // 1. 扫描历史消息，找出已经通知过的 Server
  const announced = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'mcp_instructions_delta') continue
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  // 2. 找出新连接的、有 instructions 的 Server
  const connected = mcpClients.filter(c => c.type === 'connected')
  const blocks = new Map<string, string>()
  for (const c of connected) {
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }
  // 合并 client-side instructions（如 Chrome MCP 的客户端补充说明）
  for (const ci of clientSideInstructions) {
    if (!connectedNames.has(ci.serverName)) continue
    const existing = blocks.get(ci.serverName)
    blocks.set(ci.serverName, existing ? `${existing}\n\n${ci.block}` : ...)
  }

  // 3. 计算 diff：新增的和移除的
  const added = [...blocks].filter(([name]) => !announced.has(name))
  const removed = [...announced].filter(n => !connectedNames.has(n))

  if (added.length === 0 && removed.length === 0) return null
  return { addedNames, addedBlocks, removedNames }
}
```

Delta 消息在 `attachments.ts` 中被渲染为对话中的一条特殊消息：

```typescript
// utils/attachments.ts — mcp_instructions_delta 的渲染
case 'mcp_instructions_delta': {
  return `# MCP Server Instructions\n\n` +
    `The following MCP servers have provided instructions...\n\n` +
    attachment.addedBlocks.join('\n\n')
}
```

#### 两种策略的对比

```
策略一（内联）：
  System Prompt: [...静态内容...] [MCP Instructions: A, B, C]
  ↓ Server D 连接
  System Prompt: [...静态内容...] [MCP Instructions: A, B, C, D]  ← cache 失效！

策略二（Delta）：
  System Prompt: [...静态内容...]  ← 永远不变，cache 命中
  Message[3]: [mcp_instructions_delta: added A, B, C]
  ↓ Server D 连接
  Message[7]: [mcp_instructions_delta: added D]  ← 追加消息，不影响 cache
```

Delta 模式的优势是 system prompt 保持稳定，prompt cache 不会因为 MCP Server 的延迟连接而失效。代价是 LLM 需要从对话历史中"回忆"之前的 MCP 指令，而不是每轮都在 system prompt 中看到。

#### Client-Side Instructions

一个有趣的扩展点是 `ClientSideInstruction`：

```typescript
// utils/mcpInstructionsDelta.ts
export type ClientSideInstruction = {
  serverName: string
  block: string
}
```

这允许 Claude Code **客户端**为某个 MCP Server 补充额外的指令，而不依赖 Server 自己返回。典型场景是 Chrome MCP Server——Server 本身不知道 Claude Code 的 Skill 系统，但客户端知道应该提示 LLM "使用 chrome 工具前先调用 Skill tool"。

### 设计决策讨论

**为什么不直接用 Delta 模式替代内联模式？**

源码中 Delta 模式通过 GrowthBook feature flag（`tengu_basalt_3kr`）控制，内部用户默认启用，外部用户逐步灰度。这说明 Anthropic 对 Delta 模式的稳定性还在验证中——Delta 模式依赖 LLM 正确"回忆"历史消息中的指令，如果 LLM 在长对话中遗忘了早期的 delta 消息，可能导致工具使用不当。内联模式虽然性能差，但每轮都能看到完整指令，更可靠。

**Server instructions 的截断**

```typescript
// services/mcp/client.ts — connectToServer() 中
const rawInstructions = client.getInstructions()
let instructions = rawInstructions
if (rawInstructions && rawInstructions.length > MAX_MCP_DESCRIPTION_LENGTH) {
  instructions = rawInstructions.slice(0, 2048) + '… [truncated]'
}
```

和工具描述一样，Server instructions 也被截断到 2048 字符。这防止恶意或配置不当的 Server 通过超长 instructions 占用过多 token。

---

## 6.6 认证：OAuth、XAA 与 Elicitation

### 面临的问题

远程 MCP Server（SSE/HTTP）往往需要认证。不同 Server 的认证方式各异——有的用 OAuth 2.0，有的用 API Key，有的需要企业 IdP（Identity Provider）登录。Claude Code 需要在不了解具体 Server 实现的情况下，通用地处理这些认证场景。

**核心问题：如何为 CLI 环境实现通用的 OAuth 认证流程，同时支持企业级的跨应用认证（XAA）？**

### 解法：ClaudeAuthProvider + Needs-Auth 状态机 + Elicitation

#### ClaudeAuthProvider：OAuth 2.0 客户端实现

`auth.ts` 中的 `ClaudeAuthProvider` 实现了 MCP SDK 的 `OAuthClientProvider` 接口，为每个远程 Server 提供独立的 OAuth 认证能力：

```typescript
// services/mcp/auth.ts（核心结构）
export class ClaudeAuthProvider implements OAuthClientProvider {
  constructor(
    private serverName: string,
    private serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  ) {}

  // 获取已存储的 token
  async tokens(): Promise<OAuthTokens | undefined> { ... }

  // 存储新 token（到 macOS Keychain / 加密文件）
  async saveTokens(tokens: OAuthTokens): Promise<void> { ... }

  // 发起 OAuth 授权流程
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 在 CLI 中打开浏览器
    await openBrowser(authorizationUrl.toString())
  }

  // OAuth callback — 启动本地 HTTP 服务器接收回调
  async saveCodeVerifier(codeVerifier: string): Promise<void> { ... }
  async codeVerifier(): Promise<string> { ... }
}
```

每个 Server 的凭据通过 `getServerKey()` 隔离存储：

```typescript
export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string {
  const configJson = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers || {},
  })
  const hash = createHash('sha256').update(configJson).digest('hex').substring(0, 16)
  return `${serverName}|${hash}`
}
```

`serverName + config hash` 作为凭据的 key，确保：同名但不同 URL 的 Server 不会共享凭据；同一个 Server 配置变更后旧凭据自动失效。

#### Needs-Auth 缓存：避免重复 401

当一个 Server 连接时返回 401，Claude Code 将其标记为 `needs-auth` 状态，并缓存这个状态 15 分钟：

```typescript
// services/mcp/client.ts
const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 min

async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  if (!entry) return false
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS
}
```

这个缓存的作用是：如果用户有 10 个 claude.ai connector 但还没登录，不需要每次启动都对 10 个 Server 各尝试一次连接再收到 401。缓存直接跳过连接尝试，标记为 `needs-auth`。

缓存的写入通过 Promise 链串行化，防止并发 401 导致的竞态条件：

```typescript
let writeChain = Promise.resolve()

function setMcpAuthCacheEntry(serverId: string): void {
  writeChain = writeChain.then(async () => {
    const cache = await getMcpAuthCache()
    cache[serverId] = { timestamp: Date.now() }
    await writeFile(cachePath, jsonStringify(cache))
    authCachePromise = null  // 使读缓存失效
  }).catch(() => { /* best-effort */ })
}
```

#### Elicitation：Server 向用户请求信息

MCP 2025-03-26 规范引入了 **Elicitation** 机制——Server 可以在工具调用过程中向用户请求额外信息（比如 OAuth 授权 URL、表单填写）。Claude Code 的实现在 `elicitationHandler.ts` 中：

```typescript
// services/mcp/elicitationHandler.ts
export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    // 1. 先尝试 Hook 自动响应（自动化场景）
    const hookResponse = await runElicitationHooks(serverName, request.params, extra.signal)
    if (hookResponse) return hookResponse

    // 2. 将 elicitation 请求推入 AppState 队列，等待 UI 渲染
    const response = new Promise<ElicitResult>(resolve => {
      setAppState(prev => ({
        ...prev,
        elicitation: {
          queue: [...prev.elicitation.queue, {
            serverName,
            params: request.params,
            signal: extra.signal,
            respond: resolve,  // UI 组件通过 respond() 回传用户输入
          }],
        },
      }))
    })

    // 3. 等待用户在 UI 中完成交互
    const result = await response

    // 4. 通过 Hook 链处理结果
    return await runElicitationResultHooks(serverName, result, extra.signal)
  })
}
```

Elicitation 的数据流：

```
MCP Server
  │ ElicitRequest (form/url)
  ▼
registerElicitationHandler
  │ 1. 尝试 Hook 自动响应
  │ 2. 推入 AppState.elicitation.queue
  ▼
React UI (ElicitationDialog)
  │ 用户填写表单 / 打开 URL
  │ 调用 respond(result)
  ▼
runElicitationResultHooks
  │ Hook 后处理
  ▼
返回给 MCP Server
```

Elicitation 支持两种模式：
- **form**：Server 提供一个 JSON Schema，UI 渲染为表单让用户填写
- **url**：Server 提供一个 URL，UI 打开浏览器让用户完成（如 OAuth 授权）

#### Claude.ai 代理认证

claude.ai connector 通过 Anthropic 的代理服务连接，认证方式是 claude.ai 的 OAuth token：

```typescript
// services/mcp/client.ts
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const currentTokens = getClaudeAIOAuthTokens()
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // 返回发送的 token，供 401 重试判断
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) return response

    // 401: 尝试刷新 token 后重试一次
    const tokenChanged = await handleOAuth401Error(sentToken).catch(() => false)
    if (!tokenChanged) return response
    return (await doRequest()).response
  }
}
```

这里有一个微妙的并发安全设计：`doRequest` 返回的是**发送请求时使用的 token**（`sentToken`），而不是请求完成后再读取最新 token。因为在并发场景下（30 个 connector 同时 401），一个 connector 的 `handleOAuth401Error` 可能已经刷新了 token，如果此时再读取最新 token，会发现"和 keychain 里的一样"，误判为"已经是最新的了，不需要重试"。

### 设计决策讨论

**为什么连接时默认注册一个"cancel"的 elicitation handler？**

```typescript
// services/mcp/client.ts — connectToServer() 中
client.setRequestHandler(ElicitRequestSchema, async request => {
  return { action: 'cancel' as const }  // 默认拒绝
})
```

在 `connectToServer()` 和 `registerElicitationHandler()`（在 `useManageMCPConnections` 的 `onConnectionAttempt` 回调中注册）之间有一个时间窗口。如果 Server 在这个窗口内发起 Elicitation 请求，没有 handler 会导致 SDK 抛异常。默认的 "cancel" handler 是一个安全兜底——宁可拒绝请求，也不要崩溃。

**为什么 OAuth 敏感参数要从日志中脱敏？**

```typescript
const SENSITIVE_OAUTH_PARAMS = ['state', 'nonce', 'code_challenge', 'code_verifier', 'code']

function redactSensitiveUrlParams(url: string): string {
  const parsedUrl = new URL(url)
  for (const param of SENSITIVE_OAUTH_PARAMS) {
    if (parsedUrl.searchParams.has(param)) {
      parsedUrl.searchParams.set(param, '[REDACTED]')
    }
  }
  return parsedUrl.toString()
}
```

OAuth 的 `state` 参数用于防 CSRF，`code` 是授权码——泄露任何一个都可能导致安全漏洞。源码中所有涉及 OAuth URL 的日志点都经过脱敏处理。

---

## 6.7 企业安全策略：Allowlist、Denylist 与审批

### 面临的问题

对于个人用户，MCP Server 的安全问题相对简单——"你自己配置的，你自己负责"。但对于企业用户，问题复杂得多：
- IT 部门需要控制员工可以连接哪些 MCP Server
- 恶意仓库的 `.mcp.json` 不能自动执行
- 某些 Server 必须被禁止（比如包含已知漏洞的版本）

### 解法：三层安全门控

```
MCP Server 配置
      │
      ▼
┌─ 第一层：Denylist（绝对禁止）──────────────────┐
│  deniedMcpServers 匹配？                        │
│  ├─ 按名称匹配：serverName === "evil-server"    │
│  ├─ 按命令匹配：command + args 完全相同          │
│  └─ 按 URL 匹配：支持通配符 *.evil.com/*       │
│  匹配 → 直接拒绝，不可覆盖                       │
└─────────────────────────────────────────────────┘
      │ 未匹配
      ▼
┌─ 第二层：Allowlist（允许名单）──────────────────┐
│  allowedMcpServers 存在？                        │
│  ├─ 不存在 → 放行（无限制）                      │
│  ├─ 存在但为空 → 全部拒绝                        │
│  └─ 存在且非空 → 必须匹配其中一条规则            │
│  allowManagedMcpServersOnly: true 时              │
│    → 只读取 policySettings 中的 allowlist        │
└─────────────────────────────────────────────────┘
      │ 通过
      ▼
┌─ 第三层：项目审批（.mcp.json 专用）────────────┐
│  scope === 'project' ?                           │
│  ├─ 已批准（enabledMcpjsonServers）→ 连接       │
│  ├─ 已拒绝（disabledMcpjsonServers）→ 跳过      │
│  └─ pending → 弹出审批对话框                     │
│     bypassPermissions 模式下自动批准             │
│     非交互模式（SDK/-p）下自动批准               │
└─────────────────────────────────────────────────┘
      │ 通过
      ▼
    连接 Server
```

Denylist 的优先级最高，**绝对不可覆盖**——即使 allowlist 中包含了某个 Server，如果它同时出现在 denylist 中，仍然被拒绝。这是"deny wins"的安全原则。

Allowlist 支持三种匹配维度，对应不同的 Server 类型：

```typescript
// services/mcp/config.ts
function isMcpServerAllowedByPolicy(serverName, config): boolean {
  if (isMcpServerDenied(serverName, config)) return false  // Deny 优先

  if (!settings.allowedMcpServers) return true  // 无 allowlist → 放行
  if (settings.allowedMcpServers.length === 0) return false  // 空 allowlist → 全拒

  if (config) {
    const serverCommand = getServerCommandArray(config)
    if (serverCommand && hasCommandEntries) {
      // stdio Server：按 command + args 匹配
      return settings.allowedMcpServers.some(entry =>
        isMcpServerCommandEntry(entry) &&
        commandArraysMatch(entry.serverCommand, serverCommand)
      )
    }
    const serverUrl = getServerUrl(config)
    if (serverUrl && hasUrlEntries) {
      // 远程 Server：按 URL 通配符匹配
      return settings.allowedMcpServers.some(entry =>
        isMcpServerUrlEntry(entry) &&
        urlMatchesPattern(serverUrl, entry.serverUrl)
      )
    }
  }
  // fallback：按名称匹配
  return settings.allowedMcpServers.some(entry =>
    isMcpServerNameEntry(entry) && entry.serverName === serverName
  )
}
```

URL 匹配支持通配符，通过简单的正则转换实现：

```typescript
function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`)
}
// "https://*.example.com/*" → /^https:\/\/.*\.example\.com\/.*$/
```

#### 企业独占模式

当 `managed-mcp.json`（企业 MDM 部署）存在时，进入**独占模式**——只有企业配置中的 Server 可以使用，用户无法添加、删除或修改任何 Server：

```typescript
// services/mcp/config.ts
export async function getClaudeCodeMcpConfigs(...): Promise<{...}> {
  if (doesEnterpriseMcpConfigExist()) {
    // 独占模式：只返回企业 Server，忽略所有其他来源
    const filtered = {}
    for (const [name, config] of Object.entries(enterpriseServers)) {
      if (isMcpServerAllowedByPolicy(name, config)) {
        filtered[name] = config
      }
    }
    return { servers: filtered, errors: [] }
  }
  // 非独占模式：合并所有来源...
}
```

这个设计满足了一个明确的企业需求：*"我们不希望员工自行添加 MCP Server，所有 Server 必须由 IT 统一管理"*。

---

## 6.8 完整数据流：从配置到工具调用

把上述所有层串联起来，一次 MCP 工具调用的完整数据流如下：

```
[1] 启动时 ─ 配置加载
    settings.json / .mcp.json / enterprise / plugins / claude.ai
      → getClaudeCodeMcpConfigs()
        → 合并 + 去重 + 策略过滤 + 环境变量展开
        → Record<string, ScopedMcpServerConfig>

[2] 启动时 ─ 连接建立
    useManageMCPConnections (React Hook)
      → getMcpToolsCommandsAndResources()
        → pMap(configs, connectToServer, { concurrency: 3/20 })
          → 为每个 Server 选择传输层 (stdio/SSE/HTTP/WS/InProcess)
          → MCP Client.connect(transport)
          → 超时 30s，失败进入 needs-auth / failed
        → fetchToolsForClient(connectedServer)
          → tools/list → MCPTool 模板覆盖 → Tool[]
      → onConnectionAttempt → updateServer → 批量 setAppState

[3] 启动时 ─ 工具注册
    useMergedTools(initialTools, mcp.tools, permissionContext)
      → assembleToolPool() + mergeAndFilterTools()
      → 最终工具列表（内置 + MCP）提供给 LLM

[4] 启动时/运行中 ─ 指令注入
    (内联模式) prompts.ts → getMcpInstructionsSection()
    (Delta 模式) attachments.ts → getMcpInstructionsDelta()
      → "# MCP Server Instructions\n## server\n{instructions}"

[5] 对话中 ─ LLM 调用 MCP 工具
    API 返回 tool_use: { name: "mcp__slack__send_message", input: {...} }
      → 查找对应的 Tool 实例
      → checkPermissions() → 权限检查（规则 + 分类器 + UI 弹窗）
      → call(args, context)
        → ensureConnectedClient() — 确认连接仍然有效
        → client.callTool({ name: "send_message", arguments: args })
          → MCP JSON-RPC → Server 处理 → 返回结果
        → 结果序列化 → tool_result 回传给 API

[6] 运行中 ─ 异常处理
    连接断开 → client.onclose
      → stdio: 标记 failed
      → 远程: 指数退避重连 (1s/2s/4s/8s/16s, max 5 次)
    401 认证失败 → McpAuthError
      → 标记 needs-auth → 缓存 15min → 用户 /mcp 重新认证
    Session 过期 (HTTP 404 + -32001)
      → 清除 memoize cache → 重新连接 → 重试工具调用
```

---

## 6.9 总结：MCP 集成的设计哲学

回顾整个 MCP 子系统的设计，可以提炼出几个核心哲学：

### 1. 协议标准化，实现差异化

MCP 协议定义了 Client 和 Server 之间的标准接口，但 Claude Code 的实现远超协议本身。命名空间隔离、签名去重、工具折叠分类、prompt cache 优化——这些都是协议之上的工程创造。标准协议保证了互操作性，差异化实现保证了用户体验。

### 2. 安全是分层的，不是一道门

从企业 denylist 到项目审批对话框，从 OAuth token 脱敏到 instructions 截断，安全不是一个二元判断（"允许/拒绝"），而是一个多层防御体系。每一层都有自己的假设和边界：
- **Denylist**：绝对禁止，不可覆盖
- **Allowlist**：默认放行，有名单时才限制
- **项目审批**：信任边界在"用户是否知情"
- **截断**：防止资源滥用，不防恶意攻击

### 3. 性能优化必须尊重正确性

prompt cache 优化（Delta 模式）是一个典型的例子：它不是简单地"不在 system prompt 中放动态内容"，而是设计了一套完整的增量通知机制，确保 LLM 在任何时刻都能看到完整的 MCP 指令——只是看到的方式从"system prompt 内联"变成了"对话历史中的增量消息"。

### 4. 进程隔离 vs 进程内优化

MCP 的设计哲学是进程隔离（每个 Server 是独立进程），但 Claude Code 在特定场景下打破了这个原则——Chrome MCP Server 和 Computer Use MCP Server 通过 `InProcessTransport` 在同一进程中运行。这不是对协议的违反（传输层是可替换的），而是在协议框架内的性能优化。关键是**接口不变，实现可变**。

### 5. 渐进式发布

从 feature flag 控制的 Delta 模式，到 GrowthBook 门控的 channel permission relay，MCP 子系统大量使用了渐进式发布策略。新特性先在内部用户中验证，再通过灰度逐步推向外部用户。这体现了对一个复杂系统的审慎态度——"在生产环境中验证，而不是在想象中验证"。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `services/mcp/types.ts` | MCP 类型定义 | `MCPServerConnection`, `ScopedMcpServerConfig`, `ConfigScope` |
| `services/mcp/config.ts` | 配置合并与策略过滤 | `getClaudeCodeMcpConfigs()`, `addMcpConfig()`, `filterMcpServersByPolicy()` |
| `services/mcp/client.ts` | 连接建立与工具获取 | `connectToServer()`, `fetchToolsForClient()`, `getMcpToolsCommandsAndResources()` |
| `services/mcp/MCPConnectionManager.tsx` | React 连接管理 Context | `MCPConnectionManager`, `useMcpReconnect()` |
| `services/mcp/useManageMCPConnections.ts` | 连接生命周期 Hook | `useManageMCPConnections()` |
| `services/mcp/normalization.ts` | 名称规范化 | `normalizeNameForMCP()` |
| `services/mcp/mcpStringUtils.ts` | 工具名解析 | `buildMcpToolName()`, `mcpInfoFromString()` |
| `services/mcp/auth.ts` | OAuth 认证 | `ClaudeAuthProvider`, `getServerKey()` |
| `services/mcp/elicitationHandler.ts` | Elicitation 处理 | `registerElicitationHandler()`, `runElicitationHooks()` |
| `services/mcp/envExpansion.ts` | 环境变量展开 | `expandEnvVarsInString()` |
| `services/mcp/InProcessTransport.ts` | 进程内传输 | `createLinkedTransportPair()` |
| `services/mcp/channelPermissions.ts` | Channel 权限中继 | `createChannelPermissionCallbacks()`, `shortRequestId()` |
| `services/mcpServerApproval.tsx` | 项目 Server 审批 UI | `handleMcpjsonServerApprovals()` |
| `tools/MCPTool/MCPTool.ts` | MCP 工具模板 | `MCPTool` |
| `tools/MCPTool/classifyForCollapse.ts` | 工具折叠分类 | `classifyMcpToolForCollapse()` |
| `hooks/useMergedTools.ts` | 工具合并 | `useMergedTools()` |
| `hooks/useMergedClients.ts` | 客户端合并 | `useMergedClients()` |
| `utils/mcpInstructionsDelta.ts` | 指令增量通知 | `getMcpInstructionsDelta()`, `isMcpInstructionsDeltaEnabled()` |
| `constants/prompts.ts` | System Prompt 注入 | `getMcpInstructions()` |




