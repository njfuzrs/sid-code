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

/**
 * 只看 model 名的兜底启发式：事件自带 provider 与真值映射都查不到时才用。
 *
 * D6：委托给全仓唯一实现 `llm/provider-infer.ts`（真名锚定 `^claude`）。原先这里是
 * 不锚定的 `/claude/i`，与计费侧 `/^claude/i` 对 `my-claude-clone-v2` 这类第三方模型
 * 给出相反归因 —— 账本说 openai、健康面板说 anthropic，两个仪器互相矛盾。
 */
export function inferProviderFromModel(model: string): string {
  return inferProviderByModelName(model);
}

import { inferProviderByModelName } from "../llm/provider-infer.ts";

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

/**
 * 解析单个事件的 provider：**事件自带的 `provider` 字段优先**（D6，发生侧盖章），
 * 缺省（老轨迹 / 未盖章的 emit 点）才回落 resolver。
 */
export function resolveEventProvider(
  data: Record<string, unknown> | null | undefined,
  resolve: (model: string) => string,
): string {
  const own = data?.provider;
  if (typeof own === "string" && own) return own;
  const model = (data?.model as string) || "";
  return model ? resolve(model) : "unknown";
}
