---
title: Claude Code 源码解析（十三）· API 与网络层
description: '与 Anthropic API 的通信远不止发个请求——流式响应如何实时解析？网络抖动如何优雅重试？Prompt Cache 如何节省 token 开销？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十三章：API 服务层（API & Networking）

> Claude Code 与 Anthropic API 的通信层——认证、请求、流式响应、重试与错误处理。

## 核心问题

一个 LLM 驱动的 CLI 工具，其"灵魂"在云端。Claude Code 的每一次对话、每一次工具调用、每一次上下文压缩，最终都要归结为一次 HTTP 请求——发往 Anthropic 的 Messages API。这意味着 API 通信层不是一个"辅助模块"，而是整个系统的**生命线**。

这条生命线面临的挑战远比"发个 HTTP 请求"复杂：

1. **多提供商适配。** Claude Code 不只对接 Anthropic 直连 API，还要支持 AWS Bedrock、Google Vertex AI、Azure Foundry——每个提供商有不同的认证方式、SDK、区域路由和错误格式。如何用一套代码适配四种后端？

2. **认证复杂度爆炸。** OAuth 2.0 + PKCE（Claude.ai 订阅用户）、API Key（开发者）、AWS IAM（Bedrock）、GCP Service Account（Vertex）、Azure AD（Foundry）、JWT（CCR 远程容器）——六种认证方式，每种都有自己的刷新、过期、缓存逻辑。

3. **流式响应的可靠性。** SSE 流式传输在长时间运行时可能遇到连接中断、超时、部分响应等问题。如何在流式场景下实现可靠的错误恢复？

4. **重试策略的精细化。** 不是所有错误都应该重试，不是所有重试都应该用相同的策略。429（速率限制）和 529（过载）需要不同的退避策略；前台查询和后台查询的重试优先级不同；订阅用户和 API 用户的重试逻辑也不同。

5. **成本可观测性。** 用户需要知道自己花了多少钱。但 token 计费涉及输入/输出/缓存读取/缓存创建多个维度，还有不同模型的不同费率。

6. **Prompt Cache 优化。** Anthropic API 支持 prompt cache，可以显著降低重复前缀的计费。但 cache 失效是隐式的——系统提示词、工具定义、模型切换都可能导致 cache miss。如何检测和诊断 cache 失效？

**核心矛盾：通信层需要对上层完全透明（"就像直接调用 API 一样简单"），但底层要处理的复杂性是巨大的（多提供商、多认证、重试、降级、缓存、计费……）。**

Claude Code 的解法是一个**分层的 API 服务架构**——每一层解决一个特定的关注点，层与层之间通过清晰的接口隔离。

---

## 13.1 架构总览

```
用户输入 → QueryEngine → query.ts
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    API 服务层 (services/api/)                  │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  claude.ts: 请求构建与流式处理层                          │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • System Prompt 构建与 cache_control 标记               │  │
│  │  • Tool Schema 转换                                      │  │
│  │  • 消息规范化 (normalizeMessagesForAPI)                   │  │
│  │  • SSE 流式事件处理                                      │  │
│  │  • 流式 → 非流式降级                                     │  │
│  │  • 流式停滞检测 (watchdog)                               │  │
│  └──────────────────────┬──────────────────────────────────┘  │
│                         │                                      │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │  withRetry.ts: 重试与降级层                               │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • 指数退避重试 (最多 10 次)                               │  │
│  │  • 429/529 差异化处理                                     │  │
│  │  • Fast Mode 降级                                         │  │
│  │  • 模型降级 (Opus → Sonnet fallback)                      │  │
│  │  • OAuth token 自动刷新                                   │  │
│  │  • 持久重试模式 (无人值守场景)                              │  │
│  │  • max_tokens 溢出自动调整                                 │  │
│  └──────────────────────┬──────────────────────────────────┘  │
│                         │                                      │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │  client.ts: 客户端工厂层                                  │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • 多提供商适配 (Anthropic/Bedrock/Vertex/Foundry)        │  │
│  │  • 认证注入 (OAuth/API Key/IAM/GCP/Azure AD)             │  │
│  │  • 自定义 Header 注入                                     │  │
│  │  • 代理配置                                               │  │
│  │  • 请求 ID 追踪 (x-client-request-id)                    │  │
│  └──────────────────────┬──────────────────────────────────┘  │
│                         │                                      │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │  errors.ts + errorUtils.ts: 错误分类与恢复层              │  │
│  │  ─────────────────────────────────────────────────────── │  │
│  │  • 20+ 种错误类型识别与分类                                │  │
│  │  • 用户友好的错误消息生成                                  │  │
│  │  • 错误分类 (用于分析追踪)                                 │  │
│  │  • SSL/TLS 错误诊断 (29 种 SSL 错误码)                    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ usage.ts     │ │ logging.ts   │ │ promptCacheBreak     │  │
│  │ 用量追踪     │ │ API 日志     │ │ Detection.ts         │  │
│  │              │ │              │ │ Cache 失效检测        │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
│                                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │bootstrap.ts  │ │ grove.ts     │ │ sessionIngress.ts    │  │
│  │ 启动配置获取  │ │ 隐私设置     │ │ 会话日志持久化        │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
│                                                                │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  upstreamproxy/: 上游代理层 (企业/远程容器环境)                │
│  • CONNECT-over-WebSocket 中继                                │
│  • CA 证书下载与拼接                                          │
│  • 安全令牌管理 (ptrace 防护)                                 │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
              Anthropic API / Bedrock / Vertex / Foundry
```

这个架构的关键洞察是：**每一层只关心自己的职责，不越界。** `client.ts` 不关心重试逻辑，`withRetry.ts` 不关心认证方式，`errors.ts` 不关心请求构建。这种分层使得每一层都可以独立演进——比如新增一个提供商只需要修改 `client.ts`，不影响重试和错误处理。

### 关键源码文件索引

| 文件 | 职责 | 行数量级 |
|------|------|---------|
| `services/api/claude.ts` | 请求构建、流式处理、cache 管理 | ~3000 行 |
| `services/api/client.ts` | 多提供商客户端工厂 | ~390 行 |
| `services/api/withRetry.ts` | 重试引擎 | ~820 行 |
| `services/api/errors.ts` | 错误分类与消息生成 | ~1200 行 |
| `services/api/errorUtils.ts` | 底层错误提取与格式化 | ~300 行 |
| `services/api/logging.ts` | API 调用日志 | ~400 行 |
| `services/api/usage.ts` | 用量追踪 | ~200 行 |
| `services/api/promptCacheBreakDetection.ts` | Prompt Cache 失效检测 | ~400 行 |
| `services/api/bootstrap.ts` | 启动配置获取 | ~200 行 |
| `services/api/sessionIngress.ts` | 会话日志远程持久化 | ~400 行 |
| `cost-tracker.ts` | 成本追踪 | ~300 行 |
| `services/claudeAiLimits.ts` | 速率限制状态管理 | ~500 行 |
| `services/rateLimitMessages.ts` | 速率限制消息生成 | ~300 行 |
| `upstreamproxy/relay.ts` | CONNECT-over-WebSocket 中继 | ~400 行 |
| `upstreamproxy/upstreamproxy.ts` | 上游代理初始化 | ~200 行 |

---

## 13.2 客户端工厂：四种后端，一个接口

### 面临的问题

Claude Code 需要支持四种 API 后端：
- **Anthropic 直连 API**（`api.anthropic.com`）——面向个人开发者和 Claude.ai 订阅用户
- **AWS Bedrock**——面向 AWS 企业用户
- **Google Vertex AI**——面向 GCP 企业用户
- **Azure Foundry**——面向 Azure 企业用户

每种后端有完全不同的：
- **SDK**：`@anthropic-ai/sdk`、`@anthropic-ai/bedrock-sdk`、`@anthropic-ai/vertex-sdk`、`@anthropic-ai/foundry-sdk`
- **认证方式**：OAuth/API Key、AWS IAM、GCP Service Account、Azure AD
- **区域路由**：无（直连）、AWS Region、GCP Region（按模型不同）、Azure Resource
- **错误格式**：标准 API 错误、AWS 错误信封、GCP 错误格式

问题是：上层代码（`query.ts`、`withRetry.ts`）不应该关心当前用的是哪个后端。它们只想要一个 `Anthropic` 客户端实例，调用 `client.beta.messages.create()` 就行。

### 解法：工厂函数 + 类型伪装

`client.ts` 的核心是一个工厂函数 `getAnthropicClient()`，它根据环境变量决定创建哪种 SDK 客户端，然后**统一伪装为 `Anthropic` 类型**返回：

```typescript
// services/api/client.ts — 简化后的核心逻辑

export async function getAnthropicClient({ apiKey, maxRetries, model }): Promise<Anthropic> {
  // 公共配置：所有提供商共享
  const ARGS = {
    defaultHeaders: { 'x-app': 'cli', 'User-Agent': getUserAgent(), ... },
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || '600000', 10),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
  }

  // 分支 1: AWS Bedrock
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    return new AnthropicBedrock({
      ...ARGS,
      awsRegion: getAWSRegion(),
      // AWS 认证：IAM credentials 或 Bearer token
    }) as unknown as Anthropic  // ← 类型伪装
  }

  // 分支 2: Azure Foundry
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    return new AnthropicFoundry({
      ...ARGS,
      azureADTokenProvider: ...,  // Azure AD 认证
    }) as unknown as Anthropic  // ← 类型伪装
  }

  // 分支 3: Google Vertex AI
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk')
    return new AnthropicVertex({
      ...ARGS,
      region: getVertexRegionForModel(model),  // 按模型选区域
      googleAuth: new GoogleAuth({ ... }),
    }) as unknown as Anthropic  // ← 类型伪装
  }

  // 分支 4: Anthropic 直连 (默认)
  return new Anthropic({
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken : undefined,
    ...ARGS,
  })
}
```

源码中有一句坦诚的注释：

```typescript
// we have always been lying about the return type - this doesn't support batching or models
return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
```

这个 `as unknown as Anthropic` 是一个**刻意的类型谎言**。Bedrock/Vertex/Foundry SDK 的类型签名与直连 SDK 不完全一致（比如不支持 batching），但 Claude Code 只用到了 `messages.create()` 这个子集，而这个子集在所有 SDK 中是兼容的。通过类型伪装，上层代码可以统一使用 `Anthropic` 类型，不需要写 `if (provider === 'bedrock') { ... } else { ... }` 的分支。

### 提供商选择机制

提供商选择通过环境变量驱动，优先级清晰：

```typescript
// utils/model/providers.ts
export function getAPIProvider(): APIProvider {
  if (process.env.CLAUDE_CODE_USE_BEDROCK) return 'bedrock'
  if (process.env.CLAUDE_CODE_USE_VERTEX) return 'vertex'
  if (process.env.CLAUDE_CODE_USE_FOUNDRY) return 'foundry'
  return 'firstParty'
}
```

