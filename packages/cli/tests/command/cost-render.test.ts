/**
 * PR-B 渲染层（cost-render.ts）的回归测试。
 *
 * ## 防什么
 *
 * - T-B7 版式：行宽不超终端、窄列（<80）去掉进度条列、金额列对齐成列。
 *   这类缺陷纯数据断言全绿也照样存在（stringWidth 算错 / .length 冒充列宽），
 *   必须对渲染产物逐行断言。
 * - T-B8 无 ANSI：`/cost` 是 headless 命令，非 TTY 输出**一个转义码都不能有**，
 *   否则脚本解析被污染（useColor=false 的 createPainter 必须全面退化）。
 * - 千分位（D15 数字规范）：token 千分位、金额 4 位小数。
 * - 兜底价警告（D11）：入账记录 pricingSource=fallback 的模型必须亮警告行并写模型名。
 * - 「第 N 次」是请求次序不是费用排名（D13 返工回归）。
 *
 * 渲染层测试不 mock SessionState：走真实 buildCostReport → renderCostReport 全链，
 * 只注入进程级单例的假快照（gate / cacheBreaks）。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildCostReport } from "@sid-code/core/session/cost-report.ts";
import { getSideStats, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";
import {
  renderCostReport,
  fmtInt,
  fmtUSD,
  fmtDuration,
  pricingSourceLabel,
} from "../../src/command/commands/cost/cost-render.ts";
import { stringWidth } from "../../src/ui/render-port/text.ts";

const IDLE_GATE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/** 单模型网关价会话（无 fallback、无辅助调用）：版式测试的基线场景。 */
function baseSession(): SessionState {
  resetSideCallStats();
  const ss = new SessionState("cost-render-test");
  ss.setAvailableModels([
    {
      name: "origin-deepseek-v4-1-flash",
      provider: "openai",
      baseURL: "https://uniapi.ruijie.com.cn/v1",
      pricing: {
        input: 0.27397,
        output: 1.09589,
        cacheRead: 0.00548,
        cacheWrite: 0,
        source: "gateway:expr",
      },
    },
  ]);
  ss.updateUsage(
    "origin-deepseek-v4-1-flash",
    { inputTokens: 2_398_645, outputTokens: 17_440, cacheReadInputTokens: 2_199_936 },
    172_315,
    "openai",
    "https://uniapi.ruijie.com.cn/v1",
  );
  return ss;
}

function render(ss: SessionState, opts?: { useColor?: boolean; columns?: number }): string {
  const report = buildCostReport(ss, {
    sideStats: getSideStats(),
    gateStats: IDLE_GATE,
    cacheBreaks: [],
  });
  return renderCostReport(report, {
    useColor: opts?.useColor ?? false,
    columns: opts?.columns ?? 120,
  });
}

