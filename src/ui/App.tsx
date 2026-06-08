/**
 * 主 TUI 组件（支持双模式渲染）
 *
 * 模式 1（默认）：Alternate Screen Buffer + ScrollableList 虚拟化滚动
 * 模式 2（--no-alternate-buffer）：Static 历史 + 动态 pending（屏幕阅读器友好）
 *
 * 布局：
 * - 消息区域（上方）：MainContent 双模式渲染
 * - 底部固定区域：工具状态 / 对话框或输入框 / 状态栏
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useApp } from "ink";
import { KeypressProvider, useKeypress, KeypressPriority, type Key } from "./contexts/KeypressContext.tsx";
import { matchBinding } from "./keybindings/defaultBindings.ts";
import { ScrollProvider, useScrollState } from "./contexts/ScrollProvider.tsx";
import { TerminalProvider, useTerminalDimensions } from "./contexts/TerminalContext.tsx";
import { MouseProvider, enableMouseEvents, disableMouseEvents } from "./contexts/MouseContext.tsx";
import { OverflowProvider } from "./contexts/OverflowContext.tsx";
import { UIStateProvider, useUIActions } from "./contexts/UIStateContext.tsx";
import { StreamingProvider } from "./contexts/StreamingContext.tsx";
import { ConfigProvider, type ConfigContextValue } from "./contexts/ConfigContext.tsx";
import { SessionProvider, type SessionContextValue } from "./contexts/SessionContext.tsx";
import { SettingsProvider } from "./contexts/SettingsContext.tsx";
import { AlternateBufferQuittingDisplay } from "./components/AlternateBufferQuittingDisplay.tsx";
import { DefaultAppLayout } from "./components/DefaultAppLayout.tsx";
import { MainScreenLayout } from "./components/MainScreenLayout.tsx";
import type { StateBridge } from "./state-bridge.ts";
import type { Message, Usage } from "../llm/types.ts";
import type { HistoryItem } from "./types.ts";
import { StreamingState } from "./types.ts";
import { messagesToHistoryItems, isPlaceholderMessage, buildStaticItems } from "./history-adapter.ts";
import { getLogger } from "../debug/logger.ts";
import { DEFAULT_TERM_WIDTH } from "./markdown.ts";

// ── 向后兼容导出（供 app.ts 过渡期使用） ──

/** @deprecated 使用 HistoryItem 替代 */
export type DisplayItem =
  | { kind: "message"; message: Message }
  | { kind: "system"; text: string }
  | { kind: "command"; input: string; output: string | null };

/** @deprecated 使用 messagesToHistoryItems 替代 */
export function messagesToDisplayItems(msgs: Message[]): DisplayItem[] {
  return msgs
    .filter(m => !isPlaceholderMessage(m))
    .map(m => ({ kind: "message" as const, message: m }));
}

// 重新导出供外部使用
export { isPlaceholderMessage, messagesToHistoryItems };

/** TUI 回调接口 */
export interface TUICallbacks {
  onUserInput: (text: string) => Promise<void>;
  onSlashCommand: (cmd: string, args: string) => Promise<void>;
  onInterrupt: () => void;
}

/** 权限请求信息 */
export interface PermissionRequestInfo {
  toolName: string;
  toolInput: unknown;
  description: string;
  resolve: (answer: "yes" | "no" | "always") => void;
}

/** Shell 命令确认请求信息 */
export interface ShellConfirmRequestInfo {
  commands: string[];
  resolve: (confirmed: boolean) => void;
}

/** Plan Mode 审批请求信息 */
export interface PlanApprovalRequestInfo {
  planFilePath: string;
  planContent: string;
  resolve: (decision: "approve" | "reject") => void;
}

/** TUI 状态（由外部 App 驱动） */
export interface TUIState {
  messages: Message[];
  /** @deprecated 使用 historyItems 替代 */
  displayItems: DisplayItem[];
  /** HistoryItem 渲染数据（新类型系统） */
  historyItems: HistoryItem[];
  isLoading: boolean;
  toolName: string | null;
  toolInput: unknown;
  isToolExecuting: boolean;
  model: string;
  provider: string;
  usage: Usage;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  permissionMode: string;
  /** 是否处于计划模式（用于 TUI 状态标签显示） */
  isPlanMode: boolean;
  gitBranch: string;
  statusMessage: string;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  debug: boolean;
  lastToolResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
  /** 流式输出的完整文本 */
  streamingText: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 兼容旧接口：流式输出的未完成行预览 */
  streamingLine: string;
  /** 滚动百分比（0-100），100 表示在底部 */
  scrollPercent?: number;
  /** 是否正在退出（切换到退出回显模式） */
  isQuitting: boolean;
  /** Copy Mode：禁用鼠标事件，允许终端原生文本选择 */
  copyModeEnabled: boolean;
  /** 所有已注册命令（补全用） */
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  /** 当前工作目录（@ 文件补全用） */
  cwd: string;
  /** 当前打开的对话框类型，null 表示无对话框 */
  activeDialog: import("../command/types.ts").DialogType | null;
  /** 可用模型列表（对话框用） */
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  /** 当前 todo 列表（来自 TodoWrite 工具，供 TUI 面板显示） */
  todos: import("../tool/todo-write.ts").TodoItem[];
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  bridge: StateBridge;
  /** 是否启用 alternate buffer 全屏模式；默认 false → 主屏 Static 渲染（ADR-040） */
  alternateBuffer?: boolean;
}

