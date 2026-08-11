/**
 * sid-code SDK — 公共 API 入口
 *
 * 将 sid-code 从"交互式 CLI"升级为"可编程的 Agent 运行时"。
 * 外部调用者（Python SDK / IDE 插件 / CI 脚本）通过子进程 spawn + NDJSON
 * 协议与 sid-code 通信。
 *
 * 三层架构：
 * - 类型定义层：schemas / control-schemas / types（Schema-First）
 * - 会话引擎层：SDKQueryEngine / runHeadless（无头编排）
 * - 传输协议层：StructuredIO / NDJSON（双向流式通信）
 */

// ─── 类型定义层 ───
export * from "./types.ts";
export { lazySchema } from "./lazy-schema.ts";
export * as schemas from "./schemas.ts";
export * as controlSchemas from "./control-schemas.ts";
export { SDKMessageSchema } from "./schemas.ts";
export { SDKControlRequestSchema, SDKControlResponseSchema } from "./control-schemas.ts";

// ─── 传输协议层 ───
export { ndjsonStringify, ndjsonParse, ndjsonLines } from "./ndjson.ts";
export { StructuredIO } from "./structured-io.ts";

// ─── 会话引擎层 ───
export { convertToSDKMessage } from "./message-converter.ts";
export type { ConvertContext } from "./message-converter.ts";
export { CommandQueue } from "./command-queue.ts";
export type { QueuedCommand } from "./command-queue.ts";
export { SDKQueryEngine } from "./query-engine.ts";
export type { SDKQueryEngineConfig, SDKQueryEngineDriver } from "./query-engine.ts";

// ─── 控制协议 / 桥接 / 恢复 ───
export { createSDKCanUseTool } from "./permission-bridge.ts";
export type { PermissionBridgeOptions } from "./permission-bridge.ts";
export {
  SdkControlClientTransport,
  SdkControlServerTransport,
  createLinkedTransportPair,
} from "./mcp-bridge.ts";
export { deserializeMessagesWithInterruptDetection } from "./session-recovery.ts";
export type { TurnInterruptionState, DeserializeResult } from "./session-recovery.ts";
export {
  extractStructuredOutput,
  buildStructuredOutputPrompt,
} from "./structured-output.ts";
export type { StructuredOutputConfig } from "./structured-output.ts";
export { runHeadless, runHeadlessStreaming } from "./headless-runner.ts";
export {
  classifyHeadlessStreamText,
  formatHeadlessEvent,
  RETRY_TEXT_PREFIX,
} from "./headless-event-format.ts";
export type { HeadlessEventOutput } from "./headless-event-format.ts";
