// src/telemetry/als-context.ts
// 基于 AsyncLocalStorage 的 Span 上下文自动传播
//
// 对应 spec 17 §6.1.1。
// 交互级 / 工具级两层上下文,函数内部创建的 Span 自动继承父级。

import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  traceId: string;
  spanId: string;
  /** 操作类型(对齐 SpanKind 或扩展类型) */
  kind: string;
  /** 显示名 */
  name: string;
  startTime: number;
  ended: boolean;
  parentSpanId?: string;
}

/** 交互级上下文(一次用户输入 → LLM 响应的完整循环) */
const interactionContext = new AsyncLocalStorage<SpanContext | undefined>();

/** 工具级上下文(一次工具执行) */
const toolContext = new AsyncLocalStorage<SpanContext | undefined>();

/** 在交互上下文中执行函数 */
export function runInInteractionContext<T>(ctx: SpanContext, fn: () => T): T {
  return interactionContext.run(ctx, fn);
}

/** 在工具上下文中执行函数 */
export function runInToolContext<T>(ctx: SpanContext, fn: () => T): T {
  return toolContext.run(ctx, fn);
}

/** 获取当前交互上下文 */
export function getCurrentInteractionContext(): SpanContext | undefined {
  return interactionContext.getStore();
}

/** 获取当前工具上下文 */
export function getCurrentToolContext(): SpanContext | undefined {
  return toolContext.getStore();
}

/**
 * 获取当前最近的 Span 上下文(工具级优先于交互级)。
 * 用于新 Span 自动确定 parentSpanId。
 */
export function getCurrentSpanContext(): SpanContext | undefined {
  return getCurrentToolContext() ?? getCurrentInteractionContext();
}
