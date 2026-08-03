/**
 * AgenticLoop — 共享的 Agent 循环核心
 *
 * 对标 claude-code 的 runAgent()，使子代理和主代理共享同一套循环逻辑。
 * 从 executeInner() 提取，消除与 AgentLoopRunner.run() 之间的代码重复。
 *
 * M5 里程碑：子代理独立 Agent Loop
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage, SendParams } from "../llm/types.ts";
import { accumulateUsage, normalizeCacheUsage } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import { emitStreamPhase, clearStreamSnapshot, cleanupAgentSnapshots } from "../trace/stream-observer.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { processStream, type StreamProcessResult } from "./stream-processor.ts";
// B2：错误分类 / 退避计算 / abort reason 归因全部收归漏斗内部实现，
// 本文件不再直接依赖它们（原 R1 循环的 import 随之删除）。
import { streamWithResilience } from "../llm/resilient-stream.ts";
import type { QuerySource } from "../llm/fallback.ts";
// B5-4：dispatchRetryTelemetry 不是可选的便利导入——见 onTelemetryTap 里的说明，
// 少了它生产路径（不传 onTelemetry 的子代理）的重试遥测会整条消失。
import { dispatchRetryTelemetry, type RetryTelemetryEvent } from "../llm/retry-telemetry.ts";
import { resolveLoopTimeouts } from "../config/network-profile.ts";
import { executeTools } from "./tool-executor.ts";
import { isEmptyToolInput, toolHasRequiredParams } from "../query/empty-param.ts";
// B5-1：撞 context window 上限时的压缩恢复。与主循环 query/loop.ts 用同一份实现——
// 子代理另写一套压缩策略就是两份平行实现（本方案 §0.4 判据禁止的形态）。
import { reactiveCompact } from "../query/reactive-compact.ts";

// ============================================================
// 配置接口
// ============================================================

/** Agent 循环配置 */
export interface AgentLoopConfig {
  /** LLM Provider */
  provider: Provider;
  /** 模型名称 */
  model: string;
  /** 上下文管理器（系统提示词和首条用户消息已预先填充） */
  ctxMgr: ContextManager;
  /** 工具注册表（已过滤） */
  tools: ToolRegistry;
  /** 最大轮次 */
  maxTurns: number;
  /** 中止信号 */
  signal: AbortSignal;
  /** 循环检测器（外部创建，便于生命周期控制） */
  loopDetector: LoopDetector;
  /** 流式文本回调（用于 TUI 实时显示） */
  onStreamText?: (text: string) => void;
  /** 每轮开始前的回调（用于 SendMessage 注入等） */
  onBeforeTurn?: (turn: number) => void;
  /** 每轮结束后的回调（含本轮文本和工具信息，用于磁盘输出 + 进度追踪） */
  onTurnEnd?: (info: {
    turn: number;
    /** 本轮文本输出（完整内容） */
    textOutput: string;
    /** 本轮工具调用信息 */
    tools: Array<{ name: string; input: Record<string, unknown> }>;
    /** 截至本轮的累计真实 token 数（input + output，来自 totalUsage），供进度面板展示 */
    tokenCount: number;
    /** 截至本轮的累计工具调用次数 */
    toolUseCount: number;
  }) => void;
  /** 循环恢复提示词（默认使用全局 LOOP_RECOVERY_PROMPT） */
  loopRecoveryPrompt?: string;
  /** LLM 请求额外参数 */
  sendParamsExtra?: Partial<SendParams>;
  /** Hook 系统（透传给工具执行，驱动子代理工具的 Pre/PostToolUse hook 与 execute_tool span）。
   *  缺省时工具执行不触发 hook（兼容无 hook 环境/测试）。 */
  hookSystem?: HookSystem;
  /** 权限检查器（子代理用 dontAsk 语义：危险命令拦截 + safetyCheck 照常生效，ask→deny）。
   *  缺省时不做权限检查（兼容旧测试 / 纯只读子代理）。 */
  permissionChecker?: import("../permission/types.ts").Checker;
  /** GAP-07（子代理侧）：长跑工具中间进度回调。缺省时工具执行无进度上报（无副作用）。 */
  onToolProgress?: import("./tool-executor.ts").SubAgentToolProgress;
  /** H9：模型可用性服务（与主 fallback 引擎共享同一实例，来自 ProviderRegistry.availability）。
   *  子代理遇 terminal 类错误（认证失败 / 模型不存在 / 内容策略）时 markTerminal，让拉黑状态跨
   *  主路径/子代理/side-call 共享——避免同一坏模型下次子代理再选它撞一次。缺省时不做拉黑（兼容
   *  无 registry 的旧测试）。 */
  availability?: import("../llm/availability.ts").ModelAvailabilityService;
  /**
   * P2-1：JIT 上下文发现（子代理侧）。
   *
   * 子代理此前完全不走 JIT —— 读写 `src/ui/` 下文件时拿不到该目录规范，
   * 而子代理恰恰是「被派去改某个具体模块」的高频场景，正是最需要目录规则的地方。
   *
   * **必须是独立实例，不能共享主代理的 JitContextManager**（对齐 CC 为 forked agent
   * 分配独立 `loadedNestedMemoryPaths` 的做法）：子代理有自己的上下文窗口，
   * 父代理注入过不代表子代理上下文里有；共享去重集会让父加载过的规则子代理**永远**
   * 拿不到 —— 比不接 JIT 更糟（看起来接了，实际静默失效）。
   *
   * 与主路径同为 fire-and-forget（返回 void）：产物给下一轮用，await 会算进 TTFT。
   * 缺省时子代理不走 JIT（兼容旧测试 / 纯计算型子代理）。
   */
  discoverJitContext?: (toolBlocks: Array<{ name: string; input: unknown }>) => void;
  /**
   * 单轮 LLM 调用的最大重试次数（限流 / 过载 / 网络抖动等可重试错误）。
   *
   * 缺省走 network-profile 的 maxTimeoutRetries（当前 10），与主循环同源——
   * 改 settings.network.maxTimeoutRetries 或 SID_CODE_MAX_TIMEOUT_RETRIES 一处生效，
   * 不在此另立平行常量（fallback.ts 顶部注释记录过「两阶段各自维护上限架空统一配置」的同型事故）。
   * 测试可传 0 显式关闭重试。
   *
   * B2：语义不变，但**执行者从 R1 自建循环换成漏斗**——本值经
   * `streamWithResilience` 透传为 `PerCallOptions.maxRetries`。
   */
  maxStreamRetries?: number;
  /** 退避基数（毫秒）。缺省走 network-profile 的 retryBackoffBaseMs（当前 5s）。 */
  retryBackoffBaseMs?: number;
  /** 退避上限（毫秒）。缺省走 network-profile 的 retryBackoffMaxMs（当前 120s）。 */
  retryBackoffMaxMs?: number;
  /**
   * B2：本次循环的查询来源。缺省 `"agent:builtin"`。
   *
   * 自定义子代理路径（`sub-agent.ts` 的 `executeCustomInner`）应显式传
   * `"agent:custom"`，强制总结轮内部改传 `"agent:summary"`——三条路径在遥测里
   * 可分辨，是"哪类子代理在重试"这个问题能被回答的前提。
   */
  querySource?: QuerySource;
  /** B2：发起方标识（遥测归因；B4 per-agent 状态隔离复用同一标识）。 */
  agentId?: string;
  /**
   * S3（§5 缺口 C）：本次子代理的 **wall-clock 截止时刻**（`Date.now()` 轴毫秒）。
   *
   * 由 `sub-agent.ts` 按 `startTime + timeout` 算出并传入——它是 `timeoutCtrl` 那个
   * 硬顶的**同一个时刻**，只是从"到点 abort"换成"到点前主动收手"。
   *
   * 为什么不在这里自己 `Date.now() + timeout`：超时钟表必须与真正会 abort 的那个
   * 控制器同源，各算一份必然漂移（本方案反复在消除的正是这类平行实现）。
   *
   * 缺省不传 → 漏斗退化为纯次数上界，行为与 S3 之前逐字节一致。
   */
  deadlineAt?: number;
  /**
   * B4：重试遥测回调（可选）。
   *
   * 生产路径**不需要**传：`fallback.ts` 的 `emitTelemetry` 在无 per-instance 回调时
   * 走全局观察者（`setRetryTelemetryObserver`，由 app.ts 注册），子代理事件照样落
   * events.jsonl。此参数存在的意义是让"重试遥测确实带上了 agentId"可以被**测试
   * 直接断言**，而不必依赖全局单例状态——对应 §七 F7 的要求：新增韧性能力必须附一条
   * 证明它被执行的断言。
   */
  onTelemetry?: (event: RetryTelemetryEvent) => void;
  /**
   * B2：跨重试的兜底超时（毫秒），传给 `processStream`。
   *
   * 注意它与漏斗的 `streamTimeoutMs` 是**不同层**：漏斗那层是单次尝试的无数据
   * 上限（触发后重试），这一层是把"重试也救不回来"兜住（触发即结束本轮）。
   * 缺省走 `LIFECYCLE_PRESETS.subAgent`（idle 60s / overall 180s）。
   */
  streamIdleTimeoutMs?: number;
  streamOverallTimeoutMs?: number;
}

