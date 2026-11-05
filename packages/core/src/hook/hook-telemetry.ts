/**
 * Hook 执行埋点的单一事实源（观测缺口 G1 / 方案 T1）
 *
 * ## 为什么需要这个模块
 *
 * `HookRunner.executeHook` 是所有 hook 执行路径的唯一咽喉（并行 / 串行 / SessionEnd 预算串行 /
 * streaming 四条路径都经过它），执行结果 `HookExecutionResult` 带着 exitCode / duration / success，
 * 但此前只有一个 UI 用的 `HookLifecycleListener` 出口，且它的 end 事件**不带结果**。
 * 后果：轨迹里 grep 不到任何一次 hook 执行，「hook 拦了多少次、慢 hook 拖了多少时间」没有分母。
 *
 * 收口方式与 `skill/telemetry.ts` / `trace/jit-telemetry.ts` 同款（模块级 sink）：
 *   - 生产点在 core 的 HookRunner 里，拿不到 TraceCollector；
 *   - App 在 collector 就绪后调一次 `setHookTraceSink`，事件落进同一个 events.jsonl；
 *   - sink 未注入（测试、轨迹关闭）时 emit 是空操作，埋点绝不影响主流程。
 *
 * 本模块**零 import**：被 hook 子系统最底层的 runner / async-registry 依赖，任何 import 都会
 * 扩大这两个模块的依赖面（并可能在 collector ↔ hook 之间形成环）。
 *
 * ## 隐私（硬性，见方案 §二）
 *
 * events.jsonl 会被 `trace/uploader.ts` 上传到企业后端，所以这里**只允许**传脱敏后的字段：
 * `hook_id` 由 runner 算好（`name`，没有 name 时 `cmd:<sha256 前 12 位>` / `url:<host>`），
 * 不允许把 command 原文、stdout、stderr 塞进事件。
 */

/** hook 执行完成事件名 —— 生产侧与消费侧（digest / 门禁测试）共用，避免字面量漂移 */
export const HOOK_EXECUTED_EVENT_NAME = "HookExecuted";

/** 异步 hook 后台完成事件名 */
export const HOOK_ASYNC_COMPLETED_EVENT_NAME = "HookAsyncCompleted";

/** 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type HookTraceSink = (event: string, data: Record<string, unknown>) => void;

let sink: HookTraceSink | null = null;

/** 注入/清除埋点通道。传 `null` 表示关闭。 */
export function setHookTraceSink(s: HookTraceSink | null): void {
  sink = s;
}

/**
 * 写一条 hook 事件。sink 未注入或写入抛错都静默 —— 埋点绝不影响 hook 结论。
 * `event` 只接受本模块导出的两个常量（调用方直接传，不做字符串拼接）。
 */
export function emitHookTrace(event: string, data: Record<string, unknown>): void {
  try {
    sink?.(event, data);
  } catch {
    /* 埋点失败静默 */
  }
}

/**
 * HookConfig → 配置来源（user / project / plugin / skill / policy …）。
 *
 * 为什么用 WeakMap 而不是给 `HookConfig` 加字段：config 是**用户配置对象的引用**，
 * 往上挂内部元数据会污染它（/hooks 面板、序列化、深比较都会看到），而 `source` 的权威
 * 来源是 `HookRegistryEntry.source`（registry.ts），runner 只拿到 config、拿不到 entry。
 * 由 planner 在建执行计划时按 entries 下标对齐写一次，runner 埋点时查。
 *
 * WeakMap 的键是对象，config 随计划落盘后自然被 GC，不会泄漏。
 */
const configSources = new WeakMap<object, string>();

/** 登记一条 config 的来源。由 planner 在 createExecutionPlan 里调用。 */
export function setHookConfigSource(config: object, source: string): void {
  configSources.set(config, source);
}

/** 查询 config 的来源。未登记（例如单测直接调 runner）返回 undefined。 */
export function getHookConfigSource(config: object): string | undefined {
  return configSources.get(config);
}
