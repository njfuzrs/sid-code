/**
 * LLM Message → HistoryItem 适配层
 *
 * 在 agent loop 产出消息时将 LLM Message 转换为 HistoryItem，
 * 而非在渲染时解析。这样 UI 层只需按 type 字段 switch 分发即可。
 *
 * 核心设计：
 * - tool_use（assistant）和 tool_result（user）合并为单条 ToolGroup 记录
 * - 维护全局 toolNameMap 解决增量同步时 "unknown" 工具名问题
 */

import {
  type HistoryItem,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  ToolCallStatus,
  type ToolResultDisplay,
} from "./types.ts";
import type { Message } from "../llm/types.ts";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "./ui-utils.ts";

/**
 * 构建主屏 Static 模式的历史项数组（ADR-040）。
 *
 * - 空历史 → 空数组（不插 header，让 EmptyLogo 显示）
 * - 非空 → 顶部插入一个 app_header，其后接全部已完成历史项
 *
 * 关键不变量：返回结果**绝不包含流式虚拟项**（STREAMING_ITEM_ID）。
 * 流式内容在 MainScreenLayout 动态区单独渲染，流式完成后才并入 historyItems，
 * 届时本函数才把它纳入 Static（保证一条消息要么在动态区要么在 Static，不重叠）。
 */
export function buildStaticItems(historyItems: HistoryItem[], version: string): HistoryItem[] {
  if (historyItems.length === 0) return [];
  return [
    { id: -2, type: "app_header", version } as HistoryItem,
    ...historyItems,
  ];
}

/** 思考摘要（从 thinking block 提取） */
export interface ThoughtSummary {
  text: string;
  /**
   * SP1：思考耗时（秒，向下取整）。来自 ThinkingBlock.durationMs，持久化后
   * 历史项重渲仍能显示「已思考 Ns」。缺省（旧数据/未测量）时 UI 回退为「思考过程」。
   */
  durationSeconds?: number;
}

/** 占位消息文本常量 */
const PLACEHOLDER_TEXT = "[系统] 自动插入占位消息以保持角色交替";

/** 判断是否为占位消息 */
export function isPlaceholderMessage(msg: Message): boolean {
  return msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text === PLACEHOLDER_TEXT;
}

/**
 * 续接标记特征串（与 SessionStore.buildResumeMarker 保持一致）。
 * 恢复会话时该 marker 作为一条 user 消息注入 ctxMgr，仅供 LLM 感知"这是续接"，
 * 不应在 TUI 里作为用户消息展示——否则用户会看到一段 <system-reminder>，
 * 甚至包含"请勿向用户提及"的自相矛盾文案。
 */
const RESUME_MARKER_SIGNATURE = "本次会话是从之前的对话恢复的续接会话";

/** 续接标记消息（恢复会话时注入,仅供 LLM,不展示） */
export function isResumeMarkerMessage(msg: Message): boolean {
  return msg.role === "user"
    && msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text.includes(RESUME_MARKER_SIGNATURE);
}

/**
 * 内部文本块特征:这些文本是"仅供 LLM 看"的系统注入,不应作为用户消息展示。
 *
 * 背景:除续接 marker 外,主循环(query/loop.ts)与上下文管理器(context/manager.ts)
 * 还会把多类内部提示作为 user 消息**持久化进 ctxMgr**(注意:经 injectReminders 注入
 * finalMessages 的那些 reminder 是"喂给 LLM 的临时副本、不写回 ctxMgr",不会泄漏到 TUI,
 * 不在此列)。持久化进 ctxMgr 的内部文本会被 messagesToHistoryItems 渲染出来,需识别并隐藏:
 *  - `<system-reminder>` 包裹的:todo gate(buildTodoGateMessage)、空参数重试(buildEmptyParamRetryMessage) 等
 *  - `[压缩边界]` / `[已释放]`:压缩与 GC 释放的内部标记(context/manager.ts)
 * 用前缀/包含特征匹配,容忍后续文案微调。
 */
function isInternalOnlyText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<system-reminder>")
    || t.startsWith("[压缩边界]")
    || t.startsWith("[已释放]");
}

/**
 * 整条消息是否应从展示中隐藏(占位 / 续接标记 / 纯内部文本消息)。
 * 仅当消息**只含**内部文本(无真实用户文本、无 tool_result)时才整条隐藏;
 * 混合内容(如循环恢复:orphan tool_result + 内部提示文本)交给 stripInternalTextBlocks
 * 仅剥离其中的内部文本块,保留 tool_result 的正常展示。
 */
export function isHiddenFromDisplay(msg: Message): boolean {
  if (isPlaceholderMessage(msg)) return true;
  if (isResumeMarkerMessage(msg)) return true;
  // 仅含内部文本块(无其它类型 block)的消息整条隐藏
  return msg.content.length > 0
    && msg.content.every(b => b.type === "text" && isInternalOnlyText(b.text));
}

/**
 * 从混合内容消息中剥离"仅供 LLM"的内部文本块,保留其余 block(tool_result 等)。
 * 典型场景:循环恢复消息 = [orphan tool_result..., { text: LOOP_RECOVERY_PROMPT }],
 * tool_result 需正常展示,但 LOOP_RECOVERY_PROMPT 这段是给模型的内部提示,要隐藏。
 * 返回 content 全空时调用方应跳过该消息。
 */
function stripInternalTextBlocks(msg: Message): Message {
  if (!msg.content.some(b => b.type === "text" && isInternalOnlyText(b.text))) {
    return msg;
  }
  return {
    ...msg,
    content: msg.content.filter(b => !(b.type === "text" && isInternalOnlyText(b.text))),
  };
}

