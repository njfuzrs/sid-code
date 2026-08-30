/**
 * SDK 消息 Schema（真理源）
 *
 * 所有 SDK 类型从这里的 Zod Schema 推导，同时提供：
 * - 编译期类型安全（src/sdk/types.ts 通过 z.infer 推导）
 * - 运行时校验（StructuredIO 解析输入时 safeParse）
 *
 * 对齐 Claude Code 的 SDKMessage 协议，按 sid-code 实际需求裁剪。
 * 内部 QueryEngineEvent → SDKMessage 的映射见 message-converter.ts。
 */

import { z } from "zod/v3";
import { lazySchema } from "./lazy-schema.ts";

// ─── 基础类型 ───

export const UsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
  }),
);

/**
 * 内容块：对齐 src/llm/types.ts 的 ContentBlock
 * （text / tool_use / tool_result / thinking / redacted_thinking）
 *
 * ⚠️ 这里必须与 `ContentBlock` 的成员保持一致。少一个成员就是静默丢块：
 * `assistant_message` 事件透传的是内核 `response.content`（`query/loop.ts:2852`），
 * 思考块原样在内；schema 漏掉 thinking 会让 SDK 消费方 safeParse 直接判非法消息。
 * thinking 的 `signature` 在多轮回传中缺失/被改会导致 Anthropic 400，所以一并保留。
 */
export const ContentBlockSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("thinking"),
      thinking: z.string(),
      signature: z.string().optional(),
      durationMs: z.number().optional(),
    }),
    z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
    z.object({
      type: z.literal("tool_use"),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    }),
    z.object({
      type: z.literal("tool_result"),
      tool_use_id: z.string(),
      content: z.string(),
      is_error: z.boolean().optional(),
    }),
  ]),
);

/** 消息：对齐 src/llm/types.ts 的 Message（_meta 透传不校验） */
export const MessageSchema = lazySchema(() =>
  z.object({
    role: z.enum(["user", "assistant"]),
    content: z.array(ContentBlockSchema()),
    _meta: z.record(z.unknown()).optional(),
  }),
);

// ─── SDK 数据消息 ───

/** 用户消息 */
export const SDKUserMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal("user"),
    uuid: z.string(),
    session_id: z.string(),
    message: MessageSchema(),
    timestamp: z.string().optional(),
  }),
);

/** 助手消息 */
export const SDKAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal("assistant"),
    uuid: z.string(),
    session_id: z.string(),
    message: MessageSchema(),
    stop_reason: z.string().nullable(),
    usage: UsageSchema(),
  }),
);

/** 流式增量消息 */
export const SDKStreamEventSchema = lazySchema(() =>
  z.object({
    type: z.literal("stream_event"),
    event: z.unknown(), // StreamEvent 原始事件
  }),
);

/** 成功结果 */
export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.boolean(),
    num_turns: z.number(),
    result: z.string(),
    stop_reason: z.string().nullable(),
    /**
     * §20.5（2026-08-30）：轮数预算里有几格**没换来一次模型交互**（被超时/watchdog
     * 杀在零产出上）。语义与 `SDKResultErrorSchema` 的同名字段逐字一致，见那里的长注释。
     *
     * ## 为什么 success 也需要它
     *
     * 此前它**只在错误结果上存在**，success 结果压根没这个键。于是
     * 「正常收尾（end_turn）+ 预算被偷」这个组合在 `result.json` 里完全不可见 ——
     * 评测侧的排除规则想问「这题被打废是不是非能力原因」，在 success 路径上永远问不出来。
     *
     * ⚠️ 它**不是**用来把 success 移出分母的：实测唯一带 watchdog 的 success 样本
     * 剩 31 轮预算未用，那是一次真实的能力失败。这个字段只负责让「被偷了几格」
     * 这个事实可见，判读仍然要看「那个约束是不是真的绑住了」。
     *
     * `.default(0)` 同错误结果那侧：老轨迹缺这个键时解析成 0，而不是整条解析失败。
     */
    num_turns_without_model_interaction: z.number().default(0),
    total_cost_usd: z.number(),
    usage: UsageSchema(),
    session_id: z.string(),
    structured_output: z.unknown().optional(),
  }),
);

