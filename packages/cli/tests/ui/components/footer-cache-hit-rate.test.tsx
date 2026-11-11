/**
 * Footer ⚡ 命中率列整帧渲染测试（D18）
 *
 * 为什么必须整帧而不是只测 `deriveCacheMetrics` 纯函数：本次修的是**取数源**——
 * 命中率必须来自 core 的 `SessionState.getCacheHitRate()`（按每个模型自己的 provider
 * 归一化后加总），而不是 Footer 拿 `usage` + 「当前模型」推断的 provider 重算。
 * 纯函数单测两边都能绿（它只负责把数字变文本），只有整帧能证明「组件真的没重算」。
 *
 * 变异自证：把 Footer 改回「props.usage + props.model 推断 provider → normalizeCacheUsage」
 * → 第一个用例红（同一份 props 下旧算法算出 141%，不是 78%）。
 *
 * ⚠ 断言坑：Footer 是两行，行2 里也有数字/字形。统一先按 `⟳` 过滤出行1 再断言。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { Footer } from "@sid-code/cli/ui/components/Footer.tsx";
import { ConfigProvider } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import type { ConfigContextValue } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";

const config: ConfigContextValue = {
  model: "test-model",
  provider: "openai",
  permissionMode: "default",
  isPlanMode: false,
  gitBranch: "main",
  debug: false,
  cwd: "/tmp/repo",
  commands: [],
  availableModels: [],
  effortDisplay: null,
  thinkingDisplay: null,
  goalDisplay: null,
  vimMode: false,
};

/**
 * 跨协议族会话的「合计 usage」形态：anthropic（input 1000 未命中 + 命中 9000）
 * 与 openai（input 10000 含命中 6500）加总后 inputTokens = 11000、命中 = 15500。
 *
 * 这正是 D18 的现场：拿这份合计 usage 配「当前模型 openai」去 normalize，
 * 会得到 15500 / 11000 = 141% 这种明显错误的命中率。
 */
const MIXED_TOTAL_USAGE = {
  inputTokens: 11000,
  outputTokens: 2000,
  cacheReadInputTokens: 15500,
};

function renderFooter(
  props: Partial<React.ComponentProps<typeof Footer>> = {},
  columns = 200,
): string {
  const { lastFrame } = render(
    <UIStateProvider>
      <ConfigProvider value={config}>
        <Footer
          permissionMode="default"
          isPlanMode={false}
          gitBranch="main"
          debug={false}
          usage={MIXED_TOTAL_USAGE}
          stockInputTokens={40000}
          costUSD={0.12}
          costLimit={0}
          contextPercent={5}
          model="gpt-4o"
          totalRequests={3}
          termWidth={columns}
          {...props}
        />
      </ConfigProvider>
    </UIStateProvider>,
    { columns },
  );
  return stripAnsi(lastFrame() ?? "");
}

/** 渲染并取「行1」（含 ⟳ 的那行；无该行时返回空串）。 */
function renderRow1(
  props: Partial<React.ComponentProps<typeof Footer>> = {},
  columns = 200,
): string {
  return (
    renderFooter(props, columns)
      .split("\n")
      .find((l) => l.includes("⟳")) ?? ""
  );
}

describe("Footer ⚡ 命中率列 — 整帧渲染（D18）", () => {
  test("显示的是 props.cacheHitRate，不是拿 usage + 当前模型重算", () => {
    const row1 = renderRow1({ cacheHitRate: 78 });

    expect(row1).toContain("⚡78%");
    // 旧算法（合计 usage + 当前模型 gpt-4o → openai）会算出 141%：
    // promptTotal=11000、命中 15500，命中率反而超过 100%。它必须完全没出现。
    expect(row1).not.toContain("141");
    // 命中率与邻居同处行1（不是自己另起一行）
    expect(row1).toContain("gpt-4o");
  });

  test("cacheHitRate 省略 → 整帧无 ⚡（无缓存数据不渲染 0% 噪音）", () => {
    const frame = renderFooter({});
    expect(frame).not.toContain("⚡");
    // 状态栏本身照常渲染（不是整个组件崩了）
    expect(frame).toContain("gpt-4o");
  });

  test("cacheHitRate=0 → 如实显示 ⚡0%（有 prompt 但零命中，与「无数据」不同）", () => {
    const row1 = renderRow1({ cacheHitRate: 0 });
    expect(row1).toContain("⚡0%");
  });

  test("不折行：宽终端下行1 不超出终端宽度", () => {
    const columns = 200;
    const row1 = renderRow1({ cacheHitRate: 78 }, columns);
    expect(row1.length).toBeLessThanOrEqual(columns);
  });

  test("窄终端：⚡ 段按 dropOrder 被丢弃而不是把行撑爆", () => {
    const columns = 40;
    const frame = renderFooter({ cacheHitRate: 78 }, columns);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
    // model 是固定段（dropOrder=-1），窄屏也必须保留
    expect(frame).toContain("gpt-4o");
  });
});
