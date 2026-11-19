/**
 * D5（Footer 不过滤 channelTrust）：不可信渠道的命中率**照常显示 + 加 `?` 标记**。
 *
 * ## 为什么是「加标记」而不是「不显示」
 *
 * 不可信渠道（走代充/编造 usage 的网关）的 `cache_read` 是编造的，但把它从 Footer 滤掉
 * 会让整列消失 —— 用户看到的是「没有缓存命中数据」，会以为缓存坏了，而真相是
 * 「这个渠道的数不能信」。所以数字照出、只标注不确定（`↯96%?`），并在 /cost 里给一行说明。
 *
 * ## 本文件锁两层
 *
 * - `deriveCacheMetrics`：纯函数，`?` 只在 `channelUntrusted` 为真且**有命中率**时出现
 *   （没有数字时不该凭"不可信"凭空造一个 `?` 列）；
 * - `Footer` 整帧：走真实 `useStatusLineData` + 真实渲染，确认标记真的上了屏幕
 *   （纯函数绿而组件没接上 props 是这类改动的典型漏法）。
 *
 * 线上取数链（loop 无条件写入 → cost-bridge 推送）由
 * `packages/core/tests/query/loop-channel-trust.test.ts` 与
 * `packages/cli/tests/ui/cost-bridge.test.ts` 分别守住。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { Footer } from "@sid-code/cli/ui/components/Footer.tsx";
import { deriveCacheMetrics } from "@sid-code/cli/ui/hooks/useStatusLineData.ts";
import { CACHE_MARK, CHANNEL_UNTRUSTED_MARK } from "@sid-code/cli/ui/constants/figures.ts";
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

function renderFooter(props: { cacheHitRate?: number; cacheChannelUntrusted?: boolean }): string {
  const { lastFrame } = render(
    <UIStateProvider>
      <ConfigProvider value={config}>
        <Footer
          permissionMode="default"
          isPlanMode={false}
          gitBranch="main"
          debug={false}
          usage={{ inputTokens: 100, outputTokens: 10 }}
          stockInputTokens={100}
          costUSD={0}
          costLimit={0}
          contextPercent={1}
          model="test-model"
          termWidth={200}
          releaseChannel="stable"
          waitSourcesHint={null}
          {...props}
        />
      </ConfigProvider>
    </UIStateProvider>,
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("deriveCacheMetrics — D5 不可信标记", () => {
  test("可信渠道：`↯96%`，没有 `?`", () => {
    expect(deriveCacheMetrics(96)!.text).toBe(`${CACHE_MARK}96%`);
  });

  test("不可信渠道：`↯96%?` —— 数字保留，只加不确定性记号", () => {
    const m = deriveCacheMetrics(96, true)!;
    expect(m.text).toBe(`${CACHE_MARK}96%${CHANNEL_UNTRUSTED_MARK}`);
    // 数字本身不变：标记是「怎么读」，不是「算不算」
    expect(m.rate).toBe(96);
  });

  test("不可信但没有命中率：整列不出现（不凭「不可信」凭空造一个 `?`）", () => {
    expect(deriveCacheMetrics(undefined, true)).toBeNull();
  });
});

describe("Footer — 整帧渲染（标记必须真的上屏）", () => {
  test("传 cacheChannelUntrusted → 命中率后出现 `?`", () => {
    const frame = renderFooter({ cacheHitRate: 96, cacheChannelUntrusted: true });
    expect(frame).toContain(`${CACHE_MARK}96%${CHANNEL_UNTRUSTED_MARK}`);
  });

  test("不传时与改动前逐字节一致（默认路径不受影响）", () => {
    const frame = renderFooter({ cacheHitRate: 96 });
    expect(frame).toContain(`${CACHE_MARK}96%`);
    expect(frame).not.toContain(`${CACHE_MARK}96%${CHANNEL_UNTRUSTED_MARK}`);
  });

  test("不可信但没有命中率：帧里不出现孤立的 `?` 命中率列", () => {
    const frame = renderFooter({ cacheChannelUntrusted: true });
    expect(frame).not.toContain(`${CACHE_MARK}%`);
  });
});
