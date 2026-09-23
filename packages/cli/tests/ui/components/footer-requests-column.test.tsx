/**
 * Footer requests 列（`⟳ N` + 白烧后缀 `✘M`）整帧渲染测试
 *
 * 为什么必须整帧而不是只测 `deriveRequests` 纯函数（L5.2 ①）：本次改动往**已经排满的
 * 行1**里插了一个新段，纯函数全绿也照样可能塌版 —— 要验的是「段落真的渲染进了行1」
 * 「窄终端下按 dropOrder 被丢而不是把行撑爆」「零值时整段不出现」这三件事，
 * 它们只在整帧字符串里可见。
 *
 * ⚠ 断言坑（CLAUDE.md L5.2 明确点过）：不要用 `frame.includes(...)` 全帧搜 ——
 * Footer 是两行，行2 里也有数字/字形。这里统一先按 `⟳` 过滤出行1 再断言。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
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

/** 渲染 Footer 并取「行1」（含 ⟳ 的那行；无该行时返回空串）。 */
function renderRow1(
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
          usage={{ inputTokens: 40000, outputTokens: 2000 }}
          stockInputTokens={40000}
          costUSD={0.12}
          costLimit={0}
          contextPercent={5}
          model="test-model"
          termWidth={columns}
          {...props}
        />
      </ConfigProvider>
    </UIStateProvider>,
    { columns },
  );
  const frame = stripAnsi(lastFrame() ?? "");
  return frame.split("\n").find((l) => l.includes("⟳")) ?? "";
}

/** 取整帧（用于断言"某字形完全没出现"）。 */
function renderFrame(
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
          usage={{ inputTokens: 40000, outputTokens: 2000 }}
          stockInputTokens={40000}
          costUSD={0.12}
          costLimit={0}
          contextPercent={5}
          model="test-model"
          termWidth={columns}
          {...props}
        />
      </ConfigProvider>
    </UIStateProvider>,
    { columns },
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("Footer requests 列 — 整帧渲染", () => {
  test("有调用次数 → 行1 出现 `⟳ 12`", () => {
    const row1 = renderRow1({ totalRequests: 12 });
    expect(row1).toContain("⟳ 12");
    // 与邻居同处一行（确认插进了行1 的计量流，没有自己另起一行）
    expect(row1).toContain("test-model");
  });

  test("有白烧 → 行1 出现 `⟳ 12 ✘3`（子集语义，不是 15）", () => {
    const row1 = renderRow1({ totalRequests: 12, discardedRequests: 3 });
    expect(row1).toContain("⟳ 12 ✘3");
    expect(row1).not.toContain("15");
  });

  test("无白烧 → 不出现 ✘ 后缀（零值不渲染噪音）", () => {
    const row1 = renderRow1({ totalRequests: 12, discardedRequests: 0 });
    expect(row1).toContain("⟳ 12");
    expect(row1).not.toContain("✘");
  });

  test("props 省略（旧调用方 / 尚未调用模型）→ 整帧无 ⟳，不显示 `⟳ 0`", () => {
    const frame = renderFrame({});
    expect(frame).not.toContain("⟳");
    // 但状态栏本身照常渲染（不是整个组件崩了）
    expect(frame).toContain("test-model");
  });

  test("totalRequests=0 → 同样不渲染该列", () => {
    expect(renderFrame({ totalRequests: 0 })).not.toContain("⟳");
  });

  test("不折行：宽终端下行1 不超出终端宽度", () => {
    const columns = 200;
    const row1 = renderRow1({ totalRequests: 12, discardedRequests: 3 }, columns);
    expect(row1.length).toBeLessThanOrEqual(columns);
  });

  test("窄终端：requests 段被丢弃而不是把行撑爆（dropOrder 生效）", () => {
    const columns = 40;
    const frame = renderFrame({ totalRequests: 12, discardedRequests: 3 }, columns);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
    // model 是固定段（dropOrder=-1），窄屏也必须保留 —— 确认丢的是计量项不是锚点
    expect(frame).toContain("test-model");
  });

  test("窄终端下 requests 比 model 先被丢（固定段永不丢）", () => {
    const frame = renderFrame({ totalRequests: 12 }, 30);
    expect(frame).toContain("test-model");
    expect(frame).not.toContain("⟳ 12");
  });
});
