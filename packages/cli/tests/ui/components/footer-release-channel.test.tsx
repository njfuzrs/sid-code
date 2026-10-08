/**
 * Footer 行2 的发布通道标签整帧渲染测试
 *
 * 判据：beta / dev 必须在状态栏行2 看得见（首屏 Logo 滚走后这里是唯一的通道标识），
 * 正式版（stable）一个字都不加。窄终端下它与权限模式同属「永不丢弃」。
 * 按含权限模式文本（Manual）的那一行取行2，不全帧搜（L5.2 断言坑）。
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

function renderRow2(channel: "stable" | "beta" | "dev", columns = 200): string {
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
          termWidth={columns}
          releaseChannel={channel}
        />
      </ConfigProvider>
    </UIStateProvider>,
  );
  const lines = stripAnsi(lastFrame() ?? "").split("\n");
  return lines.find((l) => l.includes("Manual")) ?? "";
}

describe("Footer 发布通道标签", () => {
  test("beta → 行2 出现 beta", () => {
    expect(renderRow2("beta")).toMatch(/\bbeta\b/);
  });

  test("dev → 行2 出现 dev", () => {
    expect(renderRow2("dev")).toMatch(/\bdev\b/);
  });

  test("stable → 行2 不出现任何通道标签", () => {
    const row2 = renderRow2("stable");
    expect(row2).toContain("Manual");
    expect(row2).not.toMatch(/\b(beta|dev|stable)\b/);
  });

  test("窄终端下通道标签与权限模式一样不被丢弃", () => {
    const row2 = renderRow2("beta", 30);
    expect(row2).toMatch(/\bbeta\b/);
    expect(row2).toContain("Manual");
  });
});
