/**
 * /cost 的范围标注（D4，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * /cost 的「总费用」含辅助调用（`totalCostUSD + sideCostUSD`），但 token / 请求数 /
 * 缓存命中率 / 省钱 / API 耗时全部只来自主循环（`modelUsage` / `totalAPIDuration`）。
 * 两种范围混在一个面板上却不标注，用户拿「费用 ÷ token」估单价必然偏高，
 * 「省钱 vs 费用」也是两个不同范围在比（北极星铁律 3：分母口径必须和指标一起写死）。
 *
 * 修法不是把辅助调用并进 `modelUsage`（会污染 stock 口径的上下文大小），
 * 而是**分两块显示、各自标明范围**。
 *
 * ## 版式变更说明（PR-B / D15）
 *
 * 旧版式是一条平铺的「辅助调用 Token 用量」段（main 的 `formatSideCallTokenSection`）。
 * PR-B 重做成分区账单后，这段的职责被两处接走：`费用构成` 区把主循环/辅助调用拆成两行
 * （辅助调用再按用途逐行列出，行内带 token），注释区说明辅助调用不经过主对话。
 * 本测试按新版式断言同样的契约：**两块互不包含、各自可辨**；
 * 旧版式那几条针对独立段落/文本行的锚点不再适用（版式是有意重做的）。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildCostReport } from "@sid-code/core/session/cost-report.ts";
import { renderCostReport } from "../../src/command/commands/cost/cost-render.ts";
import type { SideCallStats } from "@sid-code/core/trace/side-call-sink.ts";

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/** 无辅助调用：会话只跑了主循环 */
const NO_SIDE: SideCallStats = {
  apiCalls: 0,
  costUSD: 0,
  tokensSent: 0,
  tokensReceived: 0,
  durationMs: 0,
  durationCalls: 0,
  details: [],
  failed: 0,
  timedOut: 0,
  usageMissing: 0,
  byLabel: {},
};

/**
 * 取证会话第一段的辅助调用累计（方案文档 2.2 节 `side_tokens_sent` / `side_tokens_received`）。
 * `details` 是进程维度逐条记录：费用构成区按用途拆分就读它。
 */
const SIDE_SAMPLE: SideCallStats = {
  apiCalls: 6,
  costUSD: 0.0645,
  tokensSent: 547_419,
  tokensReceived: 4_152,
  durationMs: 24_000,
  durationCalls: 6,
  details: [
    {
      label: "fork:memory-extract",
      model: "test-model",
      inputTokens: 243_000,
      outputTokens: 1_800,
      // CP-10d：命中部分与 inputTokens 同源，渲染层据此显示「（命中 82%）」
      cacheReadTokens: 200_000,
      costUSD: 0.0335,
      durationMs: 8_000,
    },
    {
      label: "fork:session-memory-update",
      model: "test-model",
      inputTokens: 304_000,
      outputTokens: 2_352,
      cacheReadTokens: 250_000,
      costUSD: 0.0309,
      durationMs: 15_000,
    },
  ],
  failed: 0,
  timedOut: 0,
  usageMissing: 0,
  byLabel: { "fork:memory-extract": { success: 2, failed: 0 } },
};

/** 主循环入账：10000 累计 prompt（openai 族含命中 6500）、100 输出、1 次请求 */
function mainLoopSession(): SessionState {
  const ss = new SessionState("cost-side-scope-test");
  ss.updateUsage(
    "gpt-test",
    { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 6_500 },
    1,
    "openai",
  );
  return ss;
}

function render(ss: SessionState, side: SideCallStats = NO_SIDE): string {
  const report = buildCostReport(ss, { sideStats: side, gateStats: IDLE_GATE, cacheBreaks: [] });
  return renderCostReport(report, { useColor: false, columns: 120 });
}

describe("D4 · 费用构成分区：主循环与辅助调用各占一行", () => {
  test("有辅助调用：两行都在，费用分别给出（不合并成一个数）", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("费用构成"))).toBe(true);
    expect(lines.some((l) => /^\s+主循环\s+\$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s+辅助调用\s+\$/.test(l))).toBe(true);
  });

  test("没有辅助调用：辅助调用行整段省略，不给正常路径加噪音", () => {
    const out = render(mainLoopSession(), NO_SIDE);
    expect(out).not.toMatch(/^\s+辅助调用\s+\$/m);
  });

  test("辅助调用按用途逐行拆分，行内 token 来自进程维度明细", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("fork:memory-extract");
    expect(out).toContain("243k token");
  });
});

describe("D4 · 主循环 token 段与辅助调用互不包含", () => {
  test("token 段标题标明是主循环", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("主循环 token 与单价");
  });

  test("累计发送只含主循环：10,000，不是与辅助调用相加后的 557,419", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("累计发送 10,000（flow");
    // 相加值绝不能出现——出现就说明有人把两块合并了，D4 会以另一种形态复发
    expect(out).not.toContain("557,419");
    expect(out).not.toContain("557419");
  });

  test("注释区说明辅助调用同样计费、按用途拆分只含本次启动后", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("辅助调用 = 标题生成、记忆抽取、权限分类、摘要等");
    // CP-5：作用域说明从「按用途拆分仅含本次启动后的调用」扩成「费用/耗时/按用途拆分」，
    // 因为首行现在把辅助调用次数也标了同一个作用域。
    expect(out).toContain("其费用/耗时/按用途拆分仅含本次启动后");
  });
});

describe("D4 · 耗时与范围标注", () => {
  test("API 耗时标明仅主循环，裸标签不再出现", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    const lines = out.split("\n");
    expect(lines.some((l) => l.trimStart().startsWith("API 耗时（主循环）:"))).toBe(true);
    expect(out).not.toMatch(/^API 耗时:/m);
  });

  test("辅助调用耗时写明本次启动后的覆盖范围", () => {
    const out = render(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("辅助调用耗时（逐次累计）: 24s");
    expect(out).toContain("本次启动后 6 次调用");
  });
});
