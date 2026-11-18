/**
 * A7 / PR5：「当前上下文」改为会话级单值（stock 口径）的回归用例。
 *
 * 对应方案 §4.5 与附录 B 的 P6 探针。修复前的症状（P6 实测
 * 129031 → 1200000 → 1500000 → 431000）：
 * - 子代理 usage-sink 的**累计值**覆盖主会话「当前上下文」；
 * - `/model` 切换后跨模型求和，把两个上下文窗口叠成一个数。
 *
 * 修复后的口径：`mainContextStock` 只由主循环的有效调用写（`stock: "main"`，默认），
 * 子代理 sink 显式传 `"none"`，作废重试由 `discarded` 挡住；快照带这个字段，
 * 旧快照回退到「当前主模型」那一份明细，不回退到求和。
 */

import { describe, test, expect } from "bun:test";
import {
  SessionState,
  type ModelUsageStats,
  type UsageSnapshot,
} from "@sid-code/core/session/state.ts";
import { createSubAgentUsageSink } from "@sid-code/core/agent/usage-sink.ts";
import type { SubAgentResult } from "@sid-code/core/agent/sub-agent.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

/** 构造最小可用的子代理结果（sink 只读 usage / model / provider / apiRequests）。 */
function subAgentResult(over: {
  usage: Usage;
  model?: string;
  provider?: string;
  apiRequests?: number;
}): SubAgentResult {
  return { success: true, output: "", turns: 1, toolUseCount: 0, ...over };
}

/** 构造一份合法的按模型明细（hydrateUsage 只读 stockPromptTokens 等少数几个字段）。 */
function modelStats(stockPromptTokens: number): ModelUsageStats {
  return {
    inputTokens: stockPromptTokens,
    stockPromptTokens,
    cumulativePromptTokens: stockPromptTokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    requests: 1,
    costUSD: 0,
    cacheSavingsUSD: 0,
    provider: "deepseek",
  };
}

describe("P6：子代理 sink 不再写「当前上下文」（A7 / PR5）", () => {
  test("四步与方案附录 B「应为」列逐位一致", () => {
    const s = new SessionState("s-p6");

    // 第 1 步：主循环一次调用。deepseek 口径 promptTotal = prompt_tokens = 129031
    s.updateUsage(
      "deepseek-chat",
      {
        inputTokens: 129_031,
        outputTokens: 676,
        cacheReadInputTokens: 127_232,
        cacheCreationInputTokens: 0,
      },
      1000,
      "deepseek",
    );
    expect(s.getStockPromptTokens()).toBe(129_031);

    // 第 2 步：子代理 30 轮累计 120 万 —— **不得**进入会话级单值
    createSubAgentUsageSink(s, { model: "deepseek-chat" })(
      subAgentResult({
        usage: {
          inputTokens: 1_200_000,
          outputTokens: 9000,
          cacheReadInputTokens: 1_100_000,
          cacheCreationInputTokens: 0,
        },
        model: "deepseek-chat",
        provider: "deepseek",
        apiRequests: 30,
      }),
    );
    expect(s.getStockPromptTokens()).toBe(129_031);

    // 第 3 步：另一个模型的子代理（deepseek-flash），同样不入会话级单值
    createSubAgentUsageSink(s, { model: "deepseek-chat" })(
      subAgentResult({
        usage: {
          inputTokens: 300_000,
          outputTokens: 2000,
          cacheReadInputTokens: 250_000,
          cacheCreationInputTokens: 0,
        },
        model: "deepseek-flash",
        provider: "deepseek",
        apiRequests: 10,
      }),
    );
    expect(s.getStockPromptTokens()).toBe(129_031);

    // 第 4 步：主循环下一轮，覆盖为新值（stock 是末次，不是累加）
    s.updateUsage(
      "deepseek-chat",
      {
        inputTokens: 131_000,
        outputTokens: 500,
        cacheReadInputTokens: 129_000,
        cacheCreationInputTokens: 0,
      },
      1000,
      "deepseek",
    );
    expect(s.getStockPromptTokens()).toBe(131_000);
  });

  test("子代理仍写按模型明细，只是不进会话级单值", () => {
    const s = new SessionState("s-p6-detail");
    s.updateUsage("deepseek-chat", { inputTokens: 1000, outputTokens: 10 }, 100, "deepseek");
    createSubAgentUsageSink(s, { model: "deepseek-chat" })(
      subAgentResult({
        usage: { inputTokens: 50_000, outputTokens: 100 },
        model: "deepseek-flash",
        provider: "deepseek",
        apiRequests: 5,
      }),
    );
    // 会话级单值不受影响
    expect(s.getStockPromptTokens()).toBe(1000);
    // 但按模型明细（/stats、/cost 拆解用）照常记录，requests 也按真实请求数累加
    expect(s.modelUsage["deepseek-flash"].stockPromptTokens).toBe(50_000);
    expect(s.modelUsage["deepseek-flash"].requests).toBe(5);
  });
});