/**
 * 子代理单次请求的输出 token 上限（B5-6，§5 新发现 4：给原本的裸魔数定性）。
 *
 * ── 为什么是"保留固定值"而不是"交给 resolveMaxOutputTokens 按模型解析" ──
 *
 * 两个选项都评估过，选前者，理由是二者解决的**不是同一个问题**：
 * `resolveMaxOutputTokens` 回答"模型最多能输出多少"（物理上限，用于**钳制**，防 400
 * `max_tokens out of range`）；这里要回答的是"子代理**应该**被允许输出多少"（预算选择）。
 * 把预算直接设成物理上限是错的——注册表里多数模型上限为 64K–128K，子代理产出的是给
 * 父代理消费的结论，不是给人读的长文；真按 128K 发，一次跑偏就能吃掉父代理的上下文。
 *
 * 那为什么 4096 这个具体数字是安全的（而非又一个臆测）：查注册表全部条目，
 * **非零 maxOutputTokens 的最小值恰好是 4096**，无任何模型低于它。所以固定 4096
 * 不会触发"超过模型物理上限"这类 400 —— 这正是原先缺失的那半句依据。
 *
 * 同时它不构成"输出被截断就丢结果"的风险：`max_tokens` / `length` 停止原因在本循环里
 * 会走**自动续写**分支（见下方 `stopReason === "max_tokens"`），撞上限只是多跑一轮。
 *
 * 需要更大预算的调用方可用 `config.sendParamsExtra.maxTokens` 覆盖（它在 `sendParams`
 * 里位于本常量之后展开，故覆盖生效）；漏斗降级到别的模型时还会按目标模型上限再钳一次
 * （`fallback.ts` 的 fbCeiling）。两层机制已覆盖"不够用"和"超上限"两端。
 */
export const SUBAGENT_DEFAULT_MAX_TOKENS = 4096;

