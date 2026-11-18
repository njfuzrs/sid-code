/**
 * Token 精确估算
 * 区分 ASCII 和非 ASCII 字符，提供更准确的 token 估算
 */

import { memoizeWithLRU } from "@sid-code/shared/utils/memoize-lru.ts";

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高，取 0.28 折中。
 *
 *  口径依据（2026-11-18 E1 端到端验收的离线系数实验）：S1/S2 场景的**每轮新增内容**
 *  ASCII 字符占比 86% / 76%（主要是工具结果里的代码与 JSON），按 0.20 估算时
 *  增量估算比例 α 只有 0.717 / 0.673（即新增内容被低估约 28–33%），累积成
 *  5.4% / 6.1% 的总量低估（M1）。系数提到 0.28 后 α 升到 0.906 / 0.817。
 *
 *  为什么不是更高：英文散文真实约 0.17，0.28 对纯英文散文已是高估；而会话内容
 *  以代码/JSON 为主，折中点上移是「宁可早压缩不要晚溢出」的同向选择。
 *  旧值 0.20 的注释写的是「代码/JSON 偏高,取 0.20 折中」，但没有任何实测支撑——
 *  E1 的 α 测量第一次把它量出来了。
 *
 *  注意：校准回路（recordActualTokens 的 calibrationFactor）会吸收全局偏差，
 *  所以这个系数主要影响「首次真实 usage 校准前」的估算与每轮的**增量**准度；
 *  改它必须用真实会话验证 M1，不能只看离线 α（α 是代理指标）。 */
const ASCII_TOKENS_PER_CHAR = 0.28;
/** 非 ASCII 字符（中文/日文/韩文等）：取 0.65 tok/字符。
 *
 *  口径权衡（9.4）：DeepSeek 官方 tokenizer 实测中文 ≈0.52，但 Claude/Anthropic tokenizer
 *  对中文约 0.6-0.7、日文约 0.8。本基座多 provider 共用，按"宁可早压缩不要晚溢出"取偏保守的
 *  0.65（旧值 0.55 偏向 DeepSeek，长中文对话对 Claude 会累积 10-15% 低估，使 compact 触发过晚）。
 *
 *  注意：estimateTokens 之上还有 calibrationFactor 校准回路（recordActualTokens 用真实 usage
 *  反推系数并 EMA 平滑），因此此处的启发式系数仅在"首次真实 usage 校准前"生效；校准后误差收敛 < 5%。
 *  纯字符 tokenizer（@anthropic-ai/tokenizer）只对 Anthropic 准确、对其它 provider 反而引入新偏差，
 *  且校准回路已达成精度目标，故不引入该重依赖。 */
const NON_ASCII_TOKENS_PER_CHAR = 0.65;
/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;
/** LRU 缓存键长度上限——超长文本不缓存（key 本身就贵，且命中率低） */
const CACHE_KEY_MAX_LEN = 2_000;

/**
 * 对超长文本抽样估算"每字符 token 数"（EST-6）。
 * 等距抽样后按 ASCII / 非 ASCII 占比加权，比旧固定 0.35 对大段中文准确得多
 * （中文应为 0.55，旧值低估约 36%），同时保持 O(样本数) 性能。
 */
function sampledTokensPerChar(text: string): number {
  const SAMPLE_SIZE = 2_000;
  const step = Math.max(1, Math.floor(text.length / SAMPLE_SIZE));
  let nonAscii = 0;
  let sampled = 0;
  for (let i = 0; i < text.length; i += step) {
    if (text.charCodeAt(i) > 127) nonAscii++;
    sampled++;
  }
  if (sampled === 0) return ASCII_TOKENS_PER_CHAR;
  const nonAsciiRatio = nonAscii / sampled;
  return ASCII_TOKENS_PER_CHAR * (1 - nonAsciiRatio) + NON_ASCII_TOKENS_PER_CHAR * nonAsciiRatio;
}

