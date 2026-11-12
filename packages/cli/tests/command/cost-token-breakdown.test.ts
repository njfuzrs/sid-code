/**
 * /cost 的 token 段：归一化互斥三段 + 千分位（D5，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * 同一个「输入」字段在两族协议下含义**相反**：
 * - openai 族：`prompt_tokens` 本来就包含缓存命中部分；
 * - anthropic 族：`input_tokens` 是未命中余量，与缓存读/写互斥。
 *
 * 旧实现直接贴 `getTotalUsage().inputTokens` 再并列一行「缓存读取」，openai 族会话里
 * 用户会把两行相加当成总量（实测 2,398,645 + 2,199,936，真实未命中只有 198,709）。
 * 另外 /cost 的 token 数是裸数字（`2398645`），/debug 却是 `2,398,645`。
 *
 * 修法：统一走 `getNormalizedCacheUsage()`（与命中率/省钱/计价的单一事实源），
 * 拆成 未命中 / 命中 / 写入 三段 + 合计，全部千分位。
 *
 * ## 为什么走真实 CostCommand + 真实 SessionState
 *
 * 缺陷形态是「展示层直接读了 provider 原始字段而不是归一化视图」，
 * mock 掉 SessionState 就测不到这一层，只能测到字符串拼接。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { CostCommand } from "../../src/command/commands/cost/cost.ts";
import type { PendingTasksView } from "../../src/command/commands/cost/cost.ts";

/** 后台闸门注入空闲状态：真实闸门是进程级单例，测试不碰它（理由见 cost-pending-tasks.test.ts）。 */
const IDLE: PendingTasksView = { busy: false, busyLabel: null, pendingLabels: [] };

async function runCost(ss: SessionState): Promise<string> {
  const ctx = { sessionState: ss, config: { provider: "openai" } } as any;
  const result = (await new CostCommand(() => IDLE).call("", ctx)) as { value: string };
  return result.value;
}

describe("/cost token 三段互斥与千分位（D5）", () => {
  test("openai 族：「输入」不再包含命中，拆成未命中/命中/合计，全部千分位", async () => {
    const ss = new SessionState("cost-token-breakdown-test");
    // 取证会话第一段的真实数字：累计发送 2,398,645，命中 2,199,936 → 未命中 198,709
    ss.updateUsage(
      "gpt-test",
      { inputTokens: 2_398_645, outputTokens: 17_440, cacheReadInputTokens: 2_199_936 },
      1,
      "openai",
    );
    const out = await runCost(ss);
    expect(out).toContain("输入·未命中: 198,709");
    expect(out).toContain("输入·缓存命中: 2,199,936");
    // D3（#760）起合计行带 stock/flow 口径标注，D5 的千分位同样作用在这一行
    expect(out).toContain("输入·合计（累计发送，flow）: 2,398,645");
    expect(out).toContain("输出（累计）: 17,440");
    // 裸数字（无千分位）不能再出现——这正是修复前的现场
    expect(out).not.toContain("2398645");
    expect(out).not.toContain("2199936");
    // 三段互斥：未命中 + 命中 = 合计（写入为 0 时省略，不参与加法）
    expect(out).not.toContain("输入·缓存写入");
  });

  test("anthropic 族：input 是未命中余量，不重复计入命中", async () => {
    const ss = new SessionState("cost-token-breakdown-test");
    ss.updateUsage(
      "claude-test",
      {
        inputTokens: 500,
        outputTokens: 100,
        cacheReadInputTokens: 8_000,
        cacheCreationInputTokens: 1_500,
      },
      1,
      "anthropic",
    );
    const out = await runCost(ss);
    expect(out).toContain("输入·未命中: 500");
    expect(out).toContain("输入·缓存命中: 8,000");
    expect(out).toContain("输入·缓存写入: 1,500");
    // 合计 = 500 + 8,000 + 1,500，不能是 500（旧「输入」只显示未命中余量）
    expect(out).toContain("输入·合计（累计发送，flow）: 10,000");
  });

  test("命中与写入都为 0 时两行都省略，合计仍等于未命中", async () => {
    const ss = new SessionState("cost-token-breakdown-test");
    ss.updateUsage("gpt-test", { inputTokens: 1_000, outputTokens: 50 }, 1, "openai");
    const out = await runCost(ss);
    expect(out).toContain("输入·未命中: 1,000");
    expect(out).toContain("输入·合计（累计发送，flow）: 1,000");
    expect(out).not.toContain("输入·缓存命中");
    expect(out).not.toContain("输入·缓存写入");
  });

  test("多模型混用两族：分模型 input 之和 = 汇总「输入·合计」，且都带千分位", async () => {
    const ss = new SessionState("cost-token-breakdown-test");
    // openai：cumulativePromptTokens 含命中 → promptTotal = 10,000
    ss.updateUsage(
      "gpt-test",
      { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 6_500 },
      1,
      "openai",
    );
    // anthropic：input 是未命中余量 → promptTotal = 500 + 8,000 + 1,500 = 10,000
    ss.updateUsage(
      "claude-test",
      {
        inputTokens: 500,
        outputTokens: 100,
        cacheReadInputTokens: 8_000,
        cacheCreationInputTokens: 1_500,
      },
      1,
      "anthropic",
    );
    const out = await runCost(ss);
    expect(out).toContain("输入·合计（累计发送，flow）: 20,000");
    // 两个模型各自的 input= 都是 10,000（OpenAI 族若直接贴 cumulativePromptTokens
    // 也对，但 anthropic 族若直接贴就是 500，会与汇总对不上）
    expect(out.match(/input=10,000/g)?.length).toBe(2);
  });
});
