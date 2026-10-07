/**
 * 「事件只带 model、不带 provider」时的 provider 归因 —— 唯一实现。
 *
 * 缺陷 37（20260927 可观测性审计）：`digest.aggregateProviderStats` 与
 * `provider-health.aggregateProviderHealth` 各自内部有两套规则，共四份实现：
 * - StreamPhase(first_content) 用「真值映射 → 非 claude 即 openai」；
 * - TimeoutFired 另起一套「只认 deepseek / claude，其余 unknown」。
 * 后者让 `glm` / `qwen` / `kimi` 的超时落进**从不记分母**的 `unknown` 桶
 *（`requests` 只在 AfterModelRaw 分支累加），`successRate` 兜底为 1 ⇒ 超时告警
 * 结构上不可能触发；同时真 provider 桶少记 timedOut ⇒ 成功率虚高。
 *
 * 收口成一个函数，两个入口共用 —— 形态与 `TtftCacheBucketer` / `aggregateLatencyByModel`
 * 同理：同构靠两份代码各自正确，加规则时漏改一处就是「同一份 events.jsonl 两个入口两个结论」。
 *
 * ⚠️ 新增「只带 model」的事件分支时，一律用这里返回的 resolver，不要再内联 `includes()` 启发式
 *（`tests/trace/provider-resolver.test.ts` 有一条结构断言拦这个）。
 */

/** 只看 model 名的兜底启发式：真值映射查不到时才用 */
export function inferProviderFromModel(model: string): string {
  if (!model) return "unknown";
  return /claude/i.test(model) ? "anthropic" : "openai";
}

interface EventLike {
  event?: string;
  data?: Record<string, unknown> | null;
}

/**
 * 从 AfterModelRaw 建 model→provider 真值映射（首次出现为准），返回 resolver：
 * 先查映射，查不到再走 {@link inferProviderFromModel}。
 */
export function createProviderResolver(events: readonly EventLike[]): (model: string) => string {
  const modelToProvider = new Map<string, string>();
  for (const e of events) {
    if (e.event === "AfterModelRaw" && e.data) {
      const provider = (e.data.provider as string) || "";
      const model = (e.data.model as string) || "";
      if (provider && model && !modelToProvider.has(model)) modelToProvider.set(model, provider);
    }
  }
  return (model: string) => modelToProvider.get(model) || inferProviderFromModel(model);
}
