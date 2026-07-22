/**
 * 自动压缩逻辑
 * 从 app.ts 提取，处理上下文压缩和溢出恢复
 * 集成熔断器：连续失败时停止浪费 API 调用
 */

import type { Provider } from "../llm/provider.ts";
import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import type { ToolDefinition, Message } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";
import { AutoCompactCircuitBreaker } from "./circuit-breaker.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { withSideCallDeadline, SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../llm/errors.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "../llm/stream-lifecycle.ts";
import { isPromptTooLongError } from "./reactive-compact.ts";

/** G17：摘要请求 PTL 截头重试的最大次数（每次截掉更多最早消息，达到上限后降级简单截断） */
const MAX_PTL_RETRIES = 4;
/** G17：截头重试时待摘要消息的最少保留条数（低于此值不再截，直接降级），保证不死循环 */
const PTL_RETRY_MIN_KEEP = 4;

/** 全局熔断器实例（跨调用共享状态） */
let globalCircuitBreaker: AutoCompactCircuitBreaker | null = null;

function getCircuitBreaker(): AutoCompactCircuitBreaker {
  if (!globalCircuitBreaker) {
    globalCircuitBreaker = new AutoCompactCircuitBreaker();
  }
  return globalCircuitBreaker;
}

/** 重置熔断器（测试用） */
export function resetCircuitBreaker(): void {
  globalCircuitBreaker?.reset();
  globalCircuitBreaker = null;
}

/** 自动压缩依赖 */
export interface AutoCompactDeps {
  provider: Provider;
  config: Config;
  ctxMgr: ContextManager;
  hookSystem: HookSystem;
  getAbortSignal: () => AbortSignal | undefined;
  /**
   * 可选 Session Memory 提供方。
   * 提供时优先用结构化会话笔记压缩，为空则回退到 LLM 摘要。
   */
  sessionMemory?: import("../session-memory/compact.ts").SessionMemoryProvider;
  /**
   * §3.1 压缩继承工具集：主对话的工具定义。传入后摘要请求复用主对话已缓存的工具前缀
   * （Anthropic prompt cache hit），并让 COMPACT_SYSTEM_PROMPT 显式禁止调用工具。
   * 不传则不下发 tools（行为同旧版）。
   */
  toolSchemas?: ToolDefinition[];
  /**
   * §12.3 摘要用低成本模型：覆盖摘要请求所用模型（默认 config.model）。
   * 由调用方解析（subAgentModels.summarize ?? default ?? model）。
   */
  compactModel?: string;
  /**
   * §2.1 Post-compact 文件恢复：共享的 FileReadTracker，用于压缩后恢复最近访问的文件。
   */
  fileReadTracker?: import("../tool/file-read-tracker.ts").FileReadTracker;
  /**
   * §12.5 子代理熔断器隔离：是否为主代理。
   * 仅主代理的压缩失败计入全局熔断器；子代理压缩失败不污染主代理的熔断状态。
   */
  isMainAgent?: boolean;
  /**
   * §5 压缩通知重置 MC state：缓存 microcompact 状态机。
   * 压缩成功后重置——压缩重组了消息历史，旧的"已删除 tool_use_id"映射全部失效。
   */
  cachedMicrocompactState?: import("./compact/cached-microcompact.ts").CachedMicrocompactState;
  /**
   * 会话级临时目录（§4.1 质量报告 / §4.3 决策外化落盘）。不传则跳过落盘。
   */
  sessionDir?: string;
}

/**
 * 自动压缩：上下文接近上限时，用 LLM 生成摘要并压缩消息历史
 * 如果 LLM 不可用或熔断器打开，则使用简单截断策略
 */
/**
 * autoCompact 的结果，供 loop 层区分处置（静默-9）：
 *   - "summarized"：LLM 摘要压缩成功（无损语义，无需提示）
 *   - "truncated"：摘要失败/熔断，降级为简单截断（**有损**，丢弃老消息，需 yield warning 提示用户）
 *   - "skipped"：消息太少 / 已有压缩在进行，未做任何压缩
 */
export type AutoCompactOutcome = "summarized" | "truncated" | "skipped";