// ── 流式虚拟 HistoryItem（用于在列表末尾插入流式内容） ──
const STREAMING_ITEM_ID = -1;

/** 内部 App 组件（在 Provider 内部，可使用 useKeypress） */
function TUIAppInner({ initialState, callbacks, bridge, alternateBuffer }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();
  const { getScrollState } = useScrollState();
  const { toggleRenderMarkdown, setConstrainHeight, setShowIsExpandableHint } = useUIActions();

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（Alternate Buffer 模式）");

    // 启动延迟预取（首屏渲染完成后后台预热）
    import("../entrypoints/deferred-prefetch.ts").then(({ startDeferredPrefetches }) => {
      startDeferredPrefetches(true);
    }).catch(() => { /* 静默失败 */ });

    // 标记首屏渲染完成
    import("../utils/startup-profiler.ts").then(({ profileCheckpoint }) => {
      profileCheckpoint("render_complete");
    }).catch(() => { /* 静默失败 */ });

    return () => { log.info("UI:APP", "TUIApp 组件已卸载"); };
  }, []);

  // 事件驱动状态同步
  useEffect(() => {
    const onChange = (newState: TUIState) => {
      setState(newState);
    };
    bridge.on("change", onChange);
    return () => { bridge.off("change", onChange); };
  }, [bridge]);

  // 触发退出：先设置 isQuitting=true 让 Ink 渲染最终帧，再延迟退出
  const triggerQuit = useCallback(() => {
    log.info("UI:APP", "触发退出，切换到退出回显模式");
    bridge.update({ isQuitting: true });
    // 延迟 100ms 让 Ink 渲染最终帧到主缓冲区
    setTimeout(() => {
      exit();
    }, 100);
  }, [bridge, exit]);

  // Ctrl+C 退出（Critical 优先级）
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:quit") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      triggerQuit();
      return true;
    }
    return false;
  });

  // Copy Mode 切换（Ctrl+S 进入，任意非导航键退出）
  // 仅 alternate buffer 全屏模式有意义；主屏模式鼠标从未被抢、原生选择一直可用，Ctrl+S 为 no-op（ADR-040）
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleCopyMode") {
      if (!alternateBuffer) return false;
      const next = !state.copyModeEnabled;
      log.info("UI:APP", `Copy Mode ${next ? "启用" : "禁用"}`);
      bridge.update({ copyModeEnabled: next });
      if (next) {
        disableMouseEvents();
      } else {
        enableMouseEvents();
      }
      return true;
    }
    if (state.copyModeEnabled) {
      const navKeys = new Set(["pageup", "pagedown", "up", "down", "home", "end"]);
      if (!navKeys.has(key.name || "")) {
        log.info("UI:APP", "Copy Mode 退出（非导航键）");
        bridge.update({ copyModeEnabled: false });
        enableMouseEvents();
        return false;
      }
    }
    return false;
  });

  // Alt+M 切换 Markdown 渲染
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleMarkdown") {
      log.info("UI:APP", "切换 Markdown 渲染模式");
      toggleRenderMarkdown();
      return true;
    }
    return false;
  });

  // Ctrl+O 切换高度限制
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleHeight") {
      log.info("UI:APP", "切换高度限制");
      setConstrainHeight((prev: boolean) => !prev);
      setShowIsExpandableHint(true);
      setTimeout(() => setShowIsExpandableHint(false), 3000);
      return true;
    }
    return false;
  });

  // Esc 中断当前流式响应/工具执行
  useKeypress(KeypressPriority.High, (key: Key) => {
    const isInterruptible =
      (state.isLoading || state.isStreaming || state.isToolExecuting) &&
      !state.permissionRequest &&
      !state.shellConfirmRequest &&
      !state.activeDialog;

    if (!isInterruptible) return false;
    const b = matchBinding(key);
    if (b?.action !== "app:interrupt") return false;

    log.info("UI:APP", "用户按下 Esc，请求中断当前操作");
    callbacks.onInterrupt();
    return true;
  });

  const handleSubmit = useCallback(async (text: string) => {
    log.info("UI:INPUT", `handleSubmit: "${text.slice(0, 100)}"`);
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        if (cmd === "exit" || cmd === "quit") { triggerQuit(); return; }
        await callbacks.onSlashCommand(cmd, rest.join(" "));
      } else {
        await callbacks.onUserInput(text);
      }
    } catch (err: any) {
      log.error("UI:INPUT", `handleSubmit 异常`, { error: err.message });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [callbacks, exit]);

  const isEmpty = state.historyItems.length === 0 && !state.isStreaming;
  // 使用响应式终端尺寸（resize 时自动触发重渲染）
  const { width: termWidth, height: rows } = useTerminalDimensions();

  // 从 TUIState 派生 StreamingState
  const streamingState = useMemo((): StreamingState => {
    if (state.permissionRequest || state.shellConfirmRequest || state.planApprovalRequest) return StreamingState.WaitingForConfirmation;
    if (state.isStreaming || state.isToolExecuting) return StreamingState.Responding;
    return StreamingState.Idle;
  }, [state.permissionRequest, state.shellConfirmRequest, state.planApprovalRequest, state.isStreaming, state.isToolExecuting]);

  // 派生 ConfigContext 值
  const configValue = useMemo((): ConfigContextValue => ({
    model: state.model,
    provider: state.provider,
    permissionMode: state.permissionMode,
    isPlanMode: state.isPlanMode,
    gitBranch: state.gitBranch,
    debug: state.debug,
    cwd: state.cwd,
    commands: state.commands,
  }), [state.model, state.provider, state.permissionMode, state.isPlanMode, state.gitBranch, state.debug, state.cwd, state.commands]);

  // 派生 SessionContext 值
  const sessionValue = useMemo((): SessionContextValue => ({
    usage: state.usage,
    costUSD: state.costUSD,
    costLimit: state.costLimit,
    contextPercent: state.contextPercent,
  }), [state.usage, state.costUSD, state.costLimit, state.contextPercent]);

  // 构建包含流式内容的完整 HistoryItem 数组
  const listData = useMemo((): HistoryItem[] => {
    const items: HistoryItem[] = [];

    // 插入 AppHeader 作为第一个 item（仅当有消息时显示）
    if (state.historyItems.length > 0) {
      items.push({
        id: -2,
        type: "app_header",
        version: require("../../package.json").version,
      });
    }

    items.push(...state.historyItems);

    if (state.isStreaming && state.streamingText) {
      // 插入一个虚拟的流式 HistoryItem
      items.push({
        id: STREAMING_ITEM_ID,
        type: "assistant",
        text: "__streaming__",
      });
    }
    return items;
  }, [state.historyItems, state.isStreaming, state.streamingText]);

  // 主屏 Static 模式专用：仅已完成历史（含 app_header，不含流式虚拟项）。
  // 流式内容在 MainScreenLayout 动态区单独渲染，完成后才并入 historyItems → 进 Static（ADR-040）
  const staticItems = useMemo(
    (): HistoryItem[] => buildStaticItems(state.historyItems, require("../../package.json").version),
    [state.historyItems],
  );

  // key 提取器
  const keyExtractor = useCallback((item: HistoryItem, _index: number): string => {
    if (item.id === STREAMING_ITEM_ID) return "streaming-tail";
    return `hi-${item.id}-${item.type}`;
  }, []);

  // 高度估算
  const estimatedItemHeight = useCallback((index: number): number => {
    const item = listData[index];
    if (!item) return 1;

    if (item.id === STREAMING_ITEM_ID) {
      const effectiveWidth = Math.max(1, termWidth - 12);
      return Math.max(1, Math.ceil((state.streamingText?.length || 0) / effectiveWidth));
    }

    switch (item.type) {
      case "app_header":
        return 10; // Logo + 版本 + Tip + margins
      case "user":
      case "command":
        return Math.max(1, Math.ceil((item.text?.length || 0) / Math.max(1, termWidth - 12)));
      case "assistant":
      case "assistant_content": {
        const effectiveWidth = Math.max(1, termWidth - 12);
        return Math.max(1, Math.ceil(((item.text?.length || 0) * 1.3) / effectiveWidth));
      }
      case "tool_group":
        return item.tools.length * 2;
      case "thinking":
        return Math.max(2, (item.thought.text?.split("\n").length || 0) + 1);
      default:
        return 1;
    }
  }, [listData, termWidth, state.streamingText]);

  // 获取滚动百分比
  const scrollState = getScrollState();
  const scrollPercent = scrollState ? scrollState.percent : undefined;

  // ── 对话框回调 ──
  const handleDialogClose = useCallback(() => {
    bridge.update({ activeDialog: null });
  }, [bridge]);

  const handleModelSelect = useCallback((modelName: string) => {
    // 通过斜杠命令切换模型（复用已有逻辑）
    callbacks.onSlashCommand("model", modelName);
    bridge.update({ activeDialog: null });
  }, [callbacks, bridge]);

  const handleThemeSelect = useCallback((themeName: string) => {
    callbacks.onSlashCommand("theme", themeName);
    bridge.update({ activeDialog: null });
  }, [callbacks, bridge]);

  // 可用模型列表（从 config 中获取）
  const availableModels = useMemo(() => {
    return state.availableModels ?? [];
  }, [state.availableModels]);

  // 可用主题列表
  const availableThemes = useMemo(() => {
    try {
      const { themeManager } = require("../ui/themes/theme-manager.ts");
      return themeManager.getAvailableThemes().map((t: any) => ({
        name: t.name,
        type: t.type as "light" | "dark",
        description: t.description,
      }));
    } catch {
      return [];
    }
  }, []);

  const currentTheme = useMemo(() => {
    try {
      const { themeManager } = require("../ui/themes/theme-manager.ts");
      return themeManager.getActiveTheme().name;
    } catch {
      return "";
    }
  }, []);

  // 退出回显模式
  if (state.isQuitting) {
    // 主屏模式：历史已在终端 scrollback，退出直接 unmount，无需重画（ADR-040）
    if (!alternateBuffer) return null;
    return (
      <AlternateBufferQuittingDisplay
        historyItems={state.historyItems}
        streamingText={state.isStreaming ? state.streamingText : undefined}
      />
    );
  }

  // ── 固定高度布局 ──
  return (
    <ConfigProvider value={configValue}>
    <SessionProvider value={sessionValue}>
    <StreamingProvider
      streamingState={streamingState}
      streamingText={state.streamingText}
      toolName={state.toolName}
      toolInput={state.toolInput}
      isToolExecuting={state.isToolExecuting}
      lastToolResult={state.lastToolResult}
      statusMessage={state.statusMessage}
    >
      {alternateBuffer ? (
        <DefaultAppLayout
          listData={listData}
          streamingText={state.streamingText}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          rows={rows}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          copyModeEnabled={state.copyModeEnabled}
          statusMessage={state.statusMessage}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          costUSD={state.costUSD}
          costLimit={state.costLimit}
          contextPercent={state.contextPercent}
          model={state.model}
          scrollPercent={scrollPercent}
          activeDialog={state.activeDialog}
          onDialogClose={handleDialogClose}
          availableModels={availableModels}
          onModelSelect={handleModelSelect}
          availableThemes={availableThemes}
          currentTheme={currentTheme}
          onThemeSelect={handleThemeSelect}
          todos={state.todos}
        />
      ) : (
        <MainScreenLayout
          staticItems={staticItems}
          streamingText={state.streamingText}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          keyExtractor={keyExtractor}
          statusMessage={state.statusMessage}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          costUSD={state.costUSD}
          costLimit={state.costLimit}
          contextPercent={state.contextPercent}
          model={state.model}
          activeDialog={state.activeDialog}
          onDialogClose={handleDialogClose}
          availableModels={availableModels}
          onModelSelect={handleModelSelect}
          availableThemes={availableThemes}
          currentTheme={currentTheme}
          onThemeSelect={handleThemeSelect}
          todos={state.todos}
        />
      )}
    </StreamingProvider>
    </SessionProvider>
    </ConfigProvider>
  );
}