describe("会话级单值的覆盖语义（A7 / PR5）", () => {
  test("/model 切换后取新模型的末次输入，不叠加两个上下文窗口", () => {
    const s = new SessionState("s-switch");
    s.updateUsage(
      "claude-sonnet-4-20250514",
      { inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 127_031 },
      100,
      "anthropic",
    );
    // anthropic 口径：2000 + 127031 = 129031
    expect(s.getStockPromptTokens()).toBe(129_031);

    // /model 切到另一个模型：新上下文只有 50k，旧模型的 129k 已经不在上下文里
    s.updateUsage(
      "deepseek-chat",
      { inputTokens: 50_000, outputTokens: 100, cacheReadInputTokens: 45_000 },
      100,
      "deepseek",
    );
    expect(s.getStockPromptTokens()).toBe(50_000);
  });

  test("作废重试（discarded）不覆盖会话级单值，但 flow 口径照记", () => {
    const s = new SessionState("s-discarded");
    s.updateUsage("deepseek-chat", { inputTokens: 129_031, outputTokens: 10 }, 100, "deepseek");
    const cumulativeBefore = s.getCumulativePromptTokens();

    // 作废尝试：prompt 已发到服务端（计费），响应被丢弃（不进上下文）
    s.updateUsage(
      "deepseek-chat",
      { inputTokens: 999_999, outputTokens: 0 },
      0,
      "deepseek",
      undefined,
      true, // discarded
    );
    expect(s.getStockPromptTokens()).toBe(129_031);
    // billable 口径照常累加 —— 钱是真花了
    expect(s.getCumulativePromptTokens()).toBe(cumulativeBefore + 999_999);
  });

  test("/clear（rotate）后归零：新会话没有历史上下文", () => {
    const s = new SessionState("s-rotate");
    s.updateUsage("deepseek-chat", { inputTokens: 80_000, outputTokens: 10 }, 100, "deepseek");
    expect(s.getStockPromptTokens()).toBe(80_000);
    s.rotate("s-rotate-new");
    expect(s.getStockPromptTokens()).toBe(0);
  });
});

describe("会话级单值的快照读写（A7 / PR5）", () => {
  test("新快照 round-trip：mainContextStock 逐位还原", () => {
    const orig = new SessionState("s-snap");
    orig.updateUsage(
      "claude-sonnet-4-20250514",
      { inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 127_031 },
      100,
      "anthropic",
    );
    const snap = orig.serializeUsageSnapshot();
    expect(snap.mainContextStock).toBe(129_031);

    const restored = new SessionState("s-snap-resumed");
    restored.hydrateUsage(snap, "claude-sonnet-4-20250514");
    expect(restored.getStockPromptTokens()).toBe(129_031);
  });

  test("旧快照（无 mainContextStock）回退到当前主模型那份，不回退到求和", () => {
    const oldSnap: UsageSnapshot = {
      totalCostUSD: 0,
      sideCostUSD: 0,
      totalAPIDuration: 0,
      totalToolDuration: 0,
      modelUsage: {
        // 模拟 /model 切换过的旧会话：两份明细，求和 = 55000
        "claude-sonnet-4-20250514": modelStats(43_000),
        "deepseek-chat": modelStats(12_000),
      },
    };
    const s = new SessionState("s-old-snap");
    s.hydrateUsage(oldSnap, "deepseek-chat");
    // 取当前主模型那一份，不叠加旧模型
    expect(s.getStockPromptTokens()).toBe(12_000);
  });

  test("旧快照 + 拿不到当前模型：保持 0，不猜一个求和值", () => {
    const oldSnap: UsageSnapshot = {
      totalCostUSD: 0,
      sideCostUSD: 0,
      totalAPIDuration: 0,
      totalToolDuration: 0,
      modelUsage: {
        "claude-sonnet-4-20250514": modelStats(43_000),
        "deepseek-chat": modelStats(12_000),
      },
    };
    const s = new SessionState("s-old-snap-no-model");
    s.hydrateUsage(oldSnap);
    expect(s.getStockPromptTokens()).toBe(0);
  });
});
