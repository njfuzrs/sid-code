/**
 * PR3 排版层（context-render.ts）的回归测试。
 *
 * ## 防什么
 *
 * - **行宽超出终端**：这类缺陷纯数据断言全绿也照样存在（`stringWidth` 算错 / `.length`
 *   冒充列宽）。必须在 120 / 80 / 60 三个宽度下逐行断言显示宽度。
 * - **无 ANSI**：`/context` 是 headless 命令，`color: false` 时输出**一个转义码都不能有**，
 *   否则 `-p` / 管道的脚本解析被污染。
 * - **档位不变色**：进度条颜色必须跟着 `level` 走（none 正文色、soft/hard 警告色、
 *   emergency 错误色），与 footer 的 `deriveContextColor` 同源语义。
 * - **数字张冠李戴**：面板上的「已用」「末次请求的真实输入」必须逐字等于 report 字段，
 *   且断言**按行过滤**后再做——整帧 `includes` 会命中标题里的同名数字。
 *
 * 渲染层测试不造手工 report：走真实 `buildContextReport → renderContextReport` 全链，
 * 只有测颜色分档时才替换 `level` 一个字段（渲染层只消费 report，替换单个字段是它的契约）。
 */
import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { buildContextReport } from "@sid-code/core/context/context-report.ts";
import type { ContextReport } from "@sid-code/core/context/context-report.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  renderContextReport,
  fmtInt,
  fmtCompact,
  fmtSigned,
  levelLabel,
} from "../../src/command/commands/context/context-render.ts";
import { stringWidth } from "../../src/ui/render-port/text.ts";

const MEMORY_SECTION = `#### 项目记忆（目录：/m/proj）\n\n- [a](a.md)：${"摘".repeat(200)}`;
const SYSTEM_PROMPT = ["# 身份", "你是一个用于测试的助手。", MEMORY_SECTION].join("\n\n");

function messages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "帮我看看这个文件。".repeat(20) }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先定位文件，再读内容。".repeat(30), signature: "sig" },
        { type: "tool_use", id: "toolu_01", name: "read", input: { file_path: "/tmp/a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "文件内容行\n".repeat(60) },
      ],
    },
  ];
}

function buildReport(overrides: Partial<ContextReport> = {}): ContextReport {
  const mgr = new Manager({ maxTokens: 1_000_000 });
  mgr.setSystemPrompt(SYSTEM_PROMPT);
  mgr.setMessages(messages());
  // 造出「锚点抬升」：连续两次真实 usage 让 EMA 后的校准因子低于第二次比值，
  // 于是 anchorLiftTokens > 0、grossTokens ≠ total（见 breakdown-same-source 状态 3）。
  //
  // 这条前提是必须的，不是凑数：抬升为 0 时 `subtotal === used`，于是
  // 「已用行读 used」与「读 subtotal」输出同一串数字——§8.2 第 11 条的变异
  // （渲染层「已用」改读 grossTokens）会**假绿**。恒绿的断言比没有断言更危险。
  const raw = mgr.estimateTokens(0);
  mgr.recordActualTokens(Math.round(raw * 1.15), 0);
  mgr.recordActualTokens(Math.round(raw * 1.5), 0);
  const report = buildContextReport(mgr, {
    model: "origin-deepseek-v4-1-flash",
    stockPromptTokens: 90_000,
  });
  return { ...report, ...overrides };
}

/** 按行拆分并去掉 ANSI（渲染层在 color=false 下本就没有转义码，这里只是让断言更稳）。 */
function lines(text: string): string[] {
  return text.split("\n");
}

/** 按显示宽度过滤出含某关键字的行（避免整帧 includes 命中标题里的同名数字）。 */
function findLine(text: string, needle: string): string {
  const hit = lines(text).find((l) => l.includes(needle));
  expect(hit).toBeDefined();
  return hit!;
}

