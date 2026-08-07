---
title: Claude Code 源码解析（十七）· 遥测与分析
description: '如何在充分尊重用户隐私的前提下收集产品使用数据？事件日志、诊断追踪、Opt-out 机制如何工程化落地？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十七章：遥测与分析（Telemetry & Analytics）

> 产品洞察的数据基础——如何在尊重隐私的前提下收集使用数据。

## 核心问题

一个开发者工具的遥测系统，表面上只是"发送一些事件到后端"，但 Claude Code 面临的遥测问题远比这复杂：

1. **隐私与洞察的根本矛盾。** Claude Code 能读写用户文件、执行 shell 命令、访问代码仓库——它接触的几乎全是敏感数据。产品团队需要知道"用户用了哪些工具"、"哪些操作失败了"，但绝不能泄露用户的代码、文件路径或个人信息。如何在收集有用数据的同时，从架构层面杜绝 PII 泄露？

2. **多后端、多受众的数据路由。** 遥测数据不是发到一个地方就完事。Datadog 用于实时告警和运维监控，1P（First Party）事件日志用于产品分析和 BigQuery 数据仓库，OpenTelemetry 用于企业客户的自建可观测性平台。每个后端对数据格式、隐私级别、采样策略的要求都不同。

3. **不能影响核心体验。** 遥测是"旁路"系统——它不能拖慢启动速度，不能阻塞用户操作，不能因为网络问题导致进程挂起。但同时又不能丢太多数据，否则产品决策就失去了数据基础。

4. **企业合规与用户控制。** 企业客户（Bedrock/Vertex/API 用户）可能完全禁止遥测；个人用户可能选择 opt-out；组织级别可能有独立的 metrics 开关。这些控制必须在架构层面被尊重，而不是靠每个事件发送点去检查。

5. **Feature Flag 的鸡生蛋问题。** GrowthBook（Feature Flag 系统）本身依赖网络请求来获取配置，但遥测系统的行为又受 Feature Flag 控制（比如 Datadog 开关、事件采样率）。启动时 Feature Flag 可能还没就绪，怎么办？

**Claude Code 的解法是一个分层的遥测架构**——通过 Sink 抽象解耦事件生产与消费，通过类型系统强制 PII 审查，通过磁盘缓存实现 Feature Flag 的冷启动，通过多层隐私控制实现从全局到组织到个人的精细化管控。

---

## 17.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        事件生产层                                    │
│  query.ts / tools/ / hooks/ / services/ ...                         │
│  调用 logEvent(name, metadata) 或 logEventAsync(name, metadata)     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Analytics 入口 (index.ts)                         │
│  ┌──────────────┐                                                   │
│  │  Event Queue  │ ← sink 未就绪时暂存事件                           │
│  └──────┬───────┘                                                   │
│         │ attachAnalyticsSink() 后排空                               │
│         ▼                                                           │
│  ┌──────────────┐                                                   │
│  │ Analytics Sink│ ← 路由层 (sink.ts)                               │
│  └──────┬───────┘                                                   │
│         │                                                           │
│    ┌────┴────────────────────┐                                      │
│    │    采样 + Killswitch     │                                      │
│    │  shouldSampleEvent()    │                                      │
│    │  isSinkKilled()         │                                      │
│    └────┬───────────┬────────┘                                      │
│         │           │                                               │
└─────────┼───────────┼───────────────────────────────────────────────┘
          │           │
          ▼           ▼
┌─────────────┐ ┌──────────────────────────────────────────────┐
│   Datadog    │ │          1P Event Logger                      │
│  (datadog.ts)│ │     (firstPartyEventLogger.ts)                │
│             │ │                                                │
│ • 白名单事件 │ │  ┌─────────────────────────────────┐          │
│ • 批量发送   │ │  │ OpenTelemetry LoggerProvider     │          │
│ • 15s 刷新   │ │  │  └─ BatchLogRecordProcessor      │          │
│ • 基数压缩   │ │  │      └─ 1P EventLoggingExporter  │          │
│ • 用户分桶   │ │  │          ├─ POST /api/event_*    │          │
│             │ │  │          ├─ 磁盘缓存 (失败重试)    │          │
│ stripProto  │ │  │          └─ 二次退避重试           │          │
│ Fields() ──►│ │  └─────────────────────────────────┘          │
│ (去除 PII)  │ │                                                │
└─────────────┘ └──────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    GrowthBook (Feature Flags)                       │
│  • 磁盘缓存 → 冷启动可用                                            │
│  • Remote Eval → 服务端计算                                         │
│  • 周期刷新 (6h/20min)                                              │
│  • 控制: Datadog 开关 / 事件采样率 / Sink Killswitch                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              OpenTelemetry (企业客户 / 可选)                         │
│  • Metrics → BigQuery / OTLP / Prometheus                           │
│  • Logs → OTLP                                                      │
│  • Traces → OTLP / Perfetto (BETA)                                  │
│  • 独立于 1P 事件日志，面向企业自建可观测性                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      隐私控制层                                      │
│  DISABLE_TELEMETRY ──────────────────► no-telemetry                 │
│  CLAUDE_CODE_DISABLE_NONESSENTIAL ───► essential-traffic            │
│  Bedrock / Vertex / Foundry ─────────► analytics disabled           │
│  Org-level metrics opt-out ──────────► BigQuery metrics disabled    │
│  Grove "Help improve Claude" ────────► consumer toggle              │
└─────────────────────────────────────────────────────────────────────┘
```

这个架构有几个关键设计决策值得注意：

- **Sink 模式解耦生产与消费**：事件生产方（`logEvent`）完全不知道事件会发到哪里，甚至不知道 sink 是否已就绪。这让启动期的事件不会丢失（队列暂存），也让新增后端只需修改 sink 层。
- **双通道隐私分级**：Datadog 是"通用访问"后端，通过 `stripProtoFields()` 剥离所有 PII 标记字段；1P 是"特权访问"后端，PII 字段被路由到受控的 BigQuery 列。同一个事件，两个后端看到的数据不同。
- **Feature Flag 的磁盘缓存**：GrowthBook 的值在每次成功获取后写入 `~/.claude.json`，下次启动时直接从磁盘读取，不需要等网络请求。这解决了"鸡生蛋"问题。

---

## 17.2 Analytics 入口与 Sink 模式

### 面临的问题

遥测系统有一个经典的启动时序问题：事件生产方（工具执行、API 调用等）在应用启动的很早期就开始产生事件，但事件消费方（Datadog、1P Logger）需要完成初始化后才能接收事件。如果生产方直接依赖消费方，要么丢失早期事件，要么引入循环依赖。

更棘手的是，`logEvent` 被整个代码库广泛调用——从 `query.ts` 到 `tools/` 到 `hooks/` 到 `utils/gracefulShutdown.ts`。如果这个函数导入了任何重量级模块（OpenTelemetry、axios、GrowthBook），就会把这些模块拉入几乎所有文件的依赖图，严重影响启动速度。

### 解法：零依赖入口 + 延迟绑定 Sink

`src/services/analytics/index.ts` 的设计原则是：**零外部依赖，纯内存队列，延迟绑定**。

```typescript
// src/services/analytics/index.ts

// 注意：这个文件没有任何外部 import！
// 这是刻意为之——避免导入链污染
// 文件头注释明确写道：
// DESIGN: This module has NO dependencies to avoid import cycles.

// Event queue for events logged before sink is attached
const eventQueue: QueuedEvent[] = []

// Sink - initialized during app startup
let sink: AnalyticsSink | null = null

export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,  // 故意不允许 string 类型值
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}
```

这段代码的精妙之处在于：

1. **零导入**：文件顶部没有任何 `import` 语句（除了类型导出）。这意味着无论谁导入 `logEvent`，都不会触发额外的模块加载。

2. **队列暂存**：sink 就绪前的事件被推入内存队列，不会丢失。

3. **异步排空**：当 sink 绑定时，队列通过 `queueMicrotask` 异步排空，避免阻塞启动路径：

```typescript
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) return  // 幂等——可从多处安全调用
  sink = newSink

  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0

    // 异步排空，不阻塞启动
    queueMicrotask(() => {
      for (const event of queuedEvents) {
        sink!.logEvent(event.eventName, event.metadata)
      }
    })
  }
}
```

4. **类型级 PII 防护**：metadata 的值类型被限制为 `boolean | number | undefined`——**故意不允许 `string`**。如果需要传字符串，必须显式转型为一个冗长的标记类型，这个类型名本身就是代码审查提醒：

```typescript
// 这个类型名就是最好的文档——每次 cast 都是一次自我审查
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

// 用于 PII 标记字段（路由到 BigQuery 特权列）
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

这是一种"类型即文档"的设计模式——通过让类型名本身传达意图，强制开发者在每次传入字符串时思考："这个值是否包含代码或文件路径？"

### Sink 路由层

`src/services/analytics/sink.ts` 是实际的路由实现，在 `initializeAnalyticsSink()` 时绑定到入口层：

