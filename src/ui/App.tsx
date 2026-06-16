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
import useApp from "../ink/hooks/use-app.js";
import { KeypressProvider, useKeypress, KeypressPriority, type Key } from "./contexts/KeypressContext.tsx";
import { KeybindingProvider, useKeybindings } from "./contexts/KeybindingContext.tsx";
import { AccessibilityProvider } from "./accessibility/AccessibilityContext.tsx";
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
import { useTerminalIntegration } from "./hooks/useTerminalIntegration.ts";
import { useMessageQueue } from "./hooks/useMessageQueue.ts";
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
  /** 末次输入 token（stock 口径），用于状态栏展示当前上下文大小。避免与 usage.inputTokens（flow 累计）混淆。 */
  stockInputTokens: number;
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
  /** 新增：流式思考内容（独立于 streamingText，对标 Claude Code） */
  streamingThinking: string;
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
  /**
   * 会话任务名（终端标题用）。首条用户消息提交时由本地启发式即时填入,
   * 之后后台小模型(Haiku)生成更凝练的标题覆盖。null = 尚无会话,标题回退到 cwd 末段。
   */
  sessionTitle?: string | null;
  /**
   * 本轮回合开始时的会话累计 outputTokens 起点。
   * 底部 spinner 显示「本轮新增」= usage.outputTokens − 此值,与 Footer 的「会话总账」区分开。
   * 每个用户回合开始时刷新。
   */
  turnStartOutputTokens?: number;
  /** 当前打开的对话框类型，null 表示无对话框 */
  activeDialog: import("../command/types.ts").DialogType | null;
  /** 可用模型列表（对话框用） */
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  /** 当前 todo 列表（来自 TodoWrite 工具，供 TUI 面板显示） */
  todos: import("../tool/todo-write.ts").TodoItem[];
  /** 当前后台任务列表（Shell/Agent，供 TUI 面板实时显示） */
  tasks: TaskDisplayInfo[];
  /** CM3/CM4：LLM 重试/限流状态（null = 无重试）。 */
  retryStatus: RetryStatusInfo | null;
}

/** CM3/CM4：LLM 重试/限流状态信息（驱动 RetryStatus 组件实时倒计时）。 */
export interface RetryStatusInfo {
  /** 事件类型：retry 通用重试 / rate_limit 限流 / overloaded 过载 / fallback 降级。 */
  kind: "retry" | "rate_limit" | "overloaded" | "fallback";
  /** 当前尝试次数（1-based）。 */
  attempt: number;
  /** 退避延迟（毫秒），用于倒计时。 */
  delayMs: number;
  /** 重试预计开始的绝对时间戳（Date.now() + delayMs），组件据此实时倒计时。 */
  retryAtMs: number;
  /** 模型名。 */
  model: string;
  /** 原始错误描述（可选）。 */
  error?: string;
  /** 降级目标模型（kind=fallback 时）。 */
  fallbackModel?: string;
}