这是一个**环境变量驱动的策略模式**。为什么不用配置文件？因为提供商选择通常是**部署级别**的决策（"我们公司用 Bedrock"），而不是用户级别的偏好。环境变量是部署配置的标准载体，可以通过 Docker、K8s、CI/CD 等基础设施统一管理。

### 认证注入的数据流

直连 API 的认证路径有六种，按优先级排序：

```
认证优先级（直连 API）:
┌─────────────────────────────────────────────────────┐
│ 1. ANTHROPIC_AUTH_TOKEN 环境变量 (Bearer token)      │ ← 托管环境 (CCR)
│ 2. apiKeyHelper 脚本输出 (Bearer token)              │ ← 企业自定义认证
│ 3. Claude.ai OAuth token (authToken 参数)            │ ← 订阅用户 (/login)
│ 4. ANTHROPIC_API_KEY 环境变量 (x-api-key header)     │ ← 开发者
│ 5. 配置文件中的 API Key                              │ ← 开发者 (持久化)
│ 6. macOS Keychain 中的 API Key                       │ ← 开发者 (安全存储)
└─────────────────────────────────────────────────────┘
```

关键的设计决策是 **OAuth 用户和 API Key 用户走完全不同的认证路径**：

```typescript
// OAuth 用户：使用 authToken 参数（SDK 内部处理 Authorization header）
if (isClaudeAISubscriber()) {
  clientConfig.apiKey = null
  clientConfig.authToken = getClaudeAIOAuthTokens()?.accessToken
}
// API Key 用户：使用 apiKey 参数（SDK 内部处理 x-api-key header）
else {
  clientConfig.apiKey = apiKey || getAnthropicApiKey()
}
```

为什么要区分？因为 OAuth token 和 API Key 在 HTTP 层面使用不同的 header（`Authorization: Bearer` vs `x-api-key`），而且 OAuth 用户还需要额外的 `anthropic-beta` header 来启用 OAuth 相关的 beta 功能。

### 请求 ID 追踪

`client.ts` 中有一个精巧的 `buildFetch()` 函数，它包装了原生 `fetch`，为每个请求注入一个 `x-client-request-id`：

```typescript
function buildFetch(fetchOverride, source): ClientOptions['fetch'] {
  const inner = fetchOverride ?? globalThis.fetch
  // 只对直连 API 注入——第三方代理可能拒绝未知 header
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()

  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    return inner(input, { ...init, headers })
  }
}
```

为什么只对直连 API 注入？源码注释说得很清楚：

```typescript
// Only send to the first-party API — Bedrock/Vertex/Foundry don't log it
// and unknown headers risk rejection by strict proxies (inc-4029 class).
```

这是一个**防御性设计**：第三方提供商的代理可能拒绝未知 header，所以只在确认安全的场景下注入。这个 ID 的价值在于——当请求超时（没有服务端 request ID 返回）时，客户端 ID 仍然可以用于与服务端日志关联排查。

### 设计决策讨论

**为什么第三方 SDK 用动态 `import()` 而不是静态 `import`？**

```typescript
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
  const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
  // ...
}
```

因为 `@anthropic-ai/bedrock-sdk`、`@anthropic-ai/vertex-sdk`、`@anthropic-ai/foundry-sdk` 各自依赖大量的云平台 SDK（`aws-sdk`、`google-auth-library`、`@azure/identity`）。如果静态 import，即使用户只用直连 API，也要加载所有云平台 SDK，增加数百毫秒的启动时间和数十 MB 的内存占用。动态 import 确保**只加载用户实际使用的提供商 SDK**。

**为什么 Vertex 的区域是按模型选择的？**

```typescript
region: getVertexRegionForModel(model)
```

这是因为 Google Vertex AI 的模型可用性是按区域的——某些模型只在特定区域可用。Claude Code 允许用户通过 `VERTEX_REGION_CLAUDE_3_5_HAIKU`、`VERTEX_REGION_CLAUDE_3_7_SONNET` 等环境变量为不同模型指定不同区域。这在 Bedrock 中不需要（AWS 的模型可用性更统一），体现了**适配层需要吸收各提供商的差异性**。

**为什么 Vertex 要处理 GoogleAuth 的 projectId 回退？**

源码中有一段精心处理 GCP 项目 ID 发现的逻辑：

```typescript
// google-auth-library 按以下顺序检查 project ID:
// 1. 环境变量 (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT 等)
// 2. 凭证文件 (service account JSON, ADC file)
// 3. gcloud config
// 4. GCE metadata server (在 GCP 外部会导致 12 秒超时!)
//
// 只在用户没有配置其他发现方式时，才用 ANTHROPIC_VERTEX_PROJECT_ID 作为回退
const googleAuth = new GoogleAuth({
  ...(hasProjectEnvVar || hasKeyFile ? {} : {
    projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
  }),
})
```

这解决了一个实际的用户痛点：在非 GCP 环境中（比如本地开发机），`google-auth-library` 会尝试访问 GCE metadata server 来获取 project ID，这个请求会超时 12 秒。通过提前提供 `projectId`，跳过了这个不必要的网络请求。但又不能无条件设置——如果用户已经通过环境变量或凭证文件配置了项目 ID，强制覆盖可能导致计费/审计问题。

---

## 13.3 重试与降级：不只是"再试一次"

### 面临的问题

API 调用失败是常态，不是异常。在 Claude Code 的使用场景中，一次对话可能持续数小时、发起数百次 API 调用。在这个时间跨度内，几乎必然会遇到：

- **429 Too Many Requests**：速率限制，通常几秒到几分钟后可重试
- **529 Overloaded**：服务端过载，可能持续数分钟
- **401/403**：OAuth token 过期（通常 1 小时），需要刷新
- **ECONNRESET/EPIPE**：TCP 连接被对端关闭（keep-alive 超时）
- **SSL 证书错误**：企业代理的证书问题
- **max_tokens 溢出**：输入 + 输出超过上下文窗口

简单的"失败就重试"策略在这里是不够的。不同的错误需要不同的恢复策略，而且重试本身也有代价——在服务端过载时盲目重试会加剧问题（**重试风暴**）。

### 解法：`withRetry()` — 一个 AsyncGenerator 驱动的重试引擎

`withRetry.ts` 的核心是一个 `async generator` 函数。这个设计选择本身就值得讨论——为什么用 generator 而不是普通的 async 函数？

```typescript
// services/api/withRetry.ts — 核心签名

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {

  const maxRetries = getMaxRetries(options)  // 默认 10
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw new APIUserAbortError()

    try {
      // 认证错误后重新获取 client（刷新 token）
      if (client === null || isAuthError(lastError) || isStaleConnection(lastError)) {
        client = await getClient()
      }
      return await operation(client, attempt, retryContext)
    } catch (error) {
      // ... 复杂的错误处理与重试决策 ...

      // 向 UI 报告重试进度
      yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
      await sleep(delayMs, options.signal, { abortError })
    }
  }
  throw new CannotRetryError(lastError, retryContext)
}
```

**为什么用 AsyncGenerator？** 因为重试等待期间需要向 UI 层**报告进度**。`yield` 一个 `SystemAPIErrorMessage` 会在终端显示类似 "API overloaded, retrying in 5s (attempt 3/10)" 的消息。如果用普通 async 函数，调用者只能等到最终结果或最终失败，无法在等待期间获得中间状态。

Generator 的另一个优势是**调用者可以提前终止**。如果用户按下 Ctrl+C，`options.signal` 被 abort，`sleep()` 会抛出 `APIUserAbortError`，generator 立即终止。

### 重试决策树

`withRetry()` 内部的错误处理逻辑是一棵复杂的决策树：

```
捕获到错误
    │
    ├─ 用户中止 (signal.aborted)?
    │   └─ YES → 抛出 APIUserAbortError，不重试
    │
    ├─ Fast Mode 活跃 + 429/529?
    │   ├─ 超额使用被拒 (overage rejection)?
    │   │   └─ 永久禁用 Fast Mode，立即重试
    │   ├─ Retry-After < 20秒?
    │   │   └─ 等待后重试（保持 Fast Mode 以保护 prompt cache）
    │   └─ Retry-After >= 20秒 或未知?
    │       └─ 进入 Fast Mode 冷却（切换到标准速度），立即重试
    │
    ├─ Fast Mode + "Fast mode is not enabled" 错误?
    │   └─ 永久禁用 Fast Mode，立即重试
    │
    ├─ 529 + 非前台查询源?
    │   └─ 立即放弃（不重试，避免重试风暴放大）
    │
    ├─ 529 + 连续 >= 3 次 (MAX_529_RETRIES)?
    │   ├─ 有 fallbackModel?
    │   │   └─ 抛出 FallbackTriggeredError（触发模型降级）
    │   └─ 外部用户 + 非持久模式?
    │       └─ 抛出 CannotRetryError
    │
    ├─ 超过最大重试次数 + 非持久模式?
    │   └─ 抛出 CannotRetryError
    │
    ├─ 401 (token 过期)?
    │   └─ 刷新 OAuth token，获取新 client，重试
    │
    ├─ 403 "token revoked"?
    │   └─ 刷新 OAuth token，获取新 client，重试
    │
    ├─ ECONNRESET/EPIPE (连接断开)?
    │   └─ 禁用 keep-alive，获取新 client，重试
    │
    ├─ Bedrock/Vertex 认证错误?
    │   └─ 清除凭证缓存，获取新 client，重试
    │
    ├─ max_tokens 溢出 (input + max_tokens > context)?
    │   └─ 计算安全的 max_tokens 值，调整 retryContext，重试
    │
    ├─ shouldRetry(error) 返回 false?
    │   └─ 抛出 CannotRetryError（不可重试的错误）
    │
    └─ 可重试 → 计算退避延迟，yield 进度消息，等待，重试
```

### 关键设计决策深度剖析

**1. 前台/后台查询的差异化重试**

这是 `withRetry.ts` 中最精妙的设计之一：

```typescript
// 只有前台查询源才重试 529
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',       // 用户主对话
  'sdk',                    // SDK 调用
  'agent:custom',           // 自定义 Agent
  'agent:default',          // 默认 Agent
  'compact',                // 上下文压缩
  'auto_mode',              // 安全分类器（自动模式正确性依赖）
  // ...
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  return querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
}
```

源码注释解释了为什么：

```typescript
// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway.
```

在服务端过载时，每次重试都会给网关带来 3-10 倍的放大效应。如果所有后台任务（摘要生成、标题生成、建议生成）都在重试，会加剧过载。而这些后台任务的失败对用户是不可见的——摘要没生成，用户不会注意到。所以**只让用户正在等待的前台查询重试，后台查询立即放弃**。

这是一个**系统思维**的体现：单个客户端的重试策略不能只考虑自己，还要考虑对整个系统的影响。

**2. Fast Mode 的优雅降级**

Fast Mode（快速模式）使用不同的模型变体来获得更快的响应。当遇到速率限制时，降级策略取决于等待时间：

