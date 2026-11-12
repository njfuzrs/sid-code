/**
 * D19（2026-11-10 成本口径核查）：`/stats text` 的 token 数没有千分位、没标口径。
 *
 * ## 它防的是什么
 *
 * `/debug` 一直有千分位、也标了 flow/stock（D3 之后），而 `/stats text` 仍是
 * `输入 2398645 / 输出 17440`：大数肉眼数不清位数，而且用户不知道「输入」是
 * 累计发送（flow）还是当前上下文（stock）—— 后者只有在 Footer 的 `↑` 上才用。
 *
 * 判据两条：
 * 1. 千分位真的加了（断言逗号形态，而不是只断言数字出现 —— 后者在两种写法下都通过）；
 * 2. 口径写清了，且 flow 与 stock 是**两个不同的源字段**（70,000 vs 40,000）。
 *    只写一句「累计发送」但不给 stock 行，用户仍然解释不了 Footer 的 ↑ 为何差 24 倍。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { StatsCommand } from "../../src/command/commands/stats/stats.ts";

/**
 * 两次 openai 族请求：flow = 30,000 + 40,000 = 70,000，stock = 末次 40,000。
 * 与 `/cost`、`/debug` 的口径测试（cost-token-scope.test.ts）用同一组数字，
 * 保证三个入口可以互相验算。
 */
function sessionTwoRequests(): SessionState {
  const ss = new SessionState("stats-text-format-test");
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
    ctxMgr: { getTurnCount: () => 2, messageCount: () => 7 },
    config: { model: "gpt-test", provider: "openai" },
    cwd: process.cwd(),
    traceCollector: undefined,
  };
}

async function runStatsText(ss: SessionState): Promise<string> {
  const result = (await new StatsCommand().call("text", ctxOf(ss))) as { value: string };
  return result.value;
}

describe("D19 — /stats text 的 token 千分位与口径", () => {
  test("输入是 flow（累计发送）且带千分位", async () => {
    const out = await runStatsText(sessionTwoRequests());
    expect(out).toContain("输入 70,000（累计发送，flow）");
    // 反向：未格式化的裸数字不能被当成「看起来像」通过。
    expect(out).not.toContain("输入 70000");
  });

  test("输出标累计且带千分位", async () => {
    const out = await runStatsText(sessionTwoRequests());
    expect(out).toContain("输出 300（累计）");
  });

  test("单独一行显示当前上下文（stock），并指向状态栏 ↑", async () => {
    const out = await runStatsText(sessionTwoRequests());
    // stock 是末次请求的大小（40,000），不是 flow 的 70,000 —— 两行必须是不同字段。
    expect(out).toContain("当前上下文：40,000（stock");
    expect(out).toContain("状态栏 ↑ 同一口径");
    expect(out).not.toContain("当前上下文：70,000");
  });

  test("六位数以上的 token 也带千分位（不是只给短数字加）", async () => {
    const ss = new SessionState("stats-text-format-test-large");
    ss.updateUsage("gpt-test", { inputTokens: 2_398_645, outputTokens: 17_440 }, 1, "openai");
    const out = await runStatsText(ss);
    expect(out).toContain("输入 2,398,645（累计发送，flow）");
    expect(out).toContain("输出 17,440（累计）");
    expect(out).toContain("当前上下文：2,398,645（stock");
  });
});
