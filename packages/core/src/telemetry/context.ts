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
 * 维护「当前活跃 span」的有序集合，栈顶作为新 span 的默认 parent。
 *
 * ⚠️ 结束时**按 id 移除**（removeSpan），不是弹栈顶（缺陷 2，20260927 可观测性审计）。
 * 「单进程 CLI」只说明不需要跨进程传播，**不**说明没有并发：swarm team 用
 * `Promise.all(members.map(runMember))` 并行跑成员，各自 start/stop 一个 invoke_agent。
 * 曾经 end() 无条件 popSpan()：A、B 并发时 A 先结束弹掉的是 B 的 id，此后 parent 全部张冠李戴。
 * 并发的那一类 span（子代理）另由 bus.startSpan 的 `detached` 选项处理：显式指定 parent、
 * 不进栈，所以它们既不会被别人当 parent，也不会被别人弹掉。
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

  /** 弹出栈顶 Span。仅供串行嵌套场景；SpanHandle.end() 走 removeSpan，见类注释 */
  popSpan(): string | undefined {
    return this.spanStack.pop();
  }

  /** 按 id 移除（结束的不一定是栈顶）。返回是否找到 */
  removeSpan(spanId: string): boolean {
    const i = this.spanStack.lastIndexOf(spanId);
    if (i < 0) return false;
    this.spanStack.splice(i, 1);
    return true;
  }

  /** 当前嵌套深度 */
  get depth(): number {
    return this.spanStack.length;
  }
}