```typescript
// src/services/analytics/sink.ts

function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // 1. 采样检查——由 GrowthBook 动态配置
  const sampleResult = shouldSampleEvent(eventName)
  if (sampleResult === 0) return  // 被采样掉，两个后端都不发

  const metadataWithSampleRate =
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata

  // 2. 路由到 Datadog（剥离 PII 字段）
  if (shouldTrackDatadog()) {
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 3. 路由到 1P（保留完整 payload，包括 _PROTO_* 字段）
  logEventTo1P(eventName, metadataWithSampleRate)
}
```

关键的路由逻辑：
- **采样在路由前执行**：一次采样决策，两个后端共享结果。采样率通过 GrowthBook 动态配置（`tengu_event_sampling_config`），可以按事件名设置不同的采样率。
- **Datadog 收到的是"脱敏版"**：`stripProtoFields()` 移除所有 `_PROTO_*` 前缀的字段。
- **1P 收到的是"完整版"**：`_PROTO_*` 字段被 1P Exporter 提取并路由到 BigQuery 的特权列。

### `_PROTO_*` 双通道隐私机制

这是 Claude Code 遥测系统中最精巧的隐私设计之一。问题是：某些分析场景需要知道具体的 MCP 服务器名或 Skill 名（比如"哪个 MCP 工具最常出错"），但这些名称可能包含用户配置信息，属于中等 PII。

解法是**双通道**：

```
事件 payload:
{
  toolName: "mcp_tool",                    // 脱敏后的通用名（所有后端可见）
  _PROTO_skill_name: "my-custom-skill",    // 原始值（仅 1P 特权列可见）
  _PROTO_plugin_name: "my-plugin",         // 原始值（仅 1P 特权列可见）
  ...
}

                    ┌─── stripProtoFields() ──► Datadog（只看到 toolName: "mcp_tool"）
事件 payload ───────┤
                    └─── 1P Exporter ────────► BigQuery 特权列（看到原始名称）
```

`stripProtoFields()` 的实现也很高效——只在发现 `_PROTO_` 前缀时才创建新对象，否则返回原引用（零拷贝）：

```typescript
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }  // 惰性拷贝
      }
      delete result[key]
    }
  }
  return result ?? metadata  // 无 _PROTO_ 字段时零拷贝
}
```

### 设计决策讨论

**为什么不用发布-订阅模式？** 传统的事件系统通常用 EventEmitter 或类似的发布-订阅模式。但 Claude Code 选择了更简单的"单 sink"模式。原因是：遥测后端的数量是固定的（Datadog + 1P），不需要动态订阅的灵活性；单 sink 的代码路径更可预测，更容易推理"这个事件会发到哪里"。

**为什么 `attachAnalyticsSink` 是幂等的？** 因为它可能从两个地方被调用——Commander.js 的 `preAction` hook（用于子命令）和 `setup()`（用于默认命令）。幂等设计避免了调用方之间的协调问题。

**为什么队列排空用 `queueMicrotask` 而不是同步执行？** 因为排空队列可能触发网络请求（通过 Datadog 和 1P），同步执行会阻塞启动路径。微任务在当前同步代码完成后立即执行，既不丢失事件，又不阻塞启动。

---

## 17.3 Datadog 后端：实时运维监控

### 面临的问题

产品团队需要实时监控 Claude Code 的健康状况——API 错误率是否飙升？OAuth 刷新是否正常？某个版本是否引入了回归？这需要一个低延迟、支持聚合查询和告警的后端。

但 Datadog 是一个"通用访问"平台——运维团队、产品团队、甚至外部合作方都可能查看。这意味着发送到 Datadog 的数据必须经过严格的脱敏处理，且事件类型必须受控（不能随意添加新事件导致成本失控）。

### 解法：白名单 + 基数压缩 + 用户分桶

`src/services/analytics/datadog.ts` 的核心设计围绕三个约束展开：

#### 1. 事件白名单

不是所有事件都发送到 Datadog——只有明确列入白名单的事件才会被接受：

```typescript
// src/services/analytics/datadog.ts

const DATADOG_ALLOWED_EVENTS = new Set([
  'tengu_api_error',
  'tengu_api_success',
  'tengu_cancel',
  'tengu_exit',
  'tengu_init',
  'tengu_model_fallback_triggered',
  'tengu_oauth_error',
  'tengu_oauth_success',
  'tengu_query_error',
  'tengu_started',
  'tengu_tool_use_error',
  'tengu_tool_use_success',
  'tengu_uncaught_exception',
  'tengu_unhandled_rejection',
  // ... 约 40 个事件
])
```

这个白名单的意义不仅是成本控制——它也是一种**隐私边界声明**：只有经过审查的事件类型才能进入 Datadog。新增事件必须显式添加到白名单，这迫使开发者在添加时思考"这个事件是否适合发送到通用访问后端"。

#### 2. 基数压缩（Cardinality Reduction）

Datadog 按唯一标签组合计费，高基数字段（如模型名、版本号、MCP 工具名）会导致成本爆炸。Claude Code 在发送前做了多层基数压缩：

```typescript
// MCP 工具名 → 统一为 "mcp"
if (typeof allData.toolName === 'string' && allData.toolName.startsWith('mcp__')) {
  allData.toolName = 'mcp'
}

// 模型名 → 规范化为已知短名，未知的归为 "other"
if (process.env.USER_TYPE !== 'ant' && typeof allData.model === 'string') {
  const shortName = getCanonicalName(allData.model.replace(/\[1m]$/i, ''))
  allData.model = shortName in MODEL_COSTS ? shortName : 'other'
}

// 开发版本号截断：去除时间戳和 SHA
// "2.0.53-dev.20251124.t173302.sha526cc6a" → "2.0.53-dev.20251124"
if (typeof allData.version === 'string') {
  allData.version = allData.version.replace(
    /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
    '$1',
  )
}
```

每一层压缩都有明确的理由：
- MCP 工具名包含用户配置的服务器名（PII），且组合数无上限
- 模型名可能包含自定义后缀（如 `[1m]`），需要规范化
- 开发版本的时间戳+SHA 组合会产生无限基数

#### 3. 用户分桶（User Bucketing）

告警通常需要知道"有多少用户受影响"，而不仅仅是"有多少事件"。但直接发送用户 ID 既是隐私问题，也是基数问题。Claude Code 的解法是**用户分桶**：

```typescript
const NUM_USER_BUCKETS = 30

const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})
```

将用户 ID 哈希后映射到 30 个桶中的一个。这样：
- **隐私**：无法从桶号反推用户身份
- **基数**：只有 30 个可能的值，不会导致标签爆炸
- **估算**：通过统计"有多少个不同的桶出现了错误"，可以粗略估算受影响的用户数量。如果 30 个桶中有 15 个出现了错误，说明大约 50% 的用户受影响

#### 4. 批量发送

事件不是逐条发送的，而是批量积攒后统一发送：

```typescript
const DEFAULT_FLUSH_INTERVAL_MS = 15000  // 15 秒刷新
const MAX_BATCH_SIZE = 100               // 最多 100 条
const NETWORK_TIMEOUT_MS = 5000          // 5 秒超时

let logBatch: DatadogLog[] = []

// 事件入队
logBatch.push(log)

// 满了立即发，否则定时发
if (logBatch.length >= MAX_BATCH_SIZE) {
  void flushLogs()
} else {
  scheduleFlush()  // setTimeout 15s，.unref() 不阻止进程退出
}
```

`scheduleFlush()` 中的 `.unref()` 是一个关键细节——它确保定时器不会阻止 Node.js 进程自然退出。如果用户在 15 秒内退出了 Claude Code，`gracefulShutdown` 会显式调用 `shutdownDatadog()` 来刷新剩余事件。

#### 5. 多重门控

Datadog 事件的发送受多重条件控制：

```typescript
export async function trackDatadogEvent(eventName, properties): Promise<void> {
  // 门控 1: 非生产环境不发送
  if (process.env.NODE_ENV !== 'production') return

  // 门控 2: 第三方 API 提供商不发送
  if (getAPIProvider() !== 'firstParty') return

  // 门控 3: 初始化检查（含 analytics disabled 检查）
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }

  // 门控 4: 白名单检查
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) return

  // 通过所有门控，构建并入队事件...
}
```

### 设计决策讨论

**为什么选择 30 个用户桶？** 这是精度和基数之间的权衡。桶数太少（如 5 个），估算精度太低；桶数太多（如 1000 个），接近直接发送用户 ID。30 个桶意味着每个桶大约代表 3.3% 的用户群，对于"是否有大规模问题"的判断已经足够。

**为什么用 `status` 字段要特殊处理？** Datadog 有一个保留字段叫 `status`，如果直接发送会被 Datadog 解释为日志级别。Claude Code 将 HTTP 状态码重命名为 `http_status` 并额外计算 `http_status_range`（如 `4xx`、`5xx`），避免与 Datadog 保留字段冲突。

**为什么 Datadog 只接受 firstParty 提供商的事件？** Bedrock/Vertex/Foundry 用户的 API 调用不经过 Anthropic 的服务器，Anthropic 无权收集这些用户的使用数据。这是合规要求，不是技术限制。

---

## 17.4 1P 事件日志：产品分析的核心管道

### 面临的问题

Datadog 适合实时告警，但不适合深度产品分析——它的查询能力有限，存储成本高，且数据经过了基数压缩，丢失了很多细节。产品团队需要一个能回答"哪些 MCP 工具最常被使用"、"不同订阅类型的用户行为有何差异"、"GrowthBook 实验的效果如何"等问题的分析管道。

