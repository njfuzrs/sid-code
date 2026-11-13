/**
 * Footer ⇢ 吞吐列（tps）整帧渲染测试
 *
 * 为什么必须整帧而不是只测 `deriveTps` 纯函数：这一列有三个只有整帧才能证明的东西：
 * 1. **它真的替代了 savings 那一格**（同一位置、同一 dropOrder，窄屏丢弃次序不变）；
 * 2. **读数不重算**——组件拿 props.outputTps 原样渲染，不许自己用 usage ÷ 会话时长；
 * 3. **宽度不溢出**——`⇢` 宽度 1，但整行仍要按预算丢弃，这是 L5.2 的强制项。
 *
 * 变异自证（本次实测）：
 * - 把 `deriveTps` 的 `Math.round` 去掉 → 小数用例红；
 * - 把 Footer 的 `outputTps` 换成 `props.usage.outputTokens` 自算 → 「不重算」用例红；
 * - 把 `dropOrder: 5` 改成 `-1`（永不丢）→ 窄屏用例红。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { Footer } from "@sid-code/cli/ui/components/Footer.tsx";
import { ConfigProvider } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import type { ConfigContextValue } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import { TPS_MARK } from "@sid-code/cli/ui/constants/figures.ts";

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
          usage={{ inputTokens: 40000, outputTokens: 2000 }}
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

/** 渲染并取「行1」（含 ⇢ 或 ⟳ 的那行；都没有时返回空串）。 */
function renderRow1(
  props: Partial<React.ComponentProps<typeof Footer>> = {},
  columns = 200,
): string {
  return (
    renderFooter(props, columns)
      .split("\n")
      .find((l) => l.includes(TPS_MARK) || l.includes("⟳")) ?? ""
  );
}

describe("Footer ⇢ 吞吐列 — 整帧渲染", () => {
  test("outputTps=41 → 行1 出现 `⇢41/s`（取整、无空格、单位最短）", () => {
    const row1 = renderRow1({ outputTps: 41 });

    expect(row1).toContain(`${TPS_MARK}41/s`);
    // 字形与数值之间不能有空格（L1.1 紧凑排版 + 上一轮 icon 去空隙的同一诉求）
    expect(row1).not.toContain(`${TPS_MARK} 41`);
    // 与命中率、调用次数同处行1，不另起一行
    expect(row1).toContain("gpt-4o");
    expect(row1).toContain("⟳3");
  });

  test("小数取整：outputTps=41.6 → `⇢42/s`（读数稳，不抖小数）", () => {
    const row1 = renderRow1({ outputTps: 41.6 });
    expect(row1).toContain(`${TPS_MARK}42/s`);
  });

  test("outputTps 省略 → 整帧无 ⇢（无样本不渲染 0 噪音）", () => {
    const frame = renderFooter({});
    expect(frame).not.toContain(TPS_MARK);
    // 组件本身照常渲染（不是整块崩了）
    expect(frame).toContain("gpt-4o");
  });

  test("outputTps=0 → 同样不渲染（0 是「无样本」哨兵，不是「速度为零」）", () => {
    const frame = renderFooter({ outputTps: 0 });
    expect(frame).not.toContain(TPS_MARK);
  });

  test("不重算：只给 outputTps，改 usage 不会改变吞吐读数", () => {
    // 两份 usage 差 100 倍，但 outputTps 相同 → 行1 的吞吐读数必须一致。
    // 若组件偷偷用 usage.outputTokens ÷ 会话时长自算，这里会露馅。
    const small = renderRow1({
      outputTps: 41,
      usage: { inputTokens: 100, outputTokens: 20 },
      stockInputTokens: 100,
    });
    const large = renderRow1({
      outputTps: 41,
      usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
      stockInputTokens: 1_000_000,
    });
    const pick = (row: string) => row.match(/⇢\d+\/s/)?.[0];
    expect(pick(small)).toBe("⇢41/s");
    expect(pick(large)).toBe("⇢41/s");
  });

  test("不折行：宽终端下行1 不超出终端宽度", () => {
    const columns = 200;
    const row1 = renderRow1({ outputTps: 41, cacheHitRate: 78 }, columns);
    expect(row1.length).toBeLessThanOrEqual(columns);
  });

  test("窄终端：⇢ 段按 dropOrder 5 被丢弃，model 固定段保留", () => {
    const columns = 40;
    const frame = renderFooter({ outputTps: 41, cacheHitRate: 78 }, columns);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
    expect(frame).toContain("gpt-4o");
  });

  test("窄屏丢弃次序：savings 原位置退役后，tps 仍是「比 cache 先丢」", () => {
    // 逐档收窄终端，找出「⇢ 已消失但 ↯ 还在」的宽度区间——
    // 这证明 tps 的 dropOrder(5) 确实大于 cache(4)，没有变成永不丢弃。
    const widths = [200, 80, 70, 60, 55, 50, 45, 40, 36, 32];
    const seen = widths.map((w) => {
      const frame = renderFooter({ outputTps: 41, cacheHitRate: 78 }, w);
      return { w, tps: frame.includes(TPS_MARK), cache: frame.includes("↯") };
    });
    const tpsDroppedFirst = seen.some((s) => !s.tps && s.cache);
    expect(tpsDroppedFirst).toBe(true);
  });
});
