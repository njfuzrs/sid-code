/**
 * G22：部分压缩（partial-compact / compact-up-to）
 *
 * 定位：对标 claude-code PARTIAL_COMPACT_PROMPT——只压缩对话的**前半段**（到某个 round 边界为止），
 *   把被压段替换成一份背景摘要，**保留后半段原文不动**。区别于全量 autoCompact（整段都进摘要）
 *   和 context-collapse（对最老的若干段分别做轻量段摘要）：partialCompact 是"一刀切成前/后两半，
 *   前半段一份摘要 + 后半段原文"，语义边界更清晰，适合"我只想压到某个点"的显式调用。
 *
 * 硬约束（最关键）：**绝不切碎 tool_use/tool_result 对**。
 *   压缩边界必须落在完整的 round 边界上（user 消息、不含 tool_result、非内部注入消息），
 *   与 findCompressSplitPoint / context-collapse.findSegmentBoundaries 的安全边界定义一致。
 *   切分后用 checkMessageHistoryIntegrity 双向校验：被压段（自成摘要，不含配对）+ 保留段
 *   都必须完整，否则回退到更靠前的安全边界，实在找不到就放弃（返回未改动的原消息）。
 *
 * 这是**新增能力**：默认不接进主循环自动触发（主循环仍走既有稳定的
 * runCompactPipeline → contextCollapse → autoCompact 路径），只作为可被显式调用的函数导出
 * （例如未来的 /compact-up-to 命令、或某个触发点判断"压到这里就够了"时调用）。
 */

import type { Message } from "../../llm/types.ts";
import type { Provider } from "../../llm/provider.ts";
import { getLogger } from "../../debug/index.ts";
import { estimateTextTokens } from "../../context/token.ts";
import { recordSideCall } from "../../trace/side-call-sink.ts";
import { withSideCallDeadline } from "../../llm/side-call-timeout.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "../../llm/stream-lifecycle.ts";
import { resolveSideCallTimeouts } from "../../config/network-profile.ts";
import { checkMessageHistoryIntegrity } from "../../agent/message-invariants.ts";
import {
  buildPartialCompactUserPrompt,
  PARTIAL_COMPACT_SYSTEM_PROMPT,
} from "./auto-compact-prompt.ts";

/** 部分压缩摘要消息前缀（TUI 隐藏 + 下次 snip 跳过的边界识别，与其它压缩摘要统一） */
export const PARTIAL_COMPACT_PREFIX = "[前段摘要]";

/** partialCompact 选项 */
export interface PartialCompactOptions {
  provider: Provider;
  /** 摘要所用模型（建议传低成本模型；不传由调用方保证 model 有效） */
  model: string;
  signal?: AbortSignal;
  /** 可选自定义摘要指令（追加到 prompt 末尾） */
  customInstructions?: string;
  /** 摘要请求超时（毫秒）；不传走 network-profile 的 compact 子表默认值 */
  timeoutMs?: number;
}

/** partialCompact 结果 */
export interface PartialCompactResult {
  /** 压缩后的新消息序列（前半段摘要 + 后半段原文）。success=false 时为原消息引用不变 */
  messages: Message[];
  /** 是否成功压缩 */
  success: boolean;
  /** 实际采用的压缩边界下标（保留段从此下标开始）；未压缩时为 -1 */
  splitIndex: number;
  /** 被压缩的消息条数 */
  compactedCount: number;
  /** 估算节省的 token 数 */
  savedTokens: number;
  /** 未成功时的原因（调用方可据此提示） */
  reason?: string;
}

/**
 * 判断某下标是否为安全的 round 边界：
 * user 消息、不含 tool_result、非内部注入消息（_meta.origin）。
 * 与 ContextManager.findCompressSplitPoint / context-collapse.findSegmentBoundaries 定义一致。
 */
function isSafeBoundary(msg: Message | undefined): boolean {
  if (!msg || !Array.isArray(msg.content)) return false;
  if (msg.role !== "user") return false;
  if (msg.content.some((b) => b.type === "tool_result")) return false;
  if (msg._meta?.origin) return false;
  return true;
}

/**
 * 从期望切分点 desired 出发，找到 <= desired 的最靠后的安全 round 边界下标。
 * 找不到返回 -1（说明期望点之前没有任何干净的轮次起点，无法安全压缩）。
 */
