/**
 * 非流式影子调用的统一入账（缺陷 15–16，20260927 可观测性审计）。
 *
 * 此前 5 个直调 `sendMessageNonStreaming` 的影子调用点各写一份
 * `if (resp.usage) recordSideCall(...)`：provider 不返 usage 时这次调用**不进任何账**
 * （非流式路径当时也没有 provider 侧收口，见 billing-sink.ts `recordNonStreamingBilledRequest`）。
 * 五份同形手写 = 第六份照样会漏，所以收成一个函数。
 *
 * 它做两件事：
 * 1. 用 `withRequestContext` 把 `querySource` 挂到 ALS —— provider 非流式收口发的
 *    `BilledRequest` 才带得上 caller，消费侧据 `BILLING_SELF_REPORTED_LABELS` 跳过、不双记；
 * 2. **无条件** `recordSideCall`：usage 缺失记 0 token 且 `usageMissing`，
 *    调用次数仍进 `apiCalls` / `byLabel` —— 「发生过但不知道花了多少」必须可见。
 *
 * ⚠️ `querySource` 必须是字面量且登记在 `BILLING_SELF_REPORTED_LABELS`，
 * 门禁 `tests/llm/billing-self-reported-labels.test.ts` 按 `querySource: "..."` 静态扫描。
 */

import type { Provider } from "./provider.ts";
import type { AccumulatedResponse, SendParams } from "./types.ts";
import { withRequestContext } from "./request-context.ts";
import { nextSideObserverIndex } from "./resilient-stream.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";

export interface NonStreamingSideCallOpts {
  /** 归因标签（= BilledRequest.caller），必须在 BILLING_SELF_REPORTED_LABELS 里 */
  querySource: string;
  /** recordSideCall 的 label（沿用各调用点既有的连字符命名，byLabel 统计不变） */
  label: string;
  /** 记账用的模型名；缺省取 params.model */
  model?: string;
}

/**
 * 发一次非流式影子调用并入账。失败（含超时）原样抛出，由调用方的 catch 记失败。
 * 调用方必须已判断 `provider.sendMessageNonStreaming` 存在。
 */
export async function sendNonStreamingSideCall(
  provider: Provider,
  params: SendParams,
  signal: AbortSignal | undefined,
  opts: NonStreamingSideCallOpts,
): Promise<AccumulatedResponse> {
  const startedAt = Date.now();
  const resp = await withRequestContext(
    { turnIndex: nextSideObserverIndex(), callerLabel: opts.querySource },
    () => provider.sendMessageNonStreaming!(params, signal),
  );
  const u = resp?.usage;
  recordSideCall({
    label: opts.label,
    model: opts.model ?? params.model,
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadInputTokens ?? 0,
    cacheCreationTokens: u?.cacheCreationInputTokens ?? 0,
    durationMs: Date.now() - startedAt,
    ...(u ? {} : { usageMissing: true }),
  });
  return resp;
}