/**
 * 从消息数组中构建 tool_use_id → toolName 映射
 * 用于增量同步时传入完整的映射关系
 */
export function buildToolNameMapFromMessages(msgs: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of msgs) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * 将完整消息数组转换为 HistoryItem 序列
 *
 * 核心改进：合并 tool_use + tool_result 为单条记录
 * - assistant 消息中的 tool_use → 暂存到 pendingToolCalls
 * - user 消息中的 tool_result → 与 pending 合并，输出完整的 ToolGroup
 */
export function messagesToHistoryItems(msgs: Message[]): HistoryItemWithoutId[] {
  const toolNameMap = buildToolNameMapFromMessages(msgs);
  return messagesToHistoryItemsWithMap(msgs, toolNameMap);
}

/**
 * 带外部 toolNameMap 的转换（用于增量同步）
 */
export function messagesToHistoryItemsWithMap(
  msgs: Message[],
  toolNameMap: Map<string, string>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  // 暂存 assistant 消息中的 tool_use，等待 tool_result 合并
  const pendingToolCalls = new Map<string, IndividualToolCallDisplay>();

  for (const rawMsg of msgs) {
    if (isHiddenFromDisplay(rawMsg)) continue;

    // 混合内容消息(如循环恢复 = orphan tool_result + 内部提示文本):
    // 剥离仅供 LLM 的内部文本块,保留 tool_result 等正常 block 继续转换。
    const msg = stripInternalTextBlocks(rawMsg);
    if (msg.content.length === 0) continue;

    // 收集 tool_use 名称映射
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameMap.set(block.id, block.name);
      }
    }

    if (msg.role === "assistant") {
      items.push(...convertAssistantMessage(msg, pendingToolCalls));
    } else {
      items.push(...convertUserMessage(msg, toolNameMap, pendingToolCalls));
    }
  }

  // 如果还有未匹配的 pending tool_use（流式中断等场景），输出为 executing 状态
  if (pendingToolCalls.size > 0) {
    items.push({ type: "tool_group", tools: Array.from(pendingToolCalls.values()) });
    pendingToolCalls.clear();
  }

  return items;
}

// ── 内部转换函数 ──

function convertUserMessage(
  msg: Message,
  toolNameMap: Map<string, string>,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  const textBlocks: string[] = [];
  const mergedTools: IndividualToolCallDisplay[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    } else if (block.type === "tool_result") {
      const toolName = toolNameMap.get(block.tool_use_id) || "unknown";
      const isError = !!block.is_error;
      const pending = pendingToolCalls.get(block.tool_use_id);

      // 结构化 diff 优先(edit/write):有 patch 即判定为 diff,UI 直接渲染;
      // 缺失时(旧会话重放/其它工具)降级到对 content 的正则检测。
      const hasPatch = !!block.structuredPatch?.length;
      const resultDisplay: ToolResultDisplay = {
        content: block.content,
        isError,
        isDiff: hasPatch || isDiffContent(toolName, block.content),
        filename: getFilenameFromInput(toolName, pending?.input ?? {}),
        ...(hasPatch ? { structuredPatch: block.structuredPatch } : {}),
      };

      // 合并 pending tool_use + tool_result
      mergedTools.push({
        callId: block.tool_use_id,
        name: pending?.name ?? toolName,
        description: pending?.description ?? getToolSummary(toolName, {}),
        input: pending?.input ?? {},
        status: isError ? ToolCallStatus.Error : ToolCallStatus.Success,
        resultDisplay,
        resultSummary: getResultSummary(toolName, block.content, isError),
      });

      // 已合并，从 pending 中移除
      pendingToolCalls.delete(block.tool_use_id);
    }
  }

  // 文本内容 → HistoryItemUser
  if (textBlocks.length > 0) {
    const text = textBlocks.join("\n");
    items.push({ type: "user", text });
  }

  // 合并后的工具结果 → HistoryItemToolGroup
  if (mergedTools.length > 0) {
    items.push({ type: "tool_group", tools: mergedTools });
  }

  return items;
}

function convertAssistantMessage(
  msg: Message,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  let textAccum = "";

  const flushText = () => {
    if (textAccum) {
      items.push({ type: "assistant", text: textAccum });
      textAccum = "";
    }
  };

  for (const block of msg.content) {
    if (block.type === "thinking") {
      // v2：思考块 → 独立 thinking HistoryItem（对标 Claude Code）
      flushText();
      // SP1：把持久化的 durationMs 折算为秒带入，历史项才能稳定显示耗时。
      const durationSeconds =
        typeof block.durationMs === "number"
          ? Math.floor(block.durationMs / 1000)
          : undefined;
      items.push({
        type: "thinking",
        thought: {
          text: block.thinking,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        },
      });
    } else if (block.type === "text") {
      flushText(); // 先 flush 前面的文本（如果有的话）
      textAccum += (textAccum ? "\n" : "") + block.text;
    } else if (block.type === "tool_use") {
      flushText();
      // 暂存到 pendingToolCalls，等待 tool_result 合并
      pendingToolCalls.set(block.id, {
        callId: block.id,
        name: block.name,
        description: getToolSummary(block.name, block.input),
        input: block.input,
        status: ToolCallStatus.Executing,
      });
    }
  }

  // flush 剩余文本
  flushText();

  // 注意：不在这里输出 tool_use 的 ToolGroup
  // 它们会在 convertUserMessage 中与 tool_result 合并后输出

  return items;
}
