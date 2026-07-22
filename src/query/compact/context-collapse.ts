/**
 * Context Collapse 层（§2.2，对标 claude-code context collapse）
 *
 * 定位：介于轻量压缩（budget/snip/microcompact）与全量 autoCompact 之间的"中等成本"压缩层。
 *   - snip 只丢消息（零语义保留），autoCompact 全量摘要（一次完整 LLM 调用，高成本）。
 *   - collapse 对**最老的 1-2 段**消息做**分段摘要**：保留近 70% 消息不动，只压老段，
 *     每段一个轻量摘要替换原始消息段。比 snip 多保留语义，比 autoCompact 省 token。
 *
 * 设计要点：
 *   1. 分段：把"可压缩区"（最老的 ~30%）按 SEGMENT_SIZE 条切成若干段，只压最老 maxSegments 段。
 *   2. 分段摘要：每段独立轻量 prompt（非全局摘要）。风险 10.2 缓解：每段 prompt 附带
 *      "前一段摘要"作为上下文，避免丢失跨段因果；段摘要 < 原段 10% 视为失败回退。
 *   3. 边界安全：只在 user 消息且不含 tool_result 处切段，避免切断 tool_use/tool_result 配对。
 *   4. 与 autoCompact 互斥：由 ctxMgr 压缩锁 + 本层 success 判定共同保证——collapse 成功
 *      （usage < target）则跳过 autoCompact；不够则继续 autoCompact。
 */

import type { Message } from "../../llm/types.ts";
import type { Provider } from "../../llm/provider.ts";
import { getLogger } from "../../debug/index.ts";
import { estimateTextTokens } from "../../context/token.ts";
import { recordSideCall } from "../../trace/side-call-sink.ts";
import { withSideCallDeadline, SIDE_CALL_NO_THINK } from "../../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../../llm/errors.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "../../llm/stream-lifecycle.ts";
import { resolveSideCallTimeouts } from "../../config/network-profile.ts";

/** 每段消息条数 */
const SEGMENT_SIZE = 10;
/** 默认最多压缩最老的几段 */
const DEFAULT_MAX_SEGMENTS = 2;
/** 保留不动的最近消息比例 */
const PRESERVE_RECENT_RATIO = 0.7;
/** 段摘要质量下限：摘要 token < 原段 token * 此值 → 视为失败（疑似丢信息） */
const MIN_SEGMENT_RATIO = 0.1;
/** 段摘要消息前缀（TUI 隐藏 + 下次 snip 跳过的边界识别） */
export const SEGMENT_SUMMARY_PREFIX = "[段落摘要]";

/** collapse 选项 */
export interface ContextCollapseOptions {
  targetRatio: number;
  maxTokens: number;
  provider: Provider;
  model: string;
  signal?: AbortSignal;
  /** 最多压缩最老的几段（默认 2） */
  maxSegments?: number;
}

/** collapse 结果 */
export interface CollapseResult {
  messages: Message[];
  collapsedSegments: number;
  savedTokens: number;
  /** usage 是否降到目标以下（true 则可跳过 autoCompact） */
  success: boolean;
}

/** 估算消息段的 token */
function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") total += estimateTextTokens(block.text);
      else if (block.type === "tool_result" && typeof block.content === "string") total += estimateTextTokens(block.content);
      else if (block.type === "tool_use") total += estimateTextTokens(JSON.stringify(block.input));
    }
  }
  return total;
}