/** Agent 循环结果 */
export interface AgentLoopResult {
  success: boolean;
  turns: number;
  totalUsage: Usage;
  toolUseCount: number;
  /** 最后一轮的文本输出 */
  lastTextOutput: string;
  /** 累积的上下文消息 */
  messages: Array<{ role: string; content: ContentBlock[] }>;
  /** 失败时携带的错误消息 */
  errorMessage?: string;
  /**
   * B5-4（§5 缺口 D）：本次循环累计的 LLM 重试次数（跨所有轮次，含总结轮）。
   *
   * 为什么必须单独透出、而不是靠 `errorMessage` 里的文字：超时路径**根本不看**
   * `errorMessage`。`sub-agent.ts` 判 `timeoutCtrl.signal.aborted` 为真就一律拼
   * 「子代理执行超时」，errorMessage 整句丢弃 —— 于是用户看到"超时"，真相是
   * 「限流重试 6 次仍失败」，排查方向被带去查网络/超时配置，而非限流。
   * 漏斗的 onRetry 本就会回调，这里只是把它数出来并如实带回给调用方。
   */
  retryAttempts?: number;
  /**
   * B5-4：最后一次重试的失败原因（漏斗 `classified.reason`，如 rate_limit / overloaded）。
   *
   * 取"最后一次"而非全部：它是用户最需要看到的那个（前面几次多为同因），
   * 与漏斗 `tryFallback` 里 rootCause 的取值口径保持一致。
   */
  lastRetryReason?: string;
}

// B2：原 `sleepWithAbort`（R1 退避专用）已删除。退避现由漏斗的
// `sleepWithProgress` 承担——它在长退避时**分块 sleep 并 yield
// SystemAPIErrorMessage 心跳**，而 sleepWithAbort 是静默干等（新发现 1①：
// 子代理在最长 120s 的退避里对外完全无声）。能力早已具备，只是子代理没用上。

// ============================================================
// 核心循环函数
// ============================================================

/**
 * 运行 Agent 循环核心
 *
 * 处理 LLM 流式响应、工具调用、循环检测的标准模式。
 * 调用方负责：创建 ctxMgr（含 system prompt 和首条 user 消息）、
 * 创建 tools（已过滤）、创建 loopDetector（生命周期控制）。
 *
 * 对标 claude-code runAgent()，一个函数同时服务于主 Agent 和子 Agent。
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  // ══════════════════════════════════════════════════════════════════
  // B4：teardown 包壳（对标 CC `promptCacheBreakDetection.ts:700` 的
  // `cleanupAgentTracking(agentId)`）。
  //
  // 为什么是 try/finally 包壳而不是在各出口逐个调用：`runAgentLoopInner` 有 6 个
  // return 点 + 若干 throw 路径，逐个手写清理必然漏——而"漏一个出口"的表现是
  // `_snapshots` 慢慢涨，不会有任何报错，正是最难发现的那类缺陷。包壳让"新增一条
  // return 路径"不需要记得补清理。
  //
  // 无 agentId 时 `cleanupAgentSnapshots("")` 直接 return（它自己做了空值保护），
  // 不会误伤主循环那把无身份 key。
  //
  // ── B5-4：重试统计同样在这一层统一回填 ──
  //
  // 与上面同一个理由：`runAgentLoopInner` 有 8+ 个 return 点，逐个手写
  // `retryAttempts / lastRetryReason` 必然漏一个，而漏掉的表现是"这条失败路径
  // 恰好不显示重试次数"——缺口 D 又在那条路径上复活，且没有任何报错提示。
  // 用共享 holder 让内部只管累加、出口统一回填，新增 return 路径不需要记得补。
  // ══════════════════════════════════════════════════════════════════
  const retryStats: RetryStats = { attempts: 0 };
  try {
    const result = await runAgentLoopInner(config, retryStats);
    // 0 次重试时不写字段：保持"顺利跑完"的结果形状与改造前逐字节一致，
    // 也让下游可以用 `retryAttempts ?? 0` 之外的存在性判断区分"没重试"与"未接线"。
    if (retryStats.attempts > 0) {
      result.retryAttempts = retryStats.attempts;
      result.lastRetryReason = retryStats.lastReason;
    }
    return result;
  } finally {
    if (config.agentId) cleanupAgentSnapshots(config.agentId);
  }
}

/** B5-4：跨 return 点共享的重试统计（见 runAgentLoop 内注释说明为何用 holder）。 */
interface RetryStats {
  attempts: number;
  lastReason?: string;
}