这个管道需要：
- 接收**所有**事件（不仅是白名单内的）
- 保留更丰富的元数据（包括受控的 PII 字段）
- 具备可靠的投递保证（网络故障不能丢数据）
- 支持 GrowthBook 实验曝光追踪

### 解法：基于 OpenTelemetry 的 1P 事件管道

Claude Code 构建了一个独立的 1P（First Party）事件日志管道，架构如下：

```
logEventTo1P(eventName, metadata)
        │
        ▼
┌─────────────────────────────────────────────┐
│  firstPartyEventLogger (OTel Logger)         │
│  • 元数据富化 (getEventMetadata)             │
│  • 构建 OTel LogRecord                       │
│  • emit() 到 LoggerProvider                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  BatchLogRecordProcessor                     │
│  • 批量积攒 (默认 200 条 / 10 秒)            │
│  • 触发 export()                             │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  FirstPartyEventLoggingExporter              │
│  • 转换为 Proto 格式                         │
│  • 分块发送 (每批最多 200 条)                 │
│  • POST /api/event_logging/batch             │
│  ┌─────────────────────────────────────┐     │
│  │ 失败处理:                            │     │
│  │  1. 追加写入磁盘 (~/.claude/telemetry/) │  │
│  │  2. 二次退避重试 (base * attempts²)  │     │
│  │  3. 最多 8 次尝试后丢弃              │     │
│  │  4. 401 时尝试无认证重试             │     │
│  └─────────────────────────────────────┘     │
│  ┌─────────────────────────────────────┐     │
│  │ 启动时:                              │     │
│  │  扫描并重试上次会话的失败事件         │     │
│  └─────────────────────────────────────┘     │
└─────────────────────────────────────────────┘
```

#### 为什么复用 OpenTelemetry 而不是自建？

一个关键的架构决策是：1P 事件管道复用了 OpenTelemetry 的 `LoggerProvider` 和 `BatchLogRecordProcessor`，但**不使用全局 OTel 注册表**。

```typescript
// src/services/analytics/firstPartyEventLogger.ts

// IMPORTANT: 从本地 provider 获取 logger，不是 logs.getLogger()
// 因为 logs.getLogger() 返回全局 provider 的 logger，
// 那个是给企业客户 OTLP 遥测用的
firstPartyEventLogger = firstPartyEventLoggerProvider.getLogger(
  'com.anthropic.claude_code.events',
  MACRO.VERSION,
)
```

这个决策的原因是：
- **隔离性**：1P 内部事件绝不能泄露到企业客户的 OTLP 端点，反之亦然
- **复用性**：OTel 的 `BatchLogRecordProcessor` 已经实现了高效的批量处理、背压控制和优雅关闭，没必要重新发明
- **可配置性**：批量大小、刷新间隔等参数可以通过 GrowthBook 动态调整

### FirstPartyEventLoggingExporter：可靠投递引擎

`src/services/analytics/firstPartyEventLoggingExporter.ts` 是整个 1P 管道中最复杂的组件，它解决的核心问题是：**如何在不可靠的网络环境中实现尽力而为的事件投递？**

#### 磁盘缓存 + 二次退避

当网络请求失败时，事件不是直接丢弃，而是追加写入磁盘：

```typescript
// 失败事件存储路径: ~/.claude/telemetry/1p_failed_events.<sessionId>.<batchUUID>.json
// 格式: JSON Lines (每行一个事件)

private async queueFailedEvents(events: FirstPartyEventLoggingEvent[]): Promise<void> {
  const filePath = this.getCurrentBatchFilePath()
  // 追加写入——原子操作，并发安全
  await this.appendEventsToFile(filePath, events)
}
```

重试策略使用**二次退避**（quadratic backoff），而不是常见的指数退避：

```typescript
private scheduleBackoffRetry(): void {
  // 二次退避: base * attempts² (匹配 Statsig SDK 的策略)
  const delay = Math.min(
    this.baseBackoffDelayMs * this.attempts * this.attempts,
    this.maxBackoffDelayMs,  // 上限 30 秒
  )
  // ...
}
```

为什么选择二次退避而不是指数退避？注释中说"matching Statsig SDK"——这是为了与之前使用的 Statsig SDK 保持行为一致，降低迁移风险。二次退避比指数退避增长更慢（`n²` vs `2ⁿ`），在短暂网络抖动时能更快恢复。

#### 短路机制

当一个批次发送失败时，后续批次不会继续尝试——直接短路，将所有未发送的批次一起写入磁盘：

```typescript
// 第一个批次失败后，短路所有后续批次
for (let i = 0; i < batches.length; i++) {
  try {
    await this.sendBatchWithRetry({ events: batch })
  } catch (error) {
    // 将当前批次 + 所有剩余批次一起入队
    for (let j = i; j < batches.length; j++) {
      failedBatchEvents.push(...batches[j]!)
    }
    break  // 短路——不再尝试后续批次
  }
}
```

这个设计的逻辑是：如果第一个批次失败了，说明端点可能不可用，继续发送后续批次只会浪费时间和带宽。等退避重试时再统一处理。

#### 跨会话恢复

Exporter 在启动时会扫描磁盘上的失败事件文件，尝试重新发送：

```typescript
private async retryPreviousBatches(): Promise<void> {
  const prefix = `${FILE_PREFIX}${getSessionId()}.`
  let files = (await readdir(getStorageDir()))
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .filter(f => !f.includes(BATCH_UUID))  // 排除当前批次

  for (const file of files) {
    void this.retryFileInBackground(filePath)
  }
}
```

注意文件名中包含 `sessionId` 和 `BATCH_UUID`——这确保了：
- 同一会话的不同进程实例（如 reinitialize 后）不会互相干扰
- 不同会话的失败事件被隔离处理

#### 认证降级

当遇到 401 错误时，Exporter 会尝试无认证重试：

```typescript
private async sendBatchWithRetry(payload): Promise<void> {
  try {
    await this.sendBatch(payload, false)  // 带认证
  } catch (error) {
    if (isAxios401(error) && !this.skipAuth) {
      await this.sendBatch(payload, true)  // 无认证重试
    } else {
      throw error
    }
  }
}
```

这处理的是 OAuth token 过期但尚未刷新的窗口期——无认证的请求仍然可以被服务端接受（通过其他身份标识如 device ID）。

### 事件元数据富化

每个 1P 事件在发送前都会被富化大量上下文信息。`src/services/analytics/metadata.ts` 中的 `getEventMetadata()` 收集：

```typescript
export type EventMetadata = {
  model: string              // 当前使用的模型
  sessionId: string          // 会话 ID
  userType: string           // ant / external
  betas?: string             // 启用的 beta 特性
  envContext: EnvContext      // 环境上下文（见下）
  entrypoint?: string        // 入口点 (cli / sdk / bridge)
  isInteractive: string      // 是否交互式会话
  clientType: string         // 客户端类型
  processMetrics?: ProcessMetrics  // 进程指标
  agentId?: string           // Agent ID（团队模式）
  parentSessionId?: string   // 父会话 ID
  subscriptionType?: string  // 订阅类型 (max/pro/enterprise/team)
  rh?: string                // 仓库远程 URL 的哈希（前 16 字符 SHA256）
  kairosActive?: true        // KAIROS 模式
  skillMode?: string         // Skill 发现机制
  // ...
}

export type EnvContext = {
  platform: string           // darwin / linux / win32 / wsl
  arch: string               // x64 / arm64
  nodeVersion: string        // Node.js 版本
  terminal: string | null    // 终端类型
  packageManagers: string    // 检测到的包管理器
  runtimes: string           // 检测到的运行时
  isCi: boolean              // 是否 CI 环境
  isGithubAction: boolean    // 是否 GitHub Actions
  version: string            // Claude Code 版本
  wslVersion?: string        // WSL 版本
  linuxDistroId?: string     // Linux 发行版
  vcs?: string               // 版本控制系统类型
  // ... 约 30 个字段
}
```

`rh`（repo hash）字段值得特别说明——它是仓库远程 URL 的 SHA256 哈希的前 16 个字符。这允许在服务端将同一仓库的事件关联起来（用于分析"这个仓库的用户行为"），但无法从哈希反推出仓库 URL。

### 动态重初始化

1P 管道支持在运行时重新初始化——当 GrowthBook 配置变化时（比如批量大小、端点 URL 改变），管道会自动重建：

```typescript
// src/services/analytics/firstPartyEventLogger.ts

export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {
  const newConfig = getBatchConfig()
  if (isEqual(newConfig, lastBatchConfig)) return  // 配置未变，跳过

  // 1. 先置空 logger——并发调用会命中 guard 直接返回
  const oldProvider = firstPartyEventLoggerProvider
  firstPartyEventLogger = null

  // 2. 刷新旧 provider 的缓冲区
  await oldProvider.forceFlush()

  // 3. 用新配置重建
  firstPartyEventLoggerProvider = null
  try {
    initialize1PEventLogging()
  } catch (e) {
    // 重建失败——恢复旧 provider，等下次 GrowthBook 刷新再试
    firstPartyEventLoggerProvider = oldProvider
    firstPartyEventLogger = oldLogger
    return
  }

  // 4. 后台关闭旧 provider
  void oldProvider.shutdown().catch(() => {})
}
```

