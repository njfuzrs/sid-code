// src/telemetry/span-manager.ts
// Span 生命周期管理——WeakRef + TTL 清理
//
// 对应 spec 17 §6.1.2。
// 活跃 Span 用 WeakRef 防内存泄漏;非 ALS 管理的 Span(LLM request、blocked-on-user)
// 需要强引用。30 分钟 TTL 清理孤儿 Span,1 分钟检查一次。

import type { SpanContext } from "./als-context.ts";

const SPAN_TTL_MS = 30 * 60 * 1000; // 30 分钟
const CLEANUP_INTERVAL_MS = 60_000; // 1 分钟检查一次

/** 活跃 Span 使用 WeakRef 防止内存泄漏 */
const activeSpans = new Map<string, WeakRef<SpanContext>>();

/** 非 ALS 管理的 Span 需要强引用(如 LLM request、blocked-on-user) */
const strongSpans = new Map<string, SpanContext>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 注册一个活跃 Span */
export function registerSpan(spanId: string, ctx: SpanContext, strong = false): void {
  if (strong) {
    strongSpans.set(spanId, ctx);
  }
  activeSpans.set(spanId, new WeakRef(ctx));
  ensureCleanupInterval();
}

/** 结束并注销一个 Span */
export function unregisterSpan(spanId: string): void {
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

/** 查询活跃 Span(强引用优先) */
export function getActiveSpan(spanId: string): SpanContext | undefined {
  const strong = strongSpans.get(spanId);
  if (strong) return strong;
  return activeSpans.get(spanId)?.deref();
}

/** 按 kind + name 查找一个活跃 Span(用于 blocked_on_user 等配对结束) */
export function findActiveSpan(kind: string, name: string): SpanContext | undefined {
  for (const ctx of strongSpans.values()) {
    if (ctx.kind === kind && ctx.name === name && !ctx.ended) return ctx;
  }
  for (const ref of activeSpans.values()) {
    const ctx = ref.deref();
    if (ctx && ctx.kind === kind && ctx.name === name && !ctx.ended) return ctx;
  }
  return undefined;
}

/** 活跃 Span 数量(测试用) */
export function getActiveSpanCount(): number {
  return activeSpans.size;
}

/**
 * 立即执行一次孤儿 Span 清理(测试可注入自定义 now)。
 * 返回被回收的 spanId 列表。
 */
export function sweepOrphanSpans(now: number = Date.now()): string[] {
  const cutoff = now - SPAN_TTL_MS;
  const reaped: string[] = [];

  for (const [spanId, weakRef] of activeSpans) {
    const ctx = weakRef.deref();
    if (ctx === undefined) {
      // WeakRef 已失效,GC 已回收
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
      reaped.push(spanId);
    } else if (ctx.startTime < cutoff && !ctx.ended) {
      // 超时强制结束——防止孤儿 Span 泄漏
      ctx.ended = true;
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
      reaped.push(spanId);
    }
  }
  return reaped;
}

/** 启动清理定时器——回收孤儿 Span */
function ensureCleanupInterval(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => sweepOrphanSpans(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.(); // 不阻止进程退出
}

/** 停止清理定时器并清空状态(测试 / 关闭用) */
export function shutdownSpanManager(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  activeSpans.clear();
  strongSpans.clear();
}
