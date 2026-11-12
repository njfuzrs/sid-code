/**
 * fork 前缀对齐（D16，2026-11-12）：让记忆 fork 的首请求读到主循环已经写好的 prompt cache。
 *
 * ## 问题
 *
 * fork（session-memory-update / memory-extract / auto-dream）的卖点是「共享主对话前缀，缓存友好」，
 * 但实测 deepseek 族 fork 首请求命中率 p50 只有 6%（405 个会话）。请求体有三处和主循环不一样：
 *
 * 1. **thinking / effort**：主循环 `enabled + max`，fork 写死 `SIDE_CALL_NO_THINK`。
 *    DeepSeek 把这两个参数都算进缓存键，只改其一命中就是 0（对照实验见 Agent Note）。
 * 2. **tools**：主循环开 tool search 只发 `activeDefinitions()`（24 个），fork 发 `definitions()`（52 个）。
 *    字典序第 6 位就分叉，system 之后的全部历史不命中。
 * 3. **messages**：主循环发清理后的视图（遮罩 / 冷清理 / 大输出占位），fork 发原始消息。
 *
 * ## 做法
 *
 * 主循环每次构造完 `sendParams` 调 {@link recordMainRequestShape} 记下**实际发出**的 tools
 * 与思考参数；fork 发请求前用 {@link resolveForkRequestShape} 取回。messages 由
 * `ContextManager.getForkPrefixMessages()` 给出（只读地复现主循环发送视图，不推进任何清理状态）。
 *
 * ⛔ 不要改成 fork 自己重算 `activeDefinitions()`：模型中途经 tool_search 激活的工具、
 * `withholdLateMcpTools` 扣下的晚连 MCP 工具，重算都会对不上。只认主循环最后一次实际发出的值。
 *
 * ## 按协议族区分思考参数
 *
 * 只有方言声明 `cacheKeyIncludesThinking=true` 的族（目前只有 DeepSeek OpenAI 兼容端点，实测过）
 * 才照搬思考参数。Anthropic 的缓存键不含 thinking（全量数据 fork 首请求 p50 72%），
 * 照搬只会让 fork 白付思考费，所以保持关思考。没测过的族同样保持现状。
 */

import type { Message, SendParams, ToolDefinition } from "../llm/types.ts";

/**
 * 记忆提取 / dream 必须能调用的工具（权限函数放行的写入口 + 最常用的只读工具）。
 * 快照里缺任何一个就退回全量（见 resolveForkRequestShape）。
 */
export const MEMORY_FORK_REQUIRED_TOOLS: readonly string[] = [
  "save_memory",
  "edit",
  "write",
  "read",
];

/** 主循环最后一次实际发出请求的「形状」（不含 messages，messages 走 ContextManager 的只读视图） */
export interface MainRequestShape {
  /** 渠道别名（`sendParams.model`）。fork 的模型与它不同 = 用户切过模型，整份快照作废 */
  model: string;
  /** 实际发出的工具定义（引用，主循环每轮新建数组，不会被就地改写） */
  tools?: ToolDefinition[];
  /**
   * 需要照搬的思考参数。只有 `cacheKeyIncludesThinking=true` 的族才有值；
   * 缺省 = 这个族的缓存键不含思考参数，fork 维持关思考。
   */
  thinkingMirror?: Pick<
    SendParams,
    "thinking" | "reasoningEffort" | "outputConfig" | "thinkingIntent" | "maxThinkingTokens"
  > & {
    /**
     * 主循环的输出上限。照搬思考时 fork 的上限取它与 fork 自己上限的较大值：
     * DeepSeek 的 `max_tokens` 包含思维链，开思考后仍用 2048 / 8192 会让思考吃掉正文预算，
     * 工具入参被截断（C2 那类白烧整轮）。
     */
    maxTokens?: number;
  };
}

/**
 * 按 ContextManager 实例存（WeakMap）：主循环与 fork 都持有同一个 ctxMgr，
 * 不需要给 ContextManager 加一块与上下文无关的状态，会话结束 ctxMgr 被回收时自动清掉。
 */