/** 顶层 TUI 组件：包裹 Provider 层 */
export function TUIApp(props: AppProps) {
  const selectionWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSelectionWarning = useRef(0);
  const handleSelectionWarning = useCallback(() => {
    const now = Date.now();
    if (now - lastSelectionWarning.current < 2000) return;
    lastSelectionWarning.current = now;

    props.bridge.update({
      statusMessage: "按 Ctrl+S 进入 Copy Mode 以选择和复制文本",
    });
    if (selectionWarningTimer.current) clearTimeout(selectionWarningTimer.current);
    selectionWarningTimer.current = setTimeout(() => {
      props.bridge.update({ statusMessage: "" });
      selectionWarningTimer.current = null;
    }, 3000);
  }, [props.bridge]);

  return (
    <TerminalProvider>
      <KeypressProvider>
        <MouseProvider mouseEventsEnabled={props.alternateBuffer === true} onSelectionWarning={handleSelectionWarning}>
          <ScrollProvider>
            <OverflowProvider>
              <SettingsProvider>
                <UIStateProvider>
                  <TUIAppInner {...props} />
                </UIStateProvider>
              </SettingsProvider>
            </OverflowProvider>
          </ScrollProvider>
        </MouseProvider>
      </KeypressProvider>
    </TerminalProvider>
  );
}
