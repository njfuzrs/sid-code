/**
 * SDK 类型 — 从 Zod Schema 推导
 *
 * 不手写类型，全部用 z.infer 从 schemas.ts / control-schemas.ts 推导，
 * 避免 TypeScript 类型与运行时 Schema 漂移（Schema-First，spec §7.4）。
 */

import type { z } from "zod";
import type * as schemas from "./schemas.ts";
import type * as controlSchemas from "./control-schemas.ts";

// ─── 基础类型 ───
export type SDKUsage = z.infer<ReturnType<typeof schemas.UsageSchema>>;
export type SDKContentBlock = z.infer<ReturnType<typeof schemas.ContentBlockSchema>>;
export type SDKMessageBody = z.infer<ReturnType<typeof schemas.MessageSchema>>;

// ─── 数据消息类型 ───
export type SDKUserMessage = z.infer<ReturnType<typeof schemas.SDKUserMessageSchema>>;
export type SDKAssistantMessage = z.infer<ReturnType<typeof schemas.SDKAssistantMessageSchema>>;
export type SDKStreamEvent = z.infer<ReturnType<typeof schemas.SDKStreamEventSchema>>;
export type SDKResultSuccess = z.infer<ReturnType<typeof schemas.SDKResultSuccessSchema>>;
export type SDKResultError = z.infer<ReturnType<typeof schemas.SDKResultErrorSchema>>;
export type SDKResultMessage = SDKResultSuccess | SDKResultError;

// ─── 系统消息类型 ───
export type SDKSystemInit = z.infer<ReturnType<typeof schemas.SDKSystemInitSchema>>;
export type SDKCompactBoundary = z.infer<ReturnType<typeof schemas.SDKCompactBoundarySchema>>;
export type SDKAPIRetry = z.infer<ReturnType<typeof schemas.SDKAPIRetrySchema>>;
export type SDKStatus = z.infer<ReturnType<typeof schemas.SDKStatusSchema>>;
export type SDKToolProgress = z.infer<ReturnType<typeof schemas.SDKToolProgressSchema>>;
export type SDKHookStarted = z.infer<ReturnType<typeof schemas.SDKHookStartedSchema>>;
export type SDKHookResponse = z.infer<ReturnType<typeof schemas.SDKHookResponseSchema>>;

/** 所有 SDK 消息类型的联合 */
export type SDKMessage = z.infer<ReturnType<typeof schemas.SDKMessageSchema>>;

// ─── 控制协议类型 ───
export type SDKControlRequest = z.infer<ReturnType<typeof controlSchemas.SDKControlRequestSchema>>;
export type SDKControlRequestInner = z.infer<
  ReturnType<typeof controlSchemas.SDKControlRequestInnerSchema>
>;
export type SDKControlResponse = z.infer<
  ReturnType<typeof controlSchemas.SDKControlResponseSchema>
>;
export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof controlSchemas.SDKControlPermissionRequestSchema>
>;
export type SDKControlPermissionResponse = z.infer<
  ReturnType<typeof controlSchemas.SDKControlPermissionResponseSchema>
>;
export type SDKControlInitialize = z.infer<
  ReturnType<typeof controlSchemas.SDKControlInitializeSchema>
>;

// ─── 传输层消息（stdin/stdout 上的所有消息） ───

/** 来自 stdin 的消息：用户消息 / 控制响应 / 心跳 */
export type StdinMessage = SDKUserMessage | SDKControlResponse | { type: "keep_alive" };

/** 写往 stdout 的消息：SDK 数据/系统消息 / 控制请求 */
export type StdoutMessage = SDKMessage | SDKControlRequest;