```typescript
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000  // 20 秒
const MIN_COOLDOWN_MS = 10 * 60 * 1000      // 10 分钟

if (retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
  // 短等待：保持 Fast Mode，等待后重试
  // 原因：切换模型会导致 prompt cache 失效
  await sleep(retryAfterMs)
  continue
}
// 长等待：切换到标准速度
triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
retryContext.fastMode = false
continue
```

这里的 trade-off 是：**prompt cache 保护 vs 响应速度**。切换模型（从 fast 到 standard）会导致 prompt cache 完全失效，下一次请求需要重新计算所有 token。如果等待时间很短（< 20秒），保持 Fast Mode 等待是更优的——cache 命中节省的时间远超等待时间。但如果等待时间很长，用户体验优先，切换到标准速度。

**3. 持久重试模式（Persistent Retry）**

对于无人值守的场景（CCR 远程容器），`withRetry` 支持一种特殊的"持久重试"模式：

```typescript
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000    // 最大退避 5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000 // 最大等待 6 小时
const HEARTBEAT_INTERVAL_MS = 30_000                // 心跳间隔 30 秒

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}
```

持久模式的特殊之处：
- **永不放弃**：`attempt` 被钳制在 `maxRetries`，for 循环永远不会因为次数耗尽而终止
- **心跳保活**：长等待被切分为 30 秒的小块，每块之间 yield 一个心跳消息，防止宿主环境判定会话空闲
- **尊重 reset 时间**：对于 429 错误，读取 `anthropic-ratelimit-unified-reset` header，等到窗口重置而不是盲目轮询

```typescript
// 持久模式下的分块等待
let remaining = delayMs
while (remaining > 0) {
  if (options.signal?.aborted) throw new APIUserAbortError()
  yield createSystemAPIErrorMessage(error, remaining, reportedAttempt, maxRetries)
  const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
  await sleep(chunk, options.signal, { abortError })
  remaining -= chunk
}
// 钳制 attempt，防止 for 循环终止
if (attempt >= maxRetries) attempt = maxRetries
```

源码注释中有一个 TODO 暗示了当前方案的局限：

```typescript
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
```

用 yield 错误消息来做心跳是一个权宜之计——它复用了现有的消息通道，但语义上不太干净（心跳不是错误）。未来可能会有专门的 keep-alive 通道。

**4. 退避延迟计算**

```typescript
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  // 优先使用服务端指定的 Retry-After
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) return seconds * 1000
  }
  // 否则使用指数退避 + 抖动
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}
```

退避策略遵循业界最佳实践：
- **服务端优先**：如果 API 返回了 `Retry-After` header，直接使用（服务端比客户端更了解何时可以重试）
- **指数退避**：500ms → 1s → 2s → 4s → 8s → 16s → 32s（封顶）
- **抖动（Jitter）**：在基础延迟上加 0-25% 的随机偏移，避免多个客户端同时重试（**惊群效应**）

**5. `shouldRetry()` 的订阅用户特殊逻辑**

```typescript
function shouldRetry(error: APIError): boolean {
  // 服务端明确说可以重试
  const shouldRetryHeader = error.headers?.get('x-should-retry')
  if (shouldRetryHeader === 'true' &&
      (!isClaudeAISubscriber() || isEnterpriseSubscriber())) {
    return true
  }

  // 429 速率限制：订阅用户不重试（等几小时没意义），企业用户可以（PAYG）
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }
  // ...
}
```

为什么 Claude.ai 订阅用户（Max/Pro）遇到 429 不重试？因为订阅用户的速率限制窗口通常是 5 小时或 7 天——`x-should-retry: true` 意味着"几小时后可以重试"，但让用户等几小时显然不合理。Enterprise 用户例外，因为他们通常使用 PAYG（按量付费），429 只是短暂的并发限制。

**6. max_tokens 溢出自动恢复**

```typescript
if (error instanceof APIError) {
  const overflowData = parseMaxTokensContextOverflowError(error)
  if (overflowData) {
    const { inputTokens, contextLimit } = overflowData
    const safetyBuffer = 1000
    const availableContext = Math.max(0, contextLimit - inputTokens - safetyBuffer)

    if (availableContext < FLOOR_OUTPUT_TOKENS) {  // FLOOR = 3000
      throw error  // 可用空间太小，无法恢复
    }
    retryContext.maxTokensOverride = Math.max(FLOOR_OUTPUT_TOKENS, availableContext)
    continue  // 用调整后的 max_tokens 重试
  }
}
```

当 API 返回 "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000" 时，`withRetry` 会自动计算一个安全的 `max_tokens` 值（`200000 - 188059 - 1000 = 10941`），然后用这个值重试。这避免了用户看到一个晦涩的错误消息。

---

## 13.4 流式响应处理：从 SSE 事件到 AssistantMessage

### 面临的问题

Claude Code 的 API 调用使用 SSE（Server-Sent Events）流式传输。这意味着模型的响应不是一次性返回的，而是以一系列事件的形式逐步到达：

```
message_start
  → content_block_start → content_block_delta (×N) → content_block_stop
  → message_delta → message_stop
```

流式传输带来了几个工程挑战：

1. **状态累积**：每个 `content_block_delta` 只包含增量数据（一小段文本或 JSON），需要在客户端累积成完整的内容块。
2. **多内容块交错**：一个响应可能包含多个内容块（文本 + 工具调用 + thinking），它们通过 `index` 字段区分。
3. **流式中断恢复**：流可能在任何时刻中断（网络问题、超时），需要检测并恢复。
4. **性能**：避免 O(n²) 的 JSON 解析——Anthropic SDK 的 `BetaMessageStream` 会在每个事件后重新解析整个消息，对长响应来说代价很高。

### 解法：原始流 + 手动状态机

`claude.ts` 中的 `queryModel()` 函数选择使用**原始流**（`Stream<BetaRawMessageStreamEvent>`）而不是 SDK 提供的高级 `BetaMessageStream`：

```typescript
// 使用原始流，避免 BetaMessageStream 的 O(n²) JSON 解析
const result = await anthropic.beta.messages
  .create({ ...params, stream: true }, {
    signal,
    headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId }
  })
  .withResponse()

// result.data 是 Stream<BetaRawMessageStreamEvent>，不是 BetaMessageStream
```

然后用一个手动状态机处理事件流：

```
┌─────────────────────────────────────────────────────────────┐
│                    流式事件处理状态机                          │
│                                                               │
│  message_start                                                │
│  ├─ 初始化 partialMessage                                     │
│  ├─ 记录 TTFB (Time-To-First-Byte)                           │
│  └─ 提取初始 usage                                            │
│                                                               │
│  content_block_start (index=N)                                │
│  ├─ 在 contentBlocks[N] 初始化空块                             │
│  │   ├─ tool_use → { id, name, input: '' }                   │
│  │   ├─ text → { text: '' }                                  │
│  │   └─ thinking → { thinking: '', signature: '' }           │
│  └─ 标记 advisor 工具调用（如果适用）                           │
│                                                               │
│  content_block_delta (index=N)                                │
│  ├─ input_json_delta → contentBlocks[N].input += partial_json │
│  ├─ text_delta → contentBlocks[N].text += delta.text          │
│  ├─ thinking_delta → contentBlocks[N].thinking += delta       │
│  └─ signature_delta → contentBlocks[N].signature = delta      │
│                                                               │
│  content_block_stop (index=N)                                 │
│  ├─ 规范化内容 (normalizeContentFromAPI)                       │
│  ├─ 构建 AssistantMessage                                     │
│  └─ yield AssistantMessage ← 上层可以立即开始处理              │
│                                                               │
│  message_delta                                                │
│  ├─ 更新累积 usage (updateUsage)                               │
│  ├─ 设置 stopReason                                           │
│  ├─ 计算 USD 成本                                             │
│  └─ 检查 refusal / max_tokens / context_window_exceeded       │
│                                                               │
│  message_stop                                                 │
│  └─ 流结束                                                    │
└─────────────────────────────────────────────────────────────┘
```

### 核心源码解读

**事件处理循环**（`claude.ts` 核心段）：

```typescript
for await (const part of stream) {
  // 每个事件都 yield 给上层（用于 UI 实时渲染）
  yield { type: 'stream_event', event: part, ...(part.type === 'message_start' ? { ttftMs } : undefined) }

  switch (part.type) {
    case 'message_start':
      partialMessage = { ...part.message, content: [] }
      ttftMs = Date.now() - start
      usage = part.message.usage
      break

    case 'content_block_start':
      // 按类型初始化空块
      if (part.content_block.type === 'tool_use') {
        contentBlocks[part.index] = { ...part.content_block, input: '' }
      } else if (part.content_block.type === 'text') {
        contentBlocks[part.index] = { ...part.content_block, text: '' }
      }
      // ...
      break

    case 'content_block_delta':
      // 增量累积
      if (part.delta.type === 'input_json_delta') {
        contentBlock.input += part.delta.partial_json  // 字符串拼接，非 JSON 解析
      } else if (part.delta.type === 'text_delta') {
        contentBlock.text += part.delta.text
      }
      break

    case 'content_block_stop':
      // 块完成 → 构建 AssistantMessage → yield
      const normalizedContent = normalizeContentFromAPI(contentBlocks)
      const assistantMessage: AssistantMessage = {
        type: 'assistant',
        message: { ...partialMessage, content: normalizedContent },
        requestId: streamRequestId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }
      yield assistantMessage
      break

    case 'message_delta':
      // 更新 usage 和 stopReason
      usage = updateUsage(usage, part.usage)
      stopReason = part.delta.stop_reason
      // 计算成本并累加
      const costUSD = calculateCost(usage, model)
      addToTotalSessionCost(costUSD, usage, model)
      break
  }
}
```

### 关键设计：tool_use 的 input 累积

工具调用的输入参数是以 JSON 增量的形式流式到达的。`input_json_delta` 事件携带的是 JSON 片段（如 `{"file_`、`path": "/`、`tmp/foo"`、`}`），需要拼接成完整的 JSON 字符串后再解析：

```typescript
case 'input_json_delta':
  // 注意：这里是字符串拼接，不是 JSON.parse
  // JSON 解析延迟到 content_block_stop 时一次性完成
  contentBlock.input += part.delta.partial_json
  break
```

为什么不在每个 delta 到达时尝试解析？因为 JSON 片段在拼接完成之前是不合法的 JSON——`{"file_` 无法被 `JSON.parse` 处理。只有在 `content_block_stop` 时，完整的 JSON 字符串才可用。

### 流式停滞检测（Watchdog）

长时间运行的流式请求可能"卡住"——服务端不再发送事件，但连接没有断开。`claude.ts` 实现了一个看门狗机制来检测这种情况：

```typescript
// 可配置的空闲超时（默认 90 秒）
const IDLE_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '90000', 10
)

// 在 50% 超时时发出警告
// 在 100% 超时时中止流
```

此外还有**停滞检测**（stall detection）：

