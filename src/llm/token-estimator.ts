/**
 * Token 估算服务
 * 用字符级启发式算法快速估算 token 数，避免请求前上下文超限
 */

import type { Message, ToolDefinition } from "./types.ts";
import { lookupRegistry } from "./model-registry.ts";
import { lookupCapability } from "./model-capabilities.ts";
// 审计第 21 条：收敛到 context/token.ts 的统一块估算（补全 thinking/redacted_thinking/mediaBlocks）。
import { estimateBlockTokens } from "../context/token.ts";

/** 超过此长度使用快速近似（性能优化） */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;

/** 未知模型 + 未声明 contextWindow 时的兜底窗口（tokens）。
 *  默认 1M（2026 年主流大模型上下文窗口普遍达 1M：Claude/GPT/DeepSeek/Kimi/Qwen/GLM/Gemini 全系）。
 *  可经 SID_FALLBACK_CONTEXT_WINDOW 覆盖。非法值（NaN/≤0）静默回退默认，绝不更紧。
 *  详见 docs/bugfixes/todo/20260730-未知模型contextWindow兜底失真-根因与待修方案.md */
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 1_000_000;

function resolveFallbackWindow(): number {
  const raw = process.env.SID_FALLBACK_CONTEXT_WINDOW;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_FALLBACK_CONTEXT_WINDOW;
}

/** ASCII 字符：英文散文实测 0.17、代码/JSON 偏高，取 0.20 折中 */
const ASCII_TOKENS_PER_CHAR = 0.20;
/** 非 ASCII 字符（中文等）：取 0.65 tok/char（9.4：偏保守，防长中文对话对 Claude 累积低估） */
const NON_ASCII_TOKENS_PER_CHAR = 0.65;

