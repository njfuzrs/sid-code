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

/**
 * 轮询到帧满足条件再取帧。
 *
 * effect 类等待一律用它，不用固定 sleep —— 固定值只能按最快的机器标定，
 * 慢 runner 上不够就红，而它红的时候看起来像业务坏了。
 *
 * 超时不抛错、只返回：后面那条显式 `expect` 才是判据，它报「缺了什么」比
 * 「轮询超时」有用。这与隔壁 PluginsDialog 测试的 `waitFor` 同口径。
 */
async function waitForFrame(
  r: { lastFrame: () => string | undefined },
  cond: (frame: string) => boolean,
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  // 先让出一拍，给 effect（UISeed 播种、溢出批量更新）一个执行窗口，再判条件 —— 否则
  // 「首帧恰好已含目标文本」的用例会立刻返回，等于没等。
  await new Promise((res) => setTimeout(res, 16));
  while (!cond(r.lastFrame() ?? "")) {
    if (Date.now() - start > ms) return;
    await new Promise((res) => setTimeout(res, 16));
  }
}

async function renderLayout(
  mode: Mode,
  over: Record<string, unknown>,
  seed: { toast?: string; ctrlC?: boolean } = {},
  streamingOver: {
    lastToolResult?: { toolName: string; isError: boolean; elapsedMs: number } | null;
    /**
     * 语义等待（ms）：时间本身是被测对象的场景必须真的等满。
     * 例：「工具完成提示 2s 后自己隐藏」等的是那个 TTL 到期，不是 effect 落地。
     */
    waitMs?: number;
    /**
     * 取帧前要轮询到的条件（帧文本满足即返回）。
     *
     * effect 类等待一律用它，不用固定 sleep：UISeed 的 toast / Ctrl+C 播种到进入渲染树
     * 是一条异步 effect 链，60ms 在慢 runner 上不够（2026-11-07 CI 上「瞬态块齐全」
     * 因此假红，见 docs-research 的《20261107-CI时序flake与失败归因-全量排查》3.4）。
     */
    until?: (frame: string) => boolean;
    /** 等 waitMs 之后用这份历史重渲一次（模拟回合末最终回复并入历史） */
    rerenderItems?: HistoryItem[];
  } = {},
  items: HistoryItem[] = history,
): Promise<string> {
  const props = sharedProps(over) as never;
  const tree = (items: HistoryItem[]) => {
    const layout =
      mode === "fullscreen" ? (
        <DefaultAppLayout
          {...(props as object as React.ComponentProps<typeof DefaultAppLayout>)}
          listData={items}
          rows={ROWS}
          estimatedItemHeight={() => 1}
          copyModeEnabled={false}
          scrollPercent={100}
        />
      ) : (
        <MainScreenLayout
          {...(props as object as React.ComponentProps<typeof MainScreenLayout>)}
          staticItems={items}
        />
      );

    return (
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
                          lastToolResult={streamingOver.lastToolResult ?? null}
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
      </TerminalProvider>
    );
  };
  const r = render(tree(items), { columns: COLUMNS, rows: ROWS });
  // 语义等待先行（时间本身是被测对象的场景），再用轮询等 effect 落地。
  // 顺序不能反：TTL 类的等待必须有真实时长，而 effect 类等待只需要「条件成立」。
  if (streamingOver.waitMs !== undefined) {
    await new Promise((res) => setTimeout(res, streamingOver.waitMs));
  }
  if (streamingOver.rerenderItems) {
    r.rerender(tree(streamingOver.rerenderItems));
  }
  if (streamingOver.until) await waitForFrame(r, streamingOver.until);
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
  startupWarnings: [{ id: "w1", message: "启动警告：配置项 foo 已废弃" }],
};
const transientSeed = { toast: "这是一条 Toast 警告", ctrlC: true };

/** 对话框打开：命令输出面板占据输入区（DialogSwitch 走浮层分支）。 */
const dialogState = {
  commandPanel: { title: "/doctor", content: "第一行\n第二行\n第三行\n第四行" },
};

