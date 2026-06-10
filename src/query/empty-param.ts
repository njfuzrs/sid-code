/**
 * F1：空参数 tool_use 退化检测与修复
 *
 * 根因（已确证）：DeepSeek v4-pro 在大上下文（~80k input tokens）场景下，
 * 生成 tool_use 声明但对参数填空（input={}），并以 stop_reason=end_turn 自行停止。
 * 系统若不干预，会走到 loop.ts 的 end_turn 分支直接退出，永不重试 → 任务卡死。
 *
 * 本模块提供纯函数（无副作用、易单测）：
 * - 检测一组 content 块中哪些 tool_use 参数为空
 * - 把空参数 tool_use 块原地替换为 text 块（消除孤儿风险：替换后不含 tool_use，无需 tool_result 配对）
 * - 构造给模型的"参数为空请重试"提示
 *
 * 重试策略（在 loop.ts 中编排）：每次重试前先压缩上下文（reactiveCompact），
 * 让 input tokens 单调下降，直接打击"大上下文"这个根因——而非原样追加提示重发
 * （后者只会让上下文更饱和，加剧退化）。
 */

import type { ContentBlock } from "../llm/types.ts";

/** 最大空参数重试次数 */
export const MAX_EMPTY_PARAM_RETRIES = 3;

/** 单个空参数 tool_use 的识别信息 */
export interface EmptyParamHit {
  /** tool_use id */
  id: string;
  /** 工具名 */
  name: string;
  /** 在 content 数组中的下标 */
  index: number;
}

/**
 * 判断一个 tool_use 的 input 是否为"空参数"。
 *
 * 空参数定义：input 为 null/undefined，或为不含任何自有可枚举 key 的对象 `{}`。
 * 这是 DeepSeek 退化的精确特征（identity-only 或 broken-JSON 都会在
 * stream-processor 落成 input={}）。
 *
 * 注意：非对象的 input（字符串/数组/数字）不视为空——那是另一类协议异常，
 * 不在本兜底范围内，交由工具执行层的参数校验处理。
 */
export function isEmptyToolInput(input: unknown): boolean {
  if (input === null || input === undefined) return true;
  if (typeof input !== "object") return false;
  if (Array.isArray(input)) return input.length === 0;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

/**
 * 扫描 content，返回所有空参数 tool_use 的命中信息。
 * 仅检测 type==="tool_use" 的块；其余块忽略。
 */
export function detectEmptyParamToolUses(content: ContentBlock[]): EmptyParamHit[] {
  const hits: EmptyParamHit[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === "tool_use" && isEmptyToolInput(block.input)) {
      hits.push({ id: block.id, name: block.name, index: i });
    }
  }
  return hits;
}

/**
 * 把 content 中的空参数 tool_use 块原地替换为 text 块。
 *
 * 替换后返回的 content：
 * - 不再含任何空参数 tool_use（消除孤儿 → 不会触发 OpenAI 400）
 * - 非空参数 tool_use 块**原样保留**（混合场景下不误伤正常工具调用——
 *   这些块由 loop.ts 的 fall-through 逻辑在后续正常执行）
 * - 其余块（text / thinking / 非空 tool_use）原样保留
 *
 * 返回新数组（不修改入参），符合 loop.ts 中 addMessage 前不可变更新的约定。
 */
export function replaceEmptyParamToolUses(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type === "tool_use" && isEmptyToolInput(block.input)) {
      return {
        type: "text" as const,
        text: `[系统检测] 工具 ${block.name} 的参数为空——模型在大上下文场景下退化（生成了工具调用声明但未填写参数）。该次调用已作废。`,
      };
    }
    return block;
  });
}

/**
 * 构造注入给模型的"空参数需重试"用户提示。
 *
 * 提示内容明确告知：哪些工具参数为空、已为其精简上下文、要求重新发起完整调用。
 * @param hits 本轮命中的空参数工具
 * @param attempt 当前是第几次重试（1-based）
 * @param maxAttempts 最大重试次数
 * @param compacted 本轮是否已执行上下文压缩（用于措辞）
 */
export function buildEmptyParamRetryMessage(
  hits: EmptyParamHit[],
  attempt: number,
  maxAttempts: number,
  compacted: boolean,
): string {
  const toolList = hits.map((h) => h.name).join("、");
  const compactNote = compacted
    ? "系统已为你精简对话上下文以释放空间。"
    : "";
  return (
    `<system-reminder>\n` +
    `检测到工具调用「${toolList}」的参数为空（input={}），这是大上下文下的模型退化，该调用未执行。${compactNote}\n` +
    `请重新发起完整的工具调用，务必填写所有必需参数（例如 write 工具需要 file_path 和 content）。` +
    `不要只输出"开始写"之类的文本后停止——直接给出带完整参数的工具调用。\n` +
    `（自动重试 ${attempt}/${maxAttempts}）\n` +
    `</system-reminder>`
  );
}