describe("PR3 排版层：版式与行宽", () => {
  const report = buildReport();

  for (const width of [120, 80, 60]) {
    test(`宽度 ${width}：每一行的显示宽度都不超过终端宽度`, () => {
      const out = renderContextReport(report, { width, color: false });
      for (const line of lines(out)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  }

  test("各节标题齐全：标题 / 结论 / 构成 / 对账 / 压缩阈值 / 固定开销来源", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    for (const title of ["上下文用量", "结论", "构成", "对账", "压缩阈值", "固定开销来源"]) {
      expect(out).toContain(title);
    }
  });

  test("标题带模型名与窗口（宽列）；窄列去掉模型名", () => {
    const wide = renderContextReport(report, { width: 120, color: false });
    expect(lines(wide)[0]).toContain("origin-deepseek-v4-1-flash");
    expect(lines(wide)[0]).toContain(fmtInt(report.maxTokens));

    const narrow = renderContextReport(report, { width: 60, color: false });
    expect(lines(narrow)[0]).not.toContain("origin-deepseek-v4-1-flash");
    expect(lines(narrow)[0]).toContain("上下文用量");
  });

  test("宽度 < 80 去掉「还剩」列与进度条后的百分比；≥ 80 两者都在", () => {
    const wide = renderContextReport(report, { width: 120, color: false });
    expect(wide).toContain(`${report.percentOfWindow}% / ${report.triggerPercentOfWindow}%`);
    expect(wide).toContain(`~${fmtCompact(report.thresholds[0]!.remaining)}`);

    const narrow = renderContextReport(report, { width: 60, color: false });
    expect(narrow).not.toContain(`${report.percentOfWindow}% / ${report.triggerPercentOfWindow}%`);
    expect(narrow).not.toContain(`~${fmtCompact(report.thresholds[0]!.remaining)}`);
  });

  test("常驻 / 会话两组都在，且小计 / 实测校正 / 本地已释放 / 已用四行齐全", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    expect(out).toContain("常驻（每轮都带）");
    expect(out).toContain("会话");
    for (const label of ["小计", "实测校正", "本地已释放", "已用（= 状态栏）"]) {
      expect(out).toContain(label);
    }
  });
});

describe("PR3 排版层：数字张冠李戴", () => {
  const report = buildReport();

  test("「已用（= 状态栏）」行的数字 === report.used", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    const line = findLine(out, "已用（= 状态栏）");
    expect(line).toContain(fmtInt(report.used));
  });

  test("「末次请求的真实输入」行的数字 === report.lastActualPromptTokens", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    const line = findLine(out, "末次请求的真实输入");
    expect(line).toContain(fmtInt(report.lastActualPromptTokens));
  });

  test("「差额」行 === report.delta（带符号）", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    const line = findLine(out, "差额");
    expect(line).toContain(fmtSigned(report.delta));
  });

  test("会话还没发过请求时，末次实测显示「尚无实测」而不是 0", () => {
    const noActual = buildReport({ lastActualPromptTokens: 0, delta: 0 });
    const out = renderContextReport(noActual, { width: 120, color: false });
    const line = findLine(out, "末次请求的真实输入");
    expect(line).toContain("尚无实测");
    expect(line).not.toContain(" 0 ");
  });

  test("「结论」行带档位人话与距触发还有多远", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    const line = findLine(out, "结论");
    expect(line).toContain(levelLabel(report.level));
    expect(line).toContain(fmtCompact(report.toTrigger));
  });

  test("固定开销来源列出「规则正文与其它」残差行（细目加总 = 母项）", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    if (report.fixedOverhead.residual > 0) {
      expect(out).toContain("规则正文与其它");
      expect(out).toContain(fmtInt(report.fixedOverhead.residual));
    }
  });
});