async function runAgentLoopInner(
  config: AgentLoopConfig,
  retryStats: RetryStats,
): Promise<AgentLoopResult> {
  const log = getLogger();
  const {
    provider, model, ctxMgr, tools, maxTurns, signal, loopDetector,
    loopRecoveryPrompt = LOOP_RECOVERY_PROMPT,
    availability,
  } = config;

  let turns = 0;
  let toolUseCount = 0;
  let lastTextOutput = "";
  let unknownStopWarning: string | undefined;
  // B5-1：`model_context_window_exceeded` 的压缩续写次数。有界（见该分支注释）——
  // 压缩没压动就不再续写，否则会在"压不动 → 再撞上限"之间空转到 maxTurns 耗尽。
  let ctxWindowRecoveryCount = 0;
  // B5-4（缺口 D）：重试计数写进 `retryStats` holder（跨轮次累计，由 runAgentLoop
  // 在所有出口统一回填）。累计而非每轮重置——用户问的是"这个子代理一共重试了多少次"，
  // 而"第 3 轮重试了 2 次"这种粒度已经在遥测（type=retry + agentId）里了。

  /**
   * B5-4：遥测旁路（tap）——数重试次数并记下最后一次原因，然后原样转发给调用方。
   *
   * 为什么搭在 onTelemetry 而不是 onRetry 上：`onRetry(attempt, error, delayMs)` 只给
   * 消息文本，拿不到分类结果；而 `type:"retry"` 事件带 `reopenReason`（就是漏斗的
   * `classified.reason`，或最近触发的超时层），正是"为什么重试"这个问题的结构化答案。
   * 搭在这里也不必改漏斗的 listener 签名 —— 不为一个观测需求去动最热路径的接口。
   *
   * 只认 `type:"retry"`：`fallback` / `529_dropped` 等是别的语义，混进来会让"重试了几次"
   * 变成"发生了几件事"。
   */
  const onTelemetryTap = (event: RetryTelemetryEvent): void => {
    if (event.type === "retry") {
      retryStats.attempts++;
      retryStats.lastReason = event.reopenReason ?? retryStats.lastReason;
    }
    if (config.onTelemetry) {
      config.onTelemetry(event);
      return;
    }
    // ⚠️ 这条 else 分支不可删（否则生产遥测整条消失）。
    //
    // 漏斗的 `emitTelemetry` 有一条二选一：**有** per-instance `onTelemetry` 就只走它
    // 并 return，**没有**才走全局观察者 `dispatchRetryTelemetry`（避免同一事件写两遍）。
    // 而生产路径的子代理恰恰**不传** onTelemetry，靠的就是全局观察者那条腿。
    //
    // 于是本 tap 一旦无条件传给漏斗，漏斗就永远走"有回调"分支 → 全局观察者再也收不到
    // 事件 → 子代理重试在轨迹里彻底消失。这正是 §七 F7 记的那类"能力已实现 ≠ 能力已
    // 生效"，且没有任何报错提示。所以调用方没给回调时，由我们**代替漏斗**补这次派发。
    dispatchRetryTelemetry(event);
  };

  // LSP 诊断注入所需状态（子代理侧补齐，对标主循环 G1）。
  // hasEditCapability：能力对齐门控——只有具备 edit/write 工具的子代理才注入诊断。
  //   纯只读子代理（如 explore/summarize）不会被诊断噪音打扰。这比 CC 的"有 Bash 才注入"
  //   更贴合本意：诊断是给"能改代码的 agent"看的，而本项目靠 edit/write 修复诊断、不依赖 bash。
  // editedFiles：本子代理累计编辑过的文件绝对路径，作为诊断收集的作用域——并发子代理共用
  //   全局 registry，各自只消费自己编辑文件的诊断，互不偷取（作用域消费 + 作用域清空）。
  const hasEditCapability = !!(tools.get("edit") || tools.get("write"));
  const editedFiles = new Set<string>();

  const totalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  // R1：重试/退避参数走 resolveLoopTimeouts（env > settings > 统一默认值），与主循环同源。
  // SubAgent 不持有 Config 对象，直接读 DEFAULTS 会让 env 覆盖对子代理静默失效——
  // 那就成了「看起来接了统一配置，实际只有主路径生效」的半接线状态。
  // 在轮次循环外解析一次即可（同一子代理生命周期内配置不变）。
  const netTimeouts = resolveLoopTimeouts({});

  // ══════════════════════════════════════════════════════════════════
  // B4：本次循环的快照身份维度。
  //
  // 有 agentId → 所有 StreamPhase / 快照读写都带上它，与其它并行子代理隔离；
  // 无 agentId（旧测试、未接线调用方）→ 退化为 undefined，key 与改造前逐字节相同，
  // 即"没传身份就沿用旧行为"，不会因为漏传而静默换语义。
  //
  // 为什么不在这里造一个兜底 id（如随机串）：那会让"漏传 agentId"变得不可见——
  // 隔离看起来生效了，但遥测里的 agentId 是个无法与任何子代理对应的随机值，
  // 排查时更误导。漏传就该退化成旧行为，由 §5 的一致性哨兵去发现。
  // ══════════════════════════════════════════════════════════════════
  const observerAgentId = config.agentId;

  while (turns < maxTurns) {
    turns++;
    log.debug("AGENT_LOOP", `轮次 ${turns}/${maxTurns}`);

    // 每轮开始前的回调（SendMessage 注入等）
    config.onBeforeTurn?.(turns);

    // LSP 诊断注入（子代理侧补齐，对标主循环 query/loop.ts 的 G1）。
    // 上一轮若编辑过文件，此处收集这些文件的实时诊断注入为 user 消息，让子代理感知
    // 自己编辑引入的类型/语法错误。作用域限定为本子代理编辑过的文件（editedFiles），
    // 避免与主循环 / 并发子代理互相偷取全局 registry 里的 pending 诊断。
    // ctxMgr.addMessage 会自动合并连续同角色消息，注入 user 消息不破坏角色交替。
    // 收集即消费（作用域清空），故无需额外去重——同一诊断不会重复注入。
    if (hasEditCapability && editedFiles.size > 0) {
      try {
        const { collectDiagnosticText } = await import("../lsp/manager.ts");
        const diagnosticText = collectDiagnosticText(editedFiles);
        if (diagnosticText) {
          ctxMgr.addMessage({
            role: "user",
            content: [{
              type: "text",
              text:
                `# LSP 诊断（来自语言服务器的实时反馈）\n\n${diagnosticText}\n\n` +
                `以上是语言服务器对你刚编辑文件的实时分析结果。请关注其中的 Error / Warning，` +
                `在后续工作中修复这些问题；若与当前任务无关可暂不处理，但不要无视真实的类型/语法错误。`,
            }],
          });
          log.info("AGENT_LOOP", "注入 LSP 诊断反馈（子代理）");
        }
      } catch { /* LSP 未启用 / 收集失败：降级不注入，绝不影响子代理循环 */ }
    }

    const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

    // 发给 LLM 的消息走 getCleanedMessages()（对标 cc：所有循环共用压缩管道）。
    // 子代理是 token 消耗大户（大量 read/grep/bash），此前裸发 getMessages() 完全没有
    // 工具输出剪枝/遮罩，input token 线性膨胀。getCleanedMessages 提供：大输出剪枝
    // （零依赖纯内存）+ observation masking（构造时传了 sessionId 才启用）。
    // 注意：仅"发给 LLM"这一处换；返回给调用方的 AgentLoopResult.messages 仍用
    // getMessages()（内部逻辑/最终产物需要完整历史，不能是清理后的视图）。
    const sendParams: SendParams = {
      model,
      messages: ctxMgr.getCleanedMessages(),
      system: ctxMgr.getSystemPrompt(),
      // B5-6：依据见 SUBAGENT_DEFAULT_MAX_TOKENS 注释（预算选择，非物理上限；
      // 4096 是注册表全部模型的最小上限，故不会触发 max_tokens out of range）。
      maxTokens: SUBAGENT_DEFAULT_MAX_TOKENS,
      tools: toolDefs,
      ...config.sendParamsExtra,
    };

    // T13.1：子代理 LLM 调用 StreamPhase 事件（fetch_sent）
    //
    // B4（per-agent 状态隔离）：index 只含轮次，身份维度由 `observerAgentId` 单独提供。
    // 不把 agentId 哈希进 index 是刻意的——index 落在 events.jsonl 里要能读出"第几轮"，
    // 掺进去就成了不可解释的大整数，离线分析拿不回轮次。身份走 key 的独立段（见
    // `stream-observer.ts` 的 `makeSnapshotKey`）。
    const agentStreamIndex = 10000 + turns;
    const turnStartTime = Date.now();

    // ══════════════════════════════════════════════════════════════════
    // B2：走唯一漏斗（`streamWithResilience` → `ModelFallback`）
    //
    // 事故 20260730-183103-5e334145 的根治点。此处原是 `provider.sendMessageStream()`
    // 直连 + R1 自建的一整套重试循环（约 170 行）。两份平行实现必然漂移，且 R1 那份
    // 缺失漏斗已有的能力：退避期心跳、max_tokens 溢出恢复、连续 529 降级、
    // keep-alive 禁用、401 retry-once、模型降级。
    //
    // 现在只声明"我是谁 + 我能不能弹窗"，韧性能力由漏斗统一提供：
    //  ① querySource 按实际子代理类型传（内置 / 自定义），进遥测可归因到路径；
    //  ② switchMode 固定 auto —— 子代理无 TUI，ask 会挂死在等不到答案的 Promise 上；
    //  ③ availability 注入共享实例，terminal 类错误跨路径拉黑（原 H9 的能力，
    //     漏斗内部 markTerminal 已覆盖，不必在此另写一份）。
    //
    // 三层超时的分工（不要合并，见 resilient-stream.ts 的 streamTimeoutMs 注释）：
    //   漏斗 streamTimeoutMs = 单次尝试无数据上限 → 触发后**重试**；
    //   processStream idle/overall = 跨重试兜底 → 触发即结束本轮；
    //   sub-agent.ts 的 timeoutCtrl = wall-clock 总预算硬顶。
    // ══════════════════════════════════════════════════════════════════
    emitStreamPhase(agentStreamIndex, "fetch_sent", { caller: "sub-agent", model, attempt: 0 }, observerAgentId);

    const stream = streamWithResilience(provider, sendParams, signal, {
      querySource: config.querySource ?? "agent:builtin",
      switchMode: "auto",
      maxRetries: config.maxStreamRetries ?? netTimeouts.maxTimeoutRetries,
      retryBackoffBaseMs: config.retryBackoffBaseMs,
      retryBackoffMaxMs: config.retryBackoffMaxMs,
      availability,
      agentId: config.agentId,
      // S3：把外层 wall-clock 硬顶透进漏斗，让它在"退避完也来不及发请求"时提前收手。
      deadlineAt: config.deadlineAt,
      // B5-4：经 tap 转发（数重试次数），行为对调用方不变。
      onTelemetry: onTelemetryTap,
      // 新发现 1②：快照清理必须在**退避之前**。原 R1 是 sleep 完才 clear，
      // 整个退避期（最长 120s）那份已死流的旧快照仍然活着、lastContentProgressAt
      // 停在两分钟前——正是 collector.ts 的 still_progressing 判据最容易误判的输入。
      //
      // B4：clear 必须带 observerAgentId，否则删的是「无身份」那把 key ——
      // 自己的活快照留着不动（still_progressing 误判照旧），反而把主循环那份删了。
      // 这正是缺口 A 的镜像：改造前是删别人的，漏传 id 就变成删错人的。
      onRetry: (attempt: number, error: string) => {
        clearStreamSnapshot(agentStreamIndex, undefined, observerAgentId);
        emitStreamPhase(agentStreamIndex, "error", {
          caller: "sub-agent", model, error, attempt,
          elapsed_ms: Date.now() - turnStartTime,
        }, observerAgentId);
        emitStreamPhase(agentStreamIndex, "fetch_sent", { caller: "sub-agent", model, attempt }, observerAgentId);
      },
    });

    let response: StreamProcessResult;
    try {
      response = await processStream(stream, {
        signal,
        heartbeatTimeoutMs: config.streamIdleTimeoutMs,
        overallTimeoutMs: config.streamOverallTimeoutMs,
      });
    } catch (err) {
      // 漏斗只在「用户/外部 abort」时抛（可重试错误已在内部消化成重试或 error 事件）。
      const errMessage = (err as Error)?.message ?? String(err);
      emitStreamPhase(agentStreamIndex, "error", {
        caller: "sub-agent", model, error: errMessage,
        elapsed_ms: Date.now() - turnStartTime,
      }, observerAgentId);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: errMessage,
      };
    }

    if (response.stopReason !== "error") {
      emitStreamPhase(agentStreamIndex, "completed", {
        caller: "sub-agent", model, elapsed_ms: Date.now() - turnStartTime,
      }, observerAgentId);
    }


    if (config.onStreamText) {
      const responseText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("");
      if (responseText) config.onStreamText(responseText);
    }

    // LLM API 错误：返回失败（不 throw，由调用方转换为状态变更）。
    // R1 之后此分支正常不可达——stopReason="error" 已在上方重试循环里被归一化成 failure
    // 并重试/放弃。保留为安全网：若将来有人在循环里新增 break 路径而漏判 error，
    // 这里仍会兜住，不至于把错误响应当成功继续跑工具。
    if (response.stopReason === "error") {
      log.error("AGENT_LOOP", `LLM 错误: ${response.errorMessage}`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: response.errorMessage || "LLM 错误",
      };
    }

    // H9：空响应校验（对齐主/降级路径 fallback.ts 的 hasYieldedContent 兜底）。
    // 背景：子代理默认复用主 provider（常为同一网关），网关返回 text/html 错误页或空流时，
    // processStream 会给出「stopReason 非 error、但 content 为空」的伪成功——子代理若直接透传，
    // 会误判「完成但无输出」返回空结果给主代理（事故 session 20260708-102143 同型）。
    // 判据：本轮既无任何 content block、又非因 max_tokens 截断（截断是合法的「有产出但被切」）。
    //
    // B5-1：`model_context_window_exceeded` 与 max_tokens 同样豁免。它是**服务端明确
    // 告知"输入+输出撞到模型硬上限"**，与"网关回错误页"是完全不同的故障。不豁免的话，
    // 这条路径会在下面的 stopReason 分支之前就被截走、报成"疑似模型不可用"——
    // 正是本项要消除的错误归因。
    //
    // 边界（实测，勿高估这条豁免的作用范围）：**零** content block 撞上限时，漏斗层的
    // `hasYieldedContent` 校验（fallback.ts:732）先判"响应为空"并重试→降级，压根走不到
    // 这里，故那条路径的归因仍不精确。修它要动漏斗的空响应语义，属另案；
    // 现状已由 tests/agent/resilience-b5-gates.test.ts 钉住。
    const hasAnyContent = response.content.length > 0;
    if (!hasAnyContent &&
        response.stopReason !== "max_tokens" &&
        response.stopReason !== "model_context_window_exceeded") {
      log.error("AGENT_LOOP", `子代理收到空响应（0 内容块，stopReason=${response.stopReason}），判定失败`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: `子代理收到空响应（0 内容块，疑似网关返回非流式错误页或模型不可用）`,
      };
    }

    // 累加本轮 usage（统一走 accumulateUsage，补齐 cacheRead/cacheCreation 字段；
    // response.usage 已是本轮 processStream 累加好的完整 usage）
    accumulateUsage(totalUsage, response.usage);

    // P1-6/P1-7：用真实 usage 校准子代理上下文估算器（防 compact 触发过晚 → 溢出）
    try {
      const norm = normalizeCacheUsage(response.usage, provider.name());
      ctxMgr.recordActualTokens(norm.promptTotal, tools.size());
    } catch { /* 校准失败不影响子代理循环 */ }

    // 提取文本输出
    const textBlocks = response.content.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      lastTextOutput = textBlocks
        .map(b => b.type === "text" ? b.text : "")
        .join("\n");
    }

    // 添加助手消息到历史
    ctxMgr.addMessage({ role: "assistant", content: response.content });

    // 内容循环检测
    if (lastTextOutput && loopDetector.recordContent(lastTextOutput)) {
      if (!loopDetector.tryRecover()) {
        log.warn("AGENT_LOOP", "内容循环恢复次数耗尽，终止");
        return {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage: "内容循环恢复次数耗尽",
        };
      }
      log.info("AGENT_LOOP", "检测到内容循环，注入恢复提示");
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: loopRecoveryPrompt }],
      });
      continue;
    }

    // 停止原因处理
    if (response.stopReason === "end_turn" || response.stopReason === "stop") {
      log.info("AGENT_LOOP", `完成，共 ${turns} 轮`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      return {
        success: true,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
      };
    }

    // 工具调用
    if (response.stopReason === "tool_use") {
      // 工具调用循环检测
      let loopDetected = false;
      for (const block of response.content) {
        if (block.type === "tool_use") {
          if (loopDetector.recordToolCall(block.name, block.input)) {
            loopDetected = true;
            break;
          }
        }
      }
      if (loopDetected) {
        if (!loopDetector.tryRecover()) {
          log.warn("AGENT_LOOP", "工具循环恢复次数耗尽，终止");
          return {
            success: false,
            turns,
            totalUsage,
            toolUseCount,
            lastTextOutput,
            messages: ctxMgr.getMessages(),
            errorMessage: "工具循环恢复次数耗尽",
          };
        }
        log.info("AGENT_LOOP", "检测到工具循环，注入恢复提示");
        ctxMgr.addMessage({
          role: "user",
          content: [{ type: "text", text: loopRecoveryPrompt }],
        });
        continue;
      }

      // 统计工具调用次数
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      toolUseCount += toolUseBlocks.length;

      // 空参数检测（对标主循环 F1）：弱模型退化时输出 input={} 的 tool_use，
      // 直接执行会报参数缺失错误，浪费工具执行 token。检测到后替换为错误提示让模型重试。
      const emptyParamBlocks = toolUseBlocks.filter(b => {
        if (b.type !== "tool_use") return false;
        if (!isEmptyToolInput(b.input)) return false;
        const schema = tools.get(b.name)?.inputSchema?.();
        return toolHasRequiredParams(schema);
      });
      if (emptyParamBlocks.length > 0) {
        log.warn("AGENT_LOOP", `检测到 ${emptyParamBlocks.length} 个空参数 tool_use，注入重试提示`);
        // 构造 tool_result 错误响应 + 重试提示
        const errorResults: ContentBlock[] = emptyParamBlocks.map(b => ({
          type: "tool_result" as const,
          tool_use_id: (b as { type: "tool_use"; id: string }).id,
          content: "错误：工具参数为空。请检查工具定义，提供完整的必需参数后重新调用。",
          is_error: true,
        }));
        ctxMgr.addMessage({ role: "user", content: errorResults });
        continue;
      }

      // 执行工具
      const toolResults = await executeTools(response.content, tools, signal, config.hookSystem, config.permissionChecker, config.onToolProgress);
      ctxMgr.addMessage({ role: "user", content: toolResults });

      // P2-1：JIT 上下文发现（子代理侧，独立实例）。放在 addMessage 之后、
      // 与主路径同一位置语义：本轮工具已产出结果，发现的规则供**下一轮**请求携带。
      // 不 await（fire-and-forget），读盘不进本轮关键路径。
      if (config.discoverJitContext) {
        config.discoverJitContext(
          toolUseBlocks
            .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
            .map((b) => ({ name: b.name, input: b.input })),
        );
      }

      // 记录本轮编辑过的文件（供下一轮 LSP 诊断注入的作用域）。仅当具备编辑能力时才收集，
      // 与注入门控保持一致。tool_result 的 is_error 判定成功——失败的编辑不纳入诊断作用域。
      if (hasEditCapability) {
        for (const b of toolUseBlocks) {
          if (b.type !== "tool_use") continue;
          if (b.name !== "edit" && b.name !== "write") continue;
          const resultBlock = toolResults.find(
            (r) => r.type === "tool_result" && r.tool_use_id === b.id,
          );
          if (resultBlock && resultBlock.type === "tool_result" && resultBlock.is_error) continue;
          const input = b.input as Record<string, unknown>;
          const p = (input?.file_path ?? input?.path) as string | undefined;
          if (p) editedFiles.add(p);
        }
      }

      // 每轮结束回调（进度追踪 + 磁盘输出）
      const turnToolInfo = toolUseBlocks.map(b => ({
        name: b.type === "tool_use" ? b.name : "",
        input: b.type === "tool_use" ? (b.input as Record<string, unknown>) : {},
      }));
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: turnToolInfo, tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });

      continue;
    }

    // max_tokens 续写
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
      log.info("AGENT_LOOP", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      continue;
    }

    // ─── model_context_window_exceeded（撞模型 context window 上限，Claude 4.5+ 新增）───
    //
    // B5-1（§5 新发现 2）：此前子代理**没有这个分支**，会一路穿透落到下方"其他未知
    // 停止原因"，报成「模型返回空响应，疑似模型不可用或网关返回非流式错误页」——
    // 归因完全错误：模型是好的、网关是好的，是这个子代理的上下文顶满了。而子代理恰好
    // 是 token 消耗大户（大量 read/grep/bash 输出堆在历史里），是最容易撞上限的一方。
    // 错误归因的排查成本远高于修复成本：照那句提示去查模型配置/网关可用性，查不出问题。
    //
    // 区别于 max_tokens（我们主动设的输出上限）：这是**输入+输出总和**撞到模型硬上限，
    // 服务端明确拒绝，是"真溢出"的确凿证据。[来源: anthropic-api.md:553,559]
    //
    // 与主循环（`query/loop.ts` 的同名分支）的处理策略一致：压缩上下文后续写。
    // 但**上界更严**——主循环有用户在场可以看着横幅决定要不要 ESC，子代理无人值守，
    // 必须自己保证不空转：
    //   ① 压缩没压动（success=false）→ 立即如实失败，不再续写。压不动意味着已无可裁剪
    //      空间，再来一轮必然撞同一个上限，纯烧 token；
    //   ② 压得动也只给 MAX 次机会 → 防"压一点点、又撞上限"的慢速空转。
    if (response.stopReason === "model_context_window_exceeded") {
      const MAX_CTX_WINDOW_RECOVERY = 2;
      const compactResult = reactiveCompact(ctxMgr);

      if (!compactResult.success) {
        log.error(
          "AGENT_LOOP",
          `撞模型 context window 上限且压缩未生效（${compactResult.messageCountBefore} 条未变），子代理终止`,
        );
        return {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage:
            `子代理上下文撞到模型 context window 上限（stopReason: model_context_window_exceeded），` +
            `且已无可压缩空间（${compactResult.messageCountBefore} 条消息未变）。` +
            `建议缩小子代理任务范围，或减少单次读入的文件量`,
        };
      }

      ctxWindowRecoveryCount++;

      // 上界检查必须在"压缩后续写"那条 info 之前：否则耗尽时会先打出
      // 「第 3/2 次续写」——一句自相矛盾且承诺了一次并不会发生的续写的日志。
      // 日志是排查的第一手材料，这种矛盾会直接把人带偏。
      if (ctxWindowRecoveryCount > MAX_CTX_WINDOW_RECOVERY) {
        log.error("AGENT_LOOP", `context window 压缩续写已达 ${MAX_CTX_WINDOW_RECOVERY} 次上限，子代理终止`);
        return {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage:
            `子代理反复撞到模型 context window 上限（已压缩续写 ${MAX_CTX_WINDOW_RECOVERY} 次仍未脱离）。` +
            `建议缩小子代理任务范围，或减少单次读入的文件量`,
        };
      }

      log.info(
        "AGENT_LOOP",
        `撞模型 context window 上限，压缩后续写（第 ${ctxWindowRecoveryCount}/${MAX_CTX_WINDOW_RECOVERY} 次）：` +
          `${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条`,
      );

      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      continue;
    }

    // 其他未知停止原因（含 null）
    // 背景（事故复盘 session 20260708-102143）：伪装成功的空流（网关对不可用模型
    // 回 200 + text/html 错误页，被解析成 0 事件）会让 stopReason=null 且 content 为空。
    // 此前本分支直接 break 落到"强制总结"路径，把空响应当成正常收尾返回给父级——
    // 掩盖真实故障。现在区分：空响应 → success:false 显式报错（对齐上方 stopReason==="error"
    // 的返回模式，让父级 loop 能如实呈现）；非空但停止原因未识别 → 保留原 break（内容已在
    // lastTextOutput 中，交给下方强制总结收尾）。
    if (response.content.length === 0) {
      log.error(
        "AGENT_LOOP",
        `空响应且停止原因异常（stopReason=${response.stopReason}），判定为伪装成功的空流，子代理中断`,
      );
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: `模型返回空响应（停止原因: ${response.stopReason ?? "null"}），疑似模型不可用或网关返回非流式错误页`,
      };
    }
    // 非空响应但停止原因未识别（罕见，可能是新协议字段）：内容已在 lastTextOutput 中，
    // 交给下方强制总结收尾。但必须设 errorMessage 让父级感知"异常收尾"——此前只 log.warn
    // 就 break，父级（sub-agent.ts）无法区分"正常完成"和"异常停止"。
    log.warn("AGENT_LOOP", `未知停止原因: ${response.stopReason}`);
    unknownStopWarning = `模型以未识别的停止原因结束（stopReason: ${response.stopReason ?? "null"}）`;
    break;
  }

  // 达到最大轮次——强制请求总结（额外一轮，不计入 maxTurns）。
  // 问题：子代理达到 max_turns 被强制终止时，最后一条 assistant 消息可能是
  // "Let me check..." 这类 thinking/planning 文本，extractFinalText 取到它就
  // 导致 result 无法被主循环利用。对标 CC 的策略（Anthropic 模型 thinking 有独立 type
  // 自然被过滤），但 sid-code 支持第三方模型（DeepSeek 等），其 reasoning 混在 text block 中，
  // 无法靠 type 过滤。解法：在退出前追加一轮"请总结"，让模型输出结构化结论再退出。
  if (!signal.aborted) {
    log.info("AGENT_LOOP", `达到最大轮次 ${maxTurns}，请求强制总结`);
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你已达到最大轮次限制，无法继续调用工具。请立即输出你到目前为止的所有发现和结论，以结构化格式（表格/列表）呈现。不要再调用任何工具，直接输出结论。" }],
    });

    // T13.1：强制总结轮同样发射 StreamPhase 事件（与主循环轮对齐，避免总结轮 LLM 调用不可见）。
    // 用独立命名空间 20000+turns，与主循环轮 10000+turns 区分，避免 index 撞车。
    const summaryStreamIndex = 20000 + turns;
    const summaryStartTime = Date.now();
    // B4：总结轮同样带 observerAgentId —— 20000 命名空间只避开了「同一子代理内主流
    // 与总结流」的撞车，避不开「多个并行子代理的总结轮」互相撞车（它们 turns 常常相同）。
    emitStreamPhase(summaryStreamIndex, "fetch_sent", { caller: "sub-agent-summary", model }, observerAgentId);

    try {
      // B2（D2）：总结轮同样走漏斗，**首次获得韧性**。
      //
      // 这一轮此前是纯直连：一次 429 就让整个子代理白跑——前面 maxTurns 轮的工具
      // 调用与 token 全部作废，只因收尾那一次请求没有重试。它恰好是最不该失败的一轮
      // （所有产出都靠它落地成结构化结论），却是唯一完全没有韧性的一轮。
      const summaryStream = streamWithResilience(
        provider,
        {
          model,
          messages: ctxMgr.getCleanedMessages(),
          system: ctxMgr.getSystemPrompt(),
          // B5-6：与主流同一常量。总结轮产出比主流更短（只是收尾陈述），
          // 用同一个值是保守但安全的选择；分成两个常量只会多一个需要解释的数字。
          maxTokens: SUBAGENT_DEFAULT_MAX_TOKENS,
          // 不传 tools，禁止模型继续调工具
          ...config.sendParamsExtra,
        },
        signal,
        {
          querySource: "agent:summary",
          switchMode: "auto",
          maxRetries: config.maxStreamRetries ?? netTimeouts.maxTimeoutRetries,
          retryBackoffBaseMs: config.retryBackoffBaseMs,
          retryBackoffMaxMs: config.retryBackoffMaxMs,
          availability,
          agentId: config.agentId,
          // S3：总结轮同样受时间预算约束——而且它比主流更需要。它是**最后一次**机会
          // 把前面 maxTurns 轮的产出落地成结论，在这里睡满 120s 再被外层砍掉，
          // 等于整个子代理白跑。提前收手至少还能把已有内容交出去。
          deadlineAt: config.deadlineAt,
          // B5-4：总结轮的重试同样计入。它与主流共用一个计数器是刻意的——
          // 用户问的是"这个子代理一共重试了几次"，不区分是主流还是收尾那一次。
          onTelemetry: onTelemetryTap,
          onRetry: (attempt: number, error: string) => {
            clearStreamSnapshot(summaryStreamIndex, undefined, observerAgentId);
            emitStreamPhase(summaryStreamIndex, "error", {
              caller: "sub-agent-summary", model, error, attempt,
              elapsed_ms: Date.now() - summaryStartTime,
            }, observerAgentId);
            emitStreamPhase(summaryStreamIndex, "fetch_sent", { caller: "sub-agent-summary", model, attempt }, observerAgentId);
          },
        },
      );

      const summaryResponse = await processStream(summaryStream, {
        signal,
        heartbeatTimeoutMs: config.streamIdleTimeoutMs,
        overallTimeoutMs: config.streamOverallTimeoutMs,
      });
      accumulateUsage(totalUsage, summaryResponse.usage);
      emitStreamPhase(summaryStreamIndex, "completed", { caller: "sub-agent-summary", model, elapsed_ms: Date.now() - summaryStartTime }, observerAgentId);

      // 提取总结文本
      const summaryTexts = summaryResponse.content.filter(b => b.type === "text");
      if (summaryTexts.length > 0) {
        lastTextOutput = summaryTexts
          .map(b => b.type === "text" ? b.text : "")
          .join("\n");
      }

      // 添加总结到历史
      ctxMgr.addMessage({ role: "assistant", content: summaryResponse.content });
      config.onTurnEnd?.({ turn: turns + 1, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
    } catch (err: any) {
      // 强制总结失败不影响整体返回（降级到 extractFinalText 的启发式过滤）
      emitStreamPhase(summaryStreamIndex, "error", { caller: "sub-agent-summary", model, error: err.message, elapsed_ms: Date.now() - summaryStartTime }, observerAgentId);
      log.warn("AGENT_LOOP", `强制总结轮失败: ${err.message}`);
    }
  }

  return {
    success: true,
    turns,
    totalUsage,
    toolUseCount,
    lastTextOutput,
    messages: ctxMgr.getMessages(),
    // 非空但未知停止原因：内容已返回（success:true），但附带警告让父级可感知异常收尾
    errorMessage: unknownStopWarning,
  };
}
