/**
 * 自动压缩摘要 Prompt 工程（Layer 1，对标 claude-code services/compact/prompt.ts）
 *
 * 把原 auto-compact.ts 内联的"一句话 + 消息 dump"升级为结构化 9 段摘要 prompt：
 * 明确要求模型保留"用户意图 / 已做决策 / 待办 / 关键文件 / 用户纠正"等段落，
 * 从根因上缓解长会话压缩后的"断片"问题。
 *
 * 设计要点：
 * - 9 段固定结构：每段针对一类"断片"根因（见 §3.1 分析文档）
 * - <analysis> + <summary> 双层输出：analysis 是模型的思考草稿，post-processing 剥离，
 *   不进入后续上下文；只有 <summary> 内容被注入。
 * - 差异化消息截断：user 消息全保留、assistant 文本前 2000、工具结果统一缩略，
 *   避免一刀切 500 字符既切断关键代码又浪费预算。
 * - 不引入任何供应商特有 API 参数：prompt 升级对所有 Provider 一视同仁。
 */

import type { Message } from "../../llm/types.ts";

/** 摘要系统提示词：引导模型聚焦"什么对后续对话最重要" */
export const COMPACT_SYSTEM_PROMPT =
  "你是一个专业的对话摘要助手。你的任务是生成一份结构化的摘要，使后续对话能无缝继续。" +
  "重点关注：用户意图、已做决策、待办事项、关键文件路径和代码片段。" +
  "不要省略任何重要细节。仅输出纯文本，不要调用任何工具。";

/** 结构化 9 段摘要要求（对标 claude-code BASE_COMPACT_PROMPT） */
const BASE_COMPACT_PROMPT = `你的任务是：详尽地总结到目前为止的对话内容，使后续对话在历史被压缩后仍能无缝继续。

请先在 <analysis> 块中逐条审查对话（这是你的思考草稿，不会进入最终上下文），确认下面 9 个段落都已覆盖、没有遗漏关键信息；然后在 <summary> 块中按以下 9 个固定段落输出最终摘要：

<analysis>
[在这里逐一回顾每条消息，确认每个段落都覆盖到位。这部分是草稿，会被丢弃。]
</analysis>

<summary>
1. 主要请求与意图 (Primary Request and Intent)
   完整记录用户最初及后续的核心请求和意图。不要遗漏用户明确表达的目标和约束。

2. 关键技术概念 (Key Technical Concepts)
   列出涉及的关键技术、框架、语言、库和架构决策。

3. 文件与代码段 (Files and Code Sections)
   枚举检查、修改或创建过的具体文件及代码段。特别关注最近的消息，在适用处包含完整代码片段，并说明为什么这个文件的读取或修改很重要。

4. 错误与修复 (Errors and Fixes)
   记录遇到的错误及其修复方式，以及用户给出的反馈和纠正（用户说过"不要这样做"的内容必须保留）。

5. 问题解决进展 (Problem Solving)
   描述已解决的问题，以及正在进行中的排查与思路。

6. 所有用户消息 (All User Messages)
   逐条列出所有非工具结果的用户消息。这是保证后续不偏离用户意图的关键，不要概括或合并，逐条保留。

7. 待办事项 (Pending Tasks)
   明确列出用户要求但尚未完成的待办事项。

8. 当前工作 (Current Work)
   精确描述压缩前正在做的工作，包含当前操作的文件名和相关代码片段。

9. 可选的下一步 (Optional Next Step)
   给出与最近工作直接相关的下一步。必须引用对话原文中的确切语句，证明这一步与当前任务相关，而非自行发挥。如果没有明确的下一步，可留空。
</summary>

输出要求：
- 必须先输出 <analysis> 块，再输出 <summary> 块。
- <summary> 内必须包含上述全部 9 个编号段落，即使某段无内容也要写"（无）"。
- 使用中文，保持高信号密度，不要添加客套话。`;

