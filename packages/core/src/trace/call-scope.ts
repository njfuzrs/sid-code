/**
 * 一条模型调用事件来自哪类调用：主循环 / 子代理 / 后台辅助。
 *
 * **判据只有这一份**。digest、latency-by-model、collector、/perf 全部复用它，
 * 不许在别处再写一遍 `index < 900_000` 或 `agent_id` 判断 —— 那正是 /perf 的 TTFT P95
 * 虚高 90% 的成因：三处聚合各自只判 phase / type，后台 fork 与子代理的样本混进了主口径。
 *
 * 为什么子代理不进主口径：**不是**「用户不在等它」（前台子代理用户同样在等），
 * 而是两者不可比 —— 子代理上下文更短、thinking 场景少，混进同一组分位数没有语义。
 * 子代理与后台调用各自单列，见 `aggregateSessionMetrics` 的 `subagent_*` / `side_*`。
 *
 * 事件形态（2026-11-12 对 11-01 之后全部会话扫描所得，组合表见 PR 正文）：
 *
 * | 来源 | StreamPhase | RetryTelemetry(stream_completed) | PostToolUse |
 * | --- | --- | --- | --- |
 * | 主循环 | 无 caller / 无 agent_id，index 为轮次号 | 无 caller，带 pair_index | 无 agent_id |
 * | 子代理 | caller=agent:builtin/custom/summary，agent_id=子代理 id，index 10000+/20000+ | 同 caller，**无 agent_id**，turnIndex 10000+/20000+ | 带 agent_id |
 * | fork | caller=agent:fork，agent_id=fork:*，index 900000+ | caller=agent:fork，turnIndex 900000+ | （不发） |
 * | 其他辅助（compact / goal_eval 等） | caller=任务名，index 900000+ | 同左 | （不发） |
 *
 * ⚠️ 子代理的 `stream_completed` 落盘时**不带 agent_id**（collector `streamAttributionFields`
 * 只补 `agent_turn`），只能靠 caller 判。不要为此改落盘格式：改了老轨迹也没有。
 */

/**
 * 非主循环路径的 observer index 号段基址。
 *
 * 取 `900_000` 是为了与既有约定**全部**错开：主循环用轮次号（个位到百位），
 * 子代理用 `10000 + turns` 与 `20000 + turns`，`agent/stream-processor.ts` 用 `-1`。
 * 留出的空档远大于任何真实会话的轮数，所以"号段相撞"这件事不需要靠人记着避开。
 *
 * 定义放在这里（trace 叶子模块）而不是 `llm/resilient-stream.ts`：后者 import 了
 * `trace/stream-observer.ts`，trace 反过来 import 它会让判据模块背上整条 llm 依赖链。
 * 分配侧（`nextSideObserverIndex`）从这里 import，号段仍然只有一个字面量。
 */
export const SIDE_OBSERVER_INDEX_BASE = 900_000;

export type CallScope = "main" | "subagent" | "side";

/**
 * 判定事件 data 的调用来源。适用于 `StreamPhase`、`RetryTelemetry`、`PostToolUse`、`BeforeModel`。
 *
 * 顺序有讲究：fork 既带 agent_id 又带 caller，又在 900_000+ 段，必须先判 side，
 * 否则会因为带 agent_id 落进 subagent。
 */
export function callScopeOf(data: Record<string, unknown> | undefined): CallScope {
  if (!data) return "main";
  const idx = typeof data.index === "number" ? data.index : data.turnIndex;
  if (typeof idx === "number" && idx >= SIDE_OBSERVER_INDEX_BASE) return "side";
  if (data.caller === "agent:fork") return "side";
  const agentId = data.agent_id ?? data.agentId;
  if (typeof agentId === "string" && agentId.startsWith("fork:")) return "side";
  // 主循环事件从不带 caller（扫描 30200 条主循环 stream_completed 全无），
  // 所以「有 caller 但不在副段」只可能是子代理。
  if (agentId || data.caller !== undefined) return "subagent";
  return "main";
}

/**
 * 被中断或超时结束的流：它的 `elapsedMs` 不是「把这次回答生成完」的耗时，
 * 进生成耗时分位数 / tok/s 分母会把分布往短端拉（被 ESC 打断的那条 2.6s）。
 *
 * `aborted` 由 `stream-lifecycle.ts` 在源未正常耗尽且非超时时落（消费方放弃：用户 ESC / fork 墙钟
 * abort / 源报错后弃流）；老轨迹没有这个字段，照旧计入。
 */
export function isTruncatedStream(data: Record<string, unknown> | undefined): boolean {
  return data?.aborted === true || data?.timedOut === true;
}
