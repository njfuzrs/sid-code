/**
 * microcompact — 轻量级消息压缩（工具类型感知）
 *
 * 清理旧的工具结果内容，释放上下文空间。
 *
 * 两种模式：
 * - 缓存模式（cache）：保留结构但清空内容（保护 prompt cache 位置）
 * - 时间模式（time）：直接清空旧工具结果（cache 已冷时）
 *
 * 工具类型感知（起点是 claude-code COMPACTABLE_TOOLS 白名单，bash 一档比它保守，见下）：
 * - 可丢弃工具（输出可重新生成）：read/grep/glob/ls/websearch/webfetch、**只读** bash → 完全清空
 * - 不可丢弃工具（输出不可复现）：edit/write/notebook_edit/save_memory/ask_user_question、
 *   **非只读** bash → 保留前 200 字符摘要
 * - 未分类工具（自定义 / MCP）→ 不在白名单内，**原样保留不压缩**（输出不可复现，清空会丢信息）
 *
 * 为什么要区分：edit/write 等工具的输出无法靠"重新执行"复现（它们有副作用），
 * 盲目清空会导致后续对话丢失"我改了什么"的关键信息。
 *
 * bash 为什么按**命令**而不是按工具名分类：它是唯一一个既能读也能写、副作用范围不受
 * 工具层约束的工具。`git commit` / `rm` / `curl -X POST` 的输出一旦清空，模型想回看
 * 「当时提交了什么、接口返回了什么」只能重跑——重跑就是重复副作用。所以只有
 * `isReadOnlyCommand` 判为只读的 bash 才算可丢弃，其余按不可丢弃保留摘要。
 * claude-code 的 COMPACTABLE_TOOLS 对 shell 一律清空，这里是有意比它更保守。
 */

import type { Message, ContentBlock } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";
import { isReadOnlyCommand } from "../../tool/bash/read-only-validation.ts";

// ─── 工具分类 ───

/** 可丢弃工具（输出可重新生成，压缩时可完全清空）。
 * 条目使用去掉下划线和连字符的规范化名称，与 normalizeToolName 一致。
 * 收录 sid 实际注册的只读/可复现工具：read/read_many/grep/glob/ls/
 * web_search/web_fetch/tool_search。这些工具的输出都能靠重新执行找回。
 *
 * bash **刻意不在这里**：它按命令分类（见 BASH_TOOL 与 isReadOnlyBashInput），
 * 曾经整体放在这一档，前提「输出都能靠重新执行找回」对写命令不成立。 */
const DISCARDABLE_TOOLS = new Set([
  "fileread",
  "read",
  "readmany",
  "grep",
  "glob",
  "ls",
  "websearch",
  "webfetch",
  "toolsearch",
]);

/** 不可丢弃工具（输出不可复现，压缩时保留摘要）。
 * 条目必须是真实 `tool.name()` 经 normalizeToolName 之后的值。
 * 曾写成 `memory` / `askuser`，与 `save_memory` → `savememory`、
 * `ask_user_question` → `askuserquestion` 永不相等，生产零命中。
 *
 * P2-16：`notebook_edit`（→ `notebookedit`）此前两个名单都不在，落"未知工具"分支被原样
 * 保留。方向安全但不是有意设计——它的语义与 `edit`/`write` 完全一致（改 Jupyter
 * notebook，有副作用、输出不可靠重新执行复现），被当成 MCP/自定义工具保守跳过，
 * 结果是 notebook 编辑的工具结果在 microcompact 里永远不参与压缩。 */
const NON_DISCARDABLE_TOOLS = new Set([
  "edit",
  "write",
  "notebookedit",
  "savememory",
  "askuserquestion",
]);

/** 规范化工具名：小写 + 去掉下划线和连字符 */
function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[-_]/g, "");
}

/** bash 的规范化工具名：按命令分类，不进上面两张名单 */
const BASH_TOOL = "bash";

/**
 * bash 调用是否只读（输出可靠重跑找回）。
 *
 * 拿不到命令（input 缺失 / command 非字符串）时判**非只读**：宁可多留 200 字符，
 * 也不在不知道它做了什么的情况下把输出清掉。
 */