这个重初始化过程的关键是**事件不丢失**：
- 步骤 1 置空 logger 后，并发的 `logEventTo1P()` 调用会命中 `!firstPartyEventLogger` guard 直接返回——丢失少量事件，但避免了向正在关闭的 provider 发送
- 步骤 2 的 `forceFlush()` 确保旧缓冲区中的事件被导出。导出失败的事件会写入磁盘，而磁盘文件路径由 `BATCH_UUID + sessionId` 决定，跨重初始化不变——新 Exporter 会自动拾取
- 步骤 3 失败时恢复旧 provider，确保系统不会进入"两个 provider 都为 null"的死锁状态

### 设计决策讨论

**为什么用 JSON Lines 而不是 SQLite 做磁盘缓存？** JSON Lines 的追加写入是原子操作（在大多数文件系统上），不需要锁，天然支持并发写入。SQLite 虽然查询能力更强，但引入了额外的依赖和锁竞争。对于"写入失败事件、启动时读取并重试"这个简单场景，JSON Lines 是最轻量的选择。

**为什么最多重试 8 次就丢弃？** 这是可靠性和存储之间的权衡。8 次二次退避（500ms * 1, 4, 9, 16, 25, 36, 49, 64）总计约 100 秒。如果 100 秒内端点仍不可用，继续重试的价值很低，但磁盘文件会持续增长。丢弃是合理的——遥测数据本身就是"尽力而为"的。

---

## 17.5 GrowthBook：Feature Flag 与实验平台

### 面临的问题

Claude Code 需要一个 Feature Flag 系统来控制功能的渐进式发布、A/B 实验、以及遥测系统自身的行为（如 Datadog 开关、事件采样率）。但这个系统面临几个独特的挑战：

1. **冷启动问题**：Feature Flag 的值需要从服务端获取，但很多消费方在启动的极早期就需要读取 flag 值（比如 Datadog 开关决定了是否初始化 Datadog）。不能阻塞启动等网络请求。

2. **长会话问题**：Claude Code 的会话可能持续数小时。如果 flag 值只在启动时获取一次，那么紧急的 killswitch 无法在运行中生效。

3. **离线可用性**：用户可能在没有网络的环境中使用 Claude Code（如飞机上）。Feature Flag 系统不能因为网络不可用就崩溃。

4. **实验曝光追踪**：A/B 实验需要记录"哪个用户看到了哪个变体"，这个曝光事件必须准确且不重复。

### 解法：Remote Eval + 磁盘缓存 + 周期刷新

`src/services/analytics/growthbook.ts` 实现了一个三层缓存架构：

```
┌─────────────────────────────────────────────────────────┐
│                    读取优先级                              │
│                                                           │
│  1. 环境变量覆盖 (CLAUDE_INTERNAL_FC_OVERRIDES)           │
│     └─ ant-only，用于测试和 eval harness                  │
│                                                           │
│  2. /config 本地覆盖 (growthBookOverrides)                │
│     └─ ant-only，运行时通过 /config Gates 设置            │
│                                                           │
│  3. 内存缓存 (remoteEvalFeatureValues Map)                │
│     └─ 来自最近一次成功的 Remote Eval 响应                │
│                                                           │
│  4. 磁盘缓存 (~/.claude.json → cachedGrowthBookFeatures) │
│     └─ 上次成功获取后写入，跨会话持久化                    │
│                                                           │
│  5. 默认值 (调用方提供的 fallback)                         │
│     └─ 所有缓存都未命中时使用                              │
└─────────────────────────────────────────────────────────┘
```

#### Remote Eval 模式

Claude Code 使用 GrowthBook 的 **Remote Eval** 模式——flag 的计算在服务端完成，客户端只接收结果：

```typescript
const client = new GrowthBook({
  remoteEval: true,  // 服务端计算
  clientKey: getGrowthBookClientKey(),
  attributes: getUserAttributes(),  // 用户属性发送到服务端用于定向
})
```

为什么选择 Remote Eval 而不是本地计算？
- **安全性**：flag 的规则（如"只对 enterprise 用户开启"）不会暴露给客户端
- **简单性**：客户端不需要实现复杂的规则引擎
- **一致性**：服务端计算确保所有客户端看到相同的结果

但 Remote Eval 有一个 SDK 兼容性问题——API 返回的格式与 SDK 期望的不一致：

```typescript
// API 返回: { "value": ... }
// SDK 期望: { "defaultValue": ... }
// WORKAROUND: 手动转换
for (const [key, feature] of Object.entries(payload.features)) {
  const f = feature as MalformedFeatureDefinition
  if ('value' in f && !('defaultValue' in f)) {
    transformedFeatures[key] = { ...f, defaultValue: f.value }
  }
}
```

更严重的是，SDK 的 `evalFeature()` 在 Remote Eval 模式下会尝试本地重新计算规则，忽略服务端已经计算好的值。Claude Code 的解决方案是**绕过 SDK 的 evalFeature**，直接缓存 Remote Eval 的结果：

```typescript
// 直接缓存服务端计算的值，不依赖 SDK 的 evalFeature
remoteEvalFeatureValues.clear()
for (const [key, feature] of Object.entries(transformedFeatures)) {
  const v = 'value' in feature ? feature.value : feature.defaultValue
  if (v !== undefined) {
    remoteEvalFeatureValues.set(key, v)
  }
}
```

#### 磁盘缓存与冷启动

每次成功获取 Remote Eval 结果后，完整的 feature map 被写入 `~/.claude.json`：

```typescript
function syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) return  // 未变化，跳过写入

  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}
```

这解决了冷启动问题——下次启动时，`getFeatureValue_CACHED_MAY_BE_STALE()` 可以直接从磁盘读取上次的值，不需要等网络请求：

```typescript
// 函数名本身就是文档：返回的值可能是过期的
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  // 优先级 1: 环境变量覆盖
  const envOverrides = getEnvOverrides()
  if (envOverrides && feature in envOverrides) {
    return envOverrides[feature] as T
  }

  // 优先级 2: /config 本地覆盖
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  // 优先级 3: 内存缓存（来自 Remote Eval）
  if (remoteEvalFeatureValues.has(feature)) {
    logExposureForFeature(feature)  // 记录实验曝光
    return remoteEvalFeatureValues.get(feature) as T
  }

  // 优先级 4: 磁盘缓存
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
  if (cached !== undefined) {
    return cached as T
  }

  // 优先级 5: 默认值
  return defaultValue
}
```

注意函数名中的 `_CACHED_MAY_BE_STALE` 后缀——这是一种命名约定，提醒调用方：返回的值可能不是最新的。对于安全敏感的 gate（如版本 killswitch），应该使用 `checkGate_CACHED_OR_BLOCKING()`，它会在首次调用时阻塞等待 Remote Eval 完成。

#### 周期刷新

长会话中，GrowthBook 会周期性地刷新 feature 值：

```typescript
// 外部用户: 6 小时刷新一次
// 内部用户 (ant): 20 分钟刷新一次
const refreshInterval = process.env.USER_TYPE === 'ant'
  ? 20 * 60 * 1000
  : 6 * 60 * 60 * 1000
```

刷新后，通过 `onGrowthBookRefresh` 信号通知所有订阅者：

```typescript
// 注册刷新监听器
export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))

  // 如果 init 已完成，立即触发一次（处理竞态）
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => {
      if (subscribed && remoteEvalFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => { subscribed = false; unsubscribe() }
}
```

这个"立即触发"的设计处理了一个微妙的竞态条件：在外部构建中，GrowthBook 的网络响应可能在 ~100ms 内返回，而 REPL 的 `useEffect` 可能需要 ~600ms 才能挂载。如果监听器注册时 init 已经完成，不立即触发就会错过初始值。

#### 实验曝光追踪

GrowthBook 的 A/B 实验需要记录"用户被分配到了哪个变体"。Claude Code 在 feature 被首次访问时记录曝光：

```typescript
function logExposureForFeature(feature: string): void {
  // 会话内去重——每个 feature 最多记录一次
  if (loggedExposures.has(feature)) return

  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    loggedExposures.add(feature)
    logGrowthBookExperimentTo1P({
      experimentId: expData.experimentId,
      variationId: expData.variationId,
      userAttributes: getUserAttributes(),
    })
  }
}
```

曝光事件通过 1P 管道发送，格式为 `GrowthbookExperimentEvent`（与普通的 `ClaudeCodeInternalEvent` 不同的 proto 类型）。

#### Sink Killswitch

GrowthBook 还控制着一个紧急开关——可以在不发版的情况下关闭特定的遥测后端：

```typescript
// src/services/analytics/sinkKillswitch.ts

// 故意使用混淆名称，避免被轻易发现和滥用
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'

export function isSinkKilled(sink: SinkName): boolean {
  const config = getDynamicConfig_CACHED_MAY_BE_STALE<
    Partial<Record<SinkName, boolean>>
  >(SINK_KILLSWITCH_CONFIG_NAME, {})
  return config?.[sink] === true
}
```