function findSafeSplitAtOrBefore(messages: Message[], desired: number): number {
  const upper = Math.min(desired, messages.length - 1);
  for (let i = upper; i >= 1; i--) {
    if (isSafeBoundary(messages[i])) return i;
  }
  return -1;
}

/** 估算消息段 token（与 context-collapse 口径一致） */
function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text") total += estimateTextTokens(block.text);
      else if (block.type === "tool_result" && typeof block.content === "string") total += estimateTextTokens(block.content);
      else if (block.type === "tool_use") total += estimateTextTokens(JSON.stringify(block.input));
    }
  }
  return total;
}

/**
 * 解析压缩边界：把调用方给的 upTo（下标或比例）对齐到安全 round 边界。
 *
 * @param messages 完整消息历史
 * @param upTo 压缩到哪里：
 *   - 整数 >= 1：期望的消息下标（压缩 [0, upTo)，保留 [upTo, end)）
 *   - 0 < 小数 < 1：按比例，upTo=0.5 表示压缩最早的 ~50%
 * @returns 对齐后的安全边界下标；无法安全切分返回 -1
 */
export function resolvePartialSplitIndex(messages: Message[], upTo: number): number {
  if (messages.length < 4) return -1; // 太短，压缩无意义

  let desired: number;
  if (upTo > 0 && upTo < 1) {
    desired = Math.floor(messages.length * upTo);
  } else {
    desired = Math.floor(upTo);
  }
  if (desired < 1) return -1;
  // 不允许把整段都压掉：保留段至少留 2 条
  if (desired > messages.length - 2) desired = messages.length - 2;
  if (desired < 1) return -1;

  return findSafeSplitAtOrBefore(messages, desired);
}

/**
 * G22 主函数：部分压缩。
 *
 * 只压缩 [0, splitIndex) 段（生成一份背景摘要替换），保留 [splitIndex, end) 原文不动。
 * splitIndex 由 upTo 经 resolvePartialSplitIndex 对齐到安全 round 边界，保证不切碎工具往返。
 *
 * 失败（消息太少 / 找不到安全边界 / 摘要为空或异常 / 校验不过）时返回 success=false 且
 * messages 为原引用不变——**绝不返回破缺的消息历史**。
 *
 * @param messages 完整消息历史
 * @param upTo 压缩到哪里（下标或 0~1 比例，见 resolvePartialSplitIndex）
 * @param options provider / model / 超时等
 */
