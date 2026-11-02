/**
 * 两套真实布局（DefaultAppLayout 全屏 / MainScreenLayout 主屏）的整帧快照。
 *
 * 为什么要这道门禁：两个布局的底部区域（通知、Todo、Toast、重试、错误面板、状态提示、
 * Composer/对话框二选一、退出警告、Footer）曾经各写一份，历史上 8 次改动都是同一个提交
 * 两边一起改，漏一边两种模式就漂移。抽出 BottomRegion 之后，这里锁的是「两种布局的真实
 * 输出不变」。term-bench 的 component-scenarios 用的是手写骨架，不渲染这两个真实布局，
 * 抽 BottomRegion 改坏了它照样绿，所以不能拿它当验收。
 *
 * 快照取去色后的整帧文本：颜色档位随宿主 TERM / FORCE_COLOR 变化，本机和 CI 不一致；
 * 组件顺序、间距、文案、截断才是这次重构要锁的东西，都在纯文本里。
 *
 * 变异自证（已做）：在 BottomRegion 里调换 TodoPanel 与 Notifications 的顺序，
 * 两个布局的「瞬态块齐全」快照都会变红。
 */

import { describe, expect, test } from "bun:test";
import React, { useEffect } from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { DefaultAppLayout } from "@sid-code/cli/ui/components/DefaultAppLayout.tsx";
import { MainScreenLayout } from "@sid-code/cli/ui/components/MainScreenLayout.tsx";
import { TerminalProvider } from "@sid-code/cli/ui/contexts/TerminalContext.tsx";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { MouseProvider } from "@sid-code/cli/ui/contexts/MouseContext.tsx";
import { ScrollProvider } from "@sid-code/cli/ui/contexts/ScrollProvider.tsx";
import { OverflowProvider } from "@sid-code/cli/ui/contexts/OverflowContext.tsx";
import { SettingsProvider } from "@sid-code/cli/ui/contexts/SettingsContext.tsx";
import {
  UIStateProvider,
  useUIActions,
  TransientMessageType,
} from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import {
  ConfigProvider,
  type ConfigContextValue,
} from "@sid-code/cli/ui/contexts/ConfigContext.tsx";
import {
  SessionProvider,
  type SessionContextValue,
} from "@sid-code/cli/ui/contexts/SessionContext.tsx";
import { StreamingProvider } from "@sid-code/cli/ui/contexts/StreamingContext.tsx";
import { StreamingState } from "@sid-code/cli/ui/types.ts";
import type { HistoryItem } from "@sid-code/cli/ui/types.ts";

const COLUMNS = 100;
const ROWS = 40;
const noop = () => {};

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
} as unknown as ConfigContextValue;

const usage = { inputTokens: 1200, outputTokens: 300 };
const session: SessionContextValue = {
  usage,
  costUSD: 0.01,
  costLimit: 0,
  contextPercent: 12,
} as unknown as SessionContextValue;

const history: HistoryItem[] = [{ type: "user", text: "你好" } as HistoryItem];

/** 两个布局共用的 props；场景差异只通过 over 覆盖。 */
function sharedProps(over: Record<string, unknown>) {
  return {
    streamingText: "",
    streamingThinking: "",
    thinkCollapsed: true,
    isStreaming: false,
    isEmpty: false,
    termWidth: COLUMNS,
    keyExtractor: (_item: HistoryItem, i: number) => `h-${i}`,
    statusMessage: "",
    retryStatus: null,
    errorPanel: [],
    onDismissErrorPanel: noop,
    permissionRequest: null,
    shellConfirmRequest: null,
    planApprovalRequest: null,
    askUserQuestionRequest: null,
    conflictRequest: null,
    isLoading: false,
    commands: [],
    cwd: "/tmp/repo",
    onSubmit: noop,
    permissionMode: "default",
    isPlanMode: false,
    gitBranch: "main",
    debug: false,
    usage,
    stockInputTokens: 1200,
    costUSD: 0.01,
    totalRequests: 3,
    discardedRequests: 0,
    costLimit: 0,
    contextPercent: 12,
    model: "test-model",
    activeDialog: null,
    onDialogClose: noop,
    commandPanel: null,
    onCommandPanelClose: noop,
    availableModels: [],
    onModelSelect: noop,
    availableThemes: [],
    currentTheme: "dark",
    onThemeSelect: noop,
    onLanguageSelect: noop,
    callbacks: {},
    provider: "openai",
    todos: [],
    tasks: [],
    startupWarnings: [],
    ...over,
  };
}