注意配置名 `tengu_frond_boric` 是故意混淆的——这是一个安全实践，避免 killswitch 的名称过于明显而被恶意利用。

### 设计决策讨论

**为什么不用 LaunchDarkly 或 Statsig？** 从代码中的注释可以看出，Claude Code 之前使用过 Statsig（多处提到"matching Statsig SDK"、"similar to logEventToStatsig"）。迁移到 GrowthBook + 自建 1P 管道的原因可能包括：减少第三方依赖、更好的数据控制、以及与 Anthropic 内部基础设施的集成。

**为什么磁盘缓存是全量替换而不是增量合并？** `syncRemoteEvalToDisk()` 每次都写入完整的 feature map，而不是只更新变化的部分。这是因为：如果服务端删除了一个 feature，增量合并无法感知这个删除；全量替换确保磁盘缓存与服务端状态一致。注释中明确说明了这一点："features deleted server-side are dropped from disk on the next successful payload"。

**为什么 ant 用户的刷新间隔是 20 分钟而外部用户是 6 小时？** 内部用户（ant）需要更快地看到 feature flag 变化的效果（比如测试新的实验配置），而外部用户的 flag 变化频率低得多，6 小时的刷新间隔足以覆盖大多数场景，同时减少了对 GrowthBook 服务端的请求压力。

---

## 17.6 隐私控制体系

### 面临的问题

Claude Code 的用户群体极其多样——个人开发者、企业团队、通过 Bedrock/Vertex 接入的云客户、CI/CD 环境中的自动化代理。每类用户对隐私的要求不同：

- 个人用户可能愿意分享使用数据以改善产品
- 企业客户可能有严格的数据合规要求，禁止任何遥测
- 云客户（Bedrock/Vertex）的数据主权属于云提供商，Anthropic 无权收集
- 组织管理员可能需要在组织级别统一控制 metrics 开关

这些需求不能靠一个简单的"开/关"来满足——需要一个**分层的、可组合的**隐私控制体系。

### 解法：三级隐私模型 + 多维度门控

#### 三级隐私模型

`src/utils/privacyLevel.ts` 定义了三个递进的隐私级别：

```typescript
type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

// 限制性递增: default < no-telemetry < essential-traffic

export function getPrivacyLevel(): PrivacyLevel {
  // 最严格的信号优先
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'essential-traffic'
  }
  if (process.env.DISABLE_TELEMETRY) {
    return 'no-telemetry'
  }
  return 'default'
}
```

三个级别的影响范围：

| 级别 | 遥测事件 | 自动更新 | Grove | 发布说明 | 模型能力查询 | API 调用 |
|------|---------|---------|-------|---------|------------|---------|
| `default` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `no-telemetry` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `essential-traffic` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

`essential-traffic` 级别只保留 API 调用——这是 Claude Code 运行的最低网络需求。这个级别适用于严格的网络隔离环境（如某些企业内网）。

#### 多维度门控

隐私级别只是门控的一个维度。`src/services/analytics/config.ts` 中的 `isAnalyticsDisabled()` 综合了多个维度：

```typescript
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||                    // 测试环境
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||   // Bedrock 客户
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||    // Vertex 客户
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||   // Foundry 客户
    isTelemetryDisabled()                                  // 隐私级别检查
  )
}
```

注意 `isFeedbackSurveyDisabled()` 的门控逻辑与 `isAnalyticsDisabled()` 不同——反馈调查不阻止 3P 提供商用户：

```typescript
export function isFeedbackSurveyDisabled(): boolean {
  // 不检查 Bedrock/Vertex/Foundry——调查是本地 UI 提示，
  // 不发送 transcript 数据，企业客户通过 OTEL 捕获响应
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
```

这个区分体现了一个重要原则：**门控的粒度应该匹配数据的敏感度**。反馈调查只是一个本地 UI 弹窗，不涉及用户数据传输，所以不需要被 3P 提供商门控阻止。

#### 组织级 Metrics Opt-Out

除了用户级别的隐私控制，还有组织级别的 metrics 开关。`src/services/api/metricsOptOut.ts` 实现了一个两级缓存的 opt-out 检查：

```
组织管理员设置 opt-out
        │
        ▼
┌─────────────────────────────────────┐
│  /api/claude_code/organizations/     │
│  metrics_enabled                     │
│  (服务端 API)                        │
└──────────────────┬──────────────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
   ┌──────────┐     ┌──────────────┐
   │ 磁盘缓存  │     │  内存缓存     │
   │ 24h TTL  │     │  1h TTL      │
   └──────────┘     └──────────────┘
```

两级缓存的设计意图：
- **内存缓存（1h TTL）**：避免频繁的磁盘 I/O
- **磁盘缓存（24h TTL）**：避免频繁的网络请求，同时确保 opt-out 决策在合理时间内生效

这个 opt-out 只影响 BigQuery metrics（通过 OpenTelemetry 导出的指标），不影响 1P 事件日志和 Datadog。这是因为 BigQuery metrics 包含更详细的使用数据，组织管理员可能出于合规原因需要禁用。

### PII 保护的多层防线

Claude Code 的 PII 保护不是靠单一机制，而是多层防线的组合：

```
┌─────────────────────────────────────────────────────────────┐
│  第 1 层: 类型系统                                            │
│  • metadata 值类型限制为 boolean | number | undefined         │
│  • 字符串必须显式 cast 为 _I_VERIFIED_THIS_IS_NOT_CODE_*     │
│  • 编译期强制，无法绕过                                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 2 层: 工具名脱敏                                          │
│  • MCP 工具名 → "mcp_tool" (sanitizeToolNameForAnalytics)    │
│  • 仅在特定条件下保留原始名称:                                 │
│    - 官方 MCP 注册表中的工具                                   │
│    - claude.ai 代理的连接器                                    │
│    - 内置 MCP 服务器 (如 computer-use)                        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 3 层: 文件路径脱敏                                        │
│  • 只提取文件扩展名，不记录完整路径                             │
│  • 扩展名超过 10 字符 → "other" (防止哈希文件名泄露)          │
│  • Bash 命令中只从白名单命令提取扩展名                         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 4 层: 工具输入截断                                        │
│  • 字符串 > 512 字符 → 截断到 128 字符                        │
│  • 嵌套深度 > 2 → "<nested>"                                 │
│  • 集合元素 > 20 → 截断                                      │
│  • 总 JSON 长度 > 4KB → 截断                                 │
│  • 以 _ 开头的内部标记键被过滤                                 │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 5 层: _PROTO_* 双通道                                     │
│  • 需要 PII 的字段用 _PROTO_ 前缀标记                         │
│  • Datadog 路径: stripProtoFields() 移除                      │
│  • 1P 路径: 提取到 BigQuery 特权列                            │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 6 层: Datadog 基数压缩                                    │
│  • 用户 ID → 30 个桶                                         │
│  • 模型名 → 规范化短名                                       │
│  • 版本号 → 去除时间戳和 SHA                                  │
└─────────────────────────────────────────────────────────────┘
```

这种"纵深防御"的设计意味着：即使某一层被绕过（比如开发者忘记脱敏工具名），后续层仍然能提供保护。

### 工具名脱敏的精细化控制

`src/services/analytics/metadata.ts` 中的工具名脱敏逻辑值得深入分析。MCP 工具名的格式是 `mcp__<server>__<tool>`，其中 server 名可能包含用户配置信息（如 `mcp__my-company-slack__read_channel`）。

默认情况下，所有 MCP 工具名都被脱敏为 `mcp_tool`。但在以下条件下保留原始名称：

```typescript
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  // 条件 1: Cowork 模式（无 ZDR 概念）
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return true

  // 条件 2: claude.ai 代理的连接器（始终是官方的）
  if (mcpServerType === 'claudeai-proxy') return true

  // 条件 3: URL 匹配官方 MCP 注册表
  if (mcpServerBaseUrl && isOfficialMcpUrl(mcpServerBaseUrl)) return true

  return false
}
```

这个逻辑的核心思想是：**只有"公开已知"的 MCP 服务器名才能被记录**。用户自己配置的私有 MCP 服务器名被视为 PII，必须脱敏。

### 设计决策讨论

**为什么隐私级别用环境变量而不是配置文件？** 环境变量的优势是：可以在不修改任何文件的情况下生效（比如在 CI/CD 中设置），且优先级高于任何配置文件。对于隐私控制这种"必须被尊重"的设置，环境变量是最可靠的机制。

**为什么 `essential-traffic` 不直接禁用所有网络？** 因为 Claude Code 的核心功能（与 LLM 对话）依赖 API 调用。`essential-traffic` 的语义是"只保留功能运行所必需的网络请求"，而不是"完全离线"。这个命名也暗示了设计意图——它不是一个"离线模式"，而是一个"最小网络模式"。

**为什么文件扩展名长度限制是 10 字符？** 常见的文件扩展名（`.ts`、`.tsx`、`.json`、`.py`、`.java`）都远短于 10 字符。超过 10 字符的"扩展名"通常不是真正的扩展名，而是哈希文件名的一部分（如 `.key-hash-abcd-123-456`），可能包含敏感信息。10 字符是一个保守的阈值，覆盖了所有合理的扩展名。

---

## 17.7 OpenTelemetry：企业级可观测性

### 面临的问题