/** 逐字符分类的核心算法（被缓存包裹） */
function computeTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本用快速近似（按抽样语言占比加权，而非固定混合系数）
  if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
    return Math.ceil(text.length * sampledTokensPerChar(text));
  }

  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) <= 127 ? ASCII_TOKENS_PER_CHAR : NON_ASCII_TOKENS_PER_CHAR;
  }

  return Math.ceil(tokens);
}

/**
 * 有界 LRU 缓存：热路径（重复估算同一段文本）命中缓存，
 * 短会话也不会无限增长（max=200，对齐 spec 2.1.3）。
 * 只缓存中短文本——超长文本作为 key 本身昂贵且很少重复。
 */
const memoizedTextTokens = memoizeWithLRU(computeTextTokens, (text: string) => text, 200);

/**
 * 估算文本的 token 数
 * 短文本逐字符分类计算，超长文本用快速近似
 */
export function estimateTextTokens(text: string): number {
  // 超长文本绕过缓存（避免巨大 key 占用 LRU 槽位）
  if (text.length > CACHE_KEY_MAX_LEN) {
    return computeTextTokens(text);
  }
  return memoizedTextTokens(text);
}

/**
 * 估算单个 ContentBlock 的 token 数（审计第 21 条：统一收敛点）。
 *
 * 此前全仓有 5 份各自手写的 if/else if 链（token-estimator.ts、context/manager.ts、
 * session-memory/utils.ts、compact/context-collapse.ts、compact/partial-compact.ts），
 * 全部漏算 thinking / redacted_thinking / tool_result.mediaBlocks 三类块。
 * 本函数是它们的单一收敛点——补全全部分支后，消费方调它即可，不再各自手写。
 */
export function estimateBlockTokens(block: import("../llm/types.ts").ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTextTokens(block.text);
    case "tool_use":
      return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input));
    case "tool_result": {
      let t = estimateTextTokens(typeof block.content === "string" ? block.content : "");
      // mediaBlocks（图片/PDF 的 base64）此前完全未计入，导致含富媒体工具结果的
      // token 估算严重偏低。base64 体积远大于等长文本，按字符数估近似偏保守（不低估）。
      if (block.mediaBlocks) {
        for (const mb of block.mediaBlocks) {
          t += estimateTextTokens(mb.data ?? "");
        }
      }
      return t;
    }
    case "thinking":
      return estimateTextTokens(block.thinking ?? "");
    case "redacted_thinking":
      // data 是被安全系统脱敏的密文，多轮回传必需，体积不可忽略。
      return estimateTextTokens(block.data ?? "");
    case "provider_reasoning":
      // 发现 1：Responses 的 encrypted_content 不会被渲染进新采样（官方说明），按密文长度估
      // 会让每轮累加几 KB base64，1300 轮下把 masking/压缩提前触发。按 0 计，真实开销由 usage 回填。
      return 0;
    default: {
      // 穷尽检查：`ContentBlock` 新增成员而这里没跟上时，typecheck 直接报错。
      // 旧实现是静默 `return 0`——新块类型会被无声漏算，而估算偏低会让压缩/遮罩晚触发，
      // 与 A1「分类必须穷尽」同一条教训（分类侧已有 never，估算侧此前没有）。
      // 运行时若真来了未知类型（第三方 provider 的非标块），仍按 0 计以保持防御。
      const exhaustive: never = block;
      void exhaustive;
      return 0;
    }
  }
}

/**
 * 估算一组消息的 token 总数（不含每条消息的结构开销，消费方按需自行加）。
 *
 * 审计第 21 条：收敛全仓 5 份重复实现。各消费方此前各自手写同款漏算的 if 链，
 * 改一处改不全——统一调本函数后补一次即全部生效。
 */
export function estimateMessagesTokens(messages: import("../llm/types.ts").Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      total += estimateBlockTokens(block);
    }
  }
  return total;
}

/** 未注入真实 schema 时，每个工具定义的粗估开销（与 Manager.rawEstimateTokens 同源） */
export const TOOL_SCHEMA_TOKENS_FALLBACK = 80;
/** 每条消息的结构开销（role / 分隔），与 Manager.rawEstimateTokens 同源 */
export const MESSAGE_STRUCTURAL_TOKENS = 4;
/** tool_use 块额外结构开销 */
export const TOOL_USE_STRUCTURAL_TOKENS = 20;
/** tool_result 块额外结构开销 */
export const TOOL_RESULT_STRUCTURAL_TOKENS = 10;

