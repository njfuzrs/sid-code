/**
 * `Ctrl+T` 隐藏后台面板时的等待源提示（§5.7.6 / §9.2.1 T-T1-6）。
 *
 * 为什么这条必须有：面板一藏，用户就看不见还挂着什么。唤醒尤其隐蔽——它到点会
 * **自己**叫醒 agent，用户只看到「没人说话，agent 突然开始干活」（§2.4 的病灶）。
 *
 * 三条判据逐条锁死，其中第 1 条是 MUT-15 的变异点：
 * 1. **面板可见时不出**（面板里那几行就在屏幕上，Footer 再写一遍是第二份）；
 * 2. **无等待源时不出**（没有任何东西要报时不占行）；
 * 3. 有唤醒且面板隐藏时才出，文案与 CC 同构。
 *
 * 分两层测：判据在纯函数（`deriveWaitSourcesHint`）里，渲染在 Footer 里。
 * 判据抽出去单测的理由就是它极易写漏——组件测试要拖一整套 Provider，
 * 写漏了还容易被「渲染出来有这行字」蒙混过去。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { Footer } from "@sid-code/cli/ui/components/Footer.tsx";
import { deriveWaitSourcesHint } from "@sid-code/cli/ui/wait-sources-hint.ts";
import { ConfigProvider } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import type { ConfigContextValue } from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import type { TaskDisplayInfo } from "@sid-code/cli/ui/App.tsx";

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

function wakeupRow(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "w1",
    type: "wakeup",
    kind: "wakeup",
    status: "waiting",
    description: "检查 CI",
    startTime: Date.now(),
    durationMs: 0,
    dueAt: Date.now() + 8 * 60_000,
    ...over,
  };
}

function shellRow(): TaskDisplayInfo {
  return {
    id: "s1",
    type: "local_shell",
    status: "running",
    description: "跑测试",
    command: "bun test",
    startTime: Date.now() - 5_000,
    durationMs: 1_000,
  };
}

function renderFooter(hint?: ReturnType<typeof deriveWaitSourcesHint>): string {
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
          waitSourcesHint={hint ?? null}
        />
      </ConfigProvider>
    </UIStateProvider>,
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("deriveWaitSourcesHint — 三条判据", () => {
  test("面板隐藏 + 有唤醒 → 出「N 个唤醒等待中 · Ctrl+T」", () => {
    const hint = deriveWaitSourcesHint({
      tasks: [wakeupRow()],
      panelHidden: true,
      toggleDisplay: "Ctrl+T",
    });
    expect(hint).toEqual({ counts: "1 个唤醒等待中", toggle: "Ctrl+T" });
  });

  test("**面板可见时不出**（MUT-15 的变异点：删掉这条前提此处应红）", () => {
    const hint = deriveWaitSourcesHint({ tasks: [wakeupRow()], panelHidden: false });
    expect(hint).toBeNull();
  });

  test("无等待源时不出——shell / agent 不算（它们随时有终态通知，用户不会忘）", () => {
    const hint = deriveWaitSourcesHint({ tasks: [shellRow()], panelHidden: true });
    expect(hint).toBeNull();
  });

  test("空面板时不出", () => {
    expect(deriveWaitSourcesHint({ tasks: [], panelHidden: true })).toBeNull();
  });

  test("键位显示名跟随运行时绑定（用户重绑 Ctrl+T 后文案同步）", () => {
    const hint = deriveWaitSourcesHint({
      tasks: [wakeupRow()],
      panelHidden: true,
      toggleDisplay: "Ctrl+K",
    });
    expect(hint?.toggle).toBe("Ctrl+K");
  });

  test("多个唤醒按数量计数（单链语义下通常是 1，但计数口径要正确）", () => {
    const hint = deriveWaitSourcesHint({
      tasks: [wakeupRow({ id: "w1" }), wakeupRow({ id: "w2" })],
      panelHidden: true,
    });
    expect(hint?.counts).toBe("2 个唤醒等待中");
  });
});

describe("Footer — 等待源提示渲染（T-T1-6）", () => {
  test("传了 hint → 帧里出现「1 个唤醒等待中 · Ctrl+T」", () => {
    const frame = renderFooter({ counts: "1 个唤醒等待中", toggle: "Ctrl+T" });
    expect(frame).toContain("1 个唤醒等待中");
    expect(frame).toContain("Ctrl+T");
  });

  test("不传 hint（面板可见 / 无等待源）→ 帧里一个字都不多", () => {
    const frame = renderFooter(null);
    expect(frame).not.toContain("唤醒等待中");
  });

  test("提示行在状态栏两行**之上**，不挤占 model 那一行", () => {
    const lines = renderFooter({ counts: "1 个唤醒等待中", toggle: "Ctrl+T" })
      .split("\n")
      .filter((l) => l.trim().length > 0);
    // 最后两行是既有状态栏（行1 会话态 / 行2 环境），提示必须在它们之前
    const hintIdx = lines.findIndex((l) => l.includes("唤醒等待中"));
    const modelIdx = lines.findIndex((l) => l.includes("test-model"));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(hintIdx);
  });
});