describe("T-B7：版式（行宽 / 对齐 / 窄列自适应）", () => {
  test("120 列下每行显示宽度 ≤ 列数（stringWidth，不是 .length）", () => {
    const out = render(baseSession());
    for (const line of out.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(120);
    }
  });

  test("主循环表四行的金额列起始列号相同（对齐成列）", () => {
    const out = render(baseSession());
    const lines = out.split("\n");
    // 主循环表的四行：金额以 `$` 开头，列号 = 金额串首次出现的显示位置
    const idxs = lines
      .filter((l) => /^\s+输入·(未命中|缓存命中|缓存写入)\s|^\s+输出\s/.test(l))
      .map((l) => {
        const m = l.match(/\$0\.\d{4}/);
        if (!m) throw new Error(`金额列未找到: ${JSON.stringify(l)}`);
        return stringWidth(l.slice(0, m.index ?? 0));
      });
    expect(idxs.length).toBe(4);
    expect(new Set(idxs).size).toBe(1);
  });

  test("70 列窄终端：没有进度条列（▰▱），token 与费用保留", () => {
    const out = render(baseSession(), { columns: 70 });
    expect(out).not.toContain("▰");
    expect(out).not.toContain("▱");
    // 窄列保留 token（不再有单价表头——单价列被砍）
    expect(out).toContain("2,398,645");
    for (const line of out.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(70);
    }
  });

  test("每行宽度 ≤ 列数（120 与 70 两组）——中文标签占 2 列", () => {
    const ss = baseSession();
    for (const columns of [120, 70]) {
      const out = render(ss, { columns });
      for (const line of out.split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe("T-B8：无头输出没有 ANSI（useColor=false 全面退化）", () => {
  test("渲染产物里一个转义码都没有", () => {
    const out = render(baseSession());
    expect(out).not.toContain("\x1b[");
    expect(out).not.toContain("\x1b]");
  });

  test("chalk 启用状态下 useColor=false 仍然无 ANSI（变异自证 MUTATION-3 补的用例）", async () => {
    // 测试环境非 TTY，chalk 自动禁色 → applyColor 恒返回原文 → useColor 门恒绿（变异自证
    // 实测：把 wrap 改成无条件着色，测试照样全绿——恒绿门禁比没有门禁更危险）。
    // 所以这里把 chalk.level 提到 3 模拟真终端（先例：tests/ui/diff-ansi-lines.test.ts），
    // 让 useColor 这扇门真正可测：useColor=false → 无转义码；useColor=true → 有。
    const chalk = (await import("chalk")).default;
    const saved = chalk.level;
    chalk.level = 3;
    try {
      const ss = baseSession();
      const report = buildCostReport(ss, {
        sideStats: getSideStats(),
        gateStats: IDLE_GATE,
        cacheBreaks: [],
      });
      const plain = renderCostReport(report, { useColor: false, columns: 120 });
      const colored = renderCostReport(report, { useColor: true, columns: 120 });
      expect(plain).not.toContain("\x1b["); // 门关着：一个转义码都没有
      expect(colored).toContain("\x1b["); // 门开着：真上色（确认上色路径本身没坏）
    } finally {
      chalk.level = saved;
    }
  });

  test("兜底价警告 / 后台任务 / 占比偏高同时在场时仍然没有 ANSI", () => {
    resetSideCallStats();
    const ss = new SessionState("cost-render-ansi");
    // 未知模型 → fallback 警告
    ss.updateUsage(
      "totally-unknown-model-zzz",
      { inputTokens: 10_000, outputTokens: 100 },
      0,
      "openai",
    );
    ss.addSideCost(0.05); // 辅助占比 > 30%
    const report = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: { busy: true, busyLabel: "memory-extract", pendingLabels: [] },
      cacheBreaks: [],
    });
    const out = renderCostReport(report, { useColor: false, columns: 120 });
    expect(out).toContain("totally-unknown-model-zzz 不在定价表中");
    expect(out).toContain("后台任务 memory-extract 进行中");
    expect(out).toContain("占比偏高");
    expect(out).not.toContain("\x1b");
  });
});

describe("数字格式（D15 规范）", () => {
  test("千分位：token 三位一逗，金额 4 位小数", () => {
    expect(fmtInt(2398645)).toBe("2,398,645");
    expect(fmtInt(198709)).toBe("198,709");
    expect(fmtInt(0)).toBe("0");
    expect(fmtUSD(0.085608)).toBe("0.0856");
    expect(fmtUSD(0)).toBe("0.0000");
  });

  test("耗时与 SessionState.formatDuration 同口径", () => {
    expect(fmtDuration(172_315)).toBe("2m52s");
    expect(fmtDuration(71_488)).toBe("1m11s");
    expect(fmtDuration(500)).toBe("500ms");
    expect(fmtDuration(2000)).toBe("2s");
  });

  test("渲染产物带千分位（不是裸数字）", () => {
    const out = render(baseSession());
    expect(out).toContain("2,398,645");
    expect(out).toContain("2,199,936");
    expect(out).not.toMatch(/输入·未命中\s+2398645/);
  });

  test("价格来源 → 人话", () => {
    expect(pricingSourceLabel("gateway:expr")).toBe("网关同步（expr）");
    expect(pricingSourceLabel("fallback")).toBe("兜底价");
    expect(pricingSourceLabel("local")).toBe("本地（不计费）");
    expect(pricingSourceLabel("pricing")).toBe("注册表");
    expect(pricingSourceLabel(undefined)).toBe("注册表");
  });
});

describe("兜底价警告（D11 / T-B6）", () => {
  test("有 fallback 模型：警告行出现并写模型名", () => {
    resetSideCallStats();
    const ss = new SessionState("cost-render-fallback");
    ss.updateUsage(
      "totally-unknown-model-zzz",
      { inputTokens: 10_000, outputTokens: 100 },
      0,
      "openai",
    );
    const out = render(ss);
    expect(out).toContain("⚠ 模型 totally-unknown-model-zzz 不在定价表中");
    // 来源行同步写「兜底价」
    expect(out).toContain("兜底价");
  });

  test("没有 fallback 模型：警告行整段省略", () => {
    const out = render(baseSession());
    expect(out).not.toContain("不在定价表中");
  });
});

describe("「第 N 次」是请求次序（D13）", () => {
  test("最贵的第 1 名显示它在会话里的次序，不是排名 1", () => {
    resetSideCallStats();
    const ss = new SessionState("cost-render-ordinal");
    ss.setAvailableModels([
      {
        name: "m",
        provider: "openai",
        pricing: { input: 0.27, output: 1.1, cacheRead: 0.005, cacheWrite: 0 },
      },
    ]);
    // 第 1 次便宜、第 2 次贵、第 3 次中等、第 4 次最便宜：top 3 只有第 2/3/4 次
    ss.updateUsage("m", { inputTokens: 1_000, outputTokens: 10 }, 0, "openai");
    ss.updateUsage("m", { inputTokens: 1_000_000, outputTokens: 10_000 }, 0, "openai");
    ss.updateUsage("m", { inputTokens: 100_000, outputTokens: 100 }, 0, "openai");
    ss.updateUsage("m", { inputTokens: 2_000, outputTokens: 10 }, 0, "openai");
    const report = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    // 最贵的是第 2 次请求（请求次序），不是 top 列表里的排名 1
    expect(report.perRequest!.top[0]!.index).toBe(2);
    // 第 1 次请求（最便宜）不进 top 3
    expect(report.perRequest!.top.map((t) => t.index)).not.toContain(1);
    const out = renderCostReport(report, { useColor: false, columns: 120 });
    expect(out).toContain("第 2 次  $0.2810");
  });
});

describe("预算与作废重发（D14，有值才显示）", () => {
  test("设了预算：显示 预算: 当前/上限（百分比）", () => {
    resetSideCallStats();
    const ss = new SessionState("cost-render-budget");
    ss.setAvailableModels([
      {
        name: "m",
        provider: "openai",
        pricing: { input: 0.27, output: 1.1, cacheRead: 0.005, cacheWrite: 0 },
      },
    ]);
    ss.updateUsage("m", { inputTokens: 100_000, outputTokens: 1_000 }, 0, "openai");
    const report = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
      costLimitUSD: 0.5,
    });
    const out = renderCostReport(report, { useColor: false, columns: 120 });
    expect(out).toContain("预算: $");
    expect(out).toMatch(/预算: \$[\d.]+ \/ \$0\.5000（\d+%）/);
  });

  test("没设预算：整行省略", () => {
    const out = render(baseSession());
    expect(out).not.toContain("预算:");
  });

  test("有作废重发：显示次数与白烧 token；没有则省略", () => {
    resetSideCallStats();
    const ss = new SessionState("cost-render-discarded");
    ss.setAvailableModels([
      {
        name: "m",
        provider: "openai",
        pricing: { input: 0.27, output: 1.1, cacheRead: 0.005, cacheWrite: 0 },
      },
    ]);
    ss.updateUsage("m", { inputTokens: 50_000, outputTokens: 100 }, 0, "openai", undefined, true); // 作废
    ss.updateUsage("m", { inputTokens: 50_000, outputTokens: 100 }, 0, "openai");
    const report = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: IDLE_GATE,
      cacheBreaks: [],
    });
    const out = renderCostReport(report, { useColor: false, columns: 120 });
    expect(out).toContain("作废重发 1 次");
    expect(out).toContain("白烧 50,000 token");

    expect(render(baseSession())).not.toContain("作废重发");
  });
});
