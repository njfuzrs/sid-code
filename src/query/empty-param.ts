/**
 * F1：空参数 tool_use 退化检测与修复
 *
 * 根因（已确证）：DeepSeek v4-pro 在大上下文（~80k input tokens）场景下，
 * 生成 tool_use 声明但对参数填空（input={}），并以 stop_reason=end_turn 自行停止。
 * 系统若不干预，会走到 loop.ts 的 end_turn 分支直接退出，永不重试 → 任务卡死。
 *
 * ⚠️ 误杀防护（2026-06-10）：`enter_plan_mode` / `cron_list` 这类工具的 inputSchema
 * 本就是 `{ type:"object", properties:{} }`（无必填参数），input={} 是它们**唯一合法状态**。
 * 旧实现对任何 {} 都判退化，导致 enter_plan_mode 的合法调用被反复作废、plan mode 永远进不去
 * （会话 b168a817 死循环根因）。因此检测必须结合工具 schema 的 `required` 字段：
 * 只有"有必填参数却交了空 input"才是退化；"本就无必填参数"放行。
 *
 * 本模块提供纯函数（无副作用、易单测）：
 * - 判断工具 schema 是否声明了必填参数（toolHasRequiredParams）
 * - 检测一组 content 块中哪些 tool_use 是"真退化"（结合 schema）
 * - 把真退化的 tool_use 块原地替换为 text 块（消除孤儿风险：替换后不含 tool_use，无需 tool_result 配对）
 * - 构造给模型的"参数为空请重试"提示
 *
 * 重试策略（在 loop.ts 中编排）：每次重试前先压缩上下文（reactiveCompact），
 * 让 input tokens 单调下降，直接打击"大上下文"这个根因——而非原样追加提示重发
 * （后者只会让上下文更饱和，加剧退化）。
 */

import type { ContentBlock } from "../llm/types.ts";

/** 最大空参数重试次数 */
export const MAX_EMPTY_PARAM_RETRIES = 3;

/** 根据工具名查询其 inputSchema 的函数签名（由 loop.ts 用 toolRegistry 注入） */
export type SchemaLookup = (toolName: string) => unknown;

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
 * 判断工具 schema 是否声明了**必填参数**。
 *
 * 判据：schema.required 是非空数组 → 有必填参数 → true；否则 → false。
 *
 * 拿不到 schema（undefined/null）时**保守返回 true**：宁可把它当成"应有参数"而触发
 * 重试兜底，也不放过一个可疑的空参数 tool_use。已知无必填参数的工具
 * （enter_plan_mode / cron_list 等）schema 形如 `{ type:"object", properties:{} }`，
 * 无 required 字段 → 返回 false → 其合法 input={} 不会被误判为退化。
 */
export function toolHasRequiredParams(schema: unknown): boolean {
  if (schema === null || schema === undefined) return true; // 保守：拿不到 schema 维持旧行为
  if (typeof schema !== "object") return true;
  const required = (schema as Record<string, unknown>).required;
  return Array.isArray(required) && required.length > 0;
}

/**
 * 判断一个 tool_use 块是否为"真退化"（空参数 + 该工具本应有必填参数）。
 *
 * @param block tool_use 块
 * @param getSchema 可选的 schema 查询函数；不传时退化为"任何空参数都算退化"（向后兼容旧行为）
 */
function isDegradedToolUse(
  block: Extract<ContentBlock, { type: "tool_use" }>,
  getSchema?: SchemaLookup,
): boolean {
  if (!isEmptyToolInput(block.input)) return false;
  // 不传 getSchema：维持旧逻辑（任何空参数即退化），保证既有调用方/测试不变
  if (!getSchema) return true;
  return toolHasRequiredParams(getSchema(block.name));
}

/**
 * 扫描 content，返回所有"真退化"空参数 tool_use 的命中信息。
 * 仅检测 type==="tool_use" 的块；其余块忽略。
 *
 * @param content content 块数组
 * @param getSchema 可选；传入后会结合工具 schema 的 required 字段，放过本就无必填参数的工具
 */
export function detectEmptyParamToolUses(
  content: ContentBlock[],
  getSchema?: SchemaLookup,
): EmptyParamHit[] {
  const hits: EmptyParamHit[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === "tool_use" && isDegradedToolUse(block, getSchema)) {
      hits.push({ id: block.id, name: block.name, index: i });
    }
  }
  return hits;
}

