/**
 * 主 TUI 组件（Alternate Screen Buffer 模式）
 *
 * 新架构：消息区域纳入 Ink React 渲染树，采用 VirtualizedList 虚拟化滚动。
 *
 * 布局：
 * - 消息区域（上方）：VirtualizedList 虚拟化渲染，占据 flexGrow={1}
 * - 底部固定区域：工具状态 / 对话框或输入框 / 状态栏
 *
 * 用户可用 PageUp/PageDown/Shift+↑↓/鼠标滚轮 滚动浏览消息历史
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { KeypressProvider, useKeypress, KeypressPriority } from "./contexts/KeypressContext.tsx";
import { ScrollProvider, useScrollState } from "./contexts/ScrollProvider.tsx";
import { DialogManagerProvider, DialogRenderer } from "./components/DialogManager.tsx";
import { VirtualizedList } from "./components/VirtualizedList.tsx";
import { MessageItemRenderer } from "./components/MessageItemRenderer.tsx";
import { StreamingMessage } from "./components/StreamingMessage.tsx";
import type { StateBridge } from "./state-bridge.ts";
import type { Message, Usage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

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

/** TUI 状态（由外部 App 驱动） */
export interface TUIState {
  messages: Message[];
  displayItems: DisplayItem[];
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
  const version = "v0.1.0  ·  AI-Powered Coding Assistant";
  const vLeft = Math.floor(Math.max(0, boxInner - version.length) / 2);
  const vRight = Math.max(0, boxInner - version.length - vLeft);

  return (
    <Box flexDirection="column" paddingX={margin} paddingY={1}>
      <Text color="cyan">{topLine}</Text>
      <Text color="cyan">{emptyLine}</Text>
      {logoLines.map((line, i) => {
        const left = Math.floor(Math.max(0, boxInner - line.length) / 2);
        const right = Math.max(0, boxInner - line.length - left);
        return (
          <Box key={`logo-${i}`}>
            <Text color="cyan">{"│"}</Text>
            <Text>{" ".repeat(left)}</Text>
            <Text color="cyan" bold>{line}</Text>
            <Text>{" ".repeat(right)}</Text>
            <Text color="cyan">{"│"}</Text>
          </Box>
        );
      })}
      <Text color="cyan">{emptyLine}</Text>
      <Box>
        <Text color="cyan">{"│"}</Text>
        <Text>{" ".repeat(vLeft)}</Text>
        <Text dimColor>{version}</Text>
        <Text>{" ".repeat(vRight)}</Text>
        <Text color="cyan">{"│"}</Text>
      </Box>
      <Text color="cyan">{emptyLine}</Text>
      <Text color="cyan">{botLine}</Text>
    </Box>
  );
}

/** 内部 App 组件（在 Provider 内部，可使用 useKeypress/useScrollState） */
function TUIAppInner({ initialState, callbacks, bridge }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();
  const { getScrollState, scrollActive } = useScrollState();

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（VirtualizedList 模式）");
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

  // Ctrl+C 退出（Critical 优先级）
  useKeypress(KeypressPriority.Critical, (input, key) => {
    if (key.ctrl && input === "c") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      exit();
      return true;
    }
    return false;
  });

  // SGR 鼠标事件拦截（Critical 优先级）
  useKeypress(KeypressPriority.Critical, (input, _key) => {
    const mouseMatch = /^\[<(\d+);\d+;\d+[Mm]$/.exec(input);
    if (mouseMatch) {
      const button = parseInt(mouseMatch[1], 10);
      if (button === 64) scrollActive("up");
      else if (button === 65) scrollActive("down");
      return true;
    }
    return false;
  });

  // 滚动快捷键（High 优先级）
  useKeypress(KeypressPriority.High, (_input, key) => {
    if (key.pageUp) { scrollActive("pageup"); return true; }
    if (key.pageDown) { scrollActive("pagedown"); return true; }
    if (key.shift && key.upArrow) { scrollActive("up"); return true; }
    if (key.shift && key.downArrow) { scrollActive("down"); return true; }
    // Home/End 键在 Ink 的 Key 类型中不存在，通过 input 匹配
    // （保留为注释，实际由 fullscreen.ts 的 stdin 层面处理）
    return false;
  });

  const handleSubmit = useCallback(async (text: string) => {
    log.info("UI:INPUT", `handleSubmit: "${text.slice(0, 100)}"`);
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        if (cmd === "exit" || cmd === "quit") { exit(); return; }
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

  // 渲染单个 DisplayItem
  const renderItem = useCallback((item: DisplayItem, _index: number, prevItem?: DisplayItem) => {
    return <MessageItemRenderer item={item} prevItem={prevItem} />;
  }, []);

  // 流式内容
  const streamingContent = state.isStreaming && state.streamingText ? (
    <StreamingMessage
      fullText={state.streamingText}
      isActive={state.isStreaming}
      maxWidth={termWidth}
    />
  ) : null;

  // 获取滚动百分比（从 ScrollProvider）
  const scrollState = getScrollState();
  const scrollPercent = scrollState ? scrollState.percent : undefined;

  return (
    <Box flexDirection="column" height={rows}>
      {/* ── 消息区域：VirtualizedList ── */}
      <Box flexGrow={1}>
        {isEmpty ? (
          <Box flexDirection="column" justifyContent="center" alignItems="center" width={termWidth}>
            <EmptyLogo termWidth={termWidth} />
          </Box>
        ) : (
          <VirtualizedList
            items={state.displayItems}
            renderItem={renderItem}
            height={Math.max(1, rows - 6)}
            streamingContent={streamingContent}
          />
        )}
      </Box>

      {/* ── 底部固定区域 ── */}
      <Box flexDirection="column">
        {/* 状态消息（上下文警告等） */}
        {state.statusMessage ? (
          <Box paddingX={1}>
            <Text color="yellow">{state.statusMessage}</Text>
          </Box>
        ) : null}

        {/* 工具状态 */}
        <ToolStatus
          toolName={state.toolName}
          isExecuting={state.isToolExecuting}
          toolInput={state.toolInput}
          lastResult={state.lastToolResult}
        />

        {/* 权限确认对话框 或 输入区 */}
        {state.permissionRequest ? (
          <DialogRenderer permissionRequest={state.permissionRequest} />
        ) : (
          <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />
        )}

        {/* 状态栏 */}
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
    <KeypressProvider>
      <ScrollProvider>
        <DialogManagerProvider>
          <TUIAppInner {...props} />
        </DialogManagerProvider>
      </ScrollProvider>
    </KeypressProvider>
  );
}
