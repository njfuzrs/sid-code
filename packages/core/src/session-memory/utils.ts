/**
 * Session Memory 工具函数（Task 4 / Task 5）
 *
 * 纯函数集合：token 估算、双阈值触发判断、按 section 截断、空内容检测。
 * 不依赖 LLM / 文件系统，便于单测。
 */

import type { Message } from "../llm/types.ts";
import { estimateTextTokens } from "../context/token.ts";
// 审计第 21 条：收敛到 token.ts 的统一实现（补全 thinking/redacted_thinking/mediaBlocks）。
import { estimateMessagesTokens as estimateMessagesTokensUnified } from "../context/token.ts";
// P1-5 ③：让 SESSION_MEMORY_SECTIONS 真正参与截断决策（此前它零使用）。
import { isKnownSessionMemorySection } from "./prompts.ts";

/** Session Memory 配置 */
export interface SessionMemoryConfig {
  /** 首次提取的最低 token 数 */
  minimumMessageTokensToInit: number;
  /** 两次提取之间的最低 token 增长 */
  minimumTokensBetweenUpdate: number;
  /** 两次提取之间的最低工具调用次数 */
  toolCallsBetweenUpdates: number;
}

/** Session Memory 运行时状态 */
export interface SessionMemoryState {
  initialized: boolean;
  lastSummarizedTokenCount: number;
  lastSummarizedMessageId: string | undefined;
  toolCallsSinceLastUpdate: number;
  extractionInProgress: boolean;
  extractionStartedAt: number | null;
}

/** 默认配置 */
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
};

/** 新建初始状态 */
export function initialSessionMemoryState(): SessionMemoryState {
  return {
    initialized: false,
    lastSummarizedTokenCount: 0,
    lastSummarizedMessageId: undefined,
    toolCallsSinceLastUpdate: 0,
    extractionInProgress: false,
    extractionStartedAt: null,
  };
}

/** 估算一组消息的 token 总数（审计第 21 条：委托给 context/token.ts 的统一实现） */
export function estimateMessagesTokens(messages: Message[]): number {
  return estimateMessagesTokensUnified(messages);
}

/** 最后一个 assistant turn 是否包含工具调用 */
export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return messages[i].content.some((b) => b.type === "tool_use");
    }
  }
  return false;
}

/**
 * 判断是否应触发 Session Memory 提取（双阈值）。
 * 1. Token 阈值始终必须满足（硬性要求）
 * 2. 工具调用阈值满足 OR 最后一轮无工具调用（自然断点）
 */
export function shouldExtractSessionMemory(
  state: SessionMemoryState,
  messages: Message[],
  config: SessionMemoryConfig,
): boolean {
  // 提取进行中不重复触发
  if (state.extractionInProgress) return false;

  const currentTokenCount = estimateMessagesTokens(messages);

  // 阶段 1：初始化门控
  if (!state.initialized) {
    if (currentTokenCount < config.minimumMessageTokensToInit) {
      return false;
    }
  }

  // 阶段 2：Token 增长检查（硬性要求）
  const tokenGrowth = currentTokenCount - state.lastSummarizedTokenCount;
  if (tokenGrowth < config.minimumTokensBetweenUpdate) {
    return false;
  }

  // 阶段 3：工具调用检查 OR 自然断点
  const hasMetToolCallThreshold = state.toolCallsSinceLastUpdate >= config.toolCallsBetweenUpdates;
  const lastTurnHasNoToolCalls = !hasToolCallsInLastAssistantTurn(messages);

  return hasMetToolCallThreshold || lastTurnHasNoToolCalls;
}

/** 把内容按 # section 标题切成 { title, body } 段落 */
export function splitSessionMemorySections(
  content: string,
): Array<{ title: string; body: string }> {
  const lines = content.split("\n");
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * 判断 Session Memory 是否"实质为空"——只有模板的 section 标题和斜体占位描述，
 * 没有任何实际填充内容。空内容时压缩应回退到传统摘要。
 */
export function isSessionMemoryEmpty(content: string | null | undefined): boolean {
  if (!content || !content.trim()) return true;
  const sections = splitSessionMemorySections(content);
  for (const sec of sections) {
    for (const rawLine of sec.body.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      // 斜体占位描述 _..._ 视为空
      if (/^_.*_$/.test(line)) continue;
      // HTML 注释跳过
      if (line.startsWith("<!--")) continue;
      return false; // 找到实际内容
    }
  }
  return true;
}

/**
 * 按 section 截断 Session Memory，每个 section 不超过 perSectionTokens，
 * 保留标题和结构，不切断语义单元。
 *
 * P1-5 ③：预算紧张时**先牺牲模型自己加的 section**。更新提示词第 4 条明确要求
 * 「不要添加新的 section」，所以非模板 section 一律是违规产物；而模板 section
 * （尤其 `Current State` / `Task specification`）正是压缩后模型最需要的部分。
 * 旧实现按**文件顺序**逐个塞、超预算就 break —— 于是一个被塞在前面的违规 section
 * 会把后面的 `Worklog` / `Key results` 整个挤掉。
 *
 * 排序是**稳定**的：模板 section 保持它们在文件里的相对顺序（不重排成常量表顺序 ——
 * 模型是按文件顺序写的，重排会让 Worklog 这类时序内容错位），只是把非模板 section
 * 整体移到末尾。`SESSION_MEMORY_SECTIONS` 由此第一次有了运行时消费者。
 */
export function truncateSessionMemory(
  content: string,
  maxTokens = 12_000,
  perSectionTokens = 2_000,
): string {
  const parsed = splitSessionMemorySections(content);
  // 稳定分区：模板 section 保持原相对顺序在前，模型自加的在后（预算不够时先掉它们）
  const known = parsed.filter((s) => isKnownSessionMemorySection(s.title));
  const unknown = parsed.filter((s) => !isKnownSessionMemorySection(s.title));
  const sections = [...known, ...unknown];
  const out: string[] = [];
  let used = 0;
  for (const sec of sections) {
    if (used >= maxTokens) break;
    let body = sec.body.trimEnd();
    let bodyTokens = estimateTextTokens(body);
    if (bodyTokens > perSectionTokens) {
      // 按行截断到预算内
      const lines = body.split("\n");
      const kept: string[] = [];
      let t = 0;
      for (const line of lines) {
        const lt = estimateTextTokens(line);
        if (t + lt > perSectionTokens) {
          kept.push("…(truncated)");
          break;
        }
        kept.push(line);
        t += lt;
      }
      body = kept.join("\n");
      bodyTokens = estimateTextTokens(body);
    }
    if (used + bodyTokens > maxTokens) {
      // 整体预算超限，停止追加
      break;
    }
    out.push(`# ${sec.title}\n${body}`.trimEnd());
    used += bodyTokens;
  }
  return out.join("\n\n");
}
