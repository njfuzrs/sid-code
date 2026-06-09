/**
 * API 服务层 — 统一导出
 *
 * 分层职责（对标 Claude Code 的 API 服务架构）：
 *   errors / error-utils  → 错误分类 + 用户消息 + SSL 诊断
 *   retry-engine          → @deprecated 已迁移至 llm/fallback.ts（保留兼容层）
 *   stream-watchdog       → 流式停滞检测 + 性能指标
 *   stream-handler        → 流式→非流式降级
 *   cache-strategy        → Prompt Cache breakpoint 放置
 *   cache-detection       → Cache 失效检测与归因
 *   cost-tracker          → 按模型成本累加 + USD 计算
 *   rate-limit            → 从 HTTP headers 提取真实速率限制
 *   api-log               → 结构化 API 调用日志
 *   message-normalizer    → 发送前消息规范化（tool_use 配对修复等）
 */

// 错误处理
export * from "./error-utils.ts";
export * from "./errors.ts";

// 重试引擎（@deprecated 请使用 llm/fallback.ts ModelFallback）
export * from "./retry-engine.ts";

// 流式处理
export * from "./stream-watchdog.ts";
export * from "./stream-handler.ts";

// Prompt Cache
export * from "./cache-strategy.ts";
export * from "./cache-detection.ts";

// 可观测性
export * from "./cost-tracker.ts";
export * from "./rate-limit.ts";
export * from "./api-log.ts";

// 消息规范化
export * from "./message-normalizer.ts";