```typescript
// 两个事件之间超过 30 秒视为停滞
// 记录停滞次数和总停滞时间
// 用于分析和诊断网络质量问题
logEvent('tengu_streaming_stall', {
  stall_duration_ms,
  stall_count,
  total_stall_time_ms,
  event_type,
  request_id,
})
```

### 流式 → 非流式降级

当流式请求失败时（比如某些网关不支持 SSE），`claude.ts` 会自动降级到非流式请求：

```typescript
// 流式失败后的降级逻辑
try {
  // 尝试流式请求...
} catch (streamError) {
  // 检查是否应该降级
  if (process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) {
    throw streamError  // 用户明确禁止降级
  }

  // 降级到非流式
  const result = await executeNonStreamingRequest({
    ...params,
    stream: false,
    timeout: isRemote ? 120_000 : 300_000,  // 非流式超时更短
    max_tokens: Math.min(params.max_tokens, 64_000),  // 非流式限制 64k
  })

  logEvent('tengu_streaming_fallback_to_non_streaming', { ... })
}
```

降级时有两个重要的参数调整：
- **超时缩短**：非流式请求没有中间事件，无法判断服务端是否在工作，所以用更短的超时
- **max_tokens 限制**：非流式请求的 max_tokens 被限制在 64k，因为非流式响应需要一次性返回所有内容，过大的 max_tokens 会导致极长的等待

### 设计决策讨论

**为什么不用 SDK 的 `BetaMessageStream`？**

Anthropic SDK 提供了一个高级的 `BetaMessageStream` 类，它会自动累积事件并维护一个完整的 `Message` 对象。但 Claude Code 选择使用原始流。原因是性能：`BetaMessageStream` 在每个事件到达后会重新序列化/反序列化整个消息对象，对于包含大量工具调用的长响应，这是 O(n²) 的开销。原始流 + 手动状态机虽然代码更多，但每个事件的处理是 O(1) 的。

**为什么 `content_block_stop` 时才 yield AssistantMessage？**

而不是在每个 `content_block_delta` 时就 yield？因为上层代码（`query.ts`）需要完整的内容块来做决策——比如判断是否是工具调用、提取工具名称和参数。不完整的内容块无法做这些判断。`content_block_stop` 是内容块完整性的保证点。

**TTFB（Time-To-First-Byte）的测量点**

```typescript
case 'message_start':
  ttftMs = Date.now() - start
```

TTFB 在 `message_start` 事件到达时测量，而不是在第一个 `content_block_delta` 时。这是因为 `message_start` 是 API 开始生成响应的信号——从发送请求到收到 `message_start` 的时间反映了网络延迟 + 模型启动延迟，是衡量 API 响应性的关键指标。

---

## 13.5 错误分类与恢复：20+ 种错误的精确识别

### 面临的问题

API 错误不是一个同质的集合。一个 `APIError` 可能意味着完全不同的事情：

- 400 + "prompt is too long" → 上下文溢出，需要压缩
- 400 + "image exceeds 5 MB maximum" → 图片太大，需要缩小
- 400 + "tool_use ids were found without tool_result" → 并发 bug，需要修复
- 400 + "invalid model name" → 模型不可用，需要切换
- 401 → 认证失败，需要重新登录
- 403 + "OAuth token has been revoked" → token 被撤销
- 404 → 模型不存在（3P 部署常见）
- 413 → 请求体太大（PDF + 上下文超过 32MB）
- 429 + 速率限制 headers → 配额耗尽，需要等待或升级
- 529 → 服务端过载，需要重试

每种错误需要不同的用户提示、不同的恢复策略、不同的分析标签。如果只给用户显示 "API Error: 400"，他们完全不知道该怎么办。

### 解法：两层错误处理架构

Claude Code 的错误处理分为两层：

```
API 错误
    │
    ▼
┌─────────────────────────────────────────────┐
│  errors.ts: 面向用户的错误消息生成           │
│  getAssistantMessageFromError()              │
│  ─────────────────────────────────────────── │
│  输入: 原始 Error 对象                        │
│  输出: AssistantMessage (用户可读的错误消息)   │
│  职责: "用户应该看到什么？"                    │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│  errors.ts: 面向分析的错误分类               │
│  classifyAPIError()                          │
│  ─────────────────────────────────────────── │
│  输入: 原始 Error 对象                        │
│  输出: string (标准化的错误类型标签)           │
│  职责: "Datadog 应该记录什么？"               │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│  errorUtils.ts: 底层错误提取                 │
│  extractConnectionErrorDetails()             │
│  getSSLErrorHint()                           │
│  sanitizeAPIError()                          │
│  ─────────────────────────────────────────── │
│  职责: "错误的根因是什么？"                    │
└─────────────────────────────────────────────┘
```

### `getAssistantMessageFromError()` 的匹配链

这个函数是一个长达 500+ 行的 `if-else` 链，按优先级匹配错误类型。它的设计哲学是：**每种错误都应该有一个明确的、可操作的用户提示**。

```typescript
export function getAssistantMessageFromError(
  error: unknown, model: string, options?: { ... }
): AssistantMessage {

  // 1. SDK 超时
  if (error instanceof APIConnectionTimeoutError) {
    return createAssistantAPIErrorMessage({ content: 'Request timed out' })
  }

  // 2. 图片大小错误（API 调用前的本地校验）
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage()  // 交互式: "Double press esc to go back"
    })                                          // 非交互: "Try resizing the image"
  }

  // 3. 429 速率限制（最复杂的分支）
  if (error instanceof APIError && error.status === 429) {
    // 检查新版统一速率限制 headers
    const rateLimitType = error.headers?.get('anthropic-ratelimit-unified-representative-claim')
    const overageStatus = error.headers?.get('anthropic-ratelimit-unified-overage-status')

    if (rateLimitType || overageStatus) {
      // 从 headers 构建 limits 对象，生成精确的错误消息
      const limits: ClaudeAILimits = { ... }
      const message = getRateLimitErrorMessage(limits, model)
      if (message) return createAssistantAPIErrorMessage({ content: message })
      // message 为 null → 静默降级（如 Opus → Sonnet fallback）
      return createAssistantAPIErrorMessage({ content: NO_RESPONSE_REQUESTED })
    }

    // 无配额 headers → 不是配额限制，可能是基础设施 429
    // 提取内部错误消息，给用户看原始信息
    return createAssistantAPIErrorMessage({
      content: `API Error: Request rejected (429) · ${detail || 'check status.anthropic.com'}`
    })
  }

  // 4. Prompt too long（大小写不敏感，因为 Vertex 返回大写）
  if (error.message.toLowerCase().includes('prompt is too long')) {
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      errorDetails: error.message,  // 原始消息存入 errorDetails，供 reactive compact 解析 token 数
    })
  }

  // 5. PDF 错误（页数超限、密码保护、无效文件）
  // 6. 图片大小错误（API 返回的 400）
  // 7. 多图片维度错误（many-image 请求的 2000px 限制）
  // 8. 请求体太大（413）
  // 9. tool_use/tool_result 不匹配（并发 bug）
  // 10. 重复 tool_use ID
  // 11. 无效模型名（订阅用户 vs Ant 用户不同提示）
  // 12. 余额不足
  // 13. 组织被禁用（常见于过期的 ANTHROPIC_API_KEY 环境变量）
  // 14. API Key 无效
  // 15. OAuth token 被撤销
  // 16. OAuth 组织不允许
  // 17. 通用 401/403
  // 18. Bedrock 模型访问错误
  // 19. 404 模型不存在
  // 20. 连接错误（非超时）
  // 21. 通用 Error
  // 22. 兜底：未知错误
}
```

### 错误消息的上下文感知

一个值得注意的设计模式是：**同一种错误在不同上下文下显示不同的消息**。

```typescript
// 交互式 vs 非交互式
export function getPdfTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? `PDF too large (max ${API_PDF_MAX_PAGES} pages). Try reading the file a different way.`
    : `PDF too large (max ${API_PDF_MAX_PAGES} pages). Double press esc to go back and try again.`
}
```

交互式用户可以按 Esc 回退编辑消息，所以提示 "Double press esc"。非交互式用户（SDK 调用）没有这个选项，所以提示替代方案。这种**上下文感知的错误消息**贯穿整个 `errors.ts`。

### 组织被禁用的精细处理

一个特别有趣的错误处理案例是 "Organization has been disabled"：

```typescript
if (error.message.toLowerCase().includes('organization has been disabled')) {
  const { source } = getAnthropicApiKeyWithSource()

  // 只处理环境变量来源的 API Key
  if (source === 'ANTHROPIC_API_KEY' && process.env.ANTHROPIC_API_KEY && !isClaudeAISubscriber()) {
    const hasStoredOAuth = getClaudeAIOAuthTokens()?.accessToken != null
    return createAssistantAPIErrorMessage({
      // 如果用户同时有 OAuth token，提示 "unset env var to use subscription"
      // 否则只提示 "update or unset the env var"
      content: hasStoredOAuth
        ? 'Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead'
        : 'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable',
      error: 'invalid_request',  // 不是 'authentication_failed'！
    })
  }
}
```

这里有三个精妙之处：

1. **只处理环境变量来源**：如果 API Key 来自 `apiKeyHelper` 或 `/login`，说明用户主动配置了这个 key，组织确实被禁用了。但如果来自环境变量，很可能是旧公司/旧项目遗留的，用户可能忘了它的存在。

2. **检查是否有 OAuth 备选**：如果用户同时有 OAuth token（通过 `/login` 登录），提示他们 unset 环境变量就能用订阅了。这是一个**可操作的建议**，而不是一个死胡同。

3. **错误类型是 `invalid_request` 而不是 `authentication_failed`**：注释解释了原因——`authentication_failed` 会触发 VS Code 的 `showLogin()` 弹窗，但 `/login` 无法修复这个问题（环境变量会继续覆盖 OAuth）。正确的修复是配置层面的（unset 环境变量），所以用 `invalid_request`。

### `classifyAPIError()` 的分析标签

`classifyAPIError()` 将错误映射为标准化的字符串标签，用于 Datadog 等分析平台：

| 错误场景 | 分类标签 |
|---------|---------|
| 用户中止 | `aborted` |
| 连接超时 | `api_timeout` |
| 重复 529 | `repeated_529` |
| 容量关闭开关 | `capacity_off_switch` |
| 429 速率限制 | `rate_limit` |
| 529 过载 | `server_overload` |
| Prompt 太长 | `prompt_too_long` |
| PDF 太大 | `pdf_too_large` |
| PDF 密码保护 | `pdf_password_protected` |
| 图片太大 | `image_too_large` |
| tool_use 不匹配 | `tool_use_mismatch` |
| 意外 tool_result | `unexpected_tool_result` |
| 重复 tool_use ID | `duplicate_tool_use_id` |
| 无效模型 | `invalid_model` |
| 余额不足 | `credit_balance_low` |
| API Key 无效 | `invalid_api_key` |
| Token 被撤销 | `token_revoked` |
| OAuth 组织不允许 | `oauth_org_not_allowed` |
| 通用认证错误 | `auth_error` |
| Bedrock 模型访问 | `bedrock_model_access` |
| 5xx 服务端错误 | `server_error` |
| 4xx 客户端错误 | `client_error` |
| SSL 证书错误 | `ssl_cert_error` |
| 连接错误 | `connection_error` |
| 未知 | `unknown` |

