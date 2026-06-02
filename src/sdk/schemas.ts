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

import { z } from "zod";
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

/** 内容块：对齐 src/llm/types.ts 的 ContentBlock（text / tool_use / tool_result） */
export const ContentBlockSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
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
    subtype: z.enum([
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
    ]),
    errors: z.array(z.string()),
    duration_ms: z.number(),
    num_turns: z.number(),
    total_cost_usd: z.number(),
    usage: UsageSchema(),
    session_id: z.string(),
  }),
);

/** 结果消息（成功或错误） */
export const SDKResultMessageSchema = lazySchema(() =>
  z.discriminatedUnion("subtype", [
    SDKResultSuccessSchema(),
    SDKResultErrorSchema(),
  ]),
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
