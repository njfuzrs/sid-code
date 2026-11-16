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
  buildByVersion,
  buildSessionPerf,
  fmtDuration,
  judgeBottleneck,
  TTFB_BUFFER_GAP_RATIO,
  type SessionPerfInput,
  type SessionPerfReport,
} from "@sid-code/core/trace/perf-report.ts";
import type { SessionIndexEntry } from "@sid-code/core/trace/session-index.ts";
import {
  bar,
  distCells,
  renderByVersion,
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

describe("D16 进行中", () => {
  test("墙钟快照滞后于 events 时，墙钟不小于活跃时间；标题写「进行中 · 截至」", () => {
    const live = buildSessionPerf({
      ...input,
      ended: false,
      snapshotAt: "2026-11-10T09:12:36.168Z",
      wallMs: 1000,
    });
    expect(live.header.wallMs).toBe(live.header.activeMs);
    const first = strip(renderSessionPerf(live, { width: 200, color: false })).split("\n")[0]!;
    expect(first).toContain("进行中 · 截至");
    expect(first).not.toContain("已结束");
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

  test("走到 completed 的后台调用不算中止（只有没收尾的才算）", () => {
    const sp = (phase: string, extra: Record<string, unknown> = {}) => ({
      event: "StreamPhase",
      data: { index: 900007, phase, attempt: 1, caller: "goal_eval", ...extra },
    });
    const d = aggregatePerfDetail([
      sp("fetch_sent"),
      sp("first_content", { ttft_ms: 1200 }),
      sp("completed"),
    ]);
    expect(d.side).toEqual([{ key: "goal_eval", n: 1, ttfts: [1200], aborted: 0 }]);
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

describe("P99 与横条细节", () => {
  test("n<100 时即使有 p99 值也显示 —；n≥100 才显示", () => {
    expect(distCells({ p50: 1000, p95: 2000, p99: 3000, n: 99 }, false)[2]).toBe("—");
    expect(distCells({ p50: 1000, p95: 2000, p99: 3000, n: 100 }, false)[2]).toBe("3.0s");
  });

  test("占比 >0 但不足 1/8 格时也画一格细线，与 0% 区分", () => {
    expect(bar(0.001, 30)).toBe("▏");
    expect(bar(0, 30)).toBe("");
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

  test("优先在空格处折行：英文命令与时刻不被拆开", () => {
    // 16 列硬断会落在「18:0」之后；按空格断则整段时刻挪到续行
    expect(wrapLines(["abc · 截至 18:05:26"], 16, 2)).toEqual(["abc · 截至", "  18:05:26"]);
    const out = wrapLines(["进行中 · 截至 18:05:26 用 /trace --health 对比"], 24, 2);
    expect(out.some((l) => l.includes("--health"))).toBe(true);
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(24);
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

// ── 跨会话「按版本」视图（D14 / D12 / A8）──
//
// 方案 5.2 表只给到 T-B1…T-B11，覆盖的全是**会话视图**；`--by-version` 的三处改动
// （D14 两列、D12 incomplete 脚注、A8 旧口径提示）当时只有实现、没有断言，
// 5.3 第 6 步要求的端到端取证也没留输出。坏了不会有任何东西变红。
//
// 这里用**合成的索引行自己造数据**（不依赖本机有没有历史版本）把三处锁成回归：
// 造数据而不是等真实数据，是因为这三项判据是开关型的（出没出那两列、加没加脚注），
// 只靠碰巧攒够某个 incomplete 占比 >30% 的版本，可能永远等不到。

/** 合成一条 `session-index.jsonl` 行。只写判据用得到的字段，其余落最小合法值 */
function idxRow(over: Partial<SessionIndexEntry> & { session_id: string }): SessionIndexEntry {
  return {
    ts: 1_700_000_000,
    model: "m1",
    exit_status: "end_turn",
    duration_ms: 60_000,
    turns: 3,
    total_steps: 10,
    cost_usd: 0,
    tokens_sent: 1000,
    tokens_received: 500,
    ttft_n: 1,
    e2e_n: 1,
    real_errors: 0,
    anomalies_count: 0,
    pathological: [],
    compactions: 0,
    defense_triggered: false,
    ...over,
  };
}

describe("D14 按版本视图补「生成 P95」「工具/会话 P50」两列", () => {
  const versionReport = buildByVersion(
    [
      idxRow({
        session_id: "a",
        app_version: "0.1.616",
        ttft_p50: 1000,
        ttft_p95: 2000,
        gen_p95: 8000,
        tps: 30,
        e2e_p95: 60_000,
        tool_duration_ms: 4000,
        perf_scope: "main",
      }),
    ],
    10,
  );

  test("非窄终端出这两列，值取自索引行的 gen_p95 / tool_p50", () => {
    const text = strip(renderByVersion(versionReport, { width: 200, color: false }));
    expect(text).toContain("生成 P95");
    expect(text).toContain("工具/会话 P50");
    expect(text).toContain("8.0s"); // gen_p95 = 8000ms
    expect(text).toContain("4.0s"); // tool_duration_ms = 4000ms
  });

  test("窄终端省略这两列（否则会折行挤乱表格）", () => {
    const text = strip(renderByVersion(versionReport, { width: 60, color: false }));
    expect(text).not.toContain("生成 P95");
    expect(text).not.toContain("工具/会话 P50");
  });

  test("整列无样本时给「—」并说明是当时没该字段，不是 0", () => {
    const noTps = buildByVersion(
      [idxRow({ session_id: "b", app_version: "0.1.605", perf_scope: "main" })],
      10,
    );
    const text = strip(renderByVersion(noTps, { width: 200, color: false }));
    expect(text).toContain("0.1.605");
    expect(text).toContain("不是 0");
  });
});

describe("D12 incomplete 占比 >30% 的版本加脚注", () => {
  test("50% 出脚注且报出分子分母；25% 不出", () => {
    const versionReport = buildByVersion(
      [
        // 0.1.607：1 收尾 + 1 incomplete = 50% > 30% → 该出脚注
        idxRow({ session_id: "a", app_version: "0.1.607", perf_scope: "main" }),
        idxRow({ session_id: "b", app_version: "0.1.607", exit_status: "incomplete" }),
        // 0.1.616：3 收尾 + 1 incomplete = 25% ≤ 30% → 不该出
        idxRow({ session_id: "c", app_version: "0.1.616", perf_scope: "main" }),
        idxRow({ session_id: "d", app_version: "0.1.616", perf_scope: "main" }),
        idxRow({ session_id: "e", app_version: "0.1.616", perf_scope: "main" }),
        idxRow({ session_id: "f", app_version: "0.1.616", exit_status: "incomplete" }),
      ],
      10,
    );
    const text = strip(renderByVersion(versionReport, { width: 200, color: false }));
    expect(text).toContain("0.1.607 有 1/2 行未收尾");
    expect(text).toContain("样本偏少");
    expect(text).not.toContain("0.1.616 有");
  });

  test("incomplete 行不计入会话数（被 settled() 剔除）", () => {
    const versionReport = buildByVersion(
      [
        idxRow({ session_id: "a", app_version: "0.1.700", perf_scope: "main" }),
        idxRow({ session_id: "b", app_version: "0.1.700", exit_status: "incomplete" }),
      ],
      10,
    );
    expect(versionReport.versions[0]!.sessions).toBe(1);
    expect(versionReport.versions[0]!.incompleteSessions).toBe(1);
  });
});

describe("A8 按版本视图点名旧口径版本", () => {
  test("有旧口径行时点名版本并说明不可比；全是主循环时不出现", () => {
    const legacy = buildByVersion(
      [idxRow({ session_id: "a", app_version: "0.1.610" })], // 无 perf_scope = 旧口径
      10,
    );
    const legacyText = strip(renderByVersion(legacy, { width: 200, color: false }));
    expect(legacyText).toContain("0.1.610 含旧口径会话");
    expect(legacyText).toContain("不可直接比");

    const current = buildByVersion(
      [idxRow({ session_id: "b", app_version: "0.1.616", perf_scope: "main" })],
      10,
    );
    expect(strip(renderByVersion(current, { width: 200, color: false }))).not.toContain(
      "含旧口径会话",
    );
  });
});