### SSL 错误诊断

`errorUtils.ts` 中的 `getSSLErrorHint()` 能识别 29 种 SSL/TLS 错误码，并给出可操作的诊断建议：

```typescript
export function getSSLErrorHint(error: APIConnectionError): string | undefined {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) return undefined

  // 根据错误码给出具体建议
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE → "Corporate proxy? Set NODE_EXTRA_CA_CERTS"
  // CERT_HAS_EXPIRED → "Certificate expired, check system clock or proxy cert"
  // SELF_SIGNED_CERT_IN_CHAIN → "Self-signed cert detected, set NODE_EXTRA_CA_CERTS"
  // ...
}
```

`extractConnectionErrorDetails()` 会**遍历错误的 cause 链**来找到根因：

```typescript
export function extractConnectionErrorDetails(error: APIConnectionError) {
  let current: Error | undefined = error
  while (current) {
    if ('code' in current && typeof current.code === 'string') {
      return {
        code: current.code,
        isSSLError: SSL_ERROR_CODES.has(current.code),
      }
    }
    current = current.cause instanceof Error ? current.cause : undefined
  }
}
```

这是因为 Node.js 的网络错误通常被多层包装：`APIConnectionError` → `FetchError` → `TLSError`。只看最外层的错误消息可能只有 "Connection error"，真正有用的信息（如 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）藏在最内层的 `cause` 中。

---

## 13.6 Prompt Cache 优化：检测隐式的 Cache 失效

### 面临的问题

Anthropic API 支持 Prompt Cache——对于请求中重复的前缀部分（system prompt、工具定义、历史消息），API 可以缓存其 token 化结果，后续请求只需为缓存命中的部分支付较低的费用。对于 Claude Code 这样的多轮对话场景，prompt cache 可以节省 **80-90%** 的输入 token 费用。

但 cache 失效是**隐式的**——API 不会告诉你"你的 cache 失效了，原因是 X"。你只能通过观察 `cache_read_input_tokens` 的突然下降来推断。而导致 cache 失效的原因很多：

- System prompt 变化（Git 状态更新、CLAUDE.md 修改）
- 工具定义变化（MCP 工具上下线）
- 模型切换（`/model` 命令）
- Fast Mode 切换
- Beta header 变化
- `cache_control` 标记位置变化
- Cache TTL 过期（默认 5 分钟）

如果不能诊断 cache 失效的原因，就无法优化——用户只会看到费用突然上升，却不知道为什么。

### 解法：两阶段的 Cache 失效检测

`promptCacheBreakDetection.ts` 实现了一个两阶段的检测机制：

```
Phase 1: 请求前 — recordPromptState()
┌─────────────────────────────────────────┐
│  快照当前状态:                            │
│  • system prompt hash                    │
│  • tool schemas hash (逐工具)            │
│  • model name                            │
│  • fast mode 状态                        │
│  • cache_control scope/TTL               │
│  • beta headers                          │
│  • effort level                          │
│  • extra body params                     │
│  • 上次请求时间戳                         │
└─────────────────────┬───────────────────┘
                      │
                      ▼
              发送 API 请求
                      │
                      ▼
Phase 2: 响应后 — checkResponseForCacheBreak()
┌─────────────────────────────────────────┐
│  比较 cache_read_tokens:                  │
│  • 下降 > 5% AND 绝对下降 > 2000 tokens? │
│  │                                        │
│  ├─ NO → 无 cache break，记录新状态       │
│  │                                        │
│  └─ YES → 检测到 cache break!             │
│     ├─ 对比快照，找出变化的字段             │
│     ├─ 生成详细的 diff 报告               │
│     ├─ 记录分析事件                        │
│     └─ (Ant 用户) 写入 diff 文件          │
└─────────────────────────────────────────┘
```

### 核心源码解读

**Phase 1：状态快照**

```typescript
// promptCacheBreakDetection.ts

export function recordPromptState(params: {
  systemPrompt: string
  toolSchemas: Record<string, unknown>[]
  model: string
  fastMode: boolean
  globalCacheStrategy: string
  betas: string[]
  effort: string | undefined
}): void {
  previousState = {
    systemPromptHash: hashString(params.systemPrompt),
    toolSchemasHash: hashString(JSON.stringify(params.toolSchemas)),
    // 逐工具 hash，用于精确定位哪个工具变了
    perToolHashes: new Map(
      params.toolSchemas.map(t => [t.name, hashString(JSON.stringify(t))])
    ),
    model: params.model,
    fastMode: params.fastMode,
    // ...
    timestamp: Date.now(),
  }
}
```

**Phase 2：Cache Break 检测与归因**

```typescript
export function checkResponseForCacheBreak(params: {
  cacheReadTokens: number
  previousCacheReadTokens: number
  // ... 当前状态参数
}): void {
  const { cacheReadTokens, previousCacheReadTokens } = params

  // 阈值判断：下降 > 5% 且绝对值 > 2000
  const dropPercent = 1 - cacheReadTokens / previousCacheReadTokens
  if (dropPercent < 0.05 || previousCacheReadTokens - cacheReadTokens < 2000) {
    // 不是 cache break，更新状态并返回
    previousState = currentState
    return
  }

  // 检测到 cache break — 归因分析
  const changes: string[] = []

  if (currentState.model !== previousState.model) {
    changes.push(`Model changed: ${previousState.model} → ${currentState.model}`)
  }
  if (currentState.systemPromptHash !== previousState.systemPromptHash) {
    changes.push(`System prompt changed (${charDelta} chars)`)
  }
  if (currentState.toolSchemasHash !== previousState.toolSchemasHash) {
    // 精确到哪些工具被添加/删除/修改
    const added = [...currentTools].filter(t => !previousTools.has(t))
    const removed = [...previousTools].filter(t => !currentTools.has(t))
    changes.push(`Tools changed: +${added.length} -${removed.length}`)
  }
  if (currentState.fastMode !== previousState.fastMode) {
    changes.push(`Fast mode toggled: ${previousState.fastMode} → ${currentState.fastMode}`)
  }
  // ... 更多字段比较

  // TTL 过期检测
  const timeSinceLastRequest = Date.now() - previousState.timestamp
  if (timeSinceLastRequest > 3600_000) {  // > 1 小时
    changes.push(`TTL likely expired (${Math.round(timeSinceLastRequest / 60000)}min gap)`)
  } else if (timeSinceLastRequest > 300_000) {  // > 5 分钟
    changes.push(`TTL may have expired (${Math.round(timeSinceLastRequest / 60000)}min gap)`)
  }

  // 记录分析事件
  logEvent('tengu_prompt_cache_break', {
    drop_percent: dropPercent,
    drop_tokens: previousCacheReadTokens - cacheReadTokens,
    changes: changes.join('; '),
    // ...
  })
}
```

### Cache Breakpoint 放置策略

`claude.ts` 中的 `addCacheBreakpoints()` 函数决定在消息序列的哪个位置放置 `cache_control` 标记：

```
消息序列:
┌──────────────────────────────────────────────┐
│ [system prompt]  ← cache_control (始终缓存)   │
│ [tool schemas]   ← cache_control (始终缓存)   │
│ [message 1]                                   │
│ [message 2]                                   │
│ ...                                           │
│ [message N-1]                                 │
│ [message N]      ← cache_control (最后一条)    │
└──────────────────────────────────────────────┘
```

规则是：**恰好一个 `cache_control` 标记放在最后一条消息上**。这确保了从 system prompt 到最后一条消息的整个前缀都被缓存。下一次请求时，如果前缀没有变化，所有这些 token 都会命中缓存。

有一个特殊情况：`skipCacheWrite`（fire-and-forget 的分支请求）。这种请求不应该写入缓存（因为它的消息序列可能与主对话不同，写入会污染缓存），所以 `cache_control` 标记放在**倒数第二条**消息上——这样前缀仍然可以读取缓存，但最后一条消息不会触发缓存写入。

### 设计决策讨论

**为什么用 hash 比较而不是直接比较？**

System prompt 和 tool schemas 可能非常大（数万字符）。直接比较字符串的开销不可忽略，而且存储两份完整副本也浪费内存。Hash 比较是 O(1) 的，只在检测到 hash 不同时才需要进一步分析。

**为什么 cache break 的阈值是 5% AND 2000 tokens？**

两个条件缺一不可：
- 只看百分比：如果上次 cache_read 只有 100 tokens，下降 10 tokens 就是 10%，但这不是有意义的 cache break
- 只看绝对值：如果上次 cache_read 有 100000 tokens，下降 2000 tokens 只是 2%，可能只是正常波动

双重阈值确保只在**真正有意义的 cache 失效**时触发告警。

---

## 13.7 成本追踪与速率限制

### 面临的问题

Claude Code 的用户需要回答两个关键问题：

1. **"我花了多少钱？"** —— 对于 API Key 用户（按量付费），成本直接关系到钱包；对于订阅用户（Max/Pro），成本间接反映了配额消耗。
2. **"我还能用多少？"** —— 订阅用户有 5 小时/7 天的使用窗口限制，需要知道自己离限额还有多远。

这两个问题看似简单，但实现起来有不少复杂性：

- Token 计费有多个维度：输入 token、输出 token、缓存读取 token（折扣价）、缓存创建 token
- 不同模型有不同的费率
- 速率限制信息分散在 HTTP response headers 中，需要从每次 API 响应中提取
- 速率限制有多种类型（5 小时窗口、7 天窗口、Opus 专用窗口、Sonnet 专用窗口、超额使用窗口）
- 需要在用户接近限额时提前预警，而不是等到被拒绝才告知

### 成本追踪：`cost-tracker.ts`

成本追踪的核心是一个全局的累加器，每次 API 调用完成后更新：

```typescript
// cost-tracker.ts — 核心数据结构

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: {
    [modelName: string]: {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests?: number
    }
  } | undefined
}
```

每次 API 调用成功后，`addToTotalSessionCost()` 被调用：

```typescript
export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): void {
  totalCostUSD += cost

  // 按模型累加 token 用量
  if (!modelUsage[model]) {
    modelUsage[model] = { inputTokens: 0, outputTokens: 0, ... }
  }
  modelUsage[model].inputTokens += usage.input_tokens
  modelUsage[model].outputTokens += usage.output_tokens
  modelUsage[model].cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage[model].cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0

  // OpenTelemetry 指标上报
  otelCostCounter.add(cost)
  otelTokenCounter.add(usage.input_tokens, { type: 'input' })
  otelTokenCounter.add(usage.output_tokens, { type: 'output' })
}
```

