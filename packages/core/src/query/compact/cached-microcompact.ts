/**
 * Cached Microcompact（Layer 3，对标 claude-code services/microcompact/cachedMicrocompact.ts）
 *
 * 背景：sid 现有 microcompactMessages 在"缓存模式"下仍会改写消息内容（截断 + 占位符），
 * 这会改变 prompt 前缀字节 → Anthropic prompt cache 失效（cache miss），下次请求需重算整段前缀，
 * 反而浪费 token。本模块提供"缓存友好"的替代路径：
 *
 *   - **Anthropic + 缓存温热**：不改本地消息内容（前缀保持字节一致 → cache hit），
 *     只记录"需要服务器侧删除内容"的 tool_use_id，生成 cache_edits 块交给 API 层携带。
 *   - **非 Anthropic / 缓存已冷**：回退到现有 microcompactMessages 直接清内容（反正缓存没了，
 *     不如趁机真正释放本地 token）。
 *
 * ⚠️ 多供应商务实约束（见分析文档 §5.5）：
 *   `cache_edits` 是 Anthropic 私有的、未公开进 Messages API 文档的字段。无脑把它注入每次请求体
 *   会导致非 Anthropic 供应商 400、甚至 Anthropic 自身在该字段语义变化时报错。因此本模块：
 *   1. 默认 **不** 真正发射 cache_edits（emitCacheEdits=false）——只做"供应商感知的模式选择" +
 *      "tool_use_id 状态追踪",已能消除"缓存模式仍改前缀"这一确定性的 cache 破坏。
 *   2. 仅当调用方显式 opt-in（emitCacheEdits=true，且供应商为 anthropic）才产出 cache_edits 块。
 *   这样既补齐了能力骨架，又不会在生产里破坏现有多供应商请求。
 */

import type { Message } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";
import {
  microcompactMessages,
  isDiscardableTool,
  type MicrocompactOptions,
} from "./microcompact.ts";

/**
 * 可压缩工具判定（对标 claude-code COMPACTABLE_TOOLS）。
 *
 * ⚠️ 历史上这里维护过一套独立的裸字符串白名单 `COMPACTABLE_TOOLS`，与 microcompact.ts 的
 * `DISCARDABLE_TOOLS` 不一致：① 漏收 `web_search`/`web_fetch`/`tool_search`，② 混入了不存在的
 * `list`，③ 不做 normalizeToolName 归一化（裸 `.has()` 无法命中 `read_many` 等带下划线的真实工具名）。
 * 一旦 cache_edits 路径接入并开启 emitCacheEdits，这三个工具的结果将永远不被删除 → 埋雷。
 *
 * 现统一复用 microcompact.ts 的 `isDiscardableTool`（带归一化、与真实注册名一致），
 * 单一事实源,消除两套白名单漂移的风险。
 */
export const isCompactableTool = isDiscardableTool;

/** 单个 tool_use 的缓存编辑追踪状态 */
export interface CachedToolState {
  /** tool_use_id */
  toolUseId: string;
  /** 产出该结果的工具名（用于白名单判断） */
  toolName: string;
  /** 是否已标记为"待服务器侧删除" */
  markedForDeletion: boolean;
}

/** cache_edits 状态机（跨多次 microcompact 复用，记录哪些 tool_use 已删） */
export interface CachedMicrocompactState {
  /** tool_use_id → 状态 */
  tools: Map<string, CachedToolState>;
  /** 已发射删除指令的 tool_use_id（防止重复删除） */
  deleted: Set<string>;
}

/** 新建空状态 */
export function createCachedMicrocompactState(): CachedMicrocompactState {
  return { tools: new Map(), deleted: new Set() };
}

/** 复位状态（对标 claude-code resetMicrocompactState，cache 失效后调用） */
export function resetCachedMicrocompactState(state: CachedMicrocompactState): void {
  state.tools.clear();
  state.deleted.clear();
}

/**
 * 从消息历史登记所有 tool_use（建立 tool_use_id → toolName 映射）。
 * assistant 的 tool_use 块带 name，user 的 tool_result 块只带 tool_use_id，
 * 因此先扫一遍 assistant 块建立映射。
 */
export function registerToolUses(state: CachedMicrocompactState, messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && !state.tools.has(block.id)) {
        state.tools.set(block.id, {
          toolUseId: block.id,
          toolName: block.name,
          markedForDeletion: false,
        });
      }
    }
  }
}

/** cache_edits 单条删除指令（对标 Anthropic 私有字段形状） */
export interface CacheEditDelete {
  type: "delete";
  tool_use_id: string;
}

/** cache_edits 块（交给 API 层在下一次请求携带） */
export interface CacheEditsBlock {
  edits: CacheEditDelete[];
}

/**
 * 为"应被压缩"的旧工具结果生成 cache_edits 删除指令。
 *
 * 只处理：① 在白名单内 ② 内容超过 minContentLength ③ 位于 preserveRecentCount 之前
 * ④ 尚未删除过 的 tool_result。生成后把对应 tool_use_id 记入 state.deleted，避免重复。
 *
 * @returns 删除指令数组（可能为空）；本函数 **不** 修改 messages。
 */