/** 把一段消息渲染成摘要 LLM 的输入文本 */
function renderSegment(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const text = msg.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_use") return `[调用工具 ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`;
        if (b.type === "tool_result" && typeof b.content === "string") return `[工具结果: ${b.content.slice(0, 500)}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) parts.push(`[${msg.role}] ${text}`);
  }
  return parts.join("\n\n");
}

/**
 * 找到可压缩区的"段边界下标"列表（只在安全分割点切段）。
 * 返回的每个下标都是"段的起点"，且为 user 消息、不含 tool_result。
 */
function findSegmentBoundaries(messages: Message[], compressibleEnd: number): number[] {
  const boundaries: number[] = [];
  let countSinceLast = 0;
  for (let i = 0; i < compressibleEnd; i++) {
    const msg = messages[i];
    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    const isSafe = msg.role === "user" && !hasToolResult && !msg._meta?.origin;
    if (boundaries.length === 0) {
      if (isSafe) { boundaries.push(i); countSinceLast = 0; }
    } else {
      countSinceLast++;
      if (isSafe && countSinceLast >= SEGMENT_SIZE) {
        boundaries.push(i);
        countSinceLast = 0;
      }
    }
  }
  return boundaries;
}

/** 单段摘要的轻量 prompt（含前段摘要作上下文，缓解跨段因果丢失） */
async function summarizeSegment(
  segmentText: string,
  prevSummary: string | null,
  opts: ContextCollapseOptions,
): Promise<string> {
  const prevContext = prevSummary
    ? `\n\n为保持连贯，这是紧邻的上一段摘要（仅作参考，不要重复其内容）：\n${prevSummary}\n`
    : "";
  const system =
    "你是对话分段摘要助手。给定一段较早的对话片段，生成一段简洁但保留关键结构的摘要：" +
    "保留涉及的文件、关键决策、用户纠正、已完成与待办。仅输出摘要纯文本，不要调用工具。";
  const user = `请摘要以下对话片段（保留文件路径、决策、用户纠正等关键信息）：${prevContext}\n\n${segmentText}`;

  // T3.3：给单段摘要套 45s 硬超时（单段比整体 compact 更短）。超时后 throw
  // SideCallTimeoutError，由外层 catch 处理（跳过该段 / 返回已成功部分）。
  // 配置-4：走 network-profile 的 side-call 子表统一解析（env override > 默认 45s）
  const SEGMENT_TIMEOUT_MS = resolveSideCallTimeouts().collapseSegmentMs;

  const { summary, streamUsage } = await withSideCallDeadline(
    "context-collapse",
    SEGMENT_TIMEOUT_MS,
    async (signal) => {
      const stream = opts.provider.sendMessageStream(
        {
          model: opts.model,
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
          system,
          maxTokens: 1500,
          // H5：分段摘要是压缩任务，关思考（同 auto-compact）。
          thinking: SIDE_CALL_NO_THINK,
        },
        signal,
      );
      let s = "";
      let usage: any = null;
      // T7：叠加 StreamLifecycle（sideCall preset），overall 收敛到 45s 段超时之内。
      // 提供比 45s 硬 deadline 更细粒度的 idle/content stall 检测。
      const lifecycle = createStreamLifecycle({
        idleTimeoutMs: LIFECYCLE_PRESETS.sideCall.idleTimeoutMs,
        contentProgressTimeoutMs: Math.min(
          LIFECYCLE_PRESETS.sideCall.contentProgressTimeoutMs,
          SEGMENT_TIMEOUT_MS,
        ),
        overallTimeoutMs: SEGMENT_TIMEOUT_MS,
        isContentProgress: (e: any) =>
          e?.type === "content_block_delta" || e?.type === "message_delta",
        label: "SIDE-CALL:context-collapse",
        signal,
      });
      for await (const event of lifecycle.guard(stream)) {
        // A7 纵深防御：上下文折叠 side-call 检查 signal
        // H10：抛出携带 abort reason 的错误，与主路径 reason 白名单口径一致。
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
    opts.signal,
  );
  // 记录辅助调用用量
  if (streamUsage) {
    recordSideCall({
      label: "context-collapse",
      model: opts.model,
      inputTokens: streamUsage.inputTokens ?? 0,
      outputTokens: streamUsage.outputTokens ?? 0,
      cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
      cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
      durationMs: 0,
    });
  }
  return summary.trim();
}

/**
 * 执行 Context Collapse：对最老的若干段做分段摘要替换。
 * 失败（无可压段 / 摘要质量不达标 / LLM 异常）时尽量返回已成功的部分，success 反映是否达标。
 */
export async function contextCollapse(
  messages: Message[],
  options: ContextCollapseOptions,
): Promise<CollapseResult> {
  const log = getLogger();
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const tokensBefore = estimateMessagesTokens(messages);

  // 可压缩区：最老的 (1 - PRESERVE_RECENT_RATIO) 部分
  const compressibleEnd = Math.floor(messages.length * (1 - PRESERVE_RECENT_RATIO));
  if (compressibleEnd < SEGMENT_SIZE) {
    // 可压区太小，不值得 collapse
    return { messages, collapsedSegments: 0, savedTokens: 0, success: false };
  }

  const boundaries = findSegmentBoundaries(messages, compressibleEnd);
  if (boundaries.length < 2) {
    // 不足以切出完整段（需要至少 2 个边界界定 1 段）
    return { messages, collapsedSegments: 0, savedTokens: 0, success: false };
  }

  // 构造段区间 [start, end)，只取最老的 maxSegments 段
  const segments: { start: number; end: number }[] = [];
  for (let i = 0; i < boundaries.length - 1 && segments.length < maxSegments; i++) {
    segments.push({ start: boundaries[i], end: boundaries[i + 1] });
  }
  if (segments.length === 0) {
    return { messages, collapsedSegments: 0, savedTokens: 0, success: false };
  }

  // 逐段摘要（顺序执行，把前段摘要传给后段）
  const segmentSummaries: { start: number; end: number; summary: string }[] = [];
  let prevSummary: string | null = null;
  for (const seg of segments) {
    const segMsgs = messages.slice(seg.start, seg.end);
    const segText = renderSegment(segMsgs);
    const segTokens = estimateMessagesTokens(segMsgs);
    try {
      const summary = await summarizeSegment(segText, prevSummary, options);
      // 质量下限：摘要过短视为失败，跳过该段（保留原始消息）
      if (!summary || estimateTextTokens(summary) < segTokens * MIN_SEGMENT_RATIO) {
        log.warn("CONTEXT_COLLAPSE", `段 [${seg.start},${seg.end}) 摘要质量不达标，跳过该段`);
        continue;
      }
      segmentSummaries.push({ ...seg, summary });
      prevSummary = summary;
    } catch (err: any) {
      log.warn("CONTEXT_COLLAPSE", `段 [${seg.start},${seg.end}) 摘要失败: ${err.message}`);
      // T13.3：记录失败的 side-call
      recordSideCall({
        label: "context-collapse",
        model: options.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 0,
        success: false,
        error: err.message,
        timedOut: /timeout|超时|timed out/i.test(err.message),
      });
      // 单段失败不影响其它段
    }
  }

  if (segmentSummaries.length === 0) {
    return { messages, collapsedSegments: 0, savedTokens: 0, success: false };
  }

  // 用段摘要消息替换原始段（从后往前替换，避免下标漂移）
  const result = [...messages];
  for (let i = segmentSummaries.length - 1; i >= 0; i--) {
    const { start, end, summary } = segmentSummaries[i];
    const summaryMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `${SEGMENT_SUMMARY_PREFIX}\n${summary}` }],
      _meta: { origin: "compact-summary" },
    };
    const ackMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，已了解这段较早的对话。" }],
      _meta: { origin: "compact-summary" },
    };
    result.splice(start, end - start, summaryMsg, ackMsg);
  }

  const tokensAfter = estimateMessagesTokens(result);
  const savedTokens = Math.max(0, tokensBefore - tokensAfter);
  const usageAfter = tokensAfter / options.maxTokens;
  const success = usageAfter <= options.targetRatio;

  log.info(
    "CONTEXT_COLLAPSE",
    `collapse ${segmentSummaries.length} 段，节省 ~${savedTokens} token，使用率降至 ${(usageAfter * 100).toFixed(0)}%${success ? "（已达标，跳过 autoCompact）" : "（仍超标，继续 autoCompact）"}`,
  );

  return { messages: result, collapsedSegments: segmentSummaries.length, savedTokens, success };
}