/**
 * 估算过程中的一个「可归因片段」（PR1：面板分类与决策估算同源的基础）。
 *
 * 为什么不给每个分类各写一个累加器：那样面板就必须**再写一遍**分块循环，
 * 于是同一套归类规则存在两份（第 7 份手写 if 链）——`estimateBlockTokens` 补了
 * thinking，面板那份没补，就出现了「决策算得对、面板漏算 28k」。
 * 访问者让「各部分之和 ≡ 返回值」由构造保证，而不是靠两条并行实现自觉保持一致。
 */
export type TokenPart =
  /** 系统提示词本体（含记忆/CLAUDE.md，切分由消费方按注入端记账再做） */
  | { kind: "system" }
  /** 工具定义 schema 合计（含 MCP / 子代理定义，同上由消费方切分） */
  | { kind: "tools" }
  /** 单条消息的结构开销（role / 分隔） */
  | { kind: "overhead" }
  /** 一个内容块，**已含**该块自身的结构开销（tool_use +20 / tool_result +10） */
  | {
      kind: "block";
      role: import("../llm/types.ts").Message["role"];
      block: import("../llm/types.ts").ContentBlock;
    };

/** `estimateConversationTokens` 的选项。`visit` 缺省时不产生任何回调开销。 */
export interface EstimateConversationOptions {
  systemPrompt?: string;
  toolCount?: number;
  toolSchemaTokens?: number | null;
  /**
   * 供展示层按分类归因的访问者。不传 = 热路径（决策估算），零额外开销。
   *
   * 保证：`Σ 回调收到的 tokens === 函数返回值`。前提是调用方不在回调里丢数
   * （分类键必须覆盖全部 `TokenPart` 种类）。
   */
  visit?: (part: TokenPart, tokens: number) => void;
}

/**
 * 会话级启发式 token 估算（消息 + 结构开销 + 可选 system / 工具 schema）。
 *
 * P1-6：管线达标判据与 Manager.rawEstimateTokens 必须走同一份计算——
 * 旧 `chars/4` 漏 thinking、无 CJK 区分、不含结构开销，中文密集会话上能差出数倍。
 * 校准系数（calibrationFactor）由 Manager.estimateTokensFor 在这份基线上再乘。
 *
 * PR1：新增可选访问者。传入时每次 `total +=` 同步回调一次，于是「分类之和 ≡ 总量」
 * 由构造保证；不传时只多一次 `undefined` 判断，热路径行为与性能不变。
 */
export function estimateConversationTokens(
  messages: import("../llm/types.ts").Message[],
  opts?: EstimateConversationOptions,
): number {
  const visit = opts?.visit;
  let total = 0;

  const systemTokens = estimateTextTokens(opts?.systemPrompt ?? "");
  total += systemTokens;
  if (visit) visit({ kind: "system" }, systemTokens);

  const toolTokens = opts?.toolSchemaTokens ?? (opts?.toolCount ?? 0) * TOOL_SCHEMA_TOKENS_FALLBACK;
  total += toolTokens;
  if (visit) visit({ kind: "tools" }, toolTokens);

  for (const msg of messages) {
    total += MESSAGE_STRUCTURAL_TOKENS;
    if (visit) visit({ kind: "overhead" }, MESSAGE_STRUCTURAL_TOKENS);
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      // 块自身的结构开销与块合并成一次回调，归到同一分类——面板不需要把 +20/+10
      // 单列一行（那是「工具调用/工具结果」之所以比纯文本贵的来源，拆开反而更难解释）。
      let blockTokens = estimateBlockTokens(block);
      if (block.type === "tool_use") blockTokens += TOOL_USE_STRUCTURAL_TOKENS;
      else if (block.type === "tool_result") blockTokens += TOOL_RESULT_STRUCTURAL_TOKENS;
      total += blockTokens;
      if (visit) visit({ kind: "block", role: msg.role, block }, blockTokens);
    }
  }
  return total;
}