/** 在 UIStateProvider 内把 Toast / 退出警告这类 UI 状态摆好。 */
function UISeed({ toast, ctrlC }: { toast?: string; ctrlC?: boolean }) {
  const actions = useUIActions();
  useEffect(() => {
    if (toast) actions.showTransientMessage(toast, TransientMessageType.Warning);
    if (ctrlC) actions.setCtrlCPressedOnce(true);
  }, []);
  return null;
}

type Mode = "fullscreen" | "main";

async function renderLayout(
  mode: Mode,
  over: Record<string, unknown>,
  seed: { toast?: string; ctrlC?: boolean } = {},
): Promise<string> {
  const props = sharedProps(over) as never;
  const layout =
    mode === "fullscreen" ? (
      <DefaultAppLayout
        {...(props as object as React.ComponentProps<typeof DefaultAppLayout>)}
        listData={history}
        rows={ROWS}
        estimatedItemHeight={() => 1}
        copyModeEnabled={false}
        scrollPercent={100}
      />
    ) : (
      <MainScreenLayout
        {...(props as object as React.ComponentProps<typeof MainScreenLayout>)}
        staticItems={history}
      />
    );

  const r = render(
    <TerminalProvider>
      <KeypressProvider>
        <MouseProvider mouseEventsEnabled={mode === "fullscreen"}>
          <ScrollProvider>
            <OverflowProvider>
              <SettingsProvider>
                <UIStateProvider>
                  <UISeed {...seed} />
                  <ConfigProvider value={config}>
                    <SessionProvider value={session}>
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
                        {layout}
                      </StreamingProvider>
                    </SessionProvider>
                  </ConfigProvider>
                </UIStateProvider>
              </SettingsProvider>
            </OverflowProvider>
          </ScrollProvider>
        </MouseProvider>
      </KeypressProvider>
    </TerminalProvider>,
    { columns: COLUMNS, rows: ROWS },
  );
  // 让 effect（UISeed、溢出批量更新等）跑完再取帧
  await new Promise((res) => setTimeout(res, 60));
  const frame = r.lastFrame() ?? "";
  r.unmount();
  // 行尾空白随布局填充宽度变化，不属于这次要锁的内容
  return stripAnsi(frame)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

/** 瞬态块齐全：Todo、Toast、重试（降级，静态文案无倒计时）、错误面板、状态提示、退出警告。 */
const transientState = {
  todos: [
    { content: "补快照测试", activeForm: "正在补快照测试", status: "completed" },
    { content: "抽出 BottomRegion", activeForm: "正在抽出 BottomRegion", status: "in_progress" },
    { content: "跑门禁", activeForm: "正在跑门禁", status: "pending" },
  ],
  retryStatus: {
    kind: "fallback",
    attempt: 1,
    delayMs: 0,
    retryAtMs: 0,
    model: "test-model",
    fallbackModel: "backup-model",
  },
  errorPanel: [
    {
      id: "e1",
      code: "auth",
      title: "认证失败",
      detail: "401 Unauthorized",
      suggestion: "检查 API key 配置",
      timestamp: 0,
    },
  ],
  statusMessage: "状态提示：正在同步",
};
const transientSeed = { toast: "这是一条 Toast 警告", ctrlC: true };

/** 对话框打开：命令输出面板占据输入区（DialogSwitch 走浮层分支）。 */
const dialogState = {
  commandPanel: { title: "/doctor", content: "第一行\n第二行\n第三行\n第四行" },
};

describe("真实布局整帧快照（底部区域）", () => {
  for (const mode of ["main", "fullscreen"] as const) {
    test(`${mode}：瞬态块齐全`, async () => {
      const frame = await renderLayout(mode, transientState, transientSeed);
      // 先确认场景真的摆出来了，避免快照锁住一张「什么都没渲染」的空帧
      for (const s of ["跑门禁", "Toast 警告", "backup-model", "认证失败", "正在同步", "Ctrl+C"]) {
        expect(frame).toContain(s);
      }
      expect(frame).toMatchSnapshot();
    });

    test(`${mode}：对话框打开`, async () => {
      const frame = await renderLayout(mode, dialogState);
      expect(frame).toContain("第四行");
      expect(frame).toMatchSnapshot();
    });
  }
});