/** 末尾重申：纯文本输出（对标 claude-code NO_TOOLS_TRAILER，但去掉 Anthropic 特有措辞） */
const NO_TOOLS_TRAILER = `

提醒：请只用纯文本回复——一个 <analysis> 块紧跟一个 <summary> 块，不要调用任何工具。`;

/**
 * 生成结构化压缩 prompt 的指令部分（不含待总结的对话内容）。
 * @param customInstructions 可选的用户自定义压缩指令（来自配置/Hook），追加到末尾。
 */
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = BASE_COMPACT_PROMPT;
  if (customInstructions && customInstructions.trim() !== "") {
    prompt += `\n\n额外指令:\n${customInstructions.trim()}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

/** 单条消息截断为摘要输入时的角色差异化策略上限 */
const TRUNCATE_LIMITS = {
  /** assistant 文本：关键信息通常在开头 */
  assistantText: 2000,
  /** assistant 工具调用参数 */
  toolUseInput: 500,
  /** user 工具结果：统一缩略（工具结果可能上万字符） */
  toolResult: 200,
} as const;

/**
 * 把一条消息渲染为摘要输入文本（差异化截断）。
 *
 * - user 文本消息：保留全部（用户消息通常较短且非常重要）
 * - assistant 文本消息：保留前 2000 字符
 * - assistant 工具调用：保留工具名 + 前 500 字符参数
 * - user 工具结果：保留前 200 字符 + 总长度标注
 */
export function renderMessageForSummary(msg: Message): string {
  const parts: string[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      if (msg.role === "user") {
        // 用户文本：全文保留
        parts.push(block.text);
      } else {
        // assistant 文本：前 2000 字符
        parts.push(truncateWithMark(block.text, TRUNCATE_LIMITS.assistantText));
      }
    } else if (block.type === "tool_use") {
      const input = (() => {
        try {
          return JSON.stringify(block.input);
        } catch {
          return String(block.input);
        }
      })();
      parts.push(
        `[工具调用: ${block.name}] ${truncateWithMark(input, TRUNCATE_LIMITS.toolUseInput)}`,
      );
    } else if (block.type === "tool_result") {
      const total = block.content.length;
      const head = block.content.slice(0, TRUNCATE_LIMITS.toolResult);
      const mark = total > TRUNCATE_LIMITS.toolResult ? `…[共 ${total} 字符]` : "";
      parts.push(`[工具结果] ${head}${mark}`);
    }
    // thinking 块不计入摘要输入（思考过程不需要被二次总结）
  }

  const body = parts.join("\n").trim();
  return `[${msg.role}] ${body}`;
}

/** 截断字符串并在超长时追加省略标记（使用 Unicode 省略号，不触发占位符检测） */
function truncateWithMark(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * 把待总结的消息列表拼装为完整的用户 prompt 文本（指令 + 对话内容）。
 * @param messages 待总结的消息（通常是 messages.slice(0, -N)）
 * @param customInstructions 可选自定义指令
 */
export function buildCompactUserPrompt(messages: Message[], customInstructions?: string): string {
  const instruction = getCompactPrompt(customInstructions);
  const transcript = messages.map(renderMessageForSummary).join("\n\n");
  return `${instruction}\n\n--- 以下是需要总结的对话内容 ---\n\n${transcript}`;
}

/**
 * 剥离 <analysis> 块、把 <summary> 标签转成可读内容（对标 claude-code formatCompactSummary）。
 *
 * 多重回退（12.1：LLM 输出格式抖动时正则单路径会失效，导致 analysis 草稿泄漏进最终摘要）：
 *   1. 正则剥离闭合的 <analysis>…</analysis>（可能多个）
 *   2. indexOf 回退：处理未闭合 <analysis>（只有开标签）——从该位置切到下一个 <summary>，
 *      若无 <summary> 则切到文末，整段丢弃。
 *   3. 提取 <summary>…</summary> 内容；无闭合 summary 标签时用 indexOf 从 <summary> 切到文末。
 *   4. 全部失败（无任何标签）：原样返回 trim 后的文本（鲁棒回退，宁可多留不要清空）。
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary;

  // 1. 剥离闭合的 analysis 草稿块（可能有多个，全部移除）
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");

  // 2. indexOf 回退：处理"未闭合 <analysis>"（开标签无闭合）。
  //    残留的开标签说明上面的正则没匹配上 → 从开标签切到下一个 <summary>（或文末）整段丢弃。
  const lcForAnalysis = formatted.toLowerCase();
  const openAnalysis = lcForAnalysis.indexOf("<analysis>");
  if (openAnalysis !== -1) {
    const nextSummary = lcForAnalysis.indexOf("<summary>", openAnalysis);
    if (nextSummary !== -1) {
      // 丢弃 [openAnalysis, nextSummary)，保留 <summary> 起的后续内容
      formatted = formatted.slice(0, openAnalysis) + formatted.slice(nextSummary);
    } else {
      // 没有 summary 标签：从 analysis 开标签到文末全部丢弃
      formatted = formatted.slice(0, openAnalysis);
    }
  }

  // 3. 提取 summary 块内容
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    formatted = summaryMatch[1];
  } else {
    // 无闭合 summary 标签：indexOf 回退——找到开标签则取其后全部内容
    const lc = formatted.toLowerCase();
    const openSummary = lc.indexOf("<summary>");
    if (openSummary !== -1) {
      formatted = formatted.slice(openSummary + "<summary>".length);
    }
    // 剥离可能残留的开/闭标签
    formatted = formatted.replace(/<\/?summary>/gi, "");
  }

  // 4. 兜底：剥离后若为空（标签处理意外清空），回退到剥离 analysis 后的原文
  const trimmed = formatted.trim();
  if (trimmed.length === 0) {
    return summary
      .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
      .replace(/<\/?(analysis|summary)>/gi, "")
      .trim();
  }
  return trimmed;
}

/** post-compact 消息重组选项 */
export interface CompactSummaryMessageOptions {
  /** autoCompact 静默续接：不让模型回顾、问候或问问题 */
  suppressFollowUpQuestions?: boolean;
  /** 完整转录文件路径（压缩前细节可在此查阅）；不存在时省略该提示 */
  transcriptPath?: string;
  /** 近期消息是否被完整保留 */
  recentMessagesPreserved?: boolean;
  /** 被完整保留的近期消息条数（用于提示文案，可选） */
  preservedCount?: number;
}

/**
 * 把摘要组装成"继续会话用"的用户消息（对标 claude-code getCompactUserSummaryMessage）。
 *
 * 在 formatCompactSummary 的基础上追加：
 * - 续接说明（这是压缩后的摘要）
 * - 转录路径提示（如果提供）
 * - 保留消息提示（如果提供）
 * - 静默续接指令（autoCompact 场景）
 */
export function getCompactUserSummaryMessage(
  summary: string,
  options: CompactSummaryMessageOptions = {},
): string {
  const formattedSummary = formatCompactSummary(summary);

  let base = `以下是对之前对话的结构化摘要（之前的会话因上下文超限被压缩，本摘要覆盖较早的对话部分）：\n\n${formattedSummary}`;

  if (options.transcriptPath) {
    base += `\n\n如果你需要压缩前的具体细节（例如确切的代码片段、错误信息或你之前生成的内容），可以读取完整转录文件：${options.transcriptPath}`;
  }

  if (options.recentMessagesPreserved) {
    const countHint =
      typeof options.preservedCount === "number" && options.preservedCount > 0
        ? `最近的 ${options.preservedCount} 条消息`
        : "最近的消息";
    base += `\n\n${countHint}被完整保留在本摘要之后。`;
  }

  if (options.suppressFollowUpQuestions) {
    base +=
      `\n请直接从你上次中断的地方继续工作，不要向用户提任何问题。` +
      `直接继续——不要复述摘要、不要回顾刚才在做什么、不要用"我将继续"之类的开场白。` +
      `把最后的任务当作从未中断那样接着做下去。`;
  }

  return base;
}

// ────────────────────────────────────────────────────────────────────────────
// G22：部分压缩（partial-compact / compact-up-to）专用 prompt
//
// 与全量摘要的区别：全量摘要假设"整段对话都被压缩、其后只有保留的最近几条"；
// 部分压缩只压缩对话的**前半段**，被压缩段之后**还有完整的原文后半段**继续。
// 因此摘要要为"后续原文延续"服务，而不是替代整段对话——不能给"下一步"结论
// （下一步在保留的原文里），重点是把前半段的**背景、决策、文件、纠正**沉淀下来，
// 让模型读到保留的后半段原文时不缺前情。
// ────────────────────────────────────────────────────────────────────────────

/** 部分压缩系统提示词：强调这是"前半段"的背景摘要，后半段原文仍在 */
export const PARTIAL_COMPACT_SYSTEM_PROMPT =
  "你是一个专业的对话摘要助手。你收到的是一段较长对话的**前半段**——它之后还保留着完整的对话后半段原文。" +
  "你的任务是把前半段沉淀成一份背景摘要，让读者在直接阅读后半段原文时不缺任何前情。" +
  "重点保留：用户意图与约束、已做决策、涉及的关键文件与代码片段、用户的纠正。" +
  "不要给出'下一步该做什么'的结论（后续动作在保留的原文里）。仅输出纯文本，不要调用任何工具。";

/** 部分压缩摘要要求（比全量摘要精简：无"当前工作/下一步"段，因为那些在保留的原文里） */
const PARTIAL_COMPACT_PROMPT = `你的任务是：为下面这段对话的**前半段**生成一份背景摘要。这段之后还保留着完整的对话后半段原文，你的摘要只是为了让读者读后半段时不缺前情，不能替代后半段。

请在 <summary> 块中按以下固定段落输出（无需 <analysis> 草稿）：

<summary>
1. 主要请求与意图 (Primary Request and Intent)
   完整记录用户在这段内表达的核心请求、目标和约束。

2. 关键技术概念与决策 (Key Technical Concepts & Decisions)
   列出涉及的关键技术、框架、库，以及已经拍板的架构/实现决策。

3. 文件与代码段 (Files and Code Sections)
   枚举这段内检查、修改或创建过的具体文件及关键代码段，说明其重要性。

4. 错误与用户纠正 (Errors and User Corrections)
   记录遇到的错误及修复方式，以及用户明确的反馈与纠正（"不要这样做"必须保留）。

5. 未决事项 (Open Threads)
   这段结束时仍悬而未决、可能在后半段被继续处理的事项。
</summary>

输出要求：
- 只输出一个 <summary> 块，包含上述 5 个编号段落，即使某段无内容也写"（无）"。
- 使用中文，高信号密度，不要客套话，不要推断"下一步"。`;

/**
 * 组装"部分压缩"用户 prompt（指令 + 前半段对话内容）。
 * 复用 renderMessageForSummary 的差异化截断策略。
 * @param messages 待压缩的前半段消息
 * @param customInstructions 可选自定义指令
 */
export function buildPartialCompactUserPrompt(
  messages: Message[],
  customInstructions?: string,
): string {
  let instruction = PARTIAL_COMPACT_PROMPT;
  if (customInstructions && customInstructions.trim() !== "") {
    instruction += `\n\n额外指令:\n${customInstructions.trim()}`;
  }
  instruction += `\n\n提醒：请只用纯文本回复一个 <summary> 块，不要调用任何工具。`;
  const transcript = messages.map(renderMessageForSummary).join("\n\n");
  return `${instruction}\n\n--- 以下是需要摘要的对话前半段 ---\n\n${transcript}`;
}
