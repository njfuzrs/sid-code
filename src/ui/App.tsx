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
import { Box, Text, useApp, useStdout } from "ink";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { KeypressProvider, useKeypress, KeypressPriority, type Key } from "./contexts/KeypressContext.tsx";
import { ScrollProvider, useScrollState } from "./contexts/ScrollProvider.tsx";
import { TerminalProvider } from "./contexts/TerminalContext.tsx";
import { MouseProvider } from "./contexts/MouseContext.tsx";
import { DialogRenderer } from "./components/DialogManager.tsx";
import { MainContent } from "./components/MainContent.tsx";
import { AlternateBufferQuittingDisplay } from "./components/AlternateBufferQuittingDisplay.tsx";
import type { StateBridge } from "./state-bridge.ts";
import type { Message, Usage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";

/** 占位消息文本常量 */
const PLACEHOLDER_TEXT = "[系统] 自动插入占位消息以保持角色交替";

/** 渲染数据源联合类型 */
export type DisplayItem =
  | { kind: "message"; message: Message }
  | { kind: "system"; text: string }
  | { kind: "command"; input: string; output: string | null };

/** 判断是否为占位消息 */
export function isPlaceholderMessage(msg: Message): boolean {
  return msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text === PLACEHOLDER_TEXT;
}

/** 从消息数组构建 DisplayItem（过滤占位消息） */
export function messagesToDisplayItems(msgs: Message[]): DisplayItem[] {
  return msgs
    .filter(m => !isPlaceholderMessage(m))
    .map(m => ({ kind: "message" as const, message: m }));
}

/** TUI 回调接口 */
export interface TUICallbacks {
  onUserInput: (text: string) => Promise<void>;
  onSlashCommand: (cmd: string, args: string) => Promise<void>;
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

/** TUI 状态（由外部 App 驱动） */
export interface TUIState {
  messages: Message[];
  displayItems: DisplayItem[];
  /** 已确认的历史消息（Static 模式用：已完成的轮次） */
  confirmedHistoryItems: DisplayItem[];
  /** 当前轮次进行中的消息（Static 模式用：流式输出、工具执行中） */
  pendingHistoryItems: DisplayItem[];
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
  gitBranch: string;
  statusMessage: string;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
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
  /** 是否使用 alternate buffer 模式（默认 true） */
  useAlternateBuffer: boolean;
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  bridge: StateBridge;
}

/** 空状态 Logo 组件 */
function EmptyLogo({ termWidth }: { termWidth: number }) {
  const logoLines = [
    "   _____ _     _     _____          _      ",
    "  / ____(_)   | |   / ____|        | |     ",
    " | (___  _  __| |  | |     ___   __| | ___ ",
    "  \\___ \\| |/ _` |  | |    / _ \\ / _` |/ _ \\",
    "  ____) | | (_| |  | |___| (_) | (_| |  __/",
    " |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|",
  ];
  const margin = 2;
  const boxInner = Math.max(47, termWidth - margin * 2 - 2);
  const topLine = "╭" + "─".repeat(boxInner) + "╮";
  const botLine = "╰" + "─".repeat(boxInner) + "╯";
  const emptyLine = "│" + " ".repeat(boxInner) + "│";
  const version = `v${require("../../package.json").version}  ·  AI-Powered Coding Assistant`;
  const vLeft = Math.floor(Math.max(0, boxInner - version.length) / 2);
  const vRight = Math.max(0, boxInner - version.length - vLeft);

  return (
    <Box flexDirection="column" paddingX={margin} paddingY={1}>
      <Text color={theme.ui.active}>{topLine}</Text>
      <Text color={theme.ui.active}>{emptyLine}</Text>
      {logoLines.map((line, i) => {
        const left = Math.floor(Math.max(0, boxInner - line.length) / 2);
        const right = Math.max(0, boxInner - line.length - left);
        return (
          <Box key={`logo-${i}`}>
            <Text color={theme.ui.active}>{"│"}</Text>
            <Text>{" ".repeat(left)}</Text>
            <Text color={theme.ui.active} bold>{line}</Text>
            <Text>{" ".repeat(right)}</Text>
            <Text color={theme.ui.active}>{"│"}</Text>
          </Box>
        );
      })}
      <Text color={theme.ui.active}>{emptyLine}</Text>
      <Box>
        <Text color={theme.ui.active}>{"│"}</Text>
        <Text>{" ".repeat(vLeft)}</Text>
        <Text dimColor>{version}</Text>
        <Text>{" ".repeat(vRight)}</Text>
        <Text color={theme.ui.active}>{"│"}</Text>
      </Box>
      <Text color={theme.ui.active}>{emptyLine}</Text>
      <Text color={theme.ui.active}>{botLine}</Text>
    </Box>
  );
}

/** 内部 App 组件（在 Provider 内部，可使用 useKeypress） */
function TUIAppInner({ initialState, callbacks, bridge }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();
  const { getScrollState } = useScrollState();

  useEffect(() => {
    log.info("UI:APP", `TUIApp 组件已挂载（${state.useAlternateBuffer ? "Alternate Buffer" : "Static"} 模式）`);
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
    if (key.ctrl && key.name === "c") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      triggerQuit();
      return true;
    }
    return false;
  });

  // 注意：滚动快捷键（PageUp/PageDown/Shift+↑↓/Home/End）和鼠标滚轮
  // 已由 ScrollableList + ScrollProvider 内部处理，无需在此重复注册

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

  const isEmpty = state.displayItems.length === 0 && !state.isStreaming;
  const termWidth = stdout.columns || 80;
  const rows = stdout.rows || 24;

  // 构建包含流式内容的完整数据数组（Alternate Buffer 模式用）
  const listData = useMemo(() => {
    const items: DisplayItem[] = [...state.displayItems];
    if (state.isStreaming && state.streamingText) {
      items.push({ kind: "system" as const, text: "__streaming__" });
    }
    return items;
  }, [state.displayItems, state.isStreaming, state.streamingText]);

  // key 提取器
  const keyExtractor = useCallback((item: DisplayItem, index: number): string => {
    if (item.kind === "system" && item.text === "__streaming__") return "streaming-tail";
    if (item.kind === "system") return `sys-${index}-${item.text.slice(0, 20)}`;
    if (item.kind === "command") return `cmd-${index}-${item.input.slice(0, 20)}`;
    const msg = item.message;
    const first = msg.content[0];
    if (first?.type === "text") return `msg-${index}-${msg.role}-${first.text.slice(0, 16)}`;
    if (first?.type === "tool_use") return `msg-${index}-${msg.role}-tu-${first.id}`;
    if (first?.type === "tool_result") return `msg-${index}-${msg.role}-tr-${first.tool_use_id}`;
    return `msg-${index}-${msg.role}`;
  }, []);

  // 高度估算
  const estimatedItemHeight = useCallback((index: number): number => {
    const item = listData[index];
    if (!item) return 1;
    if (item.kind === "system") {
      if (item.text === "__streaming__") {
        const effectiveWidth = Math.max(1, termWidth - 12);
        return Math.max(1, Math.ceil((state.streamingText?.length || 0) / effectiveWidth));
      }
      return 1;
    }
    if (item.kind === "command") {
      let lines = 2;
      if (item.output) lines += item.output.split("\n").length;
      return lines;
    }
    const msg = item.message;
    let totalLines = 0;
    const effectiveWidth = Math.max(1, termWidth - 12);
    for (const block of msg.content) {
      if (block.type === "text") {
        totalLines += Math.max(1, Math.ceil((block.text.length * 1.3) / effectiveWidth));
      } else {
        totalLines += 1;
      }
    }
    return Math.max(1, totalLines);
  }, [listData, termWidth, state.streamingText]);

  // 获取滚动百分比（仅 alternate buffer 模式有意义）
  const scrollState = state.useAlternateBuffer ? getScrollState() : null;
  const scrollPercent = scrollState ? scrollState.percent : undefined;

  // 退出回显模式：渲染完整对话历史到主缓冲区
  // 仅 alternate buffer 模式需要（Static 模式历史已在主缓冲区）
  if (state.isQuitting && state.useAlternateBuffer) {
    return (
      <AlternateBufferQuittingDisplay
        displayItems={state.displayItems}
        streamingText={state.isStreaming ? state.streamingText : undefined}
      />
    );
  }

  // Static 模式退出：直接退出即可，历史已在主缓冲区
  if (state.isQuitting && !state.useAlternateBuffer) {
    return null;
  }

  // ── Alternate Buffer 模式：固定高度布局 ──
  if (state.useAlternateBuffer) {
    return (
      <Box
        flexDirection="column"
        width={termWidth}
        height={rows}
        paddingBottom={1}
        flexShrink={0}
        flexGrow={0}
        overflow="hidden"
      >
        {/* 消息区域 */}
        <Box flexGrow={1}>
          {isEmpty ? (
            <Box flexDirection="column" justifyContent="center" alignItems="center" width={termWidth}>
              <EmptyLogo termWidth={termWidth} />
            </Box>
          ) : (
            <MainContent
              useAlternateBuffer={true}
              confirmedItems={state.confirmedHistoryItems}
              pendingItems={state.pendingHistoryItems}
              listData={listData}
              streamingText={state.streamingText}
              isStreaming={state.isStreaming}
              termWidth={termWidth}
              hasFocus={true}
              estimatedItemHeight={estimatedItemHeight}
              keyExtractor={keyExtractor}
            />
          )}
        </Box>

        {/* 底部固定区域 */}
        <Box flexDirection="column" flexShrink={0}>
          {state.statusMessage ? (
            <Box paddingX={1}>
              <Text color={theme.status.warning}>{state.statusMessage}</Text>
            </Box>
          ) : null}

          <ToolStatus
            toolName={state.toolName}
            isExecuting={state.isToolExecuting}
            toolInput={state.toolInput}
            lastResult={state.lastToolResult}
          />

          {(state.permissionRequest || state.shellConfirmRequest) ? (
            <DialogRenderer
              permissionRequest={state.permissionRequest}
              shellConfirmRequest={state.shellConfirmRequest ?? null}
            />
          ) : (
            <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />
          )}

          <StatusBar
            permissionMode={state.permissionMode}
            gitBranch={state.gitBranch}
            debug={state.debug}
            usage={state.usage}
            costUSD={state.costUSD}
            costLimit={state.costLimit}
            contextPercent={state.contextPercent}
            model={state.model}
            scrollPercent={scrollPercent}
          />
        </Box>
      </Box>
    );
  }

  // ── Static 模式：无固定高度，Ink 自然流式输出 ──
  return (
    <Box flexDirection="column">
      {/* 消息区域：Static 模式 */}
      {isEmpty ? (
        <EmptyLogo termWidth={termWidth} />
      ) : (
        <MainContent
          useAlternateBuffer={false}
          confirmedItems={state.confirmedHistoryItems}
          pendingItems={state.pendingHistoryItems}
          listData={listData}
          streamingText={state.streamingText}
          isStreaming={state.isStreaming}
          termWidth={termWidth}
          hasFocus={false}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
        />
      )}

      {/* 底部区域 */}
      <Box flexDirection="column">
        {state.statusMessage ? (
          <Box paddingX={1}>
            <Text color={theme.status.warning}>{state.statusMessage}</Text>
          </Box>
        ) : null}

        <ToolStatus
          toolName={state.toolName}
          isExecuting={state.isToolExecuting}
          toolInput={state.toolInput}
          lastResult={state.lastToolResult}
        />

        {(state.permissionRequest || state.shellConfirmRequest) ? (
          <DialogRenderer
            permissionRequest={state.permissionRequest}
            shellConfirmRequest={state.shellConfirmRequest ?? null}
          />
        ) : (
          <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />
        )}

        <StatusBar
          permissionMode={state.permissionMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          costUSD={state.costUSD}
          costLimit={state.costLimit}
          contextPercent={state.contextPercent}
          model={state.model}
          scrollPercent={scrollPercent}
        />
      </Box>
    </Box>
  );
}

/** 顶层 TUI 组件：包裹 Provider 层 */
export function TUIApp(props: AppProps) {
  return (
    <TerminalProvider>
      <KeypressProvider>
        <MouseProvider>
          <ScrollProvider>
            <TUIAppInner {...props} />
          </ScrollProvider>
        </MouseProvider>
      </KeypressProvider>
    </TerminalProvider>
  );
}
