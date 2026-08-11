/**
 * 控制协议 Schema
 *
 * 控制协议是 SDK 宿主与 CLI 之间的双向 request-response 通道，
 * 与数据消息共用同一个 NDJSON 通道（单通道全序，避免跨通道时序问题）。
 *
 * 用途：
 * - initialize 握手（system_prompt / json_schema / max_turns 等）
 * - 权限请求竞速（can_use_tool ↔ Hook）
 * - 运行时控制（set_model / interrupt / get_context_usage）
 * - MCP 跨进程消息桥接（mcp_message）
 */

import { z } from "zod";
import { lazySchema } from "./lazy-schema.ts";

// ─── 控制请求类型 ───

/** 初始化请求 */
export const SDKControlInitializeSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("initialize"),
    system_prompt: z.string().optional(),
    json_schema: z.record(z.unknown()).optional(),
    max_turns: z.number().optional(),
    max_budget_usd: z.number().optional(),
  }),
);

/** 中断请求 */
export const SDKControlInterruptSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("interrupt"),
  }),
);

/** 权限请求（CLI → SDK 宿主） */
export const SDKControlPermissionRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("can_use_tool"),
    tool_name: z.string(),
    input: z.record(z.unknown()),
    tool_use_id: z.string(),
    description: z.string().optional(),
  }),
);

/** 权限响应（SDK 宿主 → CLI） */
export const SDKControlPermissionResponseSchema = lazySchema(() =>
  z.object({
    behavior: z.enum(["allow", "deny", "always_allow"]),
    tool_use_id: z.string(),
  }),
);

/** 设置模型 */
export const SDKControlSetModelSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("set_model"),
    model: z.string(),
  }),
);

/** 查询上下文用量 */
export const SDKControlGetContextUsageSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("get_context_usage"),
  }),
);

/** MCP 跨进程消息（CLI ↔ SDK 宿主） */
export const SDKControlMcpMessageSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("mcp_message"),
    server_name: z.string(),
    message: z.record(z.unknown()),
  }),
);

// ─── 控制请求包装 ───

export const SDKControlRequestInnerSchema = lazySchema(() =>
  z.union([
    SDKControlInitializeSchema(),
    SDKControlInterruptSchema(),
    SDKControlPermissionRequestSchema(),
    SDKControlSetModelSchema(),
    SDKControlGetContextUsageSchema(),
    SDKControlMcpMessageSchema(),
  ]),
);

export const SDKControlRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal("control_request"),
    request_id: z.string(),
    request: SDKControlRequestInnerSchema(),
  }),
);

// ─── 控制响应包装 ───

export const SDKControlResponseSuccessSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("success"),
    request_id: z.string(),
    response: z.unknown().optional(),
  }),
);

export const SDKControlResponseErrorSchema = lazySchema(() =>
  z.object({
    subtype: z.literal("error"),
    request_id: z.string(),
    error: z.string(),
  }),
);

export const SDKControlResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal("control_response"),
    response: z.union([
      SDKControlResponseSuccessSchema(),
      SDKControlResponseErrorSchema(),
    ]),
  }),
);