function isReadOnlyBashInput(input: unknown): boolean {
  const command = (input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return false;
  return isReadOnlyCommand(command);
}

/**
 * 判断工具调用是否为可丢弃类型（输出可重新生成）。
 * @param input 对应 tool_use 的 input；bash 依赖它按命令判定，其余工具忽略
 */
export function isDiscardableTool(toolName: string, input?: unknown): boolean {
  const name = normalizeToolName(toolName);
  if (name === BASH_TOOL) return isReadOnlyBashInput(input);
  return DISCARDABLE_TOOLS.has(name);
}

/**
 * 判断工具调用是否为不可丢弃类型（输出不可复现）。
 * @param input 对应 tool_use 的 input；bash 依赖它按命令判定，其余工具忽略
 */
export function isNonDiscardableTool(toolName: string, input?: unknown): boolean {
  const name = normalizeToolName(toolName);
  if (name === BASH_TOOL) return !isReadOnlyBashInput(input);
  return NON_DISCARDABLE_TOOLS.has(name);
}

/** microcompact 配置 */
export interface MicrocompactOptions {
  /** 保留最近 N 条消息的工具结果不压缩 */
  preserveRecentCount?: number;
  /** 工具结果内容超过此长度才压缩（字符数） */
  minContentLength?: number;
  /** 压缩模式 */
  mode?: "cache" | "time";
}

const DEFAULT_OPTIONS: Required<MicrocompactOptions> = {
  preserveRecentCount: 6, // 保留最近 3 轮（6 条消息）
  minContentLength: 500, // 超过 500 字符才压缩
  mode: "time",
};

/** 可丢弃工具占位符 */
const DISCARDABLE_PLACEHOLDER = "[可丢弃工具输出已清空，如需查看请重新执行工具]";

/**
 * 对单个 tool_result 块按工具类型生成压缩后的内容。
 *
 * 采用白名单模型（对标 claude-code COMPACTABLE_TOOLS）：只压缩**已知**的工具，
 * 未在任何名单中的工具（自定义工具 / MCP 工具）一律**不压缩**，返回 null。
 * 理由：未知工具的输出可能不可复现（无法靠"重新执行"找回），盲目清空会丢信息；
 * 且超大未知输出已由管道 ① applyToolResultBudget（>10K token）兜底截断。
 *
 * @param content 原始工具结果内容
 * @param toolName 工具名（用于分类）
 * @param input 对应 tool_use 的 input（bash 按命令分类）
 * @param mode 压缩模式：cache 模式下可丢弃工具仍保留前 100 字符以保护 cache 位置
 * @returns 压缩后的占位内容；返回 null 表示该工具不在白名单内，跳过压缩
 */
function compactToolResultContent(
  content: string,
  toolName: string,
  input: unknown,
  mode: "cache" | "time",
): string | null {
  if (isDiscardableTool(toolName, input)) {
    // 可丢弃工具：完全清空（cache 模式保留前 100 字符以保护 cache 位置）
    return mode === "cache"
      ? content.slice(0, 100) + "\n" + DISCARDABLE_PLACEHOLDER
      : DISCARDABLE_PLACEHOLDER;
  }

  if (isNonDiscardableTool(toolName, input)) {
    // 不可丢弃工具（edit/write、非只读 bash 等）：保留前 200 字符摘要。
    // 这类工具有副作用、输出不可重新执行复现，但仍是已知工具，可安全缩略。
    const summary = content.slice(0, 200);
    return `[工具输出已压缩，保留前 200 字符]\n${summary}\n... [剩余 ${content.length - 200} 字符已省略]`;
  }

  // 未知工具（自定义 / MCP）：不在白名单内 → 不压缩，原样保留。
  return null;
}

/** 一条 microcompact 改写决策：哪个块、改成什么。 */
export interface MicrocompactPlanEntry {
  msgIdx: number;
  blockIdx: number;
  toolUseId: string;
  /** 改写后的完整内容（占位符或摘要） */
  replacement: string;
  /** 原始内容长度（字符），用于记账 */
  originalLength: number;
}

/**
 * 只算「该改哪些块、改成什么」，不动消息。
 *
 * 判据与 {@link microcompactMessages} 完全一致（后者就是在它之上做应用）。拆出来是为了
 * 让 ContextManager 能把冷缓存清理**落成会话状态**而不是只改一份发送副本：
 * 决策一旦做出，之后每轮都要逐字节一致地重放，见 `ContextManager.applyColdCacheClear`。
 *
 * @param skipToolUse 调用方额外豁免的 tool_use_id（已有稳定占位的块：再改一次就是第二次改写前缀）
 */
export function planMicrocompact(
  messages: Message[],
  options?: MicrocompactOptions & { skipToolUse?: (toolUseId: string) => boolean },
): MicrocompactPlanEntry[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (messages.length <= opts.preserveRecentCount) return [];

  // 一次建好 tool_use 索引：原先每个块都 findToolUse 全量扫一遍，O(n²)
  const toolUses = new Map<string, { name: string; input: unknown }>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use")
        toolUses.set(block.id, { name: block.name, input: block.input });
    }
  }

  const plan: MicrocompactPlanEntry[] = [];
  // 只压缩 preserveRecentCount 之前的消息
  const cutoff = messages.length - opts.preserveRecentCount;
  for (let msgIdx = 0; msgIdx < cutoff; msgIdx++) {
    const msg = messages[msgIdx];
    // 只压缩 user 消息中的 tool_result 块
    if (msg.role !== "user") continue;
    msg.content.forEach((b, blockIdx) => {
      if (b.type !== "tool_result" || typeof b.content !== "string") return;
      if (b.content.length <= opts.minContentLength) return;
      if (options?.skipToolUse?.(b.tool_use_id)) return;
      const toolUse = toolUses.get(b.tool_use_id) ?? { name: "unknown", input: undefined };
      const replacement = compactToolResultContent(
        b.content,
        toolUse.name,
        toolUse.input,
        opts.mode,
      );
      // null 表示工具不在白名单内（未知 / 自定义 / MCP）→ 跳过，原样保留
      if (replacement === null) return;
      plan.push({
        msgIdx,
        blockIdx,
        toolUseId: b.tool_use_id,
        replacement,
        originalLength: b.content.length,
      });
    });
  }
  return plan;
}