describe("PR3 排版层：颜色与无 ANSI", () => {
  const report = buildReport();

  test("color: false 时输出不含任何 ANSI 转义", () => {
    const out = renderContextReport(report, { width: 120, color: false });
    expect(out).not.toContain("\x1b[");
  });

  test("color: true 时进度条颜色随档位变化（none / hard / emergency 两两不同）", async () => {
    // 测试环境非 TTY，chalk 自动禁色 → applyColor 恒返回原文 → 「颜色随档位变」恒绿
    // （与 cost-render.test.ts 同一个坑：恒绿门禁比没有门禁更危险）。
    // 把 chalk.level 提到 3 模拟真终端，这扇门才真正可测。
    const chalk = (await import("chalk")).default;
    const saved = chalk.level;
    chalk.level = 3;
    try {
      // level 与 used 必须一起替换：进度条的颜色体现在**已填充段**上，
      // used 很小时填充数为 0，三档都只剩空段（同色）——那不是缺陷，
      // 档位信息在结论行由文字承载。这里要测颜色分档，就得给进度条一点填充。
      const none = renderContextReport(buildReport({ level: "none", used: 500_000 }), {
        width: 120,
        color: true,
      });
      const hard = renderContextReport(buildReport({ level: "hard", used: 500_000 }), {
        width: 120,
        color: true,
      });
      const emergency = renderContextReport(buildReport({ level: "emergency", used: 500_000 }), {
        width: 120,
        color: true,
      });
      // 进度条行用 ▱ 定位（used 很小时已填充段为 0，找不到 ▰）
      const barOf = (s: string) => findLine(s, "▱");
      expect(barOf(hard)).not.toBe(barOf(none));
      expect(barOf(emergency)).not.toBe(barOf(hard));
      expect(barOf(none)).not.toBe(barOf(emergency));
    } finally {
      chalk.level = saved;
    }
  });

  test("color: true 时输出含 ANSI，但仍能按行过滤出数字", async () => {
    const chalk = (await import("chalk")).default;
    const saved = chalk.level;
    chalk.level = 3;
    try {
      const out = renderContextReport(report, { width: 120, color: true });
      expect(out).toContain("\x1b[");
    } finally {
      chalk.level = saved;
    }
  });
});

describe("PR3 排版层：提示与边界", () => {
  test("提示不超过 3 条且带「提示」前缀", () => {
    const report = buildReport({
      hints: ["提示一", "提示二", "提示三", "提示四"],
    });
    const out = renderContextReport(report, { width: 120, color: false });
    expect(out.split("\n").filter((l) => l.startsWith("提示")).length).toBeLessThanOrEqual(3);
  });

  test("小窗口：阈值表只有 emergency / blocking，且 blocking 说明「不调用模型」", () => {
    const mgr = new Manager({ maxTokens: 32_000 });
    mgr.setMessages(messages());
    const report = buildContextReport(mgr, { model: "small-model" });
    const out = renderContextReport(report, { width: 120, color: false });
    expect(out).toContain("紧急截断");
    expect(out).toContain("强制截断");
    expect(out).not.toContain("遮罩工具输出");
    expect(out).toContain("不调用模型，最后防线");
  });

  test("无固定开销来源时整节省略（不输出空标题）", () => {
    const report = buildReport({
      fixedOverhead: { sources: [], hints: [], residual: 0 },
    });
    const out = renderContextReport(report, { width: 120, color: false });
    expect(out).not.toContain("固定开销来源");
  });

  test("同一份 report + 同一份选项，输出逐字节确定（纯函数）", () => {
    const report = buildReport();
    const a = renderContextReport(report, { width: 100, color: false });
    const b = renderContextReport(report, { width: 100, color: false });
    expect(a).toBe(b);
  });
});

describe("PR3 跨层对账：面板「已用」百分比 === footer 的 contextPercent", () => {
  test("同一个 ctxMgr，两处百分比逐字相等", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setSystemPrompt(SYSTEM_PROMPT);
    mgr.setMessages(messages());
    // footer 的 contextPercent 取的就是 getContextUsageForDisplay().percentOfWindow
    const footerPercent = mgr.getContextUsageForDisplay(0).percentOfWindow;

    const report = buildContextReport(mgr, { model: "m", stockPromptTokens: 12_345 });
    const out = renderContextReport(report, { width: 120, color: false });

    // 结论行里的「（N%）」就是进度条与 footer 同口径的那个数
    const conclusion = findLine(out, "结论");
    expect(conclusion).toContain(`（${footerPercent}%）`);
    expect(report.percentOfWindow).toBe(footerPercent);
  });
});
