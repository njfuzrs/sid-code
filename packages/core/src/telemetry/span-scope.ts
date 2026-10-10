/**
 * span 父子关系的异步作用域（缺陷 2，20260927 可观测性审计）
 *
 * TraceContext 的 spanStack 是进程级单栈，只对串行嵌套成立。子代理可以并发
 * （swarm team 用 `Promise.all(members.map(runMember))`），共享栈会让并发成员互为父子、
 * 先结束的弹掉别人的 id。正解是 AsyncLocalStorage：每条异步执行链各自知道
 * 「我在哪个子代理里」，与进程数无关。
 *
 * 这里只存**子代理身份**（agentId），不存 span：span 由 TelemetryHookProbe 按 agentId 管理。
 * 这样本模块零依赖，`agent/sub-agent.ts` 包一层即可，不需要知道遥测是否启用。
 *
 * 曾有一版 ALS 实现（als-context.ts）于 2026-08-08 以「能力已被 spanStack 取代」为由删除——
 * 那个结论是错的：spanStack 不覆盖并发。别再以同样理由删这个文件，
 * 门禁见 tests/telemetry/observability-p0-regression.test.ts。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scopeStorage = new AsyncLocalStorage<string>();

/** 在「子代理 agentId」作用域里运行 fn；其中 fire 的 hook 事件产生的 span 挂到该子代理下 */
export function runInSpanScope<T>(agentId: string, fn: () => T): T {
  return scopeStorage.run(agentId, fn);
}

/** 当前所在子代理的 agentId；主循环返回 undefined */
export function currentSpanScope(): string | undefined {
  return scopeStorage.getStore();
}