const shapes = new WeakMap<object, MainRequestShape>();

/** 主循环每次构造完 sendParams 后调用（只在 query/loop.ts 一处调用） */
export function recordMainRequestShape(
  owner: object,
  params: SendParams,
  cacheKeyIncludesThinking: boolean,
): void {
  const shape: MainRequestShape = { model: params.model, tools: params.tools };
  if (cacheKeyIncludesThinking) {
    shape.thinkingMirror = {
      ...(params.thinking && { thinking: params.thinking }),
      ...(params.reasoningEffort && { reasoningEffort: params.reasoningEffort }),
      ...(params.outputConfig && { outputConfig: params.outputConfig }),
      ...(params.thinkingIntent && { thinkingIntent: params.thinkingIntent }),
      ...(params.maxThinkingTokens !== undefined && {
        maxThinkingTokens: params.maxThinkingTokens,
      }),
      maxTokens: params.maxTokens,
    };
  }
  shapes.set(owner, shape);
}

/** 取主循环最后一次请求的形状；主循环还没发过请求时为 undefined */
export function getMainRequestShape(owner: object): MainRequestShape | undefined {
  return shapes.get(owner);
}

/** fork 发请求用的前缀（由调用方在 fork 启动时取，见 ForkedAgentContext.getSendPrefix） */
export interface ForkSendPrefix {
  /** 主循环发送视图下的消息（清理后），替代 `ForkedAgentContext.messages` 作为发送前缀 */
  messages: Message[];
  /** 主循环最后一次请求的形状 */
  shape?: MainRequestShape;
}

/** fork 实际用的请求形状 */
export interface ForkRequestShape {
  tools: ToolDefinition[];
  /** `snapshot` = 复用了主循环快照；`fallback` = 没有快照 / 模型不同 / 缺工具，退回全量 */
  prefixSource: "snapshot" | "fallback";
  /** 退回的原因（只进日志） */
  fallbackReason?: "no_snapshot" | "model_changed" | "missing_tools";
  /** 退回时缺的工具（只进日志） */
  missingTools?: string[];
  thinkingMirror?: MainRequestShape["thinkingMirror"];
}

/**
 * 决定 fork 用哪份 tools / 思考参数。
 *
 * @param fullDefinitions 退回用的全量定义（`registry.definitions()`），惰性求值
 * @param requiredTools fork 必须能调用的工具。快照里缺任何一个就退回全量 ——
 *   tool search 的阈值或延迟名单一变，`save_memory` 之类可能被延迟，fork 不能因此静默失效。
 */
export function resolveForkRequestShape(
  shape: MainRequestShape | undefined,
  model: string,
  fullDefinitions: () => ToolDefinition[],
  requiredTools: readonly string[] = [],
): ForkRequestShape {
  if (!shape) {
    return { tools: fullDefinitions(), prefixSource: "fallback", fallbackReason: "no_snapshot" };
  }
  if (shape.model !== model) {
    return { tools: fullDefinitions(), prefixSource: "fallback", fallbackReason: "model_changed" };
  }
  const tools = shape.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  let missing = requiredTools.filter((n) => !names.has(n));
  if (missing.length > 0) {
    // 只认「全量里有、快照里没有」的才算缺：工具压根没注册（被禁用 / 未接线）时退回全量也拿不到，
    // 退回只会白白放弃缓存。
    const full = new Set(fullDefinitions().map((t) => t.name));
    missing = missing.filter((n) => full.has(n));
  }
  if (missing.length > 0) {
    // 缺工具时思考参数也不照搬：tools 段已经分叉，后面的历史本来就命中不了，开思考只剩成本
    return {
      tools: fullDefinitions(),
      prefixSource: "fallback",
      fallbackReason: "missing_tools",
      missingTools: missing,
    };
  }
  return {
    tools,
    prefixSource: "snapshot",
    ...(shape.thinkingMirror && { thinkingMirror: shape.thinkingMirror }),
  };
}