export async function partialCompact(
  messages: Message[],
  upTo: number,
  options: PartialCompactOptions,
): Promise<PartialCompactResult> {
  const log = getLogger();

  const splitIndex = resolvePartialSplitIndex(messages, upTo);
  if (splitIndex < 1) {
    return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: "找不到安全的压缩边界" };
  }

  const toCompact = messages.slice(0, splitIndex);
  const kept = messages.slice(splitIndex);

  // 边界安全校验：被压段自身应完整（不带只剩一半的 tool 配对），保留段也应完整。
  // 安全边界定义保证 kept 从干净 user 消息起，但工具往返可能跨越 splitIndex——
  // 若被压段尾部有孤儿 tool_use，其 tool_result 落在 kept 里 → kept 出现游离 → 回退更靠前的边界。
  let finalSplit = splitIndex;
  let compactPart = toCompact;
  let keptPart = kept;
  while (true) {
    const compactIntegrity = checkMessageHistoryIntegrity(compactPart);
    const keptIntegrity = checkMessageHistoryIntegrity(keptPart);
    if (compactIntegrity.intact && keptIntegrity.intact) break;

    // 回退到更靠前的安全边界重试
    const retreat = findSafeSplitAtOrBefore(messages, finalSplit - 1);
    if (retreat < 1) {
      log.warn("PARTIAL_COMPACT", "无法找到不切碎工具配对的安全边界，放弃部分压缩");
      return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: "所有候选边界都会切碎工具配对" };
    }
    finalSplit = retreat;
    compactPart = messages.slice(0, finalSplit);
    keptPart = messages.slice(finalSplit);
  }

  if (compactPart.length < 2) {
    return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: "可压缩段太小" };
  }

  const tokensBefore = estimateMessagesTokens(compactPart);
  const summaryPrompt = buildPartialCompactUserPrompt(compactPart, options.customInstructions);
  const timeoutMs = options.timeoutMs ?? resolveSideCallTimeouts().compactMs;

  let summary = "";
  try {
    summary = await runPartialSummaryRequest(options, summaryPrompt, timeoutMs);
  } catch (err: any) {
    log.warn("PARTIAL_COMPACT", `部分压缩摘要失败: ${err.message}`);
    recordSideCall({
      label: "partial-compact",
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
    return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: `摘要请求失败: ${err.message}` };
  }

  const trimmed = summary.trim();
  if (!trimmed) {
    return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: "摘要为空" };
  }

  // 组装：前段摘要（user + assistant ack）+ 保留段原文
  const summaryMsg: Message = {
    role: "user",
    content: [{ type: "text", text: `${PARTIAL_COMPACT_PREFIX}\n${trimmed}` }],
    _meta: { origin: "compact-summary" },
  };
  const ackMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: "好的，已了解这段较早的对话背景，我会结合后续原文继续。" }],
    _meta: { origin: "compact-summary" },
  };
  const result = [summaryMsg, ackMsg, ...keptPart];

  // 事后再校验一次整体完整性（摘要 user + ack assistant 无工具块，不会引入破缺；防御性）
  const finalIntegrity = checkMessageHistoryIntegrity(result);
  if (!finalIntegrity.intact) {
    log.warn("PARTIAL_COMPACT", "组装后消息历史意外破缺，放弃部分压缩");
    return { messages, success: false, splitIndex: -1, compactedCount: 0, savedTokens: 0, reason: "组装后完整性校验未通过" };
  }

  const tokensAfter = estimateMessagesTokens([summaryMsg, ackMsg]);
  const savedTokens = Math.max(0, tokensBefore - tokensAfter);

  log.info(
    "PARTIAL_COMPACT",
    `部分压缩完成：压缩 [0,${finalSplit}) 共 ${compactPart.length} 条，节省 ~${savedTokens} token，保留 ${keptPart.length} 条原文`,
  );

  return {
    messages: result,
    success: true,
    splitIndex: finalSplit,
    compactedCount: compactPart.length,
    savedTokens,
  };
}

/**
 * 发出一次部分压缩摘要请求（建流 + 流消费 + 超时守护）。
 * 结构对齐 auto-compact.runSummaryRequest，但用 PARTIAL_COMPACT_SYSTEM_PROMPT，且不下发 tools
 * （部分压缩是显式能力，不强依赖主对话工具前缀缓存；保持实现独立简洁）。
 */
async function runPartialSummaryRequest(
  options: PartialCompactOptions,
  summaryPrompt: string,
  timeoutMs: number,
): Promise<string> {
  const { summary, streamUsage } = await withSideCallDeadline(
    "partial-compact",
    timeoutMs,
    async (signal) => {
      const stream = options.provider.sendMessageStream(
        {
          model: options.model,
          messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
          system: PARTIAL_COMPACT_SYSTEM_PROMPT,
          maxTokens: 4000,
        },
        signal,
      );
      let s = "";
      let usage: any = null;
      const lifecycle = createStreamLifecycle({
        idleTimeoutMs: LIFECYCLE_PRESETS.sideCall.idleTimeoutMs,
        contentProgressTimeoutMs: LIFECYCLE_PRESETS.sideCall.contentProgressTimeoutMs,
        overallTimeoutMs: LIFECYCLE_PRESETS.sideCall.overallTimeoutMs,
        isContentProgress: (e: any) =>
          e?.type === "content_block_delta" || e?.type === "message_delta",
        label: "SIDE-CALL:partial-compact",
        signal,
      });
      for await (const event of lifecycle.guard(stream)) {
        if (signal.aborted) {
          throw new Error("Request aborted");
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          s += event.delta.text;
        } else if (event.type === "message_stop" && (event as any).usage) {
          usage = (event as any).usage;
        }
      }
      return { summary: s, streamUsage: usage };
    },
    options.signal,
  );

  if (streamUsage) {
    recordSideCall({
      label: "partial-compact",
      model: options.model,
      inputTokens: streamUsage.inputTokens ?? 0,
      outputTokens: streamUsage.outputTokens ?? 0,
      cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
      cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
      durationMs: 0,
    });
  }

  return summary;
}