/**
 * 对消息列表执行 microcompact（工具类型感知）
 *
 * 从早期消息开始扫描，保护窗口（最近 N 条）内的消息不压缩。
 * 采用白名单模型：可丢弃工具（含只读 bash）的旧输出完全清空，
 * 不可丢弃工具（edit/write、非只读 bash）保留摘要，
 * 未知工具（自定义 / MCP）原样保留不压缩。
 *
 * 返回压缩后的消息列表（不修改原数组）。
 */
export function microcompactMessages(
  messages: Message[],
  options?: MicrocompactOptions,
): { messages: Message[]; compactedCount: number; savedChars: number } {
  const log = getLogger();
  const plan = planMicrocompact(messages, options);
  if (plan.length === 0) return { messages, compactedCount: 0, savedChars: 0 };

  const byPos = new Map(plan.map((p) => [`${p.msgIdx}:${p.blockIdx}`, p]));
  const touched = new Set(plan.map((p) => p.msgIdx));
  let savedChars = 0;
  const result = messages.map((msg, msgIdx) => {
    if (!touched.has(msgIdx)) return msg;
    const newContent: ContentBlock[] = msg.content.map((b, blockIdx) => {
      const p = byPos.get(`${msgIdx}:${blockIdx}`);
      if (!p || b.type !== "tool_result") return b;
      savedChars += p.originalLength - p.replacement.length;
      return { ...b, content: p.replacement };
    });
    return { ...msg, content: newContent };
  });

  log.info("MICROCOMPACT", `压缩了 ${plan.length} 个工具结果，节省 ${savedChars} 字符`);
  return { messages: result, compactedCount: plan.length, savedChars };
}
