/**
 * Footer effort 列整帧渲染：思考关闭导致档位不下发时划线（20261018 effort 排查 PR-C / E4）
 *
 * 纯函数 deriveEffort 只能证明返回了 strikethrough 标记，证明不了 Footer 真的把它传给了 <Text>。
 * 这里保留 ANSI 断言 SGR 9（划线），并按档位名过滤出行1，不在整帧里搜。
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import chalk from "chalk";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { Footer } from "@sid-code/cli/ui/components/Footer.tsx";
import { ConfigProvider } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import type { ConfigContextValue } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";

const base: ConfigContextValue = {
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

/** 渲染 Footer，返回含档位名的那一行（保留 ANSI）。 */
function effortRow(effortDisplay: ConfigContextValue["effortDisplay"], level: string): string {
  const { lastFrame } = render(
    <UIStateProvider>
      <ConfigProvider value={{ ...base, effortDisplay }}>
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
          termWidth={200}
        />
      </ConfigProvider>
    </UIStateProvider>,
    { columns: 200 },
  );
  return (lastFrame() ?? "").split("\n").find((l) => stripAnsi(l).includes(level)) ?? "";
}

// SGR 9 = crossed-out；可能与其他属性合并成 `\x1b[2;9m` 这类形态。
const STRIKE = /\x1b\[(?:\d+;)*9(?:;\d+)*m/;

describe("Footer effort 列：inert 划线", () => {
  // colorize 用全局 chalk 单例，测试环境默认 level=0（不出 SGR），须强制开色才看得见划线。
  let prevLevel: typeof chalk.level;
  beforeAll(() => {
    prevLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  test("inert=true → 行1 档位带划线", () => {
    const row = effortRow({ level: "xhigh", isAuto: false, inert: true }, "xhigh");
    expect(stripAnsi(row)).toContain("xhigh");
    expect(row).toMatch(STRIKE);
  });

  test("inert 缺省 → 不划线", () => {
    const row = effortRow({ level: "xhigh", isAuto: false }, "xhigh");
    expect(stripAnsi(row)).toContain("xhigh");
    expect(row).not.toMatch(STRIKE);
  });
});