export function createCacheEditsBlock(
  state: CachedMicrocompactState,
  messages: Message[],
  options?: MicrocompactOptions,
): CacheEditsBlock | null {
  const preserveRecentCount = options?.preserveRecentCount ?? 6;
  const minContentLength = options?.minContentLength ?? 500;

  if (messages.length <= preserveRecentCount) return null;

  registerToolUses(state, messages);

  const cutoff = messages.length - preserveRecentCount;
  const edits: CacheEditDelete[] = [];

  for (let idx = 0; idx < cutoff; idx++) {
    const msg = messages[idx];
    if (msg.role !== "user") continue;

    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content !== "string" || block.content.length <= minContentLength) continue;

      const toolState = state.tools.get(block.tool_use_id);
      // 白名单约束：未登记（拿不到工具名）保守跳过；不可丢弃工具跳过
      if (!toolState || !isCompactableTool(toolState.toolName)) continue;
      if (state.deleted.has(block.tool_use_id)) continue;

      edits.push({ type: "delete", tool_use_id: block.tool_use_id });
      toolState.markedForDeletion = true;
      state.deleted.add(block.tool_use_id);
    }
  }

  return edits.length > 0 ? { edits } : null;
}

/** Cached microcompact 选项 */
export interface CachedMicrocompactOptions extends MicrocompactOptions {
  /** 供应商名（来自 provider.name()）。"anthropic" 时才考虑缓存友好路径。 */
  providerName: string;
  /**
   * 缓存是否温热（距上次 assistant 消息未超时）。
   * - true（默认）：缓存温热 → Anthropic 走 cache 友好路径（不改前缀）
   * - false：缓存已冷 → 直接清内容（趁机释放本地 token）
   */
  cacheWarm?: boolean;
  /**
   * 是否真正发射 cache_edits 原始块（默认 false）。
   * cache_edits 是 Anthropic 私有字段，开启前需确认 API 层已正确携带且供应商支持。
   * 关闭时仍做"供应商感知模式选择 + 状态追踪",只是不产出原始 cache_edits 块。
   */
  emitCacheEdits?: boolean;
  /** 跨调用复用的状态机（不传则内部新建，单次有效） */
  state?: CachedMicrocompactState;
}

/** Cached microcompact 结果 */
export interface CachedMicrocompactResult {
  /** 压缩后的消息（缓存友好路径下与输入完全一致，引用不变） */
  messages: Message[];
  /** 走了哪条路径 */
  path: "cache-preserving" | "direct-clear";
  /** 直接清内容路径下：压缩的工具结果数 */
  compactedCount: number;
  /** 直接清内容路径下：节省的字符数 */
  savedChars: number;
  /**
   * 缓存友好路径下：待 API 层携带的 cache_edits 块（emitCacheEdits=true 时才非空）。
   * 消息本身不变 → 下次请求前缀字节一致 → cache hit。
   */
  pendingCacheEdits: CacheEditsBlock | null;
}

/**
 * 供应商感知的 microcompact。
 *
 * - Anthropic + 缓存温热 → cache-preserving：不改消息内容，只（可选）产出 cache_edits。
 * - 其余情况 → direct-clear：委托现有 microcompactMessages 直接清内容。
 */
export function cachedMicrocompact(
  messages: Message[],
  options: CachedMicrocompactOptions,
): CachedMicrocompactResult {
  const log = getLogger();
  const isAnthropic = options.providerName === "anthropic";
  const cacheWarm = options.cacheWarm ?? true;

  // 缓存友好路径：仅 Anthropic + 缓存温热
  if (isAnthropic && cacheWarm) {
    const state = options.state ?? createCachedMicrocompactState();
    const pendingCacheEdits = options.emitCacheEdits
      ? createCacheEditsBlock(state, messages, options)
      : (registerToolUses(state, messages), null);

    log.info(
      "CACHED_MICROCOMPACT",
      `缓存友好路径（不改前缀），emitCacheEdits=${!!options.emitCacheEdits}，` +
        `待删除 ${pendingCacheEdits?.edits.length ?? 0} 项`,
    );

    return {
      messages, // 引用不变 → 前缀字节一致 → cache hit
      path: "cache-preserving",
      compactedCount: 0,
      savedChars: 0,
      pendingCacheEdits,
    };
  }

  // 直接清内容路径：非 Anthropic 或缓存已冷
  const result = microcompactMessages(messages, { ...options, mode: "time" });
  log.info(
    "CACHED_MICROCOMPACT",
    `直接清内容路径（provider=${options.providerName}, cacheWarm=${cacheWarm}），` +
      `压缩 ${result.compactedCount} 项，节省 ${result.savedChars} 字符`,
  );
  return {
    messages: result.messages,
    path: "direct-clear",
    compactedCount: result.compactedCount,
    savedChars: result.savedChars,
    pendingCacheEdits: null,
  };
}
