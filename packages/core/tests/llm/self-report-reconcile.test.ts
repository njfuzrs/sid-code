/**
 * 缺陷 CP-2 回归：自报链的运行时对账与补账。
 *
 * ## 它守的是什么
 *
 * `BILLING_SELF_REPORTED_LABELS` 里那批链走「发生侧不记钱、让消费侧自己报」的分工。
 * CP-1 证明消费侧会**静默不报**（取了 `message_stop` 上永不存在的 usage），而豁免标签让
 * 发生侧也不看它们 —— 两头都不记，钱静默漏了 199 次。
 *
 * 对账就是这道分工的安全网：发生侧仍然不记钱，但把「本该由谁报多少」记下来，
 * 会话收尾时与消费侧实报量相减，差额补账 + 告警。于是错向从「静默少钱」变成「自动补齐」。
 *
 * ## 断言口径
 *
 * - 差额按 **token** 比，不按次数比（重试那笔同样是真实花费，正该补上）。
 * - 补账金额必须等于**按价复算值**（走会话注入的 calculator，与主循环同一个），
 *   且必须同步通知 observer —— 账本行读的是 SessionState，不通知就等于"补了但账本没变"。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  BILLING_SELF_REPORTED_LABELS,
  SELF_REPORTED_LABEL_TO_QUERY_SOURCE,
  getSelfReportExpected,
  recordBilledRequest,
  resetBillingSink,
  resetSelfReportExpected,
} from "@sid-code/core/llm/billing-sink.ts";
import {
  SELF_REPORT_GAP_LABEL_PREFIX,
  applySelfReportGaps,
  reconcileSelfReports,
} from "@sid-code/core/llm/self-report-reconcile.ts";
import {
  getSideStats,
  recordSideCall,
  resetSideCallStats,
  setSideCostCalculator,
  setSideCostObserver,
} from "@sid-code/core/trace/side-call-sink.ts";

const MODEL = "mock-model";

let fetchSeq = 0;

/** 造一条发生侧计费事件（默认按"豁免标签的辅助调用"形态） */
function bill(opts: {
  label: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  accounted?: boolean;
}): void {
  fetchSeq += 1;
  recordBilledRequest({
    fetchId: `f${fetchSeq}`,
    model: MODEL,
    provider: "openai",
    usage: {
      inputTokens: opts.input,
      outputTokens: opts.output,
      ...(opts.cacheRead !== undefined && { cacheReadInputTokens: opts.cacheRead }),
      ...(opts.cacheCreate !== undefined && { cacheCreationInputTokens: opts.cacheCreate }),
    },
    index: 0,
    accounted: opts.accounted ?? false,
    callerLabel: opts.label,
  });
}

/** 造一条消费侧自报（走真实的 recordSideCall） */
function selfReport(label: string, input: number, output: number): void {
  recordSideCall({
    label,
    model: MODEL,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

beforeEach(() => {
  resetBillingSink();
  resetSelfReportExpected();
  resetSideCallStats();
  setSideCostCalculator(() => 0);
  setSideCostObserver(() => {});
});

describe("自报对账：发生侧与消费侧的差额计算", () => {
  test("豁免标签的用量进入发生侧池子（按 querySource + 计价维度分桶）", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    const expected = getSelfReportExpected();
    expect(expected.length).toBe(1);
    expect(expected[0]!.querySource).toBe("memory_recall");
    expect(expected[0]!.calls).toBe(1);
    expect(expected[0]!.inputTokens).toBe(100);
    expect(expected[0]!.outputTokens).toBe(40);
  });

  test("不在豁免表里的标签不进池子（fork / 主循环的钱有别的入账口）", () => {
    bill({ label: "session-memory-update", input: 100, output: 40 });
    bill({ label: "memory-extract", input: 50, output: 20 });
    expect(getSelfReportExpected()).toEqual([]);
  });

  test("accounted=true 的事件不进池子（已被子代理 sink 认领，不属于「让给自报」）", () => {
    bill({ label: "memory_recall", input: 100, output: 40, accounted: true });
    expect(getSelfReportExpected()).toEqual([]);
  });

  test("消费侧报了、量与发生侧一致 → 无差额（正常路径不补账不告警）", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    selfReport("memory-recall", 100, 40);
    const r = reconcileSelfReports();
    expect(r.gaps).toEqual([]);
    // 分母自证：确实比过 1 条链，不是"什么都没比就报 0"
    expect(r.comparedQuerySources).toBe(1);
  });

  test("消费侧没报 → 差额等于发生侧全量，并给出对应的消费侧 label", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    const r = reconcileSelfReports();
    expect(r.gaps.length).toBe(1);
    const g = r.gaps[0]!;
    expect(g.querySource).toBe("memory_recall");
    expect(g.labels).toEqual(["memory-recall"]);
    expect(g.expectedCalls).toBe(1);
    expect(g.reportedCalls).toBe(0);
    expect(g.inputTokens).toBe(100);
    expect(g.outputTokens).toBe(40);
  });

  test("消费侧只报了一部分 → 差额是那部分差值（不是全量）", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    selfReport("memory-recall", 60, 40);
    const r = reconcileSelfReports();
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0]!.inputTokens).toBe(40);
    expect(r.gaps[0]!.outputTokens).toBe(0);
  });

  test("消费侧报多了不倒补（差额取 0，方向安全：只补少的）", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    selfReport("memory-recall", 200, 80);
    expect(reconcileSelfReports().gaps).toEqual([]);
  });

  test("compact 三条链共用一个 querySource → 差额合并后一次补齐", () => {
    // 发生侧：auto-compact 与 context-collapse 都打 compact
    bill({ label: "compact", input: 100, output: 10 });
    bill({ label: "compact", input: 50, output: 5 });
    // 消费侧只报了 auto-compact 那一笔
    selfReport("auto-compact", 100, 10);
    const r = reconcileSelfReports();
    expect(r.gaps.length).toBe(1);
    const g = r.gaps[0]!;
    expect(g.querySource).toBe("compact");
    expect(g.inputTokens).toBe(50);
    expect(g.outputTokens).toBe(5);
    // 三条链的 label 都能定位到（排查时要知道是哪几条）
    expect(new Set(g.labels)).toEqual(
      new Set(["auto-compact", "context-collapse", "partial-compact"]),
    );
  });

  test("cache token 的差额也会被补（它们同样计价）", () => {
    bill({ label: "memory_recall", input: 10, output: 5, cacheRead: 1000, cacheCreate: 200 });
    const g = reconcileSelfReports().gaps[0]!;
    expect(g.cacheReadTokens).toBe(1000);
    expect(g.cacheCreationTokens).toBe(200);
  });
});