会话结束时，`formatTotalCost()` 生成人类可读的成本摘要：

```
Total cost: $1.23
  claude-sonnet-4-20250514: 45.2k input, 12.8k output (8.1k cache read)
  claude-opus-4-20250514: 22.1k input, 5.3k output (18.9k cache read)
Total duration (API): 45.2s
Total duration (tools): 12.8s
```

成本数据还会被持久化到项目配置中（`saveCurrentSessionCosts()`），这样恢复会话时可以继续累加。

### 速率限制状态管理：`claudeAiLimits.ts`

速率限制的状态管理比成本追踪复杂得多，因为它需要从 API 响应的 HTTP headers 中**实时提取**限制信息。

```typescript
// claudeAiLimits.ts — 核心类型

type ClaudeAILimits = {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  unifiedRateLimitFallbackAvailable: boolean  // 是否可以降级到 Sonnet
  resetsAt?: number                           // 限制重置时间戳
  rateLimitType?: RateLimitType               // 哪种限制被触发
  utilization?: number                        // 当前利用率 (0-1)
  overageStatus?: QuotaStatus                 // 超额使用状态
  overageResetsAt?: number                    // 超额使用重置时间
  overageDisabledReason?: OverageDisabledReason  // 超额使用被禁用的原因
  isUsingOverage?: boolean                    // 是否正在使用超额额度
  surpassedThreshold?: number                 // 超过的预警阈值
}

type RateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
```

**从 HTTP Headers 提取限制信息**：

每次 API 响应都携带速率限制相关的 headers：

```
anthropic-ratelimit-unified-representative-claim: five_hour
anthropic-ratelimit-unified-five_hour-surpassed-threshold: 0.8
anthropic-ratelimit-unified-overage-status: allowed
anthropic-ratelimit-unified-overage-disabled-reason: (none)
anthropic-ratelimit-unified-reset: 2025-01-15T10:00:00Z
```

`extractQuotaStatusFromHeaders()` 解析这些 headers 并构建 `ClaudeAILimits` 对象。

**提前预警机制**：

Claude Code 不会等到用户被 429 拒绝才告知——它实现了一个**提前预警系统**：

```typescript
// 从 headers 中读取 surpassed-threshold
// 例如 0.8 表示已使用 80% 的配额
const threshold = headers.get(
  `anthropic-ratelimit-unified-${claim}-surpassed-threshold`
)

if (threshold) {
  limits.status = 'allowed_warning'
  limits.surpassedThreshold = parseFloat(threshold)
}
```

当利用率超过阈值时，UI 底部会显示警告（如 "You're close to your 5-hour limit"），让用户有时间调整使用策略。

### 速率限制消息生成：`rateLimitMessages.ts`

`rateLimitMessages.ts` 负责将 `ClaudeAILimits` 对象转换为用户可读的消息。消息的内容取决于多个因素：

```
限制状态 × 限制类型 × 订阅类型 × 是否有超额额度 → 具体消息
```

例如：
- Max 订阅 + 5 小时限制 + 被拒绝 + 有超额额度 → "You've hit your 5-hour limit. You're now using extra usage credits."
- Pro 订阅 + 7 天限制 + 预警 + 无超额额度 → "You're close to your weekly limit. Consider upgrading to Max."
- Team 订阅 + 被拒绝 + 无超额额度 → "You've hit your limit. Ask your admin to enable extra usage."

```typescript
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): { message: string; severity: 'error' | 'warning' } | null {
  // 优先检查超额使用场景
  if (limits.overageStatus === 'allowed' && limits.isUsingOverage) {
    return { message: getUsingOverageText(limits), severity: 'warning' }
  }

  // 被拒绝
  if (limits.status === 'rejected') {
    return { message: getRateLimitErrorMessage(limits, model), severity: 'error' }
  }

  // 预警
  if (limits.status === 'allowed_warning') {
    return { message: getRateLimitWarning(limits, model), severity: 'warning' }
  }

  return null
}
```

### 设计决策讨论

**为什么成本追踪和速率限制是分开的系统？**

因为它们服务于不同的用户群体：
- **成本追踪**主要服务 API Key 用户（按量付费），他们关心的是美元金额
- **速率限制**主要服务订阅用户（Max/Pro/Team/Enterprise），他们关心的是配额百分比

两者的数据来源也不同：成本是客户端根据 token 数和费率计算的，速率限制是从服务端 headers 中提取的。

**为什么 Team/Enterprise 用户在有超额额度时不显示预警？**

```typescript
// 抑制 Team/Enterprise 的预警（当超额使用可用时）
// 除非用户有计费访问权限
if ((isTeamSubscriber() || isEnterpriseSubscriber()) &&
    limits.overageStatus === 'allowed' &&
    !hasBillingAccess) {
  return null  // 不显示预警
}
```

因为 Team/Enterprise 用户的超额使用由管理员控制和付费。普通成员看到 "You're close to your limit" 会焦虑，但实际上超额使用会自动接管，不会中断工作。只有有计费权限的管理员才需要看到这个预警。

---

## 13.8 认证系统：六种认证方式的统一管理

### 面临的问题

Claude Code 的认证复杂度在 CLI 工具中是罕见的。它需要同时支持：

1. **Claude.ai OAuth 2.0 + PKCE**：订阅用户通过 `/login` 命令在浏览器中完成 OAuth 授权
2. **API Key**：开发者通过环境变量或配置文件提供
3. **AWS IAM**：Bedrock 用户通过 AWS 凭证链（环境变量、配置文件、EC2 实例角色等）
4. **GCP Service Account**：Vertex AI 用户通过 Google 凭证
5. **Azure AD**：Foundry 用户通过 Azure 身份认证
6. **JWT**：CCR（Claude Code Remote）容器环境通过基础设施注入的 JWT

每种认证方式都有自己的**生命周期管理**问题：token 过期、凭证刷新、跨进程竞争、安全存储。

### OAuth 2.0 + PKCE 流程

OAuth 是 Claude.ai 订阅用户的主要认证方式。完整流程如下：

```
用户执行 /login
      │
      ▼
┌─────────────────────────────────────────────────┐
│  1. 生成 PKCE 参数                                │
│     • code_verifier: 32 字节随机值                │
│     • code_challenge: SHA256(code_verifier)       │
│     • state: CSRF 防护随机值                      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  2. 启动本地 HTTP 服务器                          │
│     • 监听 localhost:{随机端口}/callback           │
│     • 等待 OAuth 回调                             │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  3. 打开浏览器                                    │
│     • URL: platform.claude.com/oauth/authorize   │
│     • 参数: client_id, redirect_uri, scope,      │
│       code_challenge, state                       │
└──────────────────────┬──────────────────────────┘
                       │
          用户在浏览器中授权
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  4. 接收回调                                      │
│     • 验证 state 参数（CSRF 防护）                │
│     • 提取 authorization_code                     │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  5. 交换 token                                    │
│     • POST platform.claude.com/v1/oauth/token    │
│     • 参数: code, code_verifier, redirect_uri    │
│     • 返回: access_token, refresh_token,         │
│       expires_at, scopes                          │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  6. 安全存储                                      │
│     • macOS: Keychain (hex 编码防止进程监控泄露)  │
│     • Linux/Windows: 明文文件 (TODO: libsecret)  │
└─────────────────────────────────────────────────┘
```

OAuth Scopes 定义了 token 的权限范围：

| Scope | 用途 |
|-------|------|
| `user:inference` | 长期推理 token |
| `user:profile` | 用户配置文件访问 |
| `org:create_api_key` | Console API Key 创建 |
| `user:sessions:claude_code` | Claude Code 会话管理 |
| `user:mcp_servers` | MCP 服务器管理 |
| `user:file_upload` | 文件上传 |

### Token 刷新与跨进程竞争

OAuth token 有过期时间（通常 1 小时）。当 token 即将过期时，需要用 refresh_token 获取新的 access_token。但 Claude Code 可能有多个进程同时运行（主进程 + 子代理），它们可能同时尝试刷新 token，导致竞争条件。

解法是**跨进程文件锁**：

```typescript
// utils/auth.ts — Token 刷新的跨进程安全

export async function checkAndRefreshOAuthTokenIfNeeded(): Promise<void> {
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens) return

  // 5 分钟缓冲：在过期前 5 分钟就开始刷新
  const bufferMs = 5 * 60 * 1000
  if (tokens.expiresAt > Date.now() + bufferMs) return

  // 跨进程锁：防止多个进程同时刷新
  await withFileLock('oauth-refresh', async () => {
    // 再次检查（可能另一个进程已经刷新了）
    const freshTokens = getClaudeAIOAuthTokens()
    if (freshTokens && freshTokens.expiresAt > Date.now() + bufferMs) return

    const newTokens = await refreshOAuthToken(tokens.refreshToken)
    await saveOAuthTokensIfNeeded(newTokens)
  })
}
```

### 401 错误的自动恢复

当 API 返回 401 时，`withRetry.ts` 会触发 token 刷新并重试：

```typescript
// withRetry.ts 中的 401 处理

if (lastError instanceof APIError && lastError.status === 401) {
  const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
  if (failedAccessToken) {
    // 强制刷新 token（忽略过期时间检查）
    await handleOAuth401Error(failedAccessToken)
  }
  // 用新 token 创建新 client
  client = await getClient()
}
```

`handleOAuth401Error()` 接受失败时使用的 access_token 作为参数——这是为了处理一个微妙的竞争条件：如果另一个进程已经刷新了 token，当前进程的 "旧 token" 已经不是存储中的 token 了，不需要再次刷新。

### 安全存储

macOS 上使用 Keychain 存储 OAuth token，但有一个有趣的细节——token 被 **hex 编码**后再存储：

```typescript
// utils/secureStorage/keychain.ts

// 为什么 hex 编码？
// 因为 macOS `security` 命令的参数会出现在进程列表中 (ps aux)
// 如果直接传递 token 明文，其他用户可以通过 ps 看到
// hex 编码不是加密，但它防止了最常见的泄露途径
```

Linux 和 Windows 目前使用明文文件存储（源码中有 TODO 标记要集成 `libsecret`）。

### 设计决策讨论

**为什么 OAuth 和 API Key 不能共存？**

实际上它们可以共存——但有明确的优先级。如果用户同时设置了 `ANTHROPIC_API_KEY` 环境变量和 OAuth token，API Key 优先。这是因为环境变量通常是**显式的、有意的**配置，而 OAuth token 可能是之前 `/login` 留下的。

但这也导致了一个常见的用户困惑：用户通过 `/login` 登录了 Claude.ai 订阅，但因为 shell 配置中有旧的 `ANTHROPIC_API_KEY`，实际使用的是 API Key（可能属于已禁用的组织）。`errors.ts` 中对 "Organization has been disabled" 错误的精细处理（见 13.5 节）就是为了解决这个问题。

**为什么 CCR 环境用 JWT 而不是 OAuth？**

