/**
 * API 服务层 — 统一导出
 *
 * 分层职责（对标 Claude Code 的 API 服务架构）：
 *   errors / error-utils  → 错误分类 + 用户消息 + SSL 诊断
 *   stream-handler        → 流式→非流式降级
 *   cache-strategy        → Prompt Cache breakpoint 放置
 *   cache-detection       → Cache 失效检测与归因
 *   cost-tracker          → 按模型成本累加 + USD 计算
 *   rate-limit            → 从 HTTP headers 提取真实速率限制
 *   api-log               → 结构化 API 调用日志
 */

// 错误处理
export * from "./error-utils.ts";
export * from "./errors.ts";

// 流式处理
export * from "./stream-handler.ts";

// Prompt Cache
export * from "./cache-strategy.ts";
export * from "./cache-detection.ts";

// 可观测性
export * from "./cost-tracker.ts";
export * from "./rate-limit.ts";
export * from "./api-log.ts";