/**
 * 把 content 中的"真退化"空参数 tool_use 块原地替换为 text 块。
 *
 * 替换后返回的 content：
 * - 不再含任何真退化空参数 tool_use（消除孤儿 → 不会触发 OpenAI 400）
 * - 非空参数 tool_use 块、以及本就无必填参数工具的合法空 tool_use（如 enter_plan_mode）
 *   **原样保留**（混合场景下不误伤——这些块由 loop.ts 的 fall-through 逻辑在后续正常执行）
 * - 其余块（text / thinking）原样保留
 *
 * 返回新数组（不修改入参），符合 loop.ts 中 addMessage 前不可变更新的约定。
 *
 * @param content content 块数组
 * @param getSchema 可选；与 detectEmptyParamToolUses 保持一致的判据
 */
export function replaceEmptyParamToolUses(
  content: ContentBlock[],
  getSchema?: SchemaLookup,
): ContentBlock[] {
  return content.map((block) => {
    if (block.type === "tool_use" && isDegradedToolUse(block, getSchema)) {
      return {
        type: "text" as const,
        // 归因脱节修复：不再无条件断言"大上下文退化"——空参数的成因不止一种
        // （小/新上下文下模型偶发生成空 tool_use、provider 序列化丢参等）。只陈述
        // 可观测事实（参数为空、调用作废），不臆造未经证实的根因。
        text: `[系统检测] 工具 ${block.name} 生成了工具调用声明但参数为空（input={}），该次调用已作废。`,
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
 * @param stopReason 本轮响应的 stop_reason（=max_tokens/length 时归因为"截断"，
 *        给分段写入建议；否则只陈述"参数为空"事实，不臆造根因）
 */
export function buildEmptyParamRetryMessage(
  hits: EmptyParamHit[],
  attempt: number,
  maxAttempts: number,
  compacted: boolean,
  stopReason?: string,
): string {
  const toolList = hits.map((h) => h.name).join("、");
  const compactNote = compacted
    ? "系统已为你精简对话上下文以释放空间。"
    : "";

  // 截断场景（关键）：stop_reason=max_tokens/length 说明上一次响应因输出长度上限被截断，
  // tool_use 的参数 JSON（如 write 的 content 字段）只生成了一半、无法解析 → 在
  // stream-processor 落成 input={}。这与"大上下文退化"是完全不同的根因：若仍按退化提示
  // "重新发起完整调用"，模型会原样重发同一个超大 write，再次撞上限被截断 → 死循环
  // （用户实测反复卡死的正是此路径）。因此必须给出针对性的分段写入建议。
  const isTruncation = stopReason === "max_tokens" || stopReason === "length";
  if (isTruncation) {
    return (
      `<system-reminder>\n` +
      `工具调用「${toolList}」的参数为空（input={}）。根因：上一次响应达到输出长度上限（max_tokens）被截断，` +
      `参数 JSON（如 content 字段）只生成了一半、无法解析，该调用未执行。${compactNote}\n` +
      `这通常发生在一次性写入/替换超大内容时。请改用分段策略，切勿原样重发同一个超大调用（否则会再次被截断，陷入死循环）：\n` +
      `1. 先用 write 写入文件的第一部分（例如前 1/3），确保本次调用参数完整可解析；\n` +
      `2. 再用 edit（或 bash 的 cat >> 文件）逐段追加剩余内容；\n` +
      `3. 每段控制在数百行以内，使单次工具调用的参数不超过输出上限。\n` +
      `（自动重试 ${attempt}/${maxAttempts}）\n` +
      `</system-reminder>`
    );
  }

  // 非截断分支：成因不唯一（大上下文退化只是其一，也可能是小/新上下文下的偶发空调用、
  // provider 丢参等）。不再无条件断言"大上下文退化"这一未经证实的根因，只陈述事实 +
  // 给出无论何种成因都正确的补救动作（重发带完整参数的调用）。
  return (
    `<system-reminder>\n` +
    `检测到工具调用「${toolList}」的参数为空（input={}），该调用未执行。${compactNote}\n` +
    `请重新发起完整的工具调用，务必填写所有必需参数（例如 write 工具需要 file_path 和 content）。` +
    `不要只输出"开始写"之类的文本后停止——直接给出带完整参数的工具调用。\n` +
    `（自动重试 ${attempt}/${maxAttempts}）\n` +
    `</system-reminder>`
  );
}