CCR（Claude Code Remote）是一个受控的容器环境，由 Anthropic 基础设施管理。在这个环境中：
- 没有浏览器，无法完成 OAuth 授权流程
- 容器生命周期短暂，不需要长期 token
- 基础设施可以直接注入 JWT，无需用户交互

JWT 通过文件描述符注入（`/run/ccr/session_token`），读取后立即删除文件，最大限度减少泄露窗口。

---

## 13.9 上游代理与企业网络：穿越公司防火墙

### 面临的问题

在企业环境中，Claude Code 面临一个独特的网络挑战：**出站流量必须经过公司代理**。这在普通 HTTP 客户端中不算难题——设置 `HTTPS_PROXY` 环境变量即可。但 Claude Code 的场景更复杂：

1. **CCR 容器环境**：Claude Code Remote 运行在 Anthropic 管理的容器中，需要通过 Anthropic 的上游代理（upstreamproxy）访问外部网络。这个代理使用 WebSocket 作为传输层（而不是标准的 HTTP CONNECT）。
2. **mTLS（双向 TLS）**：某些企业要求客户端也提供证书（不只是验证服务端证书）。
3. **自定义 CA 证书**：企业代理通常使用自签名证书，需要将其添加到信任链中。
4. **子进程继承**：Claude Code 会 spawn 子进程（BashTool、子代理），这些子进程也需要正确的代理配置。

### 代理配置层：`utils/proxy.ts`

`proxy.ts` 是代理配置的中心枢纽，处理所有与 HTTP/HTTPS 代理相关的逻辑：

```typescript
// utils/proxy.ts — 核心函数

// 获取代理 URL（优先小写变体，符合 Node.js 惯例）
export function getProxyUrl(env = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY ||
         env.http_proxy || env.HTTP_PROXY
}

// 判断 URL 是否应该绕过代理
export function shouldBypassProxy(urlString: string, noProxy?: string): boolean {
  // 支持：精确主机名、域名后缀（.example.com）、通配符 *、端口匹配、IP 地址
}

// 创建带 mTLS 的代理 Agent
export function createHttpsProxyAgent(proxyUrl: string, extra?: {
  cert?: string    // 客户端证书
  key?: string     // 客户端私钥
  ca?: string      // 自定义 CA
}): HttpsProxyAgent {
  // ...
}

// 全局 Agent 配置（在 init() 中调用）
export function configureGlobalAgents(): void {
  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    // 设置 globalThis 的 HTTP/HTTPS agent
    // 所有后续的 fetch/axios 请求都会经过代理
  }
}

// Keep-alive 管理
export function disableKeepAlive(): void {
  // ECONNRESET 后禁用 keep-alive，防止复用已断开的连接
  // 一旦禁用，进程生命周期内不再恢复
}
```

### CONNECT-over-WebSocket 中继：`upstreamproxy/relay.ts`

CCR 环境中的上游代理不使用标准的 HTTP CONNECT 隧道，而是使用 **WebSocket 作为传输层**。`relay.ts` 实现了一个本地中继服务器，将标准的 CONNECT 请求转换为 WebSocket 消息：

```
应用层 (fetch/axios)
    │
    │ HTTPS_PROXY=http://localhost:{port}
    ▼
┌─────────────────────────────────────────┐
│  本地中继服务器 (relay.ts)                │
│  监听 localhost:{ephemeral_port}          │
│                                           │
│  1. 接收 HTTP CONNECT 请求               │
│  2. 解析目标主机:端口                     │
│  3. 建立 WebSocket 连接到上游代理         │
│  4. 将 TCP 字节封装为 protobuf 消息       │
│  5. 双向转发                              │
└──────────────────────┬──────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────┐
│  Anthropic 上游代理 (sidecar)            │
│  • 解封装 protobuf                       │
│  • 建立到目标主机的 TCP 连接             │
│  • 双向转发                              │
└─────────────────────────────────────────┘
```

**Protobuf 消息格式**：

中继使用手工编码的 protobuf（不依赖 protobuf 库，减少依赖）：

```typescript
// relay.ts — 手工 protobuf 编码

// UpstreamProxyChunk { bytes data = 1; }
// Wire format: tag 0x0a + varint length + data
export function encodeChunk(data: Uint8Array): Uint8Array {
  const tag = 0x0a  // field 1, wire type 2 (length-delimited)
  const lenBytes = encodeVarint(data.length)
  const out = new Uint8Array(1 + lenBytes.length + data.length)
  out[0] = tag
  out.set(lenBytes, 1)
  out.set(data, 1 + lenBytes.length)
  return out
}

const MAX_CHUNK_BYTES = 512 * 1024  // 512KB — Envoy per-request buffer cap
const PING_INTERVAL_MS = 30_000     // 30秒心跳（sidecar 空闲超时 50秒）
```

**连接状态机**：

每个 CONNECT 请求经历两个阶段：

```
Phase 1: 累积 CONNECT 请求
┌─────────────────────────────────────────┐
│  接收 TCP 数据，累积直到 \r\n\r\n        │
│  解析: CONNECT host:port HTTP/1.1        │
│  注意: 可能与 ClientHello 合并在同一包中  │
│  → 提取 CONNECT 请求，缓存剩余字节       │
└──────────────────────┬──────────────────┘
                       │
Phase 2: 双向转发
┌──────────────────────▼──────────────────┐
│  建立 WebSocket 连接                     │
│  发送 "200 Connection established"       │
│  转发缓存的剩余字节（如果有）             │
│  双向转发所有后续字节                     │
└─────────────────────────────────────────┘
```

### 安全措施

`upstreamproxy.ts` 中有几个值得注意的安全措施：

```typescript
// upstreamproxy.ts — 安全初始化

export async function initUpstreamProxy(): Promise<void> {
  // 1. 读取 session token
  const token = await readFile('/run/ccr/session_token', 'utf-8')

  // 2. 防止 ptrace 读取堆内存中的 token
  //    prctl(PR_SET_DUMPABLE, 0) 阻止其他进程 attach 到当前进程
  try {
    const { prctl, PR_SET_DUMPABLE } = await import('src/utils/prctl.js')
    prctl(PR_SET_DUMPABLE, 0)
  } catch {}

  // 3. 下载并拼接 CA 证书
  const caBundle = await downloadCaBundle(upstreamProxyUrl, token)
  // 将上游代理的 CA 证书与系统 CA 证书拼接
  const combinedCa = systemCa + '\n' + caBundle
  await writeFile(caPath, combinedCa)

  // 4. 启动本地中继
  const relayPort = await startUpstreamProxyRelay({ wsUrl, token })

  // 5. 删除 token 文件（最小化泄露窗口）
  await unlink('/run/ccr/session_token')

  // 6. 设置环境变量供子进程使用
  process.env.HTTPS_PROXY = `http://localhost:${relayPort}`
  process.env.SSL_CERT_FILE = caPath
}
```

**NO_PROXY 列表**：

中继配置了一个精心设计的 NO_PROXY 列表，确保某些流量不经过代理：

```typescript
const NO_PROXY = [
  'localhost', '127.0.0.1', '::1',           // 回环地址
  '10.0.0.0/8', '172.16.0.0/12',             // RFC1918 私有地址
  '169.254.169.254',                           // AWS IMDS（实例元数据）
  'api.anthropic.com',                         // Anthropic API（直连）
  'github.com', 'api.github.com',             // GitHub
  'registry.npmjs.org', 'pypi.org',           // 包管理器
  'crates.io', 'proxy.golang.org',            // 更多包管理器
].join(',')
```

为什么 `api.anthropic.com` 在 NO_PROXY 中？因为 Anthropic API 的流量已经通过专用通道处理（mTLS + 直连），不需要经过通用代理。包管理器也被排除，因为 `npm install` 等操作不应该被企业代理拦截（它们通常有自己的镜像源）。

### 设计决策讨论

**为什么用 WebSocket 而不是标准的 HTTP CONNECT？**

标准的 HTTP CONNECT 隧道需要代理服务器支持长连接和双向字节流。在 Anthropic 的基础设施中，上游代理运行在 Envoy sidecar 中，WebSocket 是 Envoy 原生支持的双向通信协议，比 CONNECT 更容易管理（负载均衡、健康检查、超时控制等）。

**为什么手工编码 protobuf 而不是用 protobuf 库？**

```typescript
// Hand-encoded protobuf UpstreamProxyChunk messages
// 避免引入 protobuf 运行时依赖
```

protobuf 运行时库（如 `protobufjs`）体积不小，而 `UpstreamProxyChunk` 只有一个 `bytes` 字段，手工编码只需要 ~20 行代码。这是一个**依赖最小化**的决策——在只需要编解码一个简单消息的场景下，引入完整的 protobuf 库是过度工程。

**为什么同时支持 Bun 和 Node.js 的中继实现？**

```typescript
if (typeof Bun !== 'undefined') {
  return startBunRelay(wsUrl, authHeader, wsAuthHeader)
} else {
  return startNodeRelay(wsUrl, authHeader, wsAuthHeader)
}
```

因为 Bun 和 Node.js 的 TCP/WebSocket API 有显著差异（特别是背压处理）。Bun 的 `Bun.listen()` 使用回调式 API，Node.js 的 `net.createServer()` 使用流式 API。两者的背压（backpressure）处理方式也不同——Bun 通过 `socket.data.paused` 标志手动管理，Node.js 通过 `stream.pause()/resume()` 管理。

---

## 13.10 API 日志与可观测性

### 面临的问题

一个 API 通信层如果不可观测，就无法调试、无法优化、无法运营。Claude Code 的 API 层需要回答以下问题：

- **性能**：每次 API 调用花了多长时间？TTFB 是多少？重试了几次？
- **成本**：消耗了多少 token？cache 命中率如何？
- **可靠性**：错误率是多少？哪种错误最常见？哪个网关在出问题？
- **诊断**：用户报告"API 很慢"，如何定位是网络问题、代理问题还是服务端问题？

### 三层日志架构

```
┌─────────────────────────────────────────────────────┐
│  logging.ts: 结构化分析日志                           │
│  • logAPIQuery()    — 请求前记录参数                  │
│  • logAPISuccess()  — 成功后记录指标                  │
│  • logAPIError()    — 失败后记录错误详情              │
│  → 输出到: Statsig/Datadog (logEvent)                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  usage.ts: 用量追踪                                   │
│  • Token 计数 (input/output/cache)                   │
│  • 成本计算 (USD)                                     │
│  • 模型级别的用量聚合                                  │
│  → 输出到: cost-tracker.ts + OpenTelemetry            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  debug.ts: 调试日志                                   │
│  • logForDebugging() — 详细的请求/响应日志            │
│  • 只在 CLAUDE_CODE_DEBUG=stderr 时输出               │
│  → 输出到: stderr                                     │
└─────────────────────────────────────────────────────┘
```

### `logAPISuccess()` 记录的指标

每次成功的 API 调用会记录以下指标到分析平台：

```typescript
logEvent('tengu_api_success', {
  // 模型信息
  model: 'claude-sonnet-4-20250514',
  preNormalizedModel: 'sonnet',           // 用户输入的模型名

  // Token 用量
  inputTokens: 45200,
  outputTokens: 12800,
  cacheReadInputTokens: 38000,
  cacheCreationInputTokens: 7200,

  // 性能指标
  durationMs: 3200,                       // API 调用耗时
  durationMsIncludingRetries: 5800,       // 含重试的总耗时
  ttftMs: 450,                            // Time-To-First-Byte
  attempt: 2,                             // 第几次尝试成功

  // 请求追踪
  requestId: 'req_abc123',                // 服务端请求 ID
  clientRequestId: 'uuid-xyz',            // 客户端请求 ID
  stopReason: 'end_turn',                 // 停止原因

  // 成本
  costUSD: 0.0234,

  // 内容分析
  textContentLength: 1500,                // 文本内容长度
  thinkingContentLength: 800,             // thinking 内容长度
  toolUseContentLengths: { 'Bash': 200, 'FileEdit': 350 },
  connectorTextBlockCount: 0,

  // 上下文信息
  querySource: 'repl_main_thread',
  queryTracking: { chainId: 'chain_1', depth: 3 },
  permissionMode: 'default',
  globalCacheStrategy: 'tool_based',
  fastMode: false,

  // 降级信息
  didFallBackToNonStreaming: false,

  // 网关检测
  gateway: null,                          // 或 'litellm', 'helicone', 'portkey' 等
})
```

### 网关检测

`logging.ts` 中的 `detectGateway()` 函数通过检查响应 headers 来识别用户是否通过 AI 网关代理访问 API：

```typescript
function detectGateway(headers: Headers): string | null {
  // LiteLLM: 'x-litellm-version' header
  if (headers.get('x-litellm-version')) return 'litellm'

  // Helicone: 'helicone-id' header
  if (headers.get('helicone-id')) return 'helicone'

  // Portkey: 'x-portkey-request-id' header
  if (headers.get('x-portkey-request-id')) return 'portkey'

  // ... 更多网关检测
  return null
}
```

为什么要检测网关？因为网关可能引入额外的延迟、修改请求/响应、或导致特定的错误模式。当用户报告问题时，知道他们是否通过网关访问可以快速缩小排查范围。

### 会话日志持久化：`sessionIngress.ts`

对于 CCR（远程容器）和需要会话恢复的场景，`sessionIngress.ts` 将会话日志持久化到远程服务器：

```typescript
// sessionIngress.ts — 核心机制