describe("自报补账：金额与账本联动", () => {
  /** 复算口径：input 3 元/M、output 15 元/M，cache 另算 —— 只为让断言能逐位对账 */
  const PRICE_IN = 3;
  const PRICE_OUT = 15;
  const PRICE_CACHE_READ = 0.3;
  const PRICE_CACHE_CREATE = 3.75;

  function priceOf(usageAny: any): number {
    return (
      (usageAny.inputTokens ?? 0) * PRICE_IN +
      (usageAny.outputTokens ?? 0) * PRICE_OUT +
      (usageAny.cacheReadInputTokens ?? 0) * PRICE_CACHE_READ +
      (usageAny.cacheCreationInputTokens ?? 0) * PRICE_CACHE_CREATE
    );
  }

  test("补账金额 == 按价复算值，且同步通知成本 observer（账本才看得到）", () => {
    setSideCostCalculator((_model, usage) => priceOf(usage));
    let booked = 0;
    setSideCostObserver((cost) => {
      booked += cost;
    });

    bill({ label: "memory_recall", input: 100, output: 40, cacheRead: 500, cacheCreate: 20 });
    const r = reconcileSelfReports();
    applySelfReportGaps(r.gaps, (x) => recordSideCall(x));

    const expected = priceOf({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 20,
    });
    // ① sink 里记的金额
    expect(getSideStats().costUSD).toBeCloseTo(expected, 10);
    // ② 账本侧（SessionState.addSideCost）收到的金额 —— 少了它账本行就是旧数
    expect(booked).toBeCloseTo(expected, 10);
  });

  test("补账记录的 label 带 self-report-gap 前缀，且不在映射表里（否则下一轮对账看不见漏报）", () => {
    bill({ label: "goal_eval", input: 10, output: 5 });
    const recorded: Array<{ label: string }> = [];
    applySelfReportGaps(reconcileSelfReports().gaps, (x) => recorded.push(x));
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.label).toBe(`${SELF_REPORT_GAP_LABEL_PREFIX}goal_eval`);
    // 关键：补账 label 绝不能出现在映射表里
    expect(SELF_REPORTED_LABEL_TO_QUERY_SOURCE.has(recorded[0]!.label)).toBe(false);
  });

  test("已自报量按 querySource 聚合，忽略补账产生的合成 label", () => {
    selfReport("memory-recall", 100, 40);
    // 补账记录（合成 label）不能算进已自报量
    recordSideCall({
      label: `${SELF_REPORT_GAP_LABEL_PREFIX}memory_recall`,
      model: MODEL,
      inputTokens: 999,
      outputTokens: 999,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const r = reconcileSelfReports();
    // 发生侧为空 → 无差额可比；这里真正要验的是"补账 label 没被当成自报"
    expect(r.comparedQuerySources).toBe(0);
  });

  test("补账后清空发生侧池子 → 再对账不再补第二笔（防 SIGHUP + 正常退出补两次）", () => {
    bill({ label: "memory_recall", input: 100, output: 40 });
    applySelfReportGaps(reconcileSelfReports().gaps, () => {});
    resetSelfReportExpected();
    expect(reconcileSelfReports().gaps).toEqual([]);
  });
});

describe("映射表反查（防漂移）", () => {
  test("每个豁免 querySource 至少被一条消费侧 label 覆盖", () => {
    const covered = new Set(SELF_REPORTED_LABEL_TO_QUERY_SOURCE.values());
    for (const qs of BILLING_SELF_REPORTED_LABELS) {
      expect(covered.has(qs)).toBe(true);
    }
  });

  test("映射表的每个值都是合法 querySource（反过来也防漂移）", () => {
    for (const [, qs] of SELF_REPORTED_LABEL_TO_QUERY_SOURCE) {
      expect(BILLING_SELF_REPORTED_LABELS.has(qs)).toBe(true);
    }
  });
});