export async function autoCompact(deps: AutoCompactDeps): Promise<AutoCompactOutcome> {
  const log = getLogger();
  const messages = deps.ctxMgr.getMessages();
  const circuitBreaker = getCircuitBreaker();
  // §12.5：子代理压缩失败不计入全局熔断器（默认按主代理处理，未显式标记时保持旧行为）
  const isMainAgent = deps.isMainAgent !== false;
  const recordFailure = () => {
    if (isMainAgent) circuitBreaker.recordFailure();
    else log.debug("COMPACT", "子代理压缩失败，不计入全局熔断器");
  };
  const recordSuccess = () => {
    if (isMainAgent) circuitBreaker.recordSuccess();
  };

  if (messages.length <= 4) {
    log.debug("COMPACT", "消息太少，跳过压缩");
    return "skipped";
  }

  // §6 压缩互斥锁：已有压缩在进行 → 跳过，避免同一消息历史被两条压缩路径竞态改写
  if (!deps.ctxMgr.acquireCompactLock()) {
    log.warn("COMPACT", "已有压缩流程在进行中，跳过本次 autoCompact");
    return "skipped";
  }

  try {
    return await doAutoCompact(deps, messages, circuitBreaker, isMainAgent, recordFailure, recordSuccess);
  } finally {
    deps.ctxMgr.releaseCompactLock();
  }
}

