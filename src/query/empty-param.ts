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
 * @param compacted 本轮是否**真的**执行了上下文压缩（用于措辞）。
 *   P0-3（2026-07-29 事故）：调用方过去传的是 `reactiveCompact` 硬编码的 `success: true`，
 *   于是在「消息一条没少」时也拼上「系统已为你精简对话上下文」。这句假话进了模型上下文后，
 *   模型此后 30 条回复反复提及「上下文被压缩」、开始给自己的推理打折扣、绕圈子——
 *   用户报的「模型不停说效果打折扣」就是它造成的，不是模型退化。
 *   现在调用方传的是实测结果（P0-1），且低占用下压根不压缩（P0-2），本参数为 false
 *   时**绝不会**出现任何「已精简上下文」字样。
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

  // ★第二层·预防(根治「git 快照冻结死循环」)——消除导火索:让模型永远知道"上一步到底落没落地"。
  //
  // 历史死循环的导火索:一个 7542 字符的超大 edit 在流式传输中因参数 JSON 被截断/中断而落成
  // input={},该 edit **没有执行**;但模型的"认知"里它已经发出了"最后一步"的指令,于是空转
  // ~40 轮反复 git status 想确认"到底做完没有"。
  //
  // 关键改进(对齐 §5 2a):不再只在 stop_reason=max_tokens 时给"未落地/分段"提示——本次真实
  // 中断是 `Request aborted`(用户 ESC / 网络断),stop_reason 并非 max_tokens。无论成因是
  // max_tokens 截断、abort 中断、还是 provider 丢参,**任何**因参数缺失/解析失败而未执行的
  // tool_use,都必须给模型一条明确回执:"这次调用未落地,请重发;若内容大,分段写"。
  const toolList2 = hits.map((h) => `\`${h.name}\``).join("、");

  // 截断场景(强信号):stop_reason=max_tokens/length 是"被输出上限截断"的确凿证据,
  // 原样重发同一个超大调用会再次被截断 → 死循环。给最强的分段引导。
  const isTruncation = stopReason === "max_tokens" || stopReason === "length";
  if (isTruncation) {
    return (
      `<system-reminder>\n` +
      `工具调用「${toolList}」未执行(参数为空 input={})。根因:上一次响应达到输出长度上限(max_tokens)被截断,` +
      `参数 JSON(如 content 字段)只生成了一半、无法解析。**这一步没有落地,工作区未发生任何改动。**${compactNote}\n` +
      `这通常发生在一次性写入/替换超大内容时。请改用分段策略,切勿原样重发同一个超大调用(否则会再次被截断,陷入死循环):\n` +
      `1. 先用 write 写入文件的第一部分(例如前 1/3),确保本次调用参数完整可解析;\n` +
      `2. 再用 edit(或 bash 的 cat >> 文件)逐段追加剩余内容;\n` +
      `3. 每段控制在数百行以内,使单次工具调用的参数不超过输出上限。\n` +
      `(自动重试 ${attempt}/${maxAttempts})\n` +
      `</system-reminder>`
    );
  }

  // 非截断分支:成因不唯一(abort 中断、大上下文退化、小/新上下文偶发空调用、provider 丢参等),
  // 无法从 stop_reason 精确区分。因此**统一**给出:①明确"未落地"事实(消除"以为已做"的幻觉);
  // ②提示可能被中断/截断(覆盖 abort 路径,§3.2 缺口);③对大内容给分段建议(降低再次被打断的概率)。
  return (
    `<system-reminder>\n` +
    `工具调用「${toolList2}」未执行(参数不完整/为空 input={},可能因上一次输出被中断或截断)。` +
    `**这一步没有落地,请不要以为它已经完成——工作区未因这次调用发生改动。**${compactNote}\n` +
    `请重新发出这次调用,确认参数完整(例如 write 需要 file_path 和 content;edit 需要 file_path、old_string、new_string)。` +
    `不要只输出"开始写/最后一步"之类的文本后停止——直接给出带完整参数的工具调用。\n` +
    `若这次改动内容较大,请分段写入(单次控制在数百行内),避免再次因输出过长被中断。\n` +
    `(自动重试 ${attempt}/${maxAttempts})\n` +
    `</system-reminder>`
  );
}