前面讨论的 Datadog 和 1P 管道都是 Anthropic 内部的遥测系统——数据流向 Anthropic 的后端。但企业客户有自己的可观测性平台（Datadog、Grafana、Splunk 等），他们需要将 Claude Code 的使用数据接入自己的监控体系。

这带来了一个根本性的架构挑战：**如何让同一个应用同时向两套完全独立的遥测后端发送数据，且互不干扰？**

- 内部遥测（1P 事件）绝不能泄露到客户的 OTLP 端点
- 客户遥测绝不能被路由到 Anthropic 的内部后端
- 两套系统的初始化时机、配置方式、数据格式都不同

### 解法：双 Provider 隔离架构

Claude Code 使用 OpenTelemetry 标准协议为企业客户提供可观测性，但通过**双 Provider 隔离**确保内部和外部遥测完全分离：

```
┌─────────────────────────────────────────────────────────────┐
│                    内部遥测 (1P)                              │
│                                                               │
│  firstPartyEventLoggerProvider (本地实例)                      │
│  └─ Logger: 'com.anthropic.claude_code.events'               │
│     └─ BatchLogRecordProcessor                                │
│        └─ FirstPartyEventLoggingExporter                      │
│           └─ POST /api/event_logging/batch                    │
│                                                               │
│  ⚠️ 不注册到全局 OTel API                                     │
│  ⚠️ 通过 provider.getLogger() 获取，不是 logs.getLogger()     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    企业遥测 (3P / OTLP)                       │
│                                                               │
│  全局 MeterProvider (注册到 OTel API)                         │
│  ├─ OTLP Metrics Exporter (gRPC / HTTP)                      │
│  ├─ Prometheus Exporter                                       │
│  └─ BigQuery Metrics Exporter                                 │
│                                                               │
│  全局 LoggerProvider (注册到 OTel API)                        │
│  └─ OTLP Log Exporter                                        │
│                                                               │
│  全局 TracerProvider (注册到 OTel API)                        │
│  └─ OTLP Trace Exporter                                      │
│                                                               │
│  ✅ 注册到全局 OTel API                                       │
│  ✅ 通过标准 OTel 环境变量配置                                 │
└─────────────────────────────────────────────────────────────┘
```

关键的隔离点在 `firstPartyEventLogger.ts` 中：

```typescript
// IMPORTANT: 从本地 provider 获取 logger，不是 logs.getLogger()
// logs.getLogger() 返回全局 provider 的 logger，那个是给企业客户用的
firstPartyEventLogger = firstPartyEventLoggerProvider.getLogger(
  'com.anthropic.claude_code.events',
  MACRO.VERSION,
)
```

### 三信号支持：Metrics / Logs / Traces

`src/utils/telemetry/instrumentation.ts` 实现了 OpenTelemetry 的三个信号（signal）：

#### Metrics（指标）

企业客户可以通过标准 OTLP 协议导出 Claude Code 的使用指标。支持三种导出协议：

```typescript
// 根据 OTEL_EXPORTER_OTLP_PROTOCOL 选择协议
switch (protocol) {
  case 'grpc':
    // 懒加载 @grpc/grpc-js (~700KB)
    const { OTLPMetricExporter } = await import(
      '@opentelemetry/exporter-metrics-otlp-grpc'
    )
    break
  case 'http/json':
    const { OTLPMetricExporter } = await import(
      '@opentelemetry/exporter-metrics-otlp-http'
    )
    break
  case 'http/protobuf':
    const { OTLPMetricExporter } = await import(
      '@opentelemetry/exporter-metrics-otlp-proto'
    )
    break
}
```

注意所有 exporter 都是**懒加载**的——通过 `await import()` 而不是顶层 `import`。这是因为 OTLP 相关模块总计约 1.2MB（gRPC 额外 700KB），而大多数用户不会启用 OTLP 导出。懒加载确保这些模块只在实际需要时才被加载。

#### BigQuery Metrics Exporter

除了标准 OTLP 导出，Claude Code 还有一个专用的 BigQuery 指标导出器，面向 API 客户和企业订阅用户：

```typescript
// src/utils/telemetry/bigqueryExporter.ts

function isBigQueryMetricsEnabled() {
  // 启用条件:
  // 1. API 客户（非 Claude.ai 订阅者，非 Bedrock/Vertex）
  // 2. Claude for Enterprise (C4E) 用户
  // 3. Claude for Teams 用户
  const subscriptionType = getSubscriptionType()
  const isC4EOrTeamUser =
    isClaudeAISubscriber() &&
    (subscriptionType === 'enterprise' || subscriptionType === 'team')

  return is1PApiCustomer() || isC4EOrTeamUser
}
```

BigQuery Exporter 有几个值得注意的设计：

1. **Delta 聚合**：强制使用 Delta 时间性（而非 Cumulative），注释中甚至有警告："DO NOT CHANGE THIS TO CUMULATIVE — It would mess up the aggregation of metrics for CC Productivity metrics dashboard"

2. **组织级 opt-out**：每次导出前检查 `checkMetricsEnabled()`，尊重组织管理员的 opt-out 决策

3. **信任前置**：在交互式模式下，必须等用户接受信任对话框后才开始导出，避免在用户同意前就发送数据

4. **5 分钟导出间隔**：比标准 OTLP 的 60 秒间隔更长，减少对 BigQuery 的写入压力

#### Logs（日志）

企业客户可以通过 OTLP 导出 Claude Code 的事件日志。`src/utils/telemetry/events.ts` 提供了 `logOTelEvent()` 函数：

```typescript
export async function logOTelEvent(
  eventName: string,
  metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  const eventLogger = getEventLogger()
  if (!eventLogger) return

  const attributes: Attributes = {
    ...getTelemetryAttributes(),
    'event.name': eventName,
    'event.timestamp': new Date().toISOString(),
    'event.sequence': eventSequence++,  // 单调递增，保证会话内排序
  }

  // 用户提示内容默认被脱敏
  // 需要显式设置 OTEL_LOG_USER_PROMPTS=1 才能记录
  eventLogger.emit({ body: `claude_code.${eventName}`, attributes })
}
```

关键的隐私控制：`OTEL_LOG_USER_PROMPTS` 环境变量控制是否记录用户提示内容。默认情况下，所有用户输入都被替换为 `<REDACTED>`：

```typescript
export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}
```

#### Traces（追踪）

Session Tracing 是 Claude Code 最复杂的遥测功能，目前处于 BETA 阶段。它为每个用户交互创建一个追踪树：

```
Interaction Span (根 span)
├── LLM Request Span
│   └── (API 调用耗时、token 数等)
├── Tool Span: "Bash"
│   ├── Blocked-on-User Span (等待权限确认)
│   ├── Execution Span (实际执行)
│   └── Hook Span (PostToolUse hook)
├── LLM Request Span
│   └── ...
└── Tool Span: "FileEdit"
    └── ...
```

`src/utils/telemetry/sessionTracing.ts` 使用 `AsyncLocalStorage` 实现 span 上下文传播：

```typescript
const interactionContext = new AsyncLocalStorage<SpanContext | undefined>()
const toolContext = new AsyncLocalStorage<SpanContext | undefined>()

// 活跃 span 使用 WeakRef 防止内存泄漏
const activeSpans = new Map<string, WeakRef<SpanContext>>()
// 非 ALS 管理的 span 需要强引用
const strongSpans = new Map<string, SpanContext>()
```

为什么同时使用 `WeakRef` 和强引用？
- ALS 管理的 span（interaction、tool）：ALS 持有强引用，`activeSpans` 用 `WeakRef`——当 ALS 清除时，GC 可以回收
- 非 ALS 管理的 span（LLM request、blocked-on-user、execution、hook）：需要 `strongSpans` 持有强引用，防止在 `end*` 函数调用前被 GC 回收

还有一个安全网——30 分钟的清理间隔，回收"孤儿 span"（因异常中断而未被正常结束的 span）：

```typescript
const SPAN_TTL_MS = 30 * 60 * 1000 // 30 minutes

function ensureCleanupInterval(): void {
  if (_cleanupIntervalStarted) return
  _cleanupIntervalStarted = true
  const interval = setInterval(() => {
    for (const [spanId, weakRef] of activeSpans) {
      const ctx = weakRef.deref()
      if (ctx === undefined) {
        activeSpans.delete(spanId)  // WeakRef 已失效
      } else if (ctx.startTime < cutoff) {
        if (!ctx.ended) ctx.span.end()  // 超时强制结束
        activeSpans.delete(spanId)
      }
    }
  }, 60_000)
  interval.unref()  // 不阻止进程退出
}
```

#### Perfetto 追踪

除了 OTel 追踪，Claude Code 还支持 Perfetto 格式的追踪——这是 Chrome DevTools 使用的追踪格式，可以在 `chrome://tracing` 中可视化：

```bash
# 启用 Perfetto 追踪
CLAUDE_CODE_PERFETTO_TRACE=1 claude
# 或指定输出路径
CLAUDE_CODE_PERFETTO_TRACE=/tmp/trace.json claude
```

Perfetto 追踪与 OTel 追踪是**并行独立**的——它有自己的生命周期，不依赖 OTel 的 TracerProvider。这允许在不配置 OTLP 端点的情况下进行本地性能分析。

