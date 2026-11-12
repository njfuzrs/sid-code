/**
 * 按「过期程度」批量清理旧工具输出（排查报告 F4 / §5.4，PR-3）
 *
 * ## 为什么需要第五条清理通道
 *
 * 已有的四条（遮罩 / 大输出清理 / microcompact / 冷缓存清理）触发条件都绑在「窗口剩余」上：
 * 1M 窗口下遮罩要到约 78%、microcompact 要到约 82%，常见任务（20 万–30 万 token）永远到不了；
 * 大输出清理只看单条 >30,000 字符，实测常见输出 3k–9k 一条都进不了候选。结果是 353 个会话里
 * 清理一次都没触发，工具结果占峰值 43.6%。
 *
 * 本模块的判据**只看结构性事实，不看窗口、不看模型名**：
 * - 一条工具结果之后，模型已经又进行了 ≥ K 个工具轮（读完、改完、验证完，它已经过期）；
 * - 不是「活跃文件」的最近一次 read（被 edit/write 过的文件，模型还要对着它改）；
 * - 不在当前 turn 内（最后一条 assistant 之后的结果模型还没看到）；
 * - 工具在 microcompact 的白名单内（未知 / MCP 工具原样保留，见 `microcompact.ts` 的分类）。
 *
 * ## 为什么必须攒批
 *
 * 每改写一个已发送的块，前缀缓存就从那个位置起失效。每轮清一条 = 每轮付一次缓存重建。
 * 所以只有待清理的释放量累计到 {@link STALE_CLEAR_MIN_BATCH_TOKENS} 才一次性提交：
 * 一次失效换一大块空间。提交后由调用方落成粘性状态逐字节重放，之后每轮前缀不再变。
 *
 * 本模块只做「该清哪些、清成什么」的纯计算，不持有状态；状态与重放在 `ContextManager`。
 */

import type { Message } from "../llm/types.ts";
import { estimateTextTokens } from "./token.ts";
import { isPersistedReference } from "./tool-result-storage.ts";
import { isDiscardableTool, isNonDiscardableTool } from "../query/compact/microcompact.ts";

/**
 * K：一条工具结果之后再经过多少个工具轮才算过期。
 * 8 ≈ 一次「读 → 改 → 验证」周期（排查报告 §5.4 第 5 点的初始建议，待 V4 回放校准）。
 */
export const STALE_CLEAR_AFTER_TOOL_ROUNDS = 8;

/**
 * N：一次提交至少释放多少 token，才值得让前缀缓存失效一次。
 * 与遮罩的 `MIN_PRUNABLE_THRESHOLD = 30_000` 同一思路，取值见排查报告 §5.4（建议 20k，待 V4 校准）。
 */
export const STALE_CLEAR_MIN_BATCH_TOKENS = 20_000;

/** 单条结果短于此长度不清：占位本身约 100 字符，清了省不出东西，还白改一次前缀 */
export const STALE_CLEAR_MIN_CONTENT_CHARS = 500;

/** 非只读工具（edit/write、写型 bash）保留的摘要长度，与 microcompact 同口径 */
const NON_DISCARDABLE_SUMMARY_CHARS = 200;

export interface StaleClearOptions {
  /** 覆盖 K（测试用） */
  afterToolRounds?: number;
  /** 覆盖 N（测试用） */
  minBatchTokens?: number;
  /** 调用方额外豁免的 id：已有稳定占位的块（遮罩 / 冷清理 / 大输出清理 / 本模块上一次提交） */
  skipToolUse?: (toolUseId: string) => boolean;
}

export interface StaleClearEntry {
  toolUseId: string;
  /** 改写后的完整内容 */
  replacement: string;
  originalLength: number;
  /** 释放的 token（估算，原文 − 占位） */
  savedTokens: number;
}

export interface StaleClearPlan {
  /** 达到批量门槛才非空；未达门槛时为空数组（本轮不改写前缀） */
  entries: StaleClearEntry[];
  /** 当前已过期但尚未提交的总释放量（含未达门槛的情况），供观测 */
  pendingTokens: number;
}

interface ToolUseMeta {
  name: string;
  input: unknown;
  filePath?: string;
}

/** 重读指引里展示的入参摘要：只取定位字段，避免把整段 heredoc 塞进占位 */
function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "command", "pattern", "url", "query"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 120 ? `${k}=${v.slice(0, 120)}…` : `${k}=${v}`;
    }
  }
  return "";
}

/**
 * 生成占位。可复现工具给「怎么重新拿到」的可执行线索（排查报告 §5.4 第 3 点）；
 * 有副作用的工具重跑会重复副作用，只能保留开头摘要。
 * 返回 null = 不在白名单内（未知 / MCP 工具），原样保留。
 */
