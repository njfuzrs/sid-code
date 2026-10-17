/**
 * 「复制即可用」回归测试：用户会复制的区域不得混入竖线 / 前导空格，链接降级不得丢 URL。
 *
 * 根因同源（L2.2）：默认主屏模式下复制走终端原生选择，渲染层画在内容同一行的任何字符
 * （边框竖线、gutter、缩进）都会原样进剪贴板；不支持 OSC 8 的终端里，只显示 label 的链接
 * 让 URL 彻底不可见。逐项：
 * - 链接：不支持 OSC 8 时显示 URL（对齐 CC createHyperlink）
 * - PlanReviewMessage：round 全框 → 只上下横线
 * - ErrorPanel：去左竖线
 * - Notifications：初始化错误去 round 框
 */

import { describe, test, expect, afterEach } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { renderMarkdown } from "@sid-code/cli/ui/markdown.ts";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { SettingsProvider } from "@sid-code/cli/ui/contexts/SettingsContext.tsx";
import { PlanReviewMessage } from "@sid-code/cli/ui/components/messages/PlanReviewMessage.tsx";
import { ErrorPanel } from "@sid-code/cli/ui/components/ErrorPanel.tsx";
import { KeybindingProvider } from "@sid-code/cli/ui/contexts/KeybindingContext.tsx";
import { Notifications } from "@sid-code/cli/ui/components/Notifications.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { StreamingProvider, StreamingState } from "@sid-code/cli/ui/contexts/StreamingContext.tsx";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

// 不做模块级替换 supportsHyperlinks：bun 的模块替换是进程级的，affected-tests 把整个
// packages/cli 放进同一进程跑，会泄漏到 contracts-layout-text 的 O4 测试（实测踩过）。
// 改为驱动它真实读取的环境变量：TERM_PROGRAM 命中白名单 ⇒ 支持；三个变量都清掉 ⇒ 不支持
// （非 TTY 测试进程里 supports-hyperlinks 库对 stdout 判否，见 packages/tui 的 hyperlinks.ts）。
const HL_ENV = ["TERM_PROGRAM", "LC_TERMINAL", "TERM"] as const;
const savedEnv = Object.fromEntries(HL_ENV.map((k) => [k, process.env[k]]));
function setHyperlinks(on: boolean) {
  for (const k of HL_ENV) delete process.env[k];
  if (on) process.env.TERM_PROGRAM = "iTerm.app";
}
afterEach(() => {
  for (const k of HL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function frame(node: React.ReactElement, columns = 80): string[] {
  const { lastFrame, unmount } = render(node, { columns });
  const out = stripAnsi(lastFrame() ?? "");
  unmount();
  return out.split("\n");
}

/** 判据：含 needle 的那一行，needle 两侧不得出现边框竖线 */
function expectNoVerticalBar(lines: string[], needle: string) {
  const line = lines.find((l) => l.includes(needle));
  expect(line, `帧里找不到「${needle}」:\n${lines.join("\n")}`).toBeDefined();
  expect(line!).not.toMatch(/[│┃|]/);
}

describe("链接降级保留 URL", () => {
  const OSC8 = /\x1b\]8;;/;

  test("不支持 OSC 8：label ≠ URL 时同时显示 label 与 URL", () => {
    setHyperlinks(false);
    const out = renderMarkdown("见 [官方文档](https://example.com/docs)");
    expect(out).not.toMatch(OSC8);
    expect(stripAnsi(out)).toBe("见 官方文档 (https://example.com/docs)");
  });

  test("不支持 OSC 8：label 就是 URL（autolink）时不重复显示", () => {
    setHyperlinks(false);
    expect(stripAnsi(renderMarkdown("<https://a.com/x>"))).toBe("https://a.com/x");
  });

  test("支持 OSC 8：仍走超链接，可见文本只有 label", () => {
    setHyperlinks(true);
    const out = renderMarkdown("[官方文档](https://example.com/docs)");
    expect(out).toMatch(OSC8);
    expect(stripAnsi(out.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""))).toBe("官方文档");
  });
});

describe("可复制区域不画竖线", () => {
  test("PlanReviewMessage：计划正文行无竖线，且内容不超出终端宽度", () => {
    const lines = frame(
      <SettingsProvider>
        <PlanReviewMessage
          planContent={"## 步骤\n\n```bash\nmake build\n```"}
          planFilePath="/tmp/plan.md"
          terminalWidth={60}
        />
      </SettingsProvider>,
      60,
    );
    expectNoVerticalBar(lines, "make build");
    expectNoVerticalBar(lines, "/tmp/plan.md");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  });

  test("ErrorPanel：detail / suggestion 行无竖线", () => {
    const lines = frame(
      <KeybindingProvider initialBindings={[]}>
        <ErrorPanel
          items={[
            {
              id: "e1",
              title: "连接失败",
              detail: "ECONNREFUSED 127.0.0.1:8080",
              suggestion: "curl -v http://127.0.0.1:8080",
              timestamp: 0,
            },
          ]}
          onDismiss={() => {}}
          width={80}
        />
      </KeybindingProvider>,
    );
    expectNoVerticalBar(lines, "ECONNREFUSED");
    expectNoVerticalBar(lines, "curl -v");
    // 错误语义仍在：标题行带 ✘
    expect(lines.find((l) => l.includes("连接失败"))).toContain("✘");
  });

  test("Notifications：初始化错误行无竖线", () => {
    const lines = frame(
      <KeypressProvider>
        <UIStateProvider>
          <StreamingProvider
            streamingState={StreamingState.Idle}
            streamingText=""
            streamingThinking=""
            toolName={null}
            toolInput={undefined}
            isToolExecuting={false}
            lastToolResult={null}
            statusMessage=""
          >
            <Notifications initError="无法读取 /Users/x/.sid-code/settings.json" />
          </StreamingProvider>
        </UIStateProvider>
      </KeypressProvider>,
    );
    expectNoVerticalBar(lines, "settings.json");
    expect(lines.find((l) => l.includes("初始化错误"))).toContain("✘");
  });
});