### 初始化时序

遥测系统的初始化是一个精心编排的过程，分布在多个阶段：

```
┌─────────────────────────────────────────────────────────────┐
│  Stage 1: init() (entrypoints/init.ts)                       │
│  • initialize1PEventLogging() — 动态导入，不阻塞启动          │
│  • 注册 GrowthBook 刷新监听器                                 │
│  • setupGracefulShutdown()                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Stage 2: initializeAnalyticsSink() (main.tsx setupBackend)  │
│  • 绑定 sink，排空事件队列                                    │
│  • initializeAnalyticsGates() — 读取 Datadog 开关            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Stage 3: initializeTelemetryAfterTrust()                    │
│  • 等待信任对话框接受                                         │
│  • 对 remote-settings 用户: 等待远程设置加载                  │
│  • 懒加载 instrumentation.ts (~400KB OTel 模块)              │
│  • 初始化 Metrics / Logs / Traces providers                  │
│  • 初始化 Perfetto                                           │
└─────────────────────────────────────────────────────────────┘
```

关键的设计决策是 **OTel 模块的懒加载**：

```typescript
// entrypoints/init.ts

// initializeTelemetry 通过 import() 懒加载，延迟 ~400KB 的 OTel + protobuf 模块
// gRPC exporter (~700KB) 在 instrumentation.ts 内部进一步懒加载
async function setMeterState(): Promise<void> {
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  const meter = await initializeTelemetry()
  // ...
}
```

这意味着如果用户没有启用 OTLP 遥测，这 400KB+ 的模块永远不会被加载。

### 设计决策讨论

**为什么 BigQuery Exporter 不走标准 OTLP？** BigQuery 的数据模型与 OTLP 不完全兼容——OTLP 的 metric 格式需要在服务端做额外转换才能写入 BigQuery。直接使用自定义格式（`/api/claude_code/metrics`）可以让服务端直接写入，减少中间环节。

**为什么 Perfetto 和 OTel Traces 并行存在？** 它们服务于不同的场景：OTel Traces 用于生产环境的分布式追踪（发送到远程后端），Perfetto 用于本地开发调试（生成本地文件，在 Chrome DevTools 中查看）。两者的数据格式和消费方式完全不同，合并反而会增加复杂度。

**为什么 `event.sequence` 用单调递增计数器而不是时间戳？** 时间戳的精度可能不足以区分同一毫秒内的多个事件，而且在不同机器上时钟可能不同步。单调递增计数器保证了会话内事件的严格排序，且不依赖时钟精度。

---

## 17.8 生命周期管理：初始化与优雅关闭

### 面临的问题

遥测系统的生命周期管理面临两个极端场景：

**启动时**：遥测子系统众多（1P Logger、Datadog、GrowthBook、OTel Metrics/Logs/Traces），它们之间有复杂的依赖关系（1P Logger 依赖 GrowthBook 的批量配置，Datadog 依赖 GrowthBook 的开关），且都涉及网络请求。如果串行初始化，会严重拖慢启动速度；如果并行初始化，需要处理依赖顺序和竞态条件。

**关闭时**：进程可能因为多种原因退出——用户按 Ctrl+C（SIGINT）、终端关闭（SIGHUP）、系统重启（SIGTERM）、甚至 macOS 撤销 TTY 文件描述符。每种情况下，遥测系统都需要尽力刷新缓冲区中的事件，但不能阻止进程退出。

### 初始化编排

遥测系统的初始化分散在三个阶段，每个阶段有明确的职责：

```
时间线 ──────────────────────────────────────────────────────────►

Phase 1: init()  (entrypoints/init.ts)
│
├─ 1P Event Logging (动态 import, 不阻塞)
├─ GrowthBook 刷新监听注册
└─ setupGracefulShutdown()
      ◄── 此时 logEvent() 的事件被暂存在队列中

Phase 2: setupBackend()  (main.tsx)
│
├─ attachAnalyticsSink()      (绑定 sink, 排空队列)
└─ initializeAnalyticsGates() (读取 Datadog 开关)
      ◄── 此时事件开始流向 Datadog 和 1P

Phase 3: After Trust  (initializeTelemetryAfterTrust)
│
├─ 等待远程设置加载 (仅 eligible 用户)
├─ 懒加载 OTel (~400KB)
├─ 初始化 Metrics Provider
├─ 初始化 Logs Provider
├─ 初始化 Traces Provider
└─ 初始化 Perfetto
```

Phase 1 中 1P Event Logging 的初始化使用了一个巧妙的并行加载模式：

```typescript
// entrypoints/init.ts

// 并行加载两个模块，然后串行初始化
void Promise.all([
  import('../services/analytics/firstPartyEventLogger.js'),
  import('../services/analytics/growthbook.js'),
]).then(([fp, gb]) => {
  fp.initialize1PEventLogging()
  // 注册刷新监听——配置变化时重建 logger
  gb.onGrowthBookRefresh(() => {
    void fp.reinitialize1PEventLoggingIfConfigChanged()
  })
})
```

注意 `void` 前缀——这个 Promise 是 fire-and-forget 的，不阻塞 `init()` 的返回。1P Logger 的初始化在后台完成，期间产生的事件被队列暂存。

Phase 3 的初始化有一个特殊的分支——对于需要远程托管设置的用户（企业客户），必须等远程设置加载完成后才能初始化 OTel，因为远程设置可能包含 OTLP 端点配置：

```typescript
// entrypoints/init.ts

export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // 特殊情况: SDK/headless + beta tracing → 先急切初始化
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry()  // 不等远程设置
    }

    // 正常路径: 等远程设置加载完再初始化
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        applyConfigEnvironmentVariables()  // 应用远程设置中的环境变量
        await doInitializeTelemetry()
      })
  } else {
    // 非企业用户: 直接初始化
    void doInitializeTelemetry()
  }
}
```

`doInitializeTelemetry()` 内部有一个防重入锁，确保即使被多次调用也只初始化一次：

```typescript
let telemetryInitialized = false

async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) return
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    telemetryInitialized = false  // 失败时重置，允许重试
    throw error
  }
}
```

### 优雅关闭

`src/utils/gracefulShutdown.ts` 中的关闭流程是一个精心编排的多阶段过程，遥测刷新是其中的关键环节：

```
gracefulShutdown(exitCode)
│
├─ 1. 计算 failsafe 超时预算
│     budget = max(5s, SessionEnd hook 超时 + 3.5s)
│     启动 failsafe 定时器
│
├─ 2. 清理终端模式 + 打印 resume hint
│     (同步，确保即使后续步骤挂起也能恢复终端)
│
├─ 3. 运行 cleanup 函数 (2s 超时)
│     (会话持久化等关键清理)
│
├─ 4. 执行 SessionEnd hooks
│     (用户配置的关闭钩子)
│
├─ 5. 发送 tengu_cache_eviction_hint 事件
│     (通知推理层可以回收缓存)
│
├─ 6. 刷新遥测缓冲区 (500ms 超时) ◄── 遥测关闭
│     Promise.race([
│       Promise.all([
│         shutdown1PEventLogging(),  // 刷新 1P 缓冲区
│         shutdownDatadog(),         // 刷新 Datadog 批次
│       ]),
│       sleep(500),  // 500ms 硬超时
│     ])
│
├─ 7. 运行 deferred cleanup 函数
│
└─ 8. forceExit(exitCode)
```

遥测刷新（步骤 6）的 500ms 超时是一个关键的设计决策：

```typescript
// 刷新遥测——上限 500ms
// 之前没有上限: 1P exporter 会等待所有 pending axios POST (每个 10s 超时)，
// 吃掉整个 failsafe 预算。慢网络上丢失遥测是可接受的；进程挂起不可接受。
try {
  await Promise.race([
    Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
    sleep(500),
  ])
} catch {
  // 忽略关闭错误
}
```

注释中的解释很直白：**丢失遥测是可接受的，进程挂起不可接受**。这体现了遥测系统的核心原则——它是"旁路"系统，绝不能影响用户体验。

`tengu_cache_eviction_hint` 事件在遥测刷新之前发送，确保它能被包含在最后一批刷新的事件中。这个事件通知推理层"这个会话结束了，可以回收 KV 缓存"——是一个跨系统的资源管理信号。

### 异常捕获与遥测

`setupGracefulShutdown()` 还注册了全局异常处理器，将未捕获的异常和未处理的 Promise 拒绝记录为遥测事件：

```typescript
process.on('uncaughtException', error => {
  logEvent('tengu_uncaught_exception', {
    error_name: error.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
})

process.on('unhandledRejection', reason => {
  const errorName = reason instanceof Error ? reason.name : 'unknown'
  logEvent('tengu_unhandled_rejection', {
    error_name: errorName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
})
```

注意只记录了 `error.name`（如 "TypeError"、"RangeError"），不记录 `error.message` 或 `error.stack`——因为错误消息可能包含文件路径或代码片段，属于 PII。错误名称是安全的，且足以用于分类和告警。

### 设计决策讨论

