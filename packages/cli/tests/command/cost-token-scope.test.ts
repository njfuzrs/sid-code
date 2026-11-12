/**
 * D3（2026-11-10 成本口径核查）：stock 和 flow 两种 token 口径都没标注。
 *
 * ## 它防的是什么
 *
 * 同一个会话里，Footer 的 `↑` 是 **stock**（最后一次请求的完整 prompt = 当前上下文大小，
 * 来自 `SessionState.getStockPromptTokens()`），而 `/cost`、`/debug` 的「输入」是 **flow**
 * （Σ 每次请求的 prompt，来自 `getTotalUsage().inputTokens` = ΣcumulativePromptTokens）。
 * 两个数都对，但界面上都只叫「输入」，用户必然以为其中一个算错了（取证会话里
 * 99,126 vs 2,398,645，差 24 倍）。
 *
 * 修法是**两处都标明口径**并把它们连起来（「状态栏 ↑ 显示的就是它」），不是改数值。
 * 所以测试的判据是：
 * 1. 两行都存在且各自带上口径字样；
 * 2. 两行取的是**不同的字段**（flow 大于 stock，且分别等于对应源字段）——
 *    防「两行都读同一个字段」这种看起来标了、实际仍是同一口径的假修复；
 * 3. /debug 与 /cost 用同一组数字、同一套说法（同一指标一种口径，不许两个入口两种措辞）。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { CostCommand } from "../../src/command/commands/cost/cost.ts";
import debugCommand from "../../src/command/commands/debug/debug.ts";

const IDLE = { busy: false, busyLabel: null, pendingLabels: [] as string[] };

/**
 * 两次 openai 族请求：flow = 30,000 + 40,000 = 70,000，stock = 末次 40,000。
 * openai 族的 prompt_tokens 本就含命中，`normalizeCacheUsage` 的 promptTotal = inputTokens，
 * 所以这组数字同时能验「stock 是末次值、flow 是累加值」这个区别本身。
 */
function sessionTwoRequests(): SessionState {
  const ss = new SessionState("cost-token-scope-test");
  ss.updateUsage(
    "gpt-test",
    { inputTokens: 30_000, outputTokens: 100, cacheReadInputTokens: 20_000 },
    1,
    "openai",
  );
  ss.updateUsage(
    "gpt-test",
    { inputTokens: 40_000, outputTokens: 200, cacheReadInputTokens: 30_000 },
    1,
    "openai",
  );
  return ss;
}

function ctxOf(ss: SessionState): any {
  return {
    sessionState: ss,
    config: { model: "gpt-test", provider: "openai" },
    cwd: process.cwd(),
    traceCollector: undefined,
  };
}

async function runCost(ss: SessionState): Promise<string> {
  const result = (await new CostCommand(() => IDLE).call("", ctxOf(ss))) as { value: string };
  return result.value;
}

async function runDebug(ss: SessionState): Promise<string> {
  const result = (await debugCommand.call("", ctxOf(ss))) as { value: string };
  return result.value;
}

describe("/cost 标注 stock / flow 两种 token 口径（D3）", () => {
  // D15 版式重做后（PR-B）：两个口径并到一行「累计发送 X（flow…） · 当前上下文 Y（stock…）」，
  // 数字带千分位。口径标注语义不变，锚点随版式更新。
  test("flow 用累计发送口径，stock 用当前上下文口径，且指向状态栏 ↑", async () => {
    const out = await runCost(sessionTwoRequests());
    // flow：两次请求之和 70,000（不是末次 40,000）
    expect(out).toContain("累计发送 70,000（flow，每次请求的 prompt 都计入）");
    // stock：末次请求 40,000（不是累加 70,000）
    expect(out).toContain("当前上下文 40,000（stock，末次请求；状态栏 ↑ 显示的就是它）");
    // 两个口径的桥梁：用户看到 Footer 的 ↑ 时知道它对应哪一行
    expect(out).toContain("状态栏 ↑");
  });

  test("两行取的不是同一个字段（防「都标了、读的是同一个值」）", async () => {
    const ss = sessionTwoRequests();
    const out = await runCost(ss);
    const flow = ss.getTotalUsage().inputTokens;
    const stock = ss.getStockPromptTokens();
    expect(flow).toBe(70_000);
    expect(stock).toBe(40_000);
    expect(flow).not.toBe(stock);
    // D15 版式带千分位：70,000 / 40,000。断言用源字段值拼千分位（不是手抄常量），
    // 防「源字段换口径、断言还锁着旧值」的假绿。
    const fmtInt = (n: number) => n.toLocaleString("en-US");
    expect(out).toContain(`累计发送 ${fmtInt(flow)}（flow`);
    expect(out).toContain(`当前上下文 ${fmtInt(stock)}（stock`);
  });
});

describe("/debug 标注 stock / flow 两种 token 口径（D3）", () => {
  test("入 标 flow、当前上下文标 stock，数字与 /cost 同源", async () => {
    const ss = sessionTwoRequests();
    const costOut = await runCost(ss);
    const debugOut = await runDebug(ss);

    expect(debugOut).toContain("入 70,000（累计发送, flow）");
    expect(debugOut).toContain("当前上下文 : 40,000（stock");
    expect(debugOut).toContain("状态栏 ↑");

    // 两个入口同一指标同一数字：截图对账时不许出现「/cost 和 /debug 又对不上」。
    // /cost 的锚点随 D15 版式更新（口径并到一行、千分位），/debug 未在本次范围（自有版式）。
    const pick = (out: string, re: RegExp): string => out.match(re)?.[1] ?? "";
    expect(pick(debugOut, /入 ([\d,]+)（累计发送/)).toBe("70,000");
    expect(pick(costOut, /累计发送 ([\d,]+)（flow/)).toBe("70,000");
    expect(pick(debugOut, /当前上下文 : ([\d,]+)（stock/)).toBe("40,000");
    expect(pick(costOut, /当前上下文 ([\d,]+)（stock/)).toBe("40,000");
  });
});