function buildReplacement(content: string, meta: ToolUseMeta): string | null {
  const desc = describeInput(meta.input);
  const call = desc ? `${meta.name}(${desc})` : meta.name;
  if (isDiscardableTool(meta.name, meta.input)) {
    if (meta.filePath && meta.name === "read") {
      return `[已过期清理: ${call}，原始 ${content.length} 字符。之后已经过多轮工具调用，按需用 read("${meta.filePath}", offset=..., limit=...) 精准重读需要的行段，不要整文件重读。]`;
    }
    return `[已过期清理: ${call}，原始 ${content.length} 字符。之后已经过多轮工具调用，需要时重新执行该调用即可恢复。]`;
  }
  if (isNonDiscardableTool(meta.name, meta.input)) {
    const head = content.slice(0, NON_DISCARDABLE_SUMMARY_CHARS);
    return `[已过期压缩: ${call}，保留前 ${NON_DISCARDABLE_SUMMARY_CHARS} 字符]\n${head}\n... [剩余 ${content.length - NON_DISCARDABLE_SUMMARY_CHARS} 字符已省略，该调用有副作用，不要为找回内容而重跑]`;
  }
  return null;
}

/**
 * 计算本轮应当提交的过期清理。未达批量门槛时返回空 entries（不动前缀）。
 *
 * @param messages 发送投影（已贴遮罩 / 冷清理占位的副本；被豁免的块由 skipToolUse 排除）
 */
export function planStaleToolOutputClear(
  messages: readonly Message[],
  options: StaleClearOptions = {},
): StaleClearPlan {
  const k = options.afterToolRounds ?? STALE_CLEAR_AFTER_TOOL_ROUNDS;
  const minBatch = options.minBatchTokens ?? STALE_CLEAR_MIN_BATCH_TOKENS;

  // 一次扫描建三张表：tool_use 元信息、每条消息之后的工具轮数、活跃文件
  const toolUses = new Map<string, ToolUseMeta>();
  const activeFiles = new Set<string>();
  let lastAssistantIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    lastAssistantIdx = i;
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as { file_path?: unknown; path?: unknown };
      const fp = typeof input.file_path === "string" ? input.file_path : undefined;
      const p = typeof input.path === "string" ? input.path : undefined;
      const filePath = fp ?? p;
      toolUses.set(b.id, { name: b.name, input: b.input, filePath });
      if (filePath && (b.name === "edit" || b.name === "write")) activeFiles.add(filePath);
    }
  }

  // roundsAfter[i] = 消息 i 之后（不含 i）含 tool_use 的 assistant 消息数。
  // 「工具轮」按 assistant 消息计而不是按 tool_use 块计：一轮并行发 5 个 read 只算一轮，
  // 否则并行度高的模型会被判成「过得更快」，清得更早。
  const roundsAfter = new Array<number>(messages.length).fill(0);
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    roundsAfter[i] = acc;
    const msg = messages[i];
    if (msg.role === "assistant" && msg.content.some((b) => b.type === "tool_use")) acc++;
  }

  // 活跃文件只豁免**最近一次** read：更早的 read 是改动前的旧内容，已被后一次覆盖，留着只是浪费
  const latestReadOfActive = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    for (const b of msg.content) {
      if (b.type !== "tool_result") continue;
      const meta = toolUses.get(b.tool_use_id);
      if (meta?.name === "read" && meta.filePath && activeFiles.has(meta.filePath)) {
        latestReadOfActive.set(meta.filePath, b.tool_use_id);
      }
    }
  }
  const exemptActive = new Set(latestReadOfActive.values());

  const candidates: StaleClearEntry[] = [];
  let pendingTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    // 当前 turn：模型还没看到这些结果
    if (lastAssistantIdx >= 0 && i > lastAssistantIdx) continue;
    if (roundsAfter[i] < k) continue;
    for (const b of msg.content) {
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      if (b.content.length < STALE_CLEAR_MIN_CONTENT_CHARS) continue;
      // 持久化引用本身就是约 200 字节的指针，由引用折叠单独处理
      if (isPersistedReference(b.content)) continue;
      if (exemptActive.has(b.tool_use_id)) continue;
      if (options.skipToolUse?.(b.tool_use_id)) continue;
      const meta = toolUses.get(b.tool_use_id);
      if (!meta) continue;
      const replacement = buildReplacement(b.content, meta);
      if (replacement === null) continue;
      const savedTokens = estimateTextTokens(b.content) - estimateTextTokens(replacement);
      if (savedTokens <= 0) continue;
      candidates.push({
        toolUseId: b.tool_use_id,
        replacement,
        originalLength: b.content.length,
        savedTokens,
      });
      pendingTokens += savedTokens;
    }
  }

  return { entries: pendingTokens >= minBatch ? candidates : [], pendingTokens };
}