**为什么 failsafe 超时要考虑 SessionEnd hook 的预算？** 用户可以在 settings.json 中配置 SessionEnd hook 的超时时间（如 10 秒）。如果 failsafe 固定为 5 秒，那么用户配置的 10 秒 hook 永远无法完成。动态计算 `max(5s, hook_timeout + 3.5s)` 确保 hook 有足够的执行时间，同时 3.5 秒的余量留给 cleanup 和遥测刷新。

**为什么遥测刷新的超时是 500ms 而不是更长？** 这是用户体验和数据完整性之间的权衡。用户按 Ctrl+C 后期望进程快速退出——如果等待 5 秒才退出，用户会认为程序"卡住了"。500ms 足以在正常网络条件下完成一次 HTTP POST，而在慢网络上，事件已经被写入磁盘（1P Exporter 的失败缓存），下次启动时会重试。

---

## 17.9 数据流全景：一个事件的完整旅程

为了将前面各节串联起来，让我们追踪一个具体事件——`tengu_tool_use_success`（工具执行成功）——从产生到最终落地的完整旅程：

```
1. 工具执行完成 (query.ts)
   │
   │  logEvent('tengu_tool_use_success', {
   │    toolName: sanitizeToolNameForAnalytics('mcp__slack__read_channel'),
   │    // → toolName: 'mcp_tool' (脱敏后)
   │    duration: 1234,
   │    ...mcpToolDetailsForAnalytics(toolName, serverType, serverBaseUrl),
   │    // → 如果是官方 MCP: { mcpServerName: 'slack', mcpToolName: 'read_channel' }
   │    // → 如果是私有 MCP: {} (空对象)
   │  })
   │
   ▼
2. Analytics 入口 (index.ts)
   │  sink 已就绪? → YES → 直接调用 sink.logEvent()
   │                  NO  → 推入 eventQueue
   │
   ▼
3. Sink 路由 (sink.ts)
   │
   ├─ 采样检查: shouldSampleEvent('tengu_tool_use_success')
   │  → GrowthBook 配置 tengu_event_sampling_config 中无此事件
   │  → 返回 null (不采样，100% 发送)
   │
   ├─ Datadog 路径:
   │  │  shouldTrackDatadog()? → 检查 GrowthBook gate + killswitch
   │  │  → YES
   │  │  stripProtoFields(metadata) → 移除 _PROTO_* 字段
   │  │  trackDatadogEvent('tengu_tool_use_success', strippedMetadata)
   │  │  │
   │  │  ├─ 白名单检查: DATADOG_ALLOWED_EVENTS.has() → YES
   │  │  ├─ getEventMetadata() → 富化环境上下文
   │  │  ├─ getUserBucket() → 用户哈希分桶 (0-29)
   │  │  ├─ 基数压缩: toolName 'mcp_tool' 不变, model 规范化, version 截断
   │  │  ├─ 构建 ddtags: event:tengu_tool_use_success,tool_name:mcp_tool,...
   │  │  └─ logBatch.push(log) → 等待 15s 批量刷新或 100 条满刷新
   │  │
   │  └─ POST https://http-intake.logs.us5.datadoghq.com/api/v2/logs
   │
   └─ 1P 路径:
      │  logEventTo1P('tengu_tool_use_success', fullMetadata)
      │  │  (保留 _PROTO_* 字段)
      │  │
      │  ├─ is1PEventLoggingEnabled()? → 检查 analytics disabled + killswitch
      │  ├─ logEventTo1PAsync():
      │  │  ├─ getEventMetadata() → 富化环境上下文
      │  │  ├─ getCoreUserData() → 用户数据
      │  │  ├─ 构建 OTel LogRecord attributes
      │  │  └─ firstPartyEventLogger.emit({ body: eventName, attributes })
      │  │
      │  ├─ BatchLogRecordProcessor 积攒 (200 条 / 10 秒)
      │  │
      │  └─ FirstPartyEventLoggingExporter.export():
      │     ├─ transformLogsToEvents() → 转换为 ClaudeCodeInternalEvent proto
      │     │  ├─ 提取 _PROTO_* 字段 → 路由到 proto 顶层字段
      │     │  ├─ stripProtoFields(additional_metadata) → 防御性清理
      │     │  └─ 构建 FirstPartyEventLoggingPayload
      │     │
      │     ├─ sendEventsInBatches() → 分块发送 (每批 200 条)
      │     │  └─ POST https://api.anthropic.com/api/event_logging/batch
      │     │
      │     ├─ 成功 → resetBackoff(), 检查并重试磁盘上的失败事件
      │     └─ 失败 → appendEventsToFile(), scheduleBackoffRetry()
      │              └─ ~/.claude/telemetry/1p_failed_events.<sid>.<uuid>.json
```

这个数据流展示了几个关键的架构特性：

1. **单一入口，多路分发**：所有事件通过同一个 `logEvent()` 入口，由 sink 层决定路由
2. **渐进式脱敏**：从工具名脱敏（调用方）→ `_PROTO_*` 分离（sink 层）→ 基数压缩（Datadog 层），每一层都在减少敏感信息
3. **异步非阻塞**：整个链路没有任何 `await`——`logEvent` 是同步的，Datadog 和 1P 都是 fire-and-forget
4. **容错设计**：任何环节的失败都不会影响其他环节，也不会影响主业务逻辑

---

## 17.10 总结：遥测系统的设计哲学

回顾整个遥测架构，可以提炼出几个贯穿始终的设计哲学：

### 1. 遥测是旁路，不是主路

遥测系统的第一原则是**绝不影响核心体验**。这体现在：
- `logEvent()` 零依赖、零阻塞
- 所有网络请求都是 fire-and-forget
- 关闭时遥测刷新有 500ms 硬超时
- 任何遥测子系统的失败都被静默吞掉

这个原则的 trade-off 是：遥测数据是"尽力而为"的，不保证 100% 投递。但对于产品分析来说，99% 的数据覆盖率已经足够做出正确的决策。

### 2. 隐私是架构约束，不是事后检查

PII 保护不是靠代码审查发现遗漏，而是通过架构层面的约束来保证：
- 类型系统禁止直接传入字符串（`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`）
- `_PROTO_*` 双通道确保 PII 只流向特权后端
- `stripProtoFields()` 在 sink 层统一执行，不依赖每个后端自己过滤
- 工具名、文件路径、用户 ID 都有专门的脱敏函数

### 3. 可观测性分层，各取所需

不同的消费方需要不同粒度的数据：
- **Datadog**：低延迟告警，高度聚合，严格脱敏
- **1P BigQuery**：深度分析，保留细节，受控 PII
- **OTLP**：企业自建，标准协议，用户控制
- **Perfetto**：本地调试，完整追踪，不出本机

这种分层设计避免了"一刀切"——不需要为了满足最严格的隐私要求而牺牲所有后端的数据丰富度。

### 4. 配置驱动，运行时可控

遥测系统的几乎所有行为都可以在运行时调整，无需发版：
- GrowthBook 控制 Datadog 开关、事件采样率、Sink Killswitch
- 环境变量控制隐私级别、OTLP 配置、用户提示记录
- 组织级 API 控制 BigQuery metrics opt-out
- 1P 批量配置（大小、间隔、端点）通过 GrowthBook 动态调整

这种"配置驱动"的设计让团队能够在不发版的情况下应对紧急情况（如关闭出问题的后端、调整采样率降低成本）。

### 关键源码索引

| 模块 | 路径 | 职责 |
|------|------|------|
| Analytics 入口 | `src/services/analytics/index.ts` | 零依赖事件 API，队列暂存 |
| Sink 路由 | `src/services/analytics/sink.ts` | 事件路由、采样、双通道分发 |
| Datadog | `src/services/analytics/datadog.ts` | 实时监控，白名单+基数压缩+分桶 |
| 1P Logger | `src/services/analytics/firstPartyEventLogger.ts` | OTel-based 事件管道 |
| 1P Exporter | `src/services/analytics/firstPartyEventLoggingExporter.ts` | 可靠投递，磁盘缓存+退避重试 |
| GrowthBook | `src/services/analytics/growthbook.ts` | Feature Flag，磁盘缓存+Remote Eval |
| Sink Killswitch | `src/services/analytics/sinkKillswitch.ts` | 紧急关闭开关 |
| Analytics Config | `src/services/analytics/config.ts` | 多维度门控 |
| 元数据富化 | `src/services/analytics/metadata.ts` | 环境上下文、PII 脱敏 |
| 隐私级别 | `src/utils/privacyLevel.ts` | 三级隐私模型 |
| Metrics Opt-Out | `src/services/api/metricsOptOut.ts` | 组织级 metrics 开关 |
| OTel 初始化 | `src/utils/telemetry/instrumentation.ts` | Metrics/Logs/Traces provider |
| BigQuery Exporter | `src/utils/telemetry/bigqueryExporter.ts` | 企业 metrics 导出 |
| Session Tracing | `src/utils/telemetry/sessionTracing.ts` | 交互追踪 (BETA) |
| OTel Events | `src/utils/telemetry/events.ts` | 企业事件日志 |
| Perfetto | `src/utils/telemetry/perfettoTracing.ts` | 本地性能追踪 |
| 初始化编排 | `src/entrypoints/init.ts` | 遥测初始化时序 |
| 优雅关闭 | `src/utils/gracefulShutdown.ts` | 关闭时遥测刷新 |
