/**
 * /perf PR-B：面板重做 —— 报告模型、瓶颈判定、渲染（T-B1…T-B11，方案 5.2 节）。
 *
 * 夹具是 PR-A 入库的取证会话脱敏事件（20261110-152006-77684ab7）。期望值来源：
 * - 时间构成、工具、最慢调用：方案 2.3 节 recompute.py 的独立重算（不经过被测代码）；
 * - 整帧快照（T-B11）：首次生成后人工逐项对照方案 4.2 节版式核过，再入库。
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import stringWidth from "string-width";
import { aggregatePerfDetail, type PerfDetail } from "@sid-code/core/trace/perf-detail.ts";
import { aggregateSessionMetrics, percentile } from "@sid-code/core/trace/digest.ts";
import { aggregateLatencyByModel } from "@sid-code/core/trace/latency-by-model.ts";
import {
  buildSessionPerf,
  fmtDuration,
  judgeBottleneck,
  TTFB_BUFFER_GAP_RATIO,
  type SessionPerfInput,
  type SessionPerfReport,
} from "@sid-code/core/trace/perf-report.ts";
import {
  renderSessionPerf,
  wrapLines,
  NARROW_WIDTH,
} from "@sid-code/cli/command/commands/perf/render.ts";

const FIXTURE = join(
  import.meta.dir,
  "../../../core/tests/fixtures/perf-scope/20261110-152006-77684ab7.events.jsonl",
);
const REPO = join(import.meta.dir, "../../../..");

type Ev = { event?: string; timestamp?: string; data?: Record<string, unknown> };
let events: Ev[];
let detail: PerfDetail;
let input: SessionPerfInput;
let report: SessionPerfReport;

beforeAll(() => {
  events = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
  detail = aggregatePerfDetail(events);
  const metrics = aggregateSessionMetrics(events, { trajCorrupt: false });
  const byModel = Object.fromEntries(
    aggregateLatencyByModel(events as never, () => "openai", percentile),
  );
  // metadata 取自取证会话 session.traj（夹具只有 events）
  input = {
    sessionId: "20261110-152006-77684ab7",
    model: "glm-5.3-uniapi",
    ended: true,
    wallMs: 6_749_754,
    metrics,
    latencyByModel: byModel,
    ttftByCache: { hit: { count: 151, p50: 5800, p95: 12800 }, miss: { count: 7, p50: 16100 } },
    detail,
    tps: 33.2,
    reasoningShare: 108_838 / 154_530,
    contextPeakRatio: 0.194644,
    contextPeakTokens: 194_644,
    contextWindow: 1_000_000,
  };
  report = buildSessionPerf(input);
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("T-B1 时间构成", () => {
  test("四项之和 === 活跃墙钟，且与独立重算一致", () => {
    const t = report.timeSplit!;
    expect(t.ttfbMs + t.genMs + t.toolMs + t.otherMs).toBe(t.activeMs);
    // recompute.py：等首字节 1131s、工具 260.5s（主循环）
    expect(Math.round(t.ttfbMs / 1000)).toBe(1131);
    expect(Math.round(t.toolMs / 1000)).toBe(260);
  });

  test("子代理内部的工具不计入工具时间（已含在 sub_agent 自身耗时里）", () => {
    const d = aggregatePerfDetail([
      { event: "PostToolUse", data: { tool_name: "sub_agent", duration_ms: 9000 } },
      { event: "PostToolUse", data: { tool_name: "bash", duration_ms: 500, agent_id: "sub-1" } },
    ]);
    expect(d.timeSplit.toolMs).toBe(9000);
    expect(d.tools.map((t) => t.name)).toEqual(["sub_agent"]);
  });

  test("活跃墙钟少记时抬平到三项之和，「其他」不出负数", () => {
    const d = aggregatePerfDetail([
      { event: "PostToolUse", data: { tool_name: "bash", duration_ms: 5000 } },
      { event: "TurnComplete", data: { stop_reason: "end_turn", elapsed_ms_since_prompt: 1000 } },
    ]);
    expect(d.timeSplit.otherMs).toBe(0);
    expect(d.timeSplit.activeMs).toBe(5000);
  });
});

describe("明细聚合（D8/D9/D10）", () => {
  test("工具按合计降序，失败数如实计", () => {
    expect(detail.tools[0]).toMatchObject({ name: "bash", n: 77, failed: 10 });
    expect(detail.tools.find((t) => t.name === "enter_worktree")).toMatchObject({
      n: 24,
      failed: 23,
    });
  });

  test("最慢 3 次调用来自主循环 AfterModelRaw", () => {
    expect(detail.slowest.map((s) => s.index)).toEqual([45, 13, 14]);
    expect(detail.slowest[0]!.outputTokens).toBe(13_598);
  });

  test("后台 fork 4 次全部没走到 completed，记为中止", () => {
    const forks = detail.side.filter((g) => g.key.startsWith("fork:"));
    expect(forks.reduce((a, g) => a + g.n, 0)).toBe(4);
    expect(forks.reduce((a, g) => a + g.aborted, 0)).toBe(4);
  });

  test("n<5 时给原始样本，且与 sessionMetrics 的 n 对得上", () => {
    expect(detail.smallSamples.e2e).toEqual([5_179_216, 872_246]);
    expect(report.latency.e2e.n).toBe(2);
    expect(detail.smallSamples.ttft).toEqual([]); // n=161 不给样本
  });
});

describe("T-B2 judgeBottleneck", () => {
  test("取证会话 → 生成是瓶颈，reasons 指出 thinking 占比", () => {
    expect(report.verdict.primary).toBe("gen");
    expect(report.verdict.reasons[0]).toContain("thinking 占输出 70%");
    expect(report.verdict.warnings).toContain("enter_worktree 失败 23/24 次");
  });

  const synth = (over: Partial<SessionPerfReport>): Omit<SessionPerfReport, "verdict"> => {
    const { verdict: _v, ...base } = report;
    return { ...base, ...over };
  };

  test("TTFB 占 60%、gapRatio 0.8 → 等首字节，文案为 prefill", () => {
    const v = judgeBottleneck(
      synth({
        timeSplit: { ttfbMs: 600, genMs: 300, toolMs: 100, otherMs: 0, activeMs: 1000 },
        latency: { ...report.latency, gapRatioP50: 0.8 },
      }),
    );
    expect(v.primary).toBe("ttfb");
    expect(v.reasons[0]).toContain("prefill");
    expect(v.reasons[0]).not.toContain("分不清");
  });

  test("gapRatio < 50% → 网关缓冲文案", () => {
    const v = judgeBottleneck(
      synth({
        timeSplit: { ttfbMs: 600, genMs: 300, toolMs: 100, otherMs: 0, activeMs: 1000 },
        latency: { ...report.latency, gapRatioP50: 0.02 },
      }),
    );
    expect(v.reasons[0]).toContain("分不清");
  });

  test("主循环 < 5 次 → insufficient", () => {
    const v = judgeBottleneck(synth({ header: { ...report.header, mainCalls: 4 } }));
    expect(v.primary).toBe("insufficient");
  });

  test("工具是瓶颈 → 列出耗时前 2 的工具", () => {
    const v = judgeBottleneck(
      synth({ timeSplit: { ttfbMs: 100, genMs: 100, toolMs: 800, otherMs: 0, activeMs: 1000 } }),
    );
    expect(v.primary).toBe("tool");
    expect(v.reasons[0]).toContain("bash");
    expect(v.reasons[0]).toContain("enter_worktree");
  });
});

describe("T-B3 阈值与北极星文档同值", () => {
  test("TTFB_BUFFER_GAP_RATIO = 0.5，northstar/README.md 写的是「> 50%」", () => {
    expect(TTFB_BUFFER_GAP_RATIO).toBe(0.5);
    const md = readFileSync(join(REPO, "northstar/README.md"), "utf8");
    expect(md).toMatch(/> ?50% 即该路由在抢先回 header/);
  });
});

describe("T-B4 样本规则", () => {
  test("n<5：不出现 P95 字样的分位数，直接列样本；n≥5 出分位数", () => {
    const text = strip(renderSessionPerf(report, { width: 120, color: false }));
    const e2eLine = text.split("\n").find((l) => l.includes("端到端"))!;
    expect(e2eLine).toContain("1h26m、14m32s");
    expect(e2eLine).toContain("n=2");
    const ttftLine = text.split("\n").find((l) => l.includes("首字 TTFT"))!;
    expect(ttftLine).toMatch(/5\.9s\s+15s\s+32s\s+161/);
  });

  test("5 ≤ n < 100 时 P99 显示 —", () => {
    const text = strip(renderSessionPerf(report, { width: 120, color: false }));
    const hitLine = text.split("\n").find((l) => l.includes("缓存命中"))!;
    expect(hitLine).toMatch(/13s\s+—\s+151/);
  });
});

describe("T-B5 按模型表只在多模型时出现", () => {
  test("单模型：报告里有 1 个模型，渲染不出现模型名表格", () => {
    expect(report.byModel.length).toBe(1);
    expect(strip(renderSessionPerf(report, { width: 120, color: false }))).not.toContain("按模型");
  });

  test("多模型：不给会话级 TTFB（跨 model 汇总是假数）", () => {
    const two = buildSessionPerf({
      ...input,
      latencyByModel: {
        a: { provider: "x", n: 3, unpairedHeaders: 0 },
        b: { provider: "y", n: 2, unpairedHeaders: 0 },
      },
    });
    expect(two.latency.headers).toBeUndefined();
    expect(two.latency.gapRatioP50).toBeUndefined();
    const text = strip(renderSessionPerf(two, { width: 120, color: false }));
    expect(text).not.toContain("首字节 TTFB");
    expect(text).toContain("按模型");
  });
});

describe("T-B6 时长格式", () => {
  test.each([
    [8689, "8.7s"],
    [59000, "59s"],
    [872246, "14m32s"],
    [5179216, "1h26m"],
    [450, "450ms"],
  ])("%d → %s", (ms, want) => {
    expect(fmtDuration(ms)).toBe(want);
  });
});

describe("T-B7 表格对齐按显示宽度", () => {
  test("延迟表每行数字列的右边界按 string-width 对齐（含中文与 —）", () => {
    const lines = strip(renderSessionPerf(report, { width: 120, color: false })).split("\n");
    const i = lines.findIndex((l) => l.startsWith("延迟"));
    // 表头 + 首字/缓存命中/TTFB/单次生成：n 列右边界一致
    // 每行截到 n 列（行内最后一个「空白 + 整数」）为止；行尾注释在它之后
    const block = lines.slice(i, i + 5).map((l) => l.match(/^.*?\s(?:\d+|n)(?=\s{3}|$)/)![0]);
    const ends = block.map((l) => stringWidth(l));
    expect(new Set(ends).size).toBe(1);
  });
});

describe("T-B8 无色模式", () => {
  test("color=false 不含 ANSI；color=true 含", () => {
    expect(renderSessionPerf(report, { width: 120, color: false })).not.toContain("\x1b[");
    expect(renderSessionPerf(report, { width: 120, color: true })).toContain("\x1b[");
  });
});

describe("T-B9 窄终端", () => {
  test(`60 列：无横条字符、无 P99 列，没有一行超过 60 列`, () => {
    expect(60).toBeLessThan(NARROW_WIDTH);
    const text = renderSessionPerf(report, { width: 60, color: true });
    expect(strip(text)).not.toMatch(/[█▏▎▍▌▋▊▉]/);
    expect(strip(text)).not.toContain("P99");
    for (const line of strip(text).split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(60);
  });

  test("折行把颜色在续行重放、断行末复位（<Ansi> 按行解析，颜色不跨行）", () => {
    const out = wrapLines([`\x1b[33m${"警".repeat(10)}\x1b[39m`], 12, 2);
    expect(out.length).toBe(2);
    expect(out[0]!.endsWith("\x1b[0m")).toBe(true);
    expect(out[1]!.startsWith("  \x1b[33m")).toBe(true);
  });
});

describe("T-B10 --json", () => {
  test("报告能 JSON 往返，含 verdict.primary 与 timeSplit", () => {
    const back = JSON.parse(JSON.stringify(report));
    expect(back.verdict.primary).toBe("gen");
    expect(back.timeSplit.activeMs).toBe(report.timeSplit!.activeMs);
  });
});

describe("T-B11 整帧快照（人工对照方案 4.2 版式核过）", () => {
  test("取证会话 100 列无色渲染", () => {
    expect(renderSessionPerf(report, { width: 100, color: false })).toMatchSnapshot();
  });
});
