/**
 * 子代理循环的结构化事件通道（L2-A，2026-10-29）。
 *
 * 此前 `runAgentLoop` 没有任何事件出口：子代理执行期间 events.jsonl 里只有
 * Pre/PostToolUse、StreamPhase、BilledRequest，**0 条**停止原因 / F1 / F2 事实，
 * 只能 grep warn.log——而 warn.log 自 2026-10-21 起同类只首次告警。
 *
 * 取向与 `setRetryTelemetryObserver` 相同：子代理实例在 sub-agent.ts 里按调用新建，
 * 链路上拿不到主循环的 `QueryDeps.traceAppendEvent`，所以由 app.ts 在 collector 就绪后
 * 注册一个进程级 sink。`AgentLoopConfig.traceAppendEvent` 显式传入时优先（测试直接断言用）。
 */

export type LoopTraceEvent = {
  event: string;
  timestamp: string;
  data?: Record<string, unknown>;
};

export type LoopTraceSink = (event: LoopTraceEvent) => void;

let globalSink: LoopTraceSink | null = null;

export function setSubagentLoopTraceSink(fn: LoopTraceSink | null): void {
  globalSink = fn;
}

export function getSubagentLoopTraceSink(): LoopTraceSink | null {
  return globalSink;
}