export async function appendSessionLog(
  sessionId: string,
  entry: SessionLogEntry,
  url: string,
): Promise<void> {
  // 乐观并发控制：使用 Last-Uuid header
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Last-Uuid': lastKnownUuid,  // 乐观锁
    },
    body: JSON.stringify(entry),
  })

  if (response.status === 409) {
    // 冲突：另一个进程已经写入了新条目
    // 采纳服务端的 UUID，下次重试
    lastKnownUuid = response.headers.get('X-Last-Uuid')
  }
}
```

**乐观并发控制**的设计选择：为什么不用悲观锁（如分布式锁）？因为会话日志的写入冲突在实践中很少发生（通常只有一个进程在写），悲观锁的开销（额外的网络往返）在大多数情况下是浪费的。乐观锁只在冲突发生时才有额外开销。

**顺序执行保证**：

```typescript
// 每个 session 有一个顺序执行包装器
// 防止同一 session 的并发写入
const perSessionQueue = new Map<string, Promise<void>>()

async function appendWithSequentialGuard(sessionId, entry, url) {
  const prev = perSessionQueue.get(sessionId) ?? Promise.resolve()
  const next = prev.then(() => doAppend(sessionId, entry, url))
  perSessionQueue.set(sessionId, next)
  return next
}
```

即使在同一进程内，也可能有多个异步操作同时尝试写入同一 session 的日志。通过 Promise 链保证顺序执行，避免了乱序写入。

---

## 13.11 请求构建：从对话状态到 API 参数

### 面临的问题

将 Claude Code 的内部状态转换为 Anthropic Messages API 的请求参数，涉及大量的转换和决策：

- System prompt 需要动态组装（Git 状态、CLAUDE.md、工具描述、MCP 指令……）
- 工具定义需要从内部 `Tool` 类型转换为 API schema
- 消息需要规范化（修复 tool_use/tool_result 配对、限制媒体数量、处理 advisor 块）
- Beta headers 需要根据当前功能状态动态组合
- Cache control 标记需要精确放置

### `paramsFromContext()` 的参数构建

`claude.ts` 中的 `paramsFromContext()` 函数是请求构建的核心，它将所有上下文信息转换为 API 请求参数：

```typescript
// claude.ts — paramsFromContext() 输出的参数结构

{
  model: string,                    // 规范化后的模型名
  messages: MessageParam[],         // 规范化后的消息（含 cache breakpoints）
  system: TextBlockParam[],         // System prompt 块（含 cache_control）
  tools: BetaToolUnion[],           // 工具 schema 列表
  tool_choice?: ToolChoice,         // 工具选择策略
  betas: string[],                  // 动态 beta headers
  metadata: {
    user_id: string,                // JSON: { device_id, account_uuid, session_id }
  },
  max_tokens: number,               // 输出 token 上限
  thinking?: {                      // 思考配置
    type: 'adaptive' | 'enabled',
    budget_tokens?: number,
  },
  temperature?: number,             // 仅在 thinking 禁用时设置
  speed?: 'fast',                   // Fast Mode
  output_config?: {
    effort?: string,                // 努力级别
    format?: JSONOutputFormat,      // 结构化输出
    task_budget?: {                 // 任务预算
      type: 'tokens',
      total: number,
      remaining?: number,
    },
  },
}
```

### Beta Headers 的动态组合

Beta headers 不是静态的——它们根据当前会话状态动态组合：

```typescript
const betas: string[] = []

// 1M 上下文窗口（Sonnet 实验）
if (isEligibleFor1MContext(model)) {
  betas.push(CONTEXT_1M_BETA_HEADER)
}

// Fast Mode（会话级锁定——一旦启用，整个会话保持）
if (isFastModeEnabled() && retryContext.fastMode) {
  betas.push(FAST_MODE_BETA_HEADER)
}

// AFK Mode（自动模式激活时锁定）
if (isAutoModeActive()) {
  betas.push(AFK_MODE_BETA_HEADER)
}

// Prompt Cache 编辑（cached microcompact 功能）
if (isCacheEditingEnabled()) {
  betas.push(CACHE_EDITING_BETA_HEADER)
}

// 更多 beta headers...
```

注意 "latched"（锁定）的概念：某些 beta headers 一旦在会话中启用，就不会再关闭。这是为了**保持 prompt cache 的稳定性**——如果 beta headers 在请求之间变化，会导致 cache 失效。

### 消息规范化

`normalizeMessagesForAPI()` 处理内部消息格式到 API 格式的转换，包括几个关键的修复操作：

1. **tool_use/tool_result 配对修复**：确保每个 `tool_use` 都有对应的 `tool_result`
2. **媒体数量限制**：单次请求最多 100 个媒体项（图片、PDF）
3. **advisor 块处理**：如果当前请求不支持 advisor beta，移除 advisor 相关的内容块
4. **角色交替**：确保消息严格按 user/assistant 交替排列（API 要求）

---

## 13.12 总结：API 服务层的设计哲学

回顾整个 API 服务层的架构，可以提炼出几个核心的设计哲学：

### 1. 分层隔离，各司其职

```
claude.ts  → "请求长什么样？"
withRetry  → "失败了怎么办？"
client.ts  → "发给谁？用什么凭证？"
errors.ts  → "出了什么错？告诉用户什么？"
```

每一层只关心自己的问题，不越界。这使得系统可以独立演进——新增提供商只改 `client.ts`，新增错误类型只改 `errors.ts`，新增重试策略只改 `withRetry.ts`。

### 2. 错误是一等公民

API 服务层花了大量代码在错误处理上——`errors.ts` + `errorUtils.ts` + `withRetry.ts` 的错误处理逻辑加起来超过 2000 行。这不是过度工程，而是对现实的尊重：**在分布式系统中，错误路径比正常路径更重要。** 正常路径只有一条，错误路径有几十条，每条都需要正确处理。

### 3. 用户体验驱动的错误消息

每种错误都有一个**可操作的**用户提示，而不是技术性的错误码。"Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead" 比 "403 Forbidden" 有用得多。

### 4. 系统思维的重试策略

重试不是"再试一次"那么简单。`withRetry.ts` 考虑了：
- 对服务端的影响（后台查询不重试 529，避免重试风暴）
- 对用户的影响（Fast Mode 降级保护 prompt cache）
- 对成本的影响（持久模式等待 reset 而不是盲目轮询）
- 对安全的影响（401 触发 token 刷新而不是简单重试）

### 5. 可观测性内建

日志、指标、追踪不是事后添加的，而是从一开始就内建在每个层中。每次 API 调用都会记录 20+ 个维度的指标，每种错误都有标准化的分类标签，每个请求都有客户端 ID 用于关联。这使得问题诊断从"猜测"变成了"查询"。

### 关键源码索引

| 关注点 | 核心文件 | 入口函数 |
|--------|---------|---------|
| 请求构建 | `services/api/claude.ts` | `queryModel()`, `paramsFromContext()` |
| 流式处理 | `services/api/claude.ts` | `queryModel()` 内的 for-await 循环 |
| 重试降级 | `services/api/withRetry.ts` | `withRetry()` |
| 客户端创建 | `services/api/client.ts` | `getAnthropicClient()` |
| 错误处理 | `services/api/errors.ts` | `getAssistantMessageFromError()` |
| 错误分类 | `services/api/errors.ts` | `classifyAPIError()` |
| SSL 诊断 | `services/api/errorUtils.ts` | `getSSLErrorHint()` |
| Cache 检测 | `services/api/promptCacheBreakDetection.ts` | `checkResponseForCacheBreak()` |
| 成本追踪 | `cost-tracker.ts` | `addToTotalSessionCost()` |
| 速率限制 | `services/claudeAiLimits.ts` | `extractQuotaStatusFromHeaders()` |
| OAuth 认证 | `services/oauth/client.ts` | `exchangeCodeForTokens()` |
| Token 刷新 | `utils/auth.ts` | `checkAndRefreshOAuthTokenIfNeeded()` |
| 代理配置 | `utils/proxy.ts` | `configureGlobalAgents()` |
| 上游代理 | `upstreamproxy/relay.ts` | `startUpstreamProxyRelay()` |
| API 日志 | `services/api/logging.ts` | `logAPISuccessAndDuration()` |
| 会话持久化 | `services/api/sessionIngress.ts` | `appendSessionLog()` |
| 启动配置 | `services/api/bootstrap.ts` | `fetchBootstrapData()` |
