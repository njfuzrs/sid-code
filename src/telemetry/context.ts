/**
 * Trace 上下文传播
 * 生成 W3C 标准的 TraceId/SpanId，管理 Span 父子关系
 */

import { randomBytes } from "crypto";

/** 生成 32 字符十六进制 Trace ID（W3C 标准） */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 生成 16 字符十六进制 Span ID（W3C 标准） */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Trace 上下文——在整个请求生命周期中传递
 *
 * sid-code 是单进程 CLI，不需要跨进程传播
 * 使用简单的栈结构管理 Span 父子关系
 * 每次 AgentLoopRunner.run() 创建一个新的 TraceContext
 */
export class TraceContext {
  readonly traceId: string;
  private spanStack: string[] = [];

  constructor(traceId?: string) {
    this.traceId = traceId ?? generateTraceId();
  }

  /** 获取当前活跃 Span 的 ID（栈顶），作为新 Span 的 parentSpanId */
  get currentSpanId(): string | undefined {
    return this.spanStack.at(-1);
  }

  /** 压入新 Span（开始一个子操作） */
  pushSpan(spanId: string): void {
    this.spanStack.push(spanId);
  }

  /** 弹出 Span（结束当前操作） */
  popSpan(): string | undefined {
    return this.spanStack.pop();
  }

  /** 当前嵌套深度 */
  get depth(): number {
    return this.spanStack.length;
  }
}