/** autoCompact 主体（已持有压缩锁） */
async function doAutoCompact(
  deps: AutoCompactDeps,
  messages: Message[],
  circuitBreaker: AutoCompactCircuitBreaker,
  _isMainAgent: boolean,
  recordFailure: () => void,
  recordSuccess: () => void,
): Promise<AutoCompactOutcome> {
  const log = getLogger();
  const messagesBefore = messages.length;
  const tokensBefore = deps.ctxMgr.estimateTokens();

  // 熔断器检查：如果熔断中，直接降级为简单截断
  if (!circuitBreaker.canExecute()) {
    log.warn("COMPACT", "autoCompact 熔断中，降级为简单截断");
    const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。（autoCompact 熔断中）`;
    deps.ctxMgr.compactWithSummary(simpleSummary);
    await postCompactReattachAndNotify(deps, messages, simpleSummary, messagesBefore, tokensBefore, false);
    return "truncated";
  }

  // pre_compact hook（blocking 时可阻止压缩）
  const preCompactResult = await deps.hookSystem.firePreCompactEvent("auto");
  if (preCompactResult.finalOutput?.isBlockingDecision()) {
    log.info("HOOK", `压缩被 hook 阻止: ${preCompactResult.finalOutput.getEffectiveReason()}`);
    return "skipped";
  }

  try {
    // 优先路径：Session Memory 压缩（结构化会话笔记）
    if (deps.sessionMemory) {
      try {
        const { trySessionMemoryCompaction } = await import("../session-memory/compact.ts");
        const smResult = await trySessionMemoryCompaction(deps.sessionMemory);
        if (smResult) {
          deps.ctxMgr.compactWithSummary(smResult.summary);
          recordSuccess();
          log.info("COMPACT", `Session Memory 压缩完成，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
          await postCompactReattachAndNotify(deps, messages, smResult.summary, messagesBefore, tokensBefore, false);
          // Session Memory 压缩是结构化笔记，语义无损，等同摘要成功。
          return "summarized";
        }
        // smResult 为 null：Session Memory 为空，回退到 LLM 摘要（不计失败）
      } catch (err: any) {
        log.debug("COMPACT", `Session Memory 压缩异常，回退 LLM 摘要: ${err.message}`);
      }
    }

    // 尝试用 LLM 生成摘要（Layer 1：结构化 9 段 prompt 工程）
    // §4.2 自适应：保留范围按历史压缩质量动态推荐
    const { recommendParams } = await import("./compact/adaptive-strategy.ts");
    const PRESERVE_RECENT = recommendParams().preserveRecent;

    // §3.4 Strip：摘要输入前剥离图片块 + 上次 post-compact 重注入的恢复消息（避免重复累积）
    const { stripImages, stripReinjectedAttachments } = await import("./compact/strip.ts");
    const summarizeBase = stripReinjectedAttachments(stripImages(messages));
    const toSummarize = summarizeBase.slice(0, -PRESERVE_RECENT);

    const {
      buildCompactUserPrompt,
      getCompactUserSummaryMessage,
    } = await import("./compact/auto-compact-prompt.ts");

    // T3.1/T3.2：给整个"建流 + 流消费"套 60s 硬超时（Promise.race，不依赖 signal 传播）。
    // 摘要不应超过 1 分钟；超时后走下方 catch → recordFailure + 降级为简单截断。
    // withSideCallDeadline 内部把合并后的 signal（外部 signal + 超时 signal）传给 provider，
    // 让底层 fetch/流在超时时也尽力被 abort（双保险）。
    // 配置-4：走 network-profile 的 side-call 子表统一解析（env override > 默认 60s）
    const COMPACT_TIMEOUT_MS = resolveSideCallTimeouts().compactMs;

    // G17：摘要请求本身 PTL 截头重试。
    // 待摘要历史可能大到连"摘要请求"这一个 user 消息都超上限（prompt-too-long）。
    // 对标 claude-code truncateHeadForPTLRetry：逐轮截掉最早的消息后重试摘要请求，
    // 而不是一步跌到有损的简单截断。全部重试都失败才降级到 catch 里的简单截断兜底。
    let summary = "";
    let streamUsage: any = null;
    let ptlSummarizeBase = toSummarize;
    for (let ptlAttempt = 0; ; ptlAttempt++) {
      const summaryPrompt = buildCompactUserPrompt(ptlSummarizeBase);
      try {
        ({ summary, streamUsage } = await runSummaryRequest(deps, summaryPrompt, COMPACT_TIMEOUT_MS));
        break; // 成功（含空摘要，交由下方判定）
      } catch (err: any) {
        // 仅对 PTL 错误做截头重试；其它错误（超时/网络/abort）直接上抛给外层 catch 降级
        if (!isPromptTooLongError(err) || ptlAttempt >= MAX_PTL_RETRIES) {
          throw err;
        }
        const truncated = truncateHeadForPTLRetry(ptlSummarizeBase, ptlAttempt);
        if (!truncated || truncated.length >= ptlSummarizeBase.length) {
          // 无法再截（已到最小保留 / 找不到更靠后的安全边界）→ 上抛降级，避免死循环
          throw err;
        }
        log.warn(
          "COMPACT",
          `摘要请求 prompt-too-long，截头重试 #${ptlAttempt + 1}：待摘要 ${ptlSummarizeBase.length} → ${truncated.length} 条`,
        );
        ptlSummarizeBase = truncated;
      }
    }

    // 记录辅助调用用量
    if (streamUsage) {
      recordSideCall({
        label: "auto-compact",
        model: deps.compactModel || deps.config.model,
        inputTokens: streamUsage.inputTokens ?? 0,
        outputTokens: streamUsage.outputTokens ?? 0,
        cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
        cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
        durationMs: 0,
      });
    }

    if (summary) {
      // Layer 2：post-compact 消息重组——剥离 analysis 草稿、追加静默续接 +
      // 保留消息提示 + 转录路径提示，让模型压缩后无缝续接而非"断片"。
      const formattedSummary = getCompactUserSummaryMessage(summary, {
        suppressFollowUpQuestions: true,
        transcriptPath: deps.ctxMgr.getTranscriptPath(),
        recentMessagesPreserved: true,
      });
      // §2.1 / §4.3：构造文件恢复 + 决策点重注入消息，随摘要一起注入
      const extraReattach = await buildExtraReattach(deps, toSummarize);
      deps.ctxMgr.compactWithSummary(formattedSummary, extraReattach);
      recordSuccess();
      log.info("COMPACT", `自动压缩完成，摘要 ${formattedSummary.length} 字符，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
      await postCompactReattachAndNotify(deps, toSummarize, formattedSummary, messagesBefore, tokensBefore, true);
      return "summarized";
    }

    // 空摘要也算失败
    recordFailure();
  } catch (err: any) {
    log.warn("COMPACT", `LLM 摘要失败，使用简单截断: ${err.message}`);
    recordFailure();
    // T13.3：记录失败的 side-call
    recordSideCall({
      label: "auto-compact",
      model: deps.compactModel || deps.config.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
      success: false,
      error: err.message,
      timedOut: /timeout|超时|timed out/i.test(err.message),
    });
  }

  // 降级：简单截断（有损——丢弃老消息，仅留一句占位）
  const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。`;
  deps.ctxMgr.compactWithSummary(simpleSummary);
  log.info("COMPACT", `简单截断完成，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
  await postCompactReattachAndNotify(deps, messages, simpleSummary, messagesBefore, tokensBefore, false);
  return "truncated";
}

/**
 * G17：发出一次摘要 LLM 请求（建流 + 流消费 + 超时守护）。
 * 从 doAutoCompact 内联提取，便于 PTL 截头重试循环复用。
 * 抛出的错误由调用方分类：PTL → 截头重试；其它 → 降级简单截断。
 */
async function runSummaryRequest(
  deps: AutoCompactDeps,
  summaryPrompt: string,
  timeoutMs: number,
): Promise<{ summary: string; streamUsage: any }> {
  const { COMPACT_SYSTEM_PROMPT } = await import("./compact/auto-compact-prompt.ts");
  return withSideCallDeadline(
    "auto-compact",
    timeoutMs,
    async (signal) => {
      const stream = deps.provider.sendMessageStream(
        {
          // §12.3：摘要走低成本模型（未指定则跟主模型）
          model: deps.compactModel || deps.config.model,
          messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
          system: COMPACT_SYSTEM_PROMPT,
          maxTokens: 4000,
          // H5：上下文摘要是「压缩历史→出摘要文本」的任务，关思考。摘要模型未指定时跟主模型，
          // 主模型为思考模型时不关会让每次 auto-compact 触发完整思考，超时（阻塞主循环）+成本双放大。
          thinking: SIDE_CALL_NO_THINK,
          // §3.1：携带主对话工具定义（命中已缓存前缀）；toolChoice=none 禁止摘要时调用工具
          ...(deps.toolSchemas && deps.toolSchemas.length > 0
            ? { tools: deps.toolSchemas, toolChoice: "none" as const }
            : {}),
        },
        signal,
      );
      let s = "";
      let usage: any = null;
      // T7：给 side-call 流消费叠加 StreamLifecycle（sideCall preset：idle 30s / content 60s /
      // overall 60s），在 withSideCallDeadline 的 60s 硬 deadline 之内提供更细粒度的 stall 检测。
      // 超时触发时 abort 合并 signal → 下方 signal.aborted 检查退出（不依赖底层 reader settle）。
      const lifecycle = createStreamLifecycle({
        idleTimeoutMs: LIFECYCLE_PRESETS.sideCall.idleTimeoutMs,
        contentProgressTimeoutMs: LIFECYCLE_PRESETS.sideCall.contentProgressTimeoutMs,
        overallTimeoutMs: LIFECYCLE_PRESETS.sideCall.overallTimeoutMs,
        isContentProgress: (e: any) =>
          e?.type === "content_block_delta" || e?.type === "message_delta",
        label: "SIDE-CALL:auto-compact",
        signal,
      });
      for await (const event of lifecycle.guard(stream)) {
        // A6 纵深防御：压缩 side-call 检查 signal，防止主循环 abort 后压缩仍挂起
        // H10：抛出携带 abort reason 的错误（withSideCallDeadline 超时段 reason="side-call-timeout"），
        // 与主路径 reason 白名单口径一致，不再裸 "Request aborted"。
        if (signal.aborted) {
          throw new Error(String((signal as any).reason ?? SIDE_CALL_TIMEOUT_REASON));
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          s += event.delta.text;
        } else if (event.type === "message_stop" && (event as any).usage) {
          usage = (event as any).usage;
        }
      }
      return { summary: s, streamUsage: usage };
    },
    deps.getAbortSignal(),
  );
}

/**
 * G17：为 PTL 截头重试截掉待摘要历史里最早的消息。
 *
 * 策略：按重试轮次递增截掉比例（第 1 次砍 ~25%、第 2 次 ~40% …），
 * 且截断点对齐到"安全边界"（user 消息且不含 tool_result），避免把 tool_use/tool_result
 * 配对切碎——虽然这里是给"摘要请求"用（其本身只有一个 user 消息，不会触发 400），
 * 但对齐轮次边界能让保留下来的片段语义更完整（不从半个工具往返开始）。
 *
 * 返回截断后的消息；若无法再截（已到最小保留 / 找不到更靠后的安全边界）返回 null。
 */
function truncateHeadForPTLRetry(messages: Message[], attempt: number): Message[] | null {
  if (messages.length <= PTL_RETRY_MIN_KEEP) return null;

  // 递增砍头比例：0.25 / 0.40 / 0.55 / 0.70 …（每轮多砍 15%，封顶 0.85）
  const dropRatio = Math.min(0.85, 0.25 + attempt * 0.15);
  let dropTarget = Math.floor(messages.length * dropRatio);
  // 至少砍 1 条，保证有进展
  if (dropTarget < 1) dropTarget = 1;

  // 从 dropTarget 起向后找第一个安全边界（user 消息、无 tool_result、非内部注入消息），
  // 让保留段从一个干净的轮次开头开始。
  let start = -1;
  for (let i = dropTarget; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    if (msg.role === "user" && !hasToolResult && !msg._meta?.origin) {
      start = i;
      break;
    }
  }
  // 找不到更靠后的安全边界 → 退回按条数硬切（发给摘要请求的单 user 消息不受配对约束）
  if (start === -1) start = dropTarget;

  // 保证最少保留
  if (messages.length - start < PTL_RETRY_MIN_KEEP) {
    start = messages.length - PTL_RETRY_MIN_KEEP;
  }
  if (start <= 0) return null;

  return messages.slice(start);
}

/**
 * §2.1 + §4.3：构造"随摘要一起注入"的额外消息——决策点重注入 + 原始任务锚点。
 * 文件恢复在 postCompact 阶段单独做（要在压缩完成、token 腾出后再注入并守预算）。
 * 决策点和原始任务锚点都很短，随摘要一起注入信息密度最高。
 */
async function buildExtraReattach(deps: AutoCompactDeps, toSummarize: Message[]): Promise<Message[] | undefined> {
  const results: Message[] = [];

  // 决策点重注入
  try {
    const { extractDecisions, persistDecisions, buildDecisionReattachMessages } = await import("./compact/decisions.ts");
    const decisions = extractDecisions(toSummarize);
    if (decisions.length > 0) {
      const decisionsPath = deps.sessionDir ? persistDecisions(decisions, deps.sessionDir) : null;
      results.push(...buildDecisionReattachMessages(decisions, decisionsPath));
    }
  } catch (err: any) {
    getLogger().debug("COMPACT", `决策点外化跳过: ${err.message}`);
  }

  // 原始任务锚点：把第一条用户消息原文保留（防止弱模型摘要丢失目标）。
  // 只有当第一条用户消息确实在被压缩的范围内时才需要重注入。
  try {
    const { REATTACH_ORIGINAL_TASK_PREFIX, REATTACH_ORIGIN } = await import("./compact/reattach-markers.ts");
    const firstUserMsg = toSummarize.find(m => m.role === "user" && m.content.some(b => b.type === "text"));
    if (firstUserMsg) {
      const userText = firstUserMsg.content
        .filter(b => b.type === "text")
        .map(b => (b as { type: "text"; text: string }).text)
        .join("\n");
      // 截断到 2000 字符，避免超长用户消息占满恢复预算
      const truncated = userText.length > 2000 ? userText.slice(0, 2000) + "\n[截断]" : userText;
      results.push({
        role: "user",
        content: [{ type: "text", text: `${REATTACH_ORIGINAL_TASK_PREFIX}\n以下是用户最初的请求（原始任务），即使摘要遗漏也务必遵循：\n\n${truncated}` }],
        _meta: { origin: REATTACH_ORIGIN },
      });
      results.push({
        role: "assistant",
        content: [{ type: "text", text: "好的，我已重新加载原始任务目标，会继续围绕它执行。" }],
        _meta: { origin: REATTACH_ORIGIN },
      });
    }
  } catch (err: any) {
    getLogger().debug("COMPACT", `原始任务锚点跳过: ${err.message}`);
  }

  return results.length > 0 ? results : undefined;
}

/**
 * 压缩后统一收尾：文件恢复（§2.1）、MC state 重置（§5）、质量校验（§4.1）、
 * 自适应记录（§4.2）、PostCompact hook（§3.2）。全部 best-effort，异常不影响主流程。
 */
async function postCompactReattachAndNotify(
  deps: AutoCompactDeps,
  originalMessages: Message[],
  summary: string,
  messagesBefore: number,
  tokensBefore: number,
  usedLLM: boolean,
): Promise<void> {
  const log = getLogger();

  // §2.1：恢复最近访问文件（压缩已腾出空间，这里再注入并守 50K 预算）
  if (deps.fileReadTracker) {
    try {
      const { buildReattachFileMessages } = await import("./compact/reattach-files.ts");
      const fileMsgs = buildReattachFileMessages(deps.fileReadTracker);
      if (fileMsgs.length > 0) {
        deps.ctxMgr.appendReattachMessages(fileMsgs);
        log.info("COMPACT", `Post-compact 文件恢复注入 ${fileMsgs.length} 条消息`);
      }
    } catch (err: any) {
      log.debug("COMPACT", `Post-compact 文件恢复跳过: ${err.message}`);
    }
  }

  // §5：压缩重组了消息历史，缓存 microcompact 状态机的"已删除 tool_use_id"映射全部失效，重置
  if (deps.cachedMicrocompactState) {
    try {
      const { resetCachedMicrocompactState } = await import("./compact/cached-microcompact.ts");
      resetCachedMicrocompactState(deps.cachedMicrocompactState);
      log.debug("COMPACT", "已重置 cached microcompact 状态机");
    } catch { /* 忽略 */ }
  }

  // G1：压缩重组消息历史后，下一次请求 cache_read 必然骤降（前缀变了），这是预期的——
  // 通知检测器抑制紧接的一次检测，避免误报 cache break 淹没真实告警。
  try {
    const { notifyCompaction } = await import("../api/cache-detection.ts");
    notifyCompaction("main");
  } catch { /* 忽略 */ }

  // §4.1：质量校验（覆盖率）
  let coverage = 1;
  try {
    const { recordCompactQuality } = await import("./compact/quality-check.ts");
    const report = recordCompactQuality(originalMessages, summary, deps.sessionDir);
    coverage = report.coverage;
  } catch { /* 忽略 */ }

  const tokensAfter = deps.ctxMgr.estimateTokens();
  const messagesAfter = deps.ctxMgr.messageCount();
  const savedRatio = tokensBefore > 0 ? Math.max(0, (tokensBefore - tokensAfter) / tokensBefore) : 0;

  // §4.2：记录压缩特征供后续自适应
  try {
    const { recordCompactFeature } = await import("./compact/adaptive-strategy.ts");
    recordCompactFeature({ tokensBefore, tokensAfter, savedRatio, usedLLM, coverage });
  } catch { /* 忽略 */ }

  // §3.2：PostCompact hook 接线
  try {
    await deps.hookSystem.firePostCompactEvent("auto", messagesBefore, messagesAfter, Math.max(0, tokensBefore - tokensAfter));
  } catch (err: any) {
    log.debug("HOOK", `PostCompact hook 执行异常（不影响压缩）: ${err.message}`);
  }
}

/**
 * 处理上下文溢出错误，尝试自动缩小 max_tokens
 * 返回调整后的 maxTokens，无法恢复时返回 null
 */
export function handleContextOverflow(
  err: any,
  _currentMaxTokens: number,
  ctxMgr: ContextManager,
  toolCount: number,
): number | null {
  const msg = err.message || String(err);
  const overflowMatch = msg.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (!overflowMatch && !msg.toLowerCase().includes("context") && !msg.toLowerCase().includes("token")) {
    return null;
  }

  // 解析不出报错文本里的具体上限时，回退到 ctxMgr 的真实上下文窗口
  // （由当前模型按 availableModels/内置 registry 推导，非硬编码 200000）。
  // 硬编码 200000 会让 1M 窗口模型的可用空间被严重低估，错误地放弃本可恢复的溢出。
  let contextLimit = ctxMgr.getMaxTokens();
  let inputTokens = 0;

  if (overflowMatch) {
    inputTokens = parseInt(overflowMatch[1], 10);
    contextLimit = parseInt(overflowMatch[3], 10);
  } else {
    inputTokens = ctxMgr.estimateTokens(toolCount);
  }

  const available = Math.max(0, contextLimit - inputTokens - 1000);
  if (available < 3000) {
    return null;
  }

  return available;
}