/** TUI 友好的任务显示信息 */
export interface TaskDisplayInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  agentType?: string;
  command?: string;
  progress?: { toolUseCount: number; tokenCount: number };
  /** 周期性进度摘要（M5 opt-in） */
  progressSummary?: string;
  durationMs: number;
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
  // 流式状态 ref 镜像：供 handleSubmit 闭包读取最新值，决定输入入队还是直送
  const streamingStateRef = useRef<StreamingState>(StreamingState.Idle);

  // 从 TUIState 派生 StreamingState（上移到 handleSubmit 之前，供输入排队判断）
  const streamingState = useMemo((): StreamingState => {
    if (state.permissionRequest || state.shellConfirmRequest || state.planApprovalRequest) return StreamingState.WaitingForConfirmation;
    if (state.isStreaming || state.isToolExecuting) return StreamingState.Responding;
    return StreamingState.Idle;
  }, [state.permissionRequest, state.shellConfirmRequest, state.planApprovalRequest, state.isStreaming, state.isToolExecuting]);
  // 同步到 ref，供 handleSubmit 闭包读取最新流式态
  streamingStateRef.current = streamingState;
  const log = getLogger();
  const { getScrollState } = useScrollState();
  const { toggleRenderMarkdown, cycleExpandLevel, setShowIsExpandableHint } = useUIActions();
  const { matchBinding } = useKeybindings();

  // v2：思考折叠状态。两种模式默认折叠成一行（对标 claude-code，思考不占满屏）。
  // ctrl+o 统一切换折叠/展开（与工具结果阶梯展开同键）。
  // - AB 模式：即时切换，重渲虚拟列表所有项。
  // - Static 模式：切换影响后续打印的项（已打印进 scrollback 的项无法重渲）。
  const defaultCollapsed = true;
  const [thinkCollapsed, setThinkCollapsed] = useState(defaultCollapsed);

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

  // Ctrl+O 统一展开/收起折叠内容（对标 claude-code：单键管所有折叠区）：
  // ① 工具结果阶梯展开（0 折叠 → 1 更多 → 2 全展开 → 0）；② 思考块折叠/展开同步切换。
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleHeight") {
      log.info("UI:APP", "统一展开/收起折叠内容（Ctrl+O）");
      // TO4：工具结果阶梯循环展开级别。
      cycleExpandLevel();
      // 思考块同步切换折叠/展开。
      setThinkCollapsed(prev => !prev);
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

  // 底层分发：真正把一条输入送到 App 业务层（斜杠命令 / 普通输入）。
  // 被 handleSubmit（直送）与消息队列（接续）共用。
  const dispatchInput = useCallback(async (text: string) => {
    log.info("UI:INPUT", `dispatchInput: "${text.slice(0, 100)}"`);
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(" ");
      if (cmd === "exit" || cmd === "quit") { triggerQuit(); return; }
      await callbacks.onSlashCommand(cmd, rest.join(" "));
    } else {
      await callbacks.onUserInput(text);
    }
  }, [callbacks]);

  // 多条输入排队：流式响应中提交的普通输入入队，当前轮结束（Idle）后自动接续。
  // 对标 cc 的 now>next>later——这里实现 next（用户输入排队），系统通知不抢占。
  const { enqueue, queueLength } = useMessageQueue({
    streamingState,
    onSend: dispatchInput,
  });

  const handleSubmit = useCallback(async (text: string) => {
    log.info("UI:INPUT", `handleSubmit: "${text.slice(0, 100)}"`);
    if (isSubmittingRef.current) return;

    // 流式进行中：斜杠命令仍直送（/exit、/clear 等需即时生效），普通输入入队接续。
    const busy = streamingStateRef.current !== StreamingState.Idle;
    if (busy && !text.startsWith("/")) {
      log.info("UI:INPUT", "流式中，输入入队等待接续");
      enqueue(text);
      return;
    }

    isSubmittingRef.current = true;
    try {
      await dispatchInput(text);
    } catch (err: any) {
      log.error("UI:INPUT", `handleSubmit 异常`, { error: err.message });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [dispatchInput, enqueue]);

  const isEmpty = state.historyItems.length === 0 && !state.isStreaming;
  // 使用响应式终端尺寸（resize 时自动触发重渲染）
  const { width: termWidth, height: rows } = useTerminalDimensions();

  // TM2/TM3/TM4：终端集成接线（标题 / tab 状态圆点 / 响应完成通知）。
  // 标题任务名优先用会话任务名（首条消息启发式 + 后台 Haiku 升级,见 app.ts）,
  // 尚无会话时回退到 cwd 末段,便于多窗口区分。
  const titleHint = useMemo(() => {
    if (state.sessionTitle && state.sessionTitle.trim()) return state.sessionTitle.trim();
    const parts = (state.cwd || "").split(/[/\\]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "sid-code";
  }, [state.sessionTitle, state.cwd]);
  useTerminalIntegration({ streamingState, titleHint });

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
    availableModels: state.availableModels,
  }), [state.model, state.provider, state.permissionMode, state.isPlanMode, state.gitBranch, state.debug, state.cwd, state.commands, state.availableModels]);

  // 派生 SessionContext 值
  const sessionValue = useMemo((): SessionContextValue => ({
    usage: state.usage,
    costUSD: state.costUSD,
    costLimit: state.costLimit,
    contextPercent: state.contextPercent,
    turnStartOutputTokens: state.turnStartOutputTokens,
  }), [state.usage, state.costUSD, state.costLimit, state.contextPercent, state.turnStartOutputTokens]);

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
          streamingThinking={state.streamingThinking}
          thinkCollapsed={thinkCollapsed}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          rows={rows}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          copyModeEnabled={state.copyModeEnabled}
          statusMessage={state.statusMessage}
          retryStatus={state.retryStatus}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          queuedCount={queueLength}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          stockInputTokens={state.stockInputTokens}
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
          tasks={state.tasks}
        />
      ) : (
        <MainScreenLayout
          staticItems={staticItems}
          streamingText={state.streamingText}
          streamingThinking={state.streamingThinking}
          thinkCollapsed={thinkCollapsed}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          rows={rows}
          keyExtractor={keyExtractor}
          statusMessage={state.statusMessage}
          retryStatus={state.retryStatus}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          queuedCount={queueLength}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          stockInputTokens={state.stockInputTokens}
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
          tasks={state.tasks}
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
                  <AccessibilityProvider>
                    <KeybindingProvider>
                      <TUIAppInner {...props} />
                    </KeybindingProvider>
                  </AccessibilityProvider>
                </UIStateProvider>
              </SettingsProvider>
            </OverflowProvider>
          </ScrollProvider>
        </MouseProvider>
      </KeypressProvider>
    </TerminalProvider>
  );
}
