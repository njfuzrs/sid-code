/**
 * /cost 的范围标注与辅助调用 token 段（D4，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * /cost 的「总费用」含辅助调用（`totalCostUSD + sideCostUSD`），但 token / 请求数 /
 * 缓存命中率 / 省钱 / API 耗时全部只来自主循环（`modelUsage` / `totalAPIDuration`）。
 * 两种范围混在一个面板上却不标注，用户拿「费用 ÷ token」估单价必然偏高，
 * 「省钱 vs 费用」也是两个不同范围在比（北极星铁律 3：分母口径必须和指标一起写死）。
 *
 * 修法不是把辅助调用并进 `modelUsage`（会污染 stock 口径的上下文大小），
 * 而是**分两块显示、各自标明范围**：主循环一块，辅助调用一块。
 *
 * ## 为什么统计源可注入
 *
 * `side-call-sink` 是进程级单例，`bun test` 同批多文件跑在同一进程里。
 * 测试若直接 `recordSideCall` / `resetSideCallStats`，会让别的测试文件的 /cost 输出
 * 凭空多出辅助段、或清掉别人刚 hydrate 的基线。所以 `CostCommand` 的读取函数可注入，
 * 行为层全部用假快照；「默认读会话维度而非进程维度」另用一条静态断言锁住
 * （`getSessionSideStats` 的语义本身已有 core 测试覆盖）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { SideCallSnapshot } from "@sid-code/core/trace/side-call-sink.ts";
import {
  CostCommand,
  formatSideCallTokenSection,
  type PendingTasksView,
} from "../../src/command/commands/cost/cost.ts";

const IDLE: PendingTasksView = { busy: false, busyLabel: null, pendingLabels: [] };

/** 无辅助调用：会话只跑了主循环 */
const NO_SIDE: SideCallSnapshot = {
  apiCalls: 0,
  costUSD: 0,
  tokensSent: 0,
  tokensReceived: 0,
  failed: 0,
  timedOut: 0,
  byLabel: {},
};

/** 取证会话第一段的辅助调用累计（方案文档 2.2 节 `side_tokens_sent` / `side_tokens_received`） */
const SIDE_SAMPLE: SideCallSnapshot = {
  apiCalls: 6,
  costUSD: 0.0645,
  tokensSent: 547_419,
  tokensReceived: 4_152,
  failed: 0,
  timedOut: 0,
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

async function runCost(ss: SessionState, side: SideCallSnapshot = NO_SIDE): Promise<string> {
  const ctx = { sessionState: ss, config: { provider: "openai" } } as any;
  const result = (await new CostCommand(
    () => IDLE,
    () => side,
  ).call("", ctx)) as {
    value: string;
  };
  return result.value;
}

describe("D4 · 辅助调用 token 段（纯函数）", () => {
  test("没有辅助调用时返回空数组：整段省略，不给正常路径加噪音", () => {
    expect(formatSideCallTokenSection(NO_SIDE)).toEqual([]);
  });

  test("有辅助调用时写出次数与输入/输出 token，并声明不计入主循环", () => {
    const lines = formatSideCallTokenSection(SIDE_SAMPLE);
    const text = lines.join("\n");
    expect(text).toContain("辅助调用 Token 用量（6 次调用");
    expect(text).toContain("不计入上面的主循环数字");
    expect(text).toContain("输入: 547419");
    expect(text).toContain("输出: 4152");
  });
});

describe("D4 · /cost 输出里每个指标都标明范围", () => {
  test("总费用标明含辅助调用（它是面板上唯一含辅助的指标）", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    const costLine = out.split("\n").find((l) => l.startsWith("总费用:"));
    expect(costLine).toBeDefined();
    expect(costLine!).toContain("（含辅助调用）");
  });

  test("主循环 token 段标题标明不含辅助调用、含子代理，并给出请求数", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("主循环 Token 用量（累计，不含辅助调用；含子代理）:");
    expect(out).toContain("请求: 1 次");
  });

  test("缓存命中率与省钱标明仅主循环", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    const cacheLine = out.split("\n").find((l) => l.startsWith("缓存命中率:"));
    expect(cacheLine).toBeDefined();
    expect(cacheLine!).toContain("（仅主循环，不含辅助调用）");
  });

  test("API 耗时标明仅主循环", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    const apiLine = out.split("\n").find((l) => l.startsWith("API 耗时:"));
    expect(apiLine).toBeDefined();
    expect(apiLine!).toContain("（仅主循环）");
  });
});

describe("D4 · 两块 token 互不包含", () => {
  test("没有辅助调用：输出里不出现辅助段", async () => {
    const out = await runCost(mainLoopSession(), NO_SIDE);
    expect(out).not.toContain("辅助调用 Token 用量");
  });

  test("有辅助调用：辅助段出现，且数字来自统计快照", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    expect(out).toContain("辅助调用 Token 用量（6 次调用");
    expect(out).toContain("输入: 547419");
    expect(out).toContain("输出: 4152");
  });

  test("主循环输入与辅助输入分开显示，不会相加成一个数", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    // 主循环段 = modelUsage 的累计 prompt（10000）；辅助段 = side-call-sink 的发送量（547419）
    expect(out).toContain("输入: 10000");
    expect(out).toContain("输入: 547419");
    // 相加值绝不能出现——出现就说明有人把两块合并了，D4 会以另一种形态复发
    expect(out).not.toContain("输入: 557419");
  });

  test("辅助段排在主循环各块之后（范围切换只发生一次）", async () => {
    const out = await runCost(mainLoopSession(), SIDE_SAMPLE);
    const lines = out.split("\n");
    const cacheIdx = lines.findIndex((l) => l.startsWith("缓存命中率:"));
    const sideIdx = lines.findIndex((l) => l.startsWith("辅助调用 Token 用量"));
    expect(sideIdx).toBeGreaterThan(cacheIdx);
  });
});

describe("D4 · 接线：默认读会话维度而非进程维度", () => {
  test("默认统计源是 getSessionSideStats（resume 后与费用同口径）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "command", "commands", "cost", "cost.ts"),
      "utf-8",
    );
    // 只锁「导入」与「默认值」两处接线，不锁注释：说明为什么不用 getSideStats 的注释里
    // 必然出现那个函数名，按全文 grep 会把解释文字当成违规。
    expect(src).toMatch(
      /import\s*\{[^}]*\bgetSessionSideStats\b[^}]*\}\s*from\s*"@sid-code\/core\/trace\/side-call-sink\.ts"/,
    );
    expect(src).toMatch(/=\s*\(\)\s*=>\s*getSessionSideStats\(\)/);
    // 进程维度 getSideStats 在 resume 会话里只剩本次启动的记录，而 /cost 的费用含回灌基线，
    // 用它会重新制造「token 只含本次启动、费用含全会话」的范围错位（正是 D4 的形态）。
    expect(src).not.toMatch(/\bimport\s*\{[^}]*\bgetSideStats\b[^}]*\}/);
    expect(src).not.toMatch(/=\s*\(\)\s*=>\s*getSideStats\s*\(/);
  });
});