/**
 * 对超长文本抽样估算"每字符 token 数"（EST-6）。
 * 等距抽样若干字符，按 ASCII / 非 ASCII 占比加权得到混合系数，
 * 比固定 0.35 对大段中文（应为 0.65）准确得多，同时保持 O(样本数) 性能。
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

export class TokenEstimator {
  /** 估算文本的 token 数 */
  estimateText(text: string): number {
    if (text.length === 0) return 0;
    // 超长文本用快速近似：EST-6 改为按抽样的非 ASCII 占比估算，
    // 旧固定 0.35 对大段中文低估（中文 0.65 远高于 0.35）。
    if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
      return Math.ceil(text.length * sampledTokensPerChar(text));
    }
    let tokens = 0;
    for (let i = 0; i < text.length; i++) {
      tokens += text.charCodeAt(i) <= 127
        ? ASCII_TOKENS_PER_CHAR
        : NON_ASCII_TOKENS_PER_CHAR;
    }
    return Math.ceil(tokens);
  }

  /** 估算消息列表的总 token 数（审计第 21 条：收敛到统一块估算，补全 thinking/redacted_thinking/mediaBlocks） */
  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // 每条消息的固定开销（role + 分隔符）
      for (const block of msg.content) {
        total += estimateBlockTokens(block);
      }
    }
    return total;
  }

  /** 估算工具定义的 token 数 */
  estimateTools(tools: ToolDefinition[]): number {
    let total = 0;
    for (const tool of tools) {
      total += this.estimateText(tool.name);
      total += this.estimateText(tool.description);
      total += this.estimateText(JSON.stringify(tool.input_schema));
    }
    return total;
  }

  /**
   * 获取模型的上下文窗口大小。
   *
   * 优先级（SSOT）：
   *   1. 用户配置 availableModels[].contextWindow —— 权威来源，用户自己声明的最准
   *   2. 内置静态表精确匹配 / 最长前缀 / 家族匹配
   *   3. 兜底 SID_FALLBACK_CONTEXT_WINDOW / 默认 1M（2026 年主流模型普遍 1M）
   *
   * @param model 模型名
   * @param availableModels 可选，用户配置的模型列表（携带权威 contextWindow）
   */
  getContextLimit(
    model: string,
    availableModels?: Array<{ name?: string; contextWindow?: number }>,
  ): number {
    // 1. 用户配置优先：availableModels 里同名模型声明的 contextWindow 是权威值，
    //    避免内置静态表与用户真实部署（自建/代理/新版本）漂移。
    //    Number.isFinite 防手改 settings.json 写出 1e400 之类溢出成 Infinity 的值——
    //    `Infinity > 0` 为 true，只查 `> 0` 挡不住，会让上下文预算永远「还有空间」。
    const userModel = availableModels?.find(m => m.name === model);
    if (
      typeof userModel?.contextWindow === "number" &&
      Number.isFinite(userModel.contextWindow) &&
      userModel.contextWindow > 0
    ) {
      return userModel.contextWindow;
    }

    // 2. 从统一注册表查找（替代旧的 MODEL_CONTEXT_LIMITS 静态表）
    const entry = lookupRegistry(model);
    if (entry) return entry.contextWindow;

    // 2.5 动态能力缓存（外部目录同步 / 探针 / 400 自愈采得）。
    //     这是「未知模型也有准确窗口」的关键一环：注册表覆盖不到的新模型（网关先上线、
    //     或用户自配的任意模型）在这里拿到真实窗口，而不是落到 1M 兜底。
    //     实测意义：gpt-5.3-codex 真实窗口 272K，兜底 1M 会高估 3.8 倍——高估直接导致
    //     塞太多 token 吃 400，正是那份 todo 文档记录的失真。
    //
    //     ⚠ 数值校验用 Number.isFinite（而非仅 `> 0`）是防御性重复：model-capabilities.ts
    //     的 sanitizeEntry 已经在写入/载入两处拦住 Infinity/NaN，这里理论上收到的必是干净值。
    //     但曾经因为 loadCapabilityCache 漏做校验，`{"contextWindow":1e400}`（JSON 解析后
    //     变成 Infinity）能一路传到这里——`Infinity > 0` 为 true，旧检查完全放行，
    //     导致「上下文永远没满」的静默失效（不报错，比报错更难发现）。两道关卡都要拦。
    const dynamic = lookupCapability(model)?.contextWindow;
    if (typeof dynamic === "number" && Number.isFinite(dynamic) && dynamic > 0) return dynamic;

    // 兜底：未知模型回退到可配置的默认值（1M）。
    // 详见 docs/bugfixes/todo/20260730-未知模型contextWindow兜底失真-根因与待修方案.md
    return resolveFallbackWindow();
  }

  /**
   * §12 P3-2：获取模型单次响应的最大输出 token 数（完成缓冲区的「输出预留」分量）。
   *
   * 优先级与 getContextLimit 一致：用户配置 availableModels[].maxOutputTokens > 内置注册表。
   * 两者都拿不到时返回 undefined——由 ContextManager 用默认预留兜底，而不是在这里编一个数字
   * （编出来的值会被当成"已知事实"参与阈值计算，比明确的 undefined 更危险）。
   */
  getMaxOutputTokens(
    model: string,
    availableModels?: Array<{ name?: string; maxOutputTokens?: number }>,
  ): number | undefined {
    const userModel = availableModels?.find(m => m.name === model);
    if (
      typeof userModel?.maxOutputTokens === "number" &&
      Number.isFinite(userModel.maxOutputTokens) &&
      userModel.maxOutputTokens > 0
    ) {
      return userModel.maxOutputTokens;
    }
    const entry = lookupRegistry(model);
    if (entry && Number.isFinite(entry.maxOutputTokens) && entry.maxOutputTokens > 0) {
      return entry.maxOutputTokens;
    }
    // 动态能力缓存兜底（与 getContextLimit 的优先级 2.5 同源）。仍拿不到才返回 undefined
    // ——由 ContextManager 用默认预留兜底，而不是在这里编一个数字。
    const dynamic = lookupCapability(model)?.maxOutputTokens;
    if (typeof dynamic === "number" && Number.isFinite(dynamic) && dynamic > 0) return dynamic;
    return undefined;
  }

  /**
   * 检查请求是否可能超出上下文限制
   * 返回 null 表示安全，否则返回超出的 token 数
   */
  checkContextFit(params: {
    model: string;
    messages: Message[];
    system?: string;
    tools?: ToolDefinition[];
    maxTokens: number;
  }): { fits: true } | { fits: false; estimated: number; limit: number } {
    const limit = this.getContextLimit(params.model);
    let estimated = this.estimateMessages(params.messages);
    if (params.system) estimated += this.estimateText(params.system);
    if (params.tools) estimated += this.estimateTools(params.tools);
    estimated += params.maxTokens; // 预留输出空间

    if (estimated < limit * 0.95) { // 留 5% 安全余量
      return { fits: true };
    }
    return { fits: false, estimated, limit };
  }
}
