/**
 * Footer context 列「初始占用常驻显示」整帧测试。
 *
 * 为什么整帧而不是只测 deriveContext 纯函数：本次改动改的是**显示条件本身**
 * （零值隐藏 → 估算隐藏），纯函数绿只说明派生对，不能证明「打开 TUI 零 usage 时
 * 列真的渲染进行1」「~ 前缀真的上了屏」「估算为 0 时整段真的消失」——这三件事
 * 只在整帧字符串里可见（L5.2 ①：涉及布局/显示条件的改动一律整帧）。
 *
 * ⚠ 断言坑（CLAUDE.md L5.2 点名）：不用 frame.includes 全帧搜——Footer 是两行，
 * 行2（git 段 / 权限模式）也可能含数字与 %。统一先按行首 model 名过滤出行1 再断言。
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

/** 渲染 Footer 并取行1（左对齐的计量行，以 model 名开头；无该行时返回空串）。 */
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
          usage={{ inputTokens: 0, outputTokens: 0 }}
          stockInputTokens={0}
          costUSD={0}
          costLimit={0}
          contextPercent={0}
          model="test-model"
          termWidth={columns}
          {...props}
        />
      </ConfigProvider>
    </UIStateProvider>,
    { columns },
  );
  const frame = stripAnsi(lastFrame() ?? "");
  return frame.split("\n").find((l) => l.trim().startsWith("test-model")) ?? "";
}

describe("Footer context 列：初始占用常驻显示", () => {
  test("usage 全零 + 估算有值 → context 列显示（打开 TUI 即见初始占用，不再等首条消息）", () => {
    const row1 = renderRow1({
      usage: { inputTokens: 0, outputTokens: 0 },
      stockInputTokens: 0,
      contextPercent: 9,
      contextTriggerPercent: 82,
    });
    expect(row1).toContain("9%/82%");
  });

  test("contextEstimated=true → ~ 前缀（纯启发式估算与已校准实测可区分）", () => {
    const row1 = renderRow1({
      contextPercent: 9,
      contextTriggerPercent: 82,
      contextEstimated: true,
    });
    expect(row1).toContain("~9%/82%");
  });

  test("contextEstimated 缺省 / false → 无 ~ 前缀（已校准口径）", () => {
    const row1 = renderRow1({
      contextPercent: 9,
      contextTriggerPercent: 82,
      contextEstimated: false,
    });
    expect(row1).toContain("9%/82%");
    expect(row1).not.toContain("~");
  });

  test("估算为 0 → 整段消失（隐藏条件是估算值而非 usage）", () => {
    const row1 = renderRow1({
      usage: { inputTokens: 40000, outputTokens: 2000 },
      stockInputTokens: 40000,
      contextPercent: 0,
    });
    expect(row1).not.toContain("%");
  });

  test("窄终端按 dropOrder 丢 context（dropOrder=1，最先丢的计量段）", () => {
    // 预算 = 18 - 2(padding) = 16 列：model(10) + 分隔点(3) + context(6) = 19 > 16 →
    // fitRow 按 dropOrder 从大到小丢，context(1) 是唯一可丢段 → 只剩 model。
    const row1 = renderRow1(
      {
        contextPercent: 9,
        contextTriggerPercent: 82,
      },
      18,
    );
    expect(row1).toContain("test-model");
    expect(row1).not.toContain("9%/82%");
  });
});