describe("真实布局整帧快照（底部区域）", () => {
  // 同一条瞬态消息只能出现一行。ToastDisplay（BottomRegion）与 Composer 的状态行
  // 曾经各渲染一份 uiState.transientMessage，粘贴一次就在输入框上方叠出两行重复提示
  // （2026-11-03 实测）。快照锁的是「整帧长什么样」，重复行是新增行、未必让旧快照变红，
  // 所以单独用行计数把这条约定钉死。
  for (const mode of ["main", "fullscreen"] as const) {
    test(`${mode}：同一条瞬态消息只渲染一行（不重复叠加）`, async () => {
      const text = "唯一一条提示-ABC";
      // toast 由 UISeed 在 useEffect 里播种，轮询到它真的进帧再取
      const frame = await renderLayout(
        mode,
        {},
        { toast: text },
        {
          until: (f) => f.includes(text),
        },
      );
      const hits = frame.split("\n").filter((line) => line.includes(text));
      expect(hits.length).toBe(1);
    });
  }

  for (const mode of ["main", "fullscreen"] as const) {
    test(`${mode}：瞬态块齐全`, async () => {
      // UISeed 的 toast / Ctrl+C 播种 + 溢出批量更新都在 effect 链上，
      // 轮询到场景摆齐再取帧（固定 60ms 在慢 runner 上不够，2026-11-07 假红过）
      const frame = await renderLayout(mode, transientState, transientSeed, {
        until: (f) => f.includes("Toast 警告") && f.includes("Ctrl+C"),
      });
      // 先确认场景真的摆出来了，避免快照锁住一张「什么都没渲染」的空帧
      for (const s of [
        "跑门禁",
        "Toast 警告",
        "backup-model",
        "认证失败",
        "正在同步",
        "Ctrl+C",
        "配置项 foo",
      ]) {
        expect(frame).toContain(s);
      }
      expect(frame).toMatchSnapshot();
    });

    test(`${mode}：对话框打开`, async () => {
      const frame = await renderLayout(
        mode,
        dialogState,
        {},
        {
          until: (f) => f.includes("第四行"),
        },
      );
      expect(frame).toContain("第四行");
      expect(frame).toMatchSnapshot();
    });
  }

  // lastToolResult 在 app.ts 里回合结束也不清空。状态行曾用 `!!lastToolResult` 判「有内容」，
  // 工具完成提示 2s 后自己隐藏了，判据却恒真 → 空闲时输入框上方恒多 1 行空占位 + 1 行 gap
  // （2026-11-05 用户截图：最后一条消息与输入框之间多出空行）。
  test("main：工具完成提示过期、回合末回复入历史后，输入框上方不留空占位行", async () => {
    const finalItems = [...history, { type: "assistant", text: "最终回复" } as HistoryItem];
    // 对照：从没出现过工具结果、历史里已有最终回复
    const baseline = await renderLayout(
      "main",
      {},
      {},
      { until: (f) => f.includes("最终回复") },
      finalItems,
    );
    // 工具完成提示出现 → 2s 后自己隐藏 → 最终回复并入历史（useHeldRows 的释放点）
    const after = await renderLayout(
      "main",
      {},
      {},
      {
        lastToolResult: { toolName: "bash", isError: false, elapsedMs: 10 },
        // 语义等待：等的是「提示 2s 后自己隐藏」那个 TTL 到期，必须真的等满
        waitMs: 2300,
        rerenderItems: finalItems,
        // 重渲后轮询到「最终回复入历史 + bash 提示已消失」再取帧
        until: (f) => f.includes("最终回复") && !f.includes("bash ("),
      },
    );
    expect(after).toContain("最终回复");
    expect(after).not.toContain("bash (");
    // 画面与从没有过工具结果时完全一致：没有多出的空占位行
    expect(after).toBe(baseline);
  }, 10_000);
});