/** 错误结果 */
export const SDKResultErrorSchema = lazySchema(() =>
  z.object({
    type: z.literal("result"),
    subtype: z.enum(["error_during_execution", "error_max_turns", "error_max_budget_usd"]),
    errors: z.array(z.string()),
    duration_ms: z.number(),
    num_turns: z.number(),
    /**
     * `subtype: "error_max_turns"` 时：`--max-turns` 那些格预算里，有几格**没换来一次
     * 模型交互**（被超时 / watchdog 杀在零产出上）。其余 subtype 下为 0。
     *
     * ## 为什么它必须出现在 result 事件里，而不只是 stderr 上的一行字
     *
     * `num_turns` 只在 `assistant_message` 上自增，而 `maxTurns` 预算在**发请求之前**
     * 就被扣掉了。于是一个零产出的轮次在 `num_turns` 里完全隐身 ——
     * 外部消费者（Harbor / 评测脚本）看到的是 `num_turns: 34` + `error_max_turns`，
     * 两个数字自相矛盾，而**没有任何字段能解释那 6 格去哪了**。
     *
     * 实测（Harbor A11，2026-08-29）：7 个 error_max_turns 样本全部满足
     * `num_turns + 本字段 = maxTurns + 1`。有了它，消费侧才能把
     * 「上限不够用」与「上游掉流偷走预算」分开 —— 两者修法完全相反。
     *
     * ⚠️ **`.default(0)` 不是随手加的**：没有它，这个字段就是**必填**，
     * 于是**修复前产出的、以及任何旧版本产出的 result 事件全部解析失败** ——
     * 一个「让成本/轮数更可观测」的改动会变成「旧轨迹读不进来」的 breaking change。
     * （本仓自检第 2 问的同型：新增字段时先问"没有它的那些数据怎么办"。）
     *
     * `.default(0)` 让输入可省、输出恒为 number：老数据解析成 0（= 没被偷，
     * 与它的真实语义一致），消费侧不必到处判 undefined。
     */
    num_turns_without_model_interaction: z.number().default(0),
    total_cost_usd: z.number(),
    usage: UsageSchema(),
    session_id: z.string(),
  }),
);

/** 结果消息（成功或错误） */
export const SDKResultMessageSchema = lazySchema(() =>
  z.discriminatedUnion("subtype", [SDKResultSuccessSchema(), SDKResultErrorSchema()]),
);

// ─── 系统消息 ───

/** 会话初始化 */
export const SDKSystemInitSchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string(),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
      }),
    ),
    model: z.string(),
    cwd: z.string(),
  }),
);

/** 上下文压缩边界 */
export const SDKCompactBoundarySchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("compact_boundary"),
    summary: z.string().optional(),
  }),
);

/** API 重试通知 */
export const SDKAPIRetrySchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("api_retry"),
    error: z.string(),
    attempt: z.number(),
    delay_ms: z.number(),
  }),
);

/** 状态变更 */
export const SDKStatusSchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("status"),
    message: z.string(),
    // 静默-7：透传严重级别（info/warning/error），此前 converter 丢弃 level，
    // SDK 消费者无法区分"预算耗尽的 error"和"普通进度 info"。可选以保持向后兼容。
    level: z.enum(["info", "warning", "error"]).optional(),
  }),
);

// ─── 工具进度消息 ───

/** 工具执行进度 */
export const SDKToolProgressSchema = lazySchema(() =>
  z.object({
    type: z.literal("tool_progress"),
    tool_name: z.string(),
    status: z.enum(["start", "end"]),
    tool_use_id: z.string().optional(),
    input: z.unknown().optional(),
    result: z
      .object({
        is_error: z.boolean().optional(),
        elapsed_ms: z.number().optional(),
      })
      .optional(),
  }),
);

// ─── Hook 生命周期消息 ───

export const SDKHookStartedSchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("hook_started"),
    hook_event: z.string(),
    hook_name: z.string(),
  }),
);

export const SDKHookResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal("system"),
    subtype: z.literal("hook_response"),
    hook_event: z.string(),
    decision: z.string().optional(),
  }),
);

// ─── 聚合 Schema ───

/** 所有 SDK 消息类型的联合 */
export const SDKMessageSchema = lazySchema(() =>
  z.union([
    SDKUserMessageSchema(),
    SDKAssistantMessageSchema(),
    SDKStreamEventSchema(),
    SDKResultSuccessSchema(),
    SDKResultErrorSchema(),
    SDKSystemInitSchema(),
    SDKCompactBoundarySchema(),
    SDKAPIRetrySchema(),
    SDKStatusSchema(),
    SDKToolProgressSchema(),
    SDKHookStartedSchema(),
    SDKHookResponseSchema(),
  ]),
);
