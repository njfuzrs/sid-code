/**
 * 自报链的运行时对账与补账（缺陷 CP-2，2026-11-13）。
 *
 * ## 它修的是什么
 *
 * `BILLING_SELF_REPORTED_LABELS` 里那批链走的是「发生侧不记钱，让消费侧自己
 * `recordSideCall`」的分工。这个分工的前提是**消费侧真的报了**——而 CP-1 恰恰证明
 * 它可以静默不报：7 条链从 `message_stop` 上取一个永不存在 usage，成功路径恒不记账，
 * 发生侧又因豁免不看它们，两头都不记，钱静默漏了 199 次（轨迹实测）。
 *
 * 所以豁免不能只是「不看」，必须配一个**运行时对账**：发生侧仍然不记钱（那是错的），
 * 但要把「本该由谁报多少」记下来，在会话收尾时与消费侧实际报的量相减。
 * 差额由发生侧补账 —— 于是漏记的错向从「静默少钱」变成「自动补齐 + 告警」。
 *
 * ## 为什么按 token 比而不按次数比
 *
 * 重试会让发生侧次数多于自报次数（同一请求被记多条 BilledRequest），而**重试那一笔
 * 同样是真实花费**，正应该被补上。按次数比会把重试报成漏账，方向相反（高估）。
 *
 * ## 为什么补账 label 带 `self-report-gap:` 前缀
 *
 * 它必须**不在** `SELF_REPORTED_LABEL_TO_QUERY_SOURCE` 里：补账补的就是差额，
 * 若它被算进 reported，下一轮对账会以为"已经自报过"，漏报从此看不见。
 * 前缀同时让 `/cost` 的 byLabel 一眼能看出这笔钱是补的，而不是那条链正常工作。
 */

import {
  getSelfReportExpected,
  SELF_REPORTED_LABEL_TO_QUERY_SOURCE,
  type SelfReportExpectedBucket,
} from "./billing-sink.ts";
import { getReportedSelfReportTokens } from "../trace/side-call-sink.ts";

/** 一条链的对账结果（只保留差额非零的条目，见 {@link reconcileSelfReports}）。 */
export interface SelfReportGap {
  /** 发生侧 querySource（`memory_recall` / `compact` …） */
  querySource: string;
  /** 该 querySource 对应的全部消费侧 label（定位坏掉的那条链用） */
  labels: string[];
  expectedCalls: number;
  reportedCalls: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  /** 差额 = 发生侧 − 消费侧（逐项取 max(0, ·)）。补账补的就是这个数。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 补账计价维度：取该 querySource 发生侧调用次数最多的那个桶 */
  model: string;
  provider: string;
  baseURL?: string;
}

export interface SelfReportReconcileResult {
  gaps: SelfReportGap[];
  /**
   * 参与比较的 querySource 数。
   *
   * **必须和 gaps 一起看**：`comparedQuerySources === 0` 表示本次会话根本没有豁免标签的
   * 调用（不是"对账通过"）。上游若要打"对账 OK"的日志，得先看这个分母。
   */
  comparedQuerySources: number;
}

/** 补账记录形态（与 `recordSideCall` 的入参子集同形，便于注入与单测）。 */
export interface SelfReportGapRecord {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 补账记录的 label 前缀。**不要**把它加进 `SELF_REPORTED_LABEL_TO_QUERY_SOURCE`。 */
export const SELF_REPORT_GAP_LABEL_PREFIX = "self-report-gap:";

/**
 * 对一个 querySource 的发生侧桶做合并：token 相加，计价维度取调用次数最多的桶。
 *
 * 为什么要合并：消费侧只按 label 报 token，无法反推它对应发生侧的哪个 (model, endpoint) 桶。
 * 同一 querySource 在一个会话里跨模型是极罕见情形（配置固定）；真出现时按主桶计价
 * 会有细微价差，但**方向安全**（补的是真实花掉的 token，不会多补出一笔不存在的调用）。
 */
function mergeExpected(buckets: SelfReportExpectedBucket[]): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  provider: string;
  baseURL?: string;
} {
  let main = buckets[0]!;
  for (const b of buckets) if (b.calls > main.calls) main = b;
  const sum = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: main.model,
    provider: main.provider,
    ...(main.baseURL !== undefined && { baseURL: main.baseURL }),
  };
  for (const b of buckets) {
    sum.calls += b.calls;
    sum.inputTokens += b.inputTokens;
    sum.outputTokens += b.outputTokens;
    sum.cacheReadTokens += b.cacheReadTokens;
    sum.cacheCreationTokens += b.cacheCreationTokens;
  }
  return sum;
}

/**
 * 对账：发生侧「让给自报」的量 − 消费侧实际自报的量。
 *
 * 返回的 `gaps` **只含差额非零的条目**（正常路径返回空数组、不补账、不告警）。
 * 消费侧报得比发生侧多（理论上不该出现）时差额取 0 —— 不"倒补"一笔负钱：
 * 方向安全的做法是只补少的，多报由 `/cost` 的偏差发现。
 */
export function reconcileSelfReports(): SelfReportReconcileResult {
  const expectedByQuerySource = new Map<string, SelfReportExpectedBucket[]>();
  for (const b of getSelfReportExpected()) {
    const list = expectedByQuerySource.get(b.querySource) ?? [];
    list.push(b);
    expectedByQuerySource.set(b.querySource, list);
  }

  const reported = getReportedSelfReportTokens();
  const gaps: SelfReportGap[] = [];

  for (const [querySource, buckets] of expectedByQuerySource) {
    const exp = mergeExpected(buckets);
    const rep = reported.get(querySource) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const inputTokens = Math.max(0, exp.inputTokens - rep.inputTokens);
    const outputTokens = Math.max(0, exp.outputTokens - rep.outputTokens);
    const cacheReadTokens = Math.max(0, exp.cacheReadTokens - rep.cacheReadTokens);
    const cacheCreationTokens = Math.max(0, exp.cacheCreationTokens - rep.cacheCreationTokens);
    if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) continue;

    const labels: string[] = [];
    for (const [label, qs] of SELF_REPORTED_LABEL_TO_QUERY_SOURCE) {
      if (qs === querySource) labels.push(label);
    }

    gaps.push({
      querySource,
      labels,
      expectedCalls: exp.calls,
      reportedCalls: rep.calls,
      expectedInputTokens: exp.inputTokens,
      expectedOutputTokens: exp.outputTokens,
      reportedInputTokens: rep.inputTokens,
      reportedOutputTokens: rep.outputTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      model: exp.model,
      provider: exp.provider,
      ...(exp.baseURL !== undefined && { baseURL: exp.baseURL }),
    });
  }

  return { gaps, comparedQuerySources: expectedByQuerySource.size };
}

/**
 * 把差额交给调用方补账。
 *
 * `record` 注入而不是直接 import `recordSideCall`：补账金额要按会话注入的计价器算
 * （`setSideCostCalculator`），单测也要能用一个纯记录器断言"补了什么"而不触发
 * 全局 observer 副作用。
 */
export function applySelfReportGaps(
  gaps: readonly SelfReportGap[],
  record: (r: SelfReportGapRecord) => void,
): void {
  for (const gap of gaps) {
    record({
      label: `${SELF_REPORT_GAP_LABEL_PREFIX}${gap.querySource}`,
      model: gap.model,
      inputTokens: gap.inputTokens,
      outputTokens: gap.outputTokens,
      cacheReadTokens: gap.cacheReadTokens,
      cacheCreationTokens: gap.cacheCreationTokens,
    });
  }
}
