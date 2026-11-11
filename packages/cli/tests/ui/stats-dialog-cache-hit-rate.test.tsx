/**
 * `/stats` 面板「缓存命中」必须是命中量与真实命中率（D9，P0），单价必须按模型端点取。
 *
 * 真实 bug（2026-11-10 /cost 口径核查发现，取证会话 20261110-142303-21c3a481）：
 *
 *   const cacheHitRate = Math.round((stockInputTokens / inputTokens) * 100);
 *
 * 分子是「末次请求的完整 prompt」（stock 快照 99,126），分母是「累计发送的 prompt」
 * （flow 累加 2,398,645）—— 两个口径相除不是命中率，本会话算成 4%，真实 91.7%。
 * 同一行显示的值当时也是 `stockInputTokens`，即「当前上下文大小」，不是命中量。
 *
 * 第二处（同一 D9 条目）：`DialogSwitch` 给 StatsDialog 的单价是
 * `resolvePricingUSD(model, availableModels)`，**缺 baseURL**。计价按「模型名 + 端点」
 * 复合键，同名模型在不同渠道价不同 —— 面板上那条单价可能压根不是实际计费的那条。
 *
 * 数据来源：取证会话第一段（06:28:50 截断）的 `session.traj` 快照。
 * 两条 updateUsage 即可构造出同样的累计与末次值，不需要 31 条逐次明细。
 *
 * 变异自证：
 *  - 命中率改回 `stockInputTokens / inputTokens`（或整行改回 stock 值）→ 用例 1 红
 *    （帧里出现 4%，不出现 91.7% / 2,199,936）。
 *  - `resolvePricingUSD` 的第三个参数（modelBaseURL）去掉 → 用例 3 红：
 *    没端点会走跨端点兜底，先借到另一个端点的价 9 而不是本端点的 1。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { StatsDialog } from "@sid-code/cli/ui/components/StatsDialog.tsx";
import { DialogSwitch } from "@sid-code/cli/ui/components/DialogSwitch.tsx";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  loadGatewayCache,
  __resetGatewayPricingForTest,
} from "@sid-code/core/llm/gateway-pricing.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

const MODEL = "origin-deepseek-v4-1-flash";

// 网关采集价是磁盘缓存 + 模块级内存，必须隔离到 tmpdir 并显式 reset：
// dev 机上的真实 gateway-pricing.json 会让「端点到价」的断言随环境时挂时过。
let tmpDir: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "stats-cache-hit-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetGatewayPricingForTest();
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetGatewayPricingForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * 构造取证会话第一段的累计画像：
 * 累计 prompt 2,398,645 = 未命中 198,709 + 命中 2,199,936；输出 17,440；
 * 末次请求的完整 prompt（stock）99,126 → 真实命中率 2,199,936 / 2,398,645 = 91.7%。
 */
function buildSession(): SessionState {
  const ss = new SessionState("stats-cache-hit-test");
  ss.updateUsage(
    MODEL,
    { inputTokens: 2_299_519, outputTokens: 17_000, cacheReadInputTokens: 2_100_810 },
    0,
    "openai",
  );
  ss.updateUsage(
    MODEL,
    { inputTokens: 99_126, outputTokens: 440, cacheReadInputTokens: 99_126 },
    0,
    "openai",
  );
  return ss;
}

/** 整帧渲染 `/stats` 面板，返回去 ANSI 的帧。 */
function renderStats(ss: SessionState | undefined, columns = 120): string {
  const { lastFrame } = render(
    <KeypressProvider>
      <StatsDialog
        onClose={() => {}}
        usage={ss ? ss.getTotalUsage() : { inputTokens: 2_398_645, outputTokens: 17_440 }}
        costUSD={0.0856}
        cacheSavingsUSD={0.5907}
        costLimit={0}
        contextPercent={15}
        model={MODEL}
        provider="openai"
        sessionState={ss}
      />
    </KeypressProvider>,
    { columns },
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("D9 — /stats「缓存命中」显示命中量与命中率，不是上下文大小", () => {
  test("命中率 91.7%，命中量 2,199,936；不再是 stock/flow 相除的 4%", () => {
    const frame = renderStats(buildSession());
    // 按行过滤再断言：整帧搜 "4%" 会误伤其它百分比（本仓踩过误判成列宽 bug）。
    const hitLine = frame.split("\n").find((l) => l.includes("缓存命中"));
    expect(hitLine).toBeDefined();
    expect(hitLine).toContain("2,199,936");
    expect(hitLine).toContain("91.7%");
    // 旧实现的两个特征：显示 99,126（上下文大小）与 4%（stock/flow 相除）。
    expect(hitLine).not.toContain("99,126");
    expect(hitLine).not.toContain("(4%)");
  });

  test("无 sessionState 时整行省略，不退回旧算法", () => {
    const frame = renderStats(undefined);
    expect(frame).not.toContain("缓存命中");
  });
});

describe("D9 — /stats 单价按当前模型的端点取，不跨端点借价", () => {
  test("同名模型两个端点不同价时，面板显示本端点价", () => {
    mkdirSync(tmpDir, { recursive: true });
    // ⚠ 桶的写入顺序是被测语义的一部分：跨端点兜底按 Object.keys 顺序借价，
    // 所以把「另一个端点」(b) 写在前面 —— 漏传 baseURL 的变异实现会先借到它的 9。
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 3,
        endpoints: {
          "https://b.example.com": {
            source_url: "https://b.example.com/api/pricing",
            fetched_at: Date.now(),
            pricing_version: "b",
            models: { "gw-stats-model": { input: 9, output: 18, quotaType: 0 } },
          },
          "https://a.example.com": {
            source_url: "https://a.example.com/api/pricing",
            fetched_at: Date.now(),
            pricing_version: "a",
            models: { "gw-stats-model": { input: 1, output: 2, quotaType: 0 } },
          },
        },
      }),
      "utf8",
    );
    __resetGatewayPricingForTest();
    loadGatewayCache();

    const base = {
      permissionRequest: null,
      shellConfirmRequest: null,
      planApprovalRequest: null,
      askUserQuestionRequest: null,
      conflictRequest: null,
      activeDialog: "stats" as const,
      commandPanel: null,
      onCommandPanelClose: () => {},
      onDialogClose: () => {},
      availableModels: [{ name: "gw-stats-model", provider: "openai" }],
      onModelSelect: () => {},
      availableThemes: [],
      currentTheme: "dark",
      onThemeSelect: () => {},
      onLanguageSelect: () => {},
      model: "gw-stats-model",
      callbacks: {
        // 模型自己配的端点（a）优先于顶层（b）—— 与主循环取端点的口径一致。
        config: {
          baseURL: "https://b.example.com",
          availableModels: [{ name: "gw-stats-model", baseURL: "https://a.example.com" }],
        },
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      costUSD: 0,
      costLimit: 0,
      contextPercent: 0,
      provider: "openai",
      onSubmit: () => {},
      isLoading: false,
      commands: [],
      cwd: "/tmp",
      isEmpty: false,
    };

    const el = (DialogSwitch as unknown as (p: unknown) => React.ReactElement | null)(base);
    expect(el).not.toBeNull();
    // DialogSwitch 把浮层包在 Transient 里，StatsDialog 是它的 children。
    const stats = (el!.props as { children: React.ReactElement }).children;
    const pricing = (stats.props as { pricing?: { input: number } }).pricing;
    expect(pricing).toBeDefined();
    // 本端点 a 的价是 1；漏传 baseURL 会走跨端点兜底先命中 b 的 9。
    expect(pricing!.input).toBeCloseTo(1, 6);
  });
});
