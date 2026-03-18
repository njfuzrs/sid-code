/**
 * 主 TUI 组件
 * 布局：Static（消息历史，终端滚动缓冲区）+ Live 区域（流式文本 + 输入 + 状态栏）
 * 消息通过 Static 写入终端原生滚动缓冲区，鼠标滚轮可滚动浏览历史
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { MessageItem, SystemItem, CommandItem } from "./MessageList.tsx";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import { StatusBar } from "./StatusBar.tsx";
import type { StateBridge } from "./state-bridge.ts";
import type { Message, Usage, ContentBlock } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 占位消息文本常量 */
const PLACEHOLDER_TEXT = "[系统] 自动插入占位消息以保持角色交替";

/** 渲染数据源联合类型 */
export type DisplayItem =
  | { kind: "message"; message: Message }
  | { kind: "system"; text: string }
  | { kind: "command"; input: string; output: string | null }
  | { kind: "streaming-chunk"; text: string; id: number };

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

/** 终端宽度 hook，宽度增大时调用 onWidthIncrease 清除 Live 区域避免残留 */
function useTerminalWidth(onWidthIncrease?: () => void) {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns);
  const lastWidthRef = useRef(stdout.columns);
  // 用 ref 包装回调，避免回调引用变化导致 effect 重复注册
  const callbackRef = useRef(onWidthIncrease);
  callbackRef.current = onWidthIncrease;

  useEffect(() => {
    const onResize = () => {
      const newWidth = stdout.columns;
      const oldWidth = lastWidthRef.current;
      lastWidthRef.current = newWidth;
      setWidth(newWidth);
      // 宽度增大时，Ink 内部不会清除 Live 区域，手动清除避免残留
      if (newWidth > oldWidth) {
        callbackRef.current?.();
      }
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]); // 不再依赖 onWidthIncrease，避免重复注册

  return width;
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
  /** 流式输出的未完成行预览（在 Live 区域显示） */
  streamingLine: string;
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  bridge: StateBridge;
  /** 终端宽度增大时的回调（用于清除 Ink Live 区域避免残留） */
  onWidthIncrease?: () => void;
}

/** 格式化工具输入的关键信息 */
function formatToolDetail(toolName: string, input: unknown): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash") {
    return (input as any)?.command || JSON.stringify(input).slice(0, 80);
  } else if (lower === "write" || lower === "edit" || lower === "read") {
    const fp = (input as any)?.file_path || (input as any)?.filePath || (input as any)?.path || "";
    return fp;
  } else if (lower === "grep") {
    return `pattern: ${(input as any)?.pattern || ""}`;
  } else if (lower === "glob") {
    return `pattern: ${(input as any)?.pattern || ""}`;
  }
  return JSON.stringify(input).slice(0, 80);
}

/** 权限确认对话框组件 */
const PermissionDialog = React.memo(function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
  const detail = formatToolDetail(request.toolName, request.toolInput);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>权限请求</Text>
      <Box marginTop={0}>
        <Text>  工具: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      <Box>
        <Text>  详情: </Text>
        <Text color="cyan">{detail.length > 60 ? detail.slice(0, 57) + "..." : detail}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="green" bold> (y)</Text><Text>允许 </Text>
        <Text color="red" bold> (n)</Text><Text>拒绝 </Text>
        <Text color="yellow" bold> (a)</Text><Text>始终允许</Text>
      </Box>
    </Box>
  );
});

/** 为 DisplayItem 生成稳定的 key */
function getDisplayItemKey(item: DisplayItem, idx: number): string {
  if (item.kind === "system") return `sys-${idx}`;
  if (item.kind === "command") return `cmd-${idx}`;
  if (item.kind === "streaming-chunk") return `sc-${item.id}`;
  const msg = item.message;
  for (const block of msg.content) {
    if (block.type === "tool_use") return `tu-${block.id}`;
    if (block.type === "tool_result") return `tr-${block.tool_use_id}`;
  }
  return `${msg.role}-${idx}`;
}

export function TUIApp({ initialState, callbacks, bridge, onWidthIncrease }: AppProps) {
  const { exit } = useApp();
  const termWidth = useTerminalWidth(onWidthIncrease);
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();
  const renderCountRef = useRef(0);

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（主缓冲区模式）");
    return () => { log.info("UI:APP", "TUIApp 组件已卸载"); };
  }, []);

  // 事件驱动状态同步（替代 50ms 轮询）
  useEffect(() => {
    const onChange = (newState: TUIState) => {
      setState(newState);
    };
    bridge.on("change", onChange);
    return () => { bridge.off("change", onChange); };
  }, [bridge]);

  // Ctrl+C 退出 + 权限对话框快捷键
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      exit();
      return;
    }
    const perm = state.permissionRequest;
    if (perm) {
      const lower = input.toLowerCase();
      if (lower === "y") { perm.resolve("yes"); }
      else if (lower === "n") { perm.resolve("no"); }
      else if (lower === "a") { perm.resolve("always"); }
    }
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

  renderCountRef.current++;

  const isEmpty = state.displayItems.length === 0;

  // 分隔线
  const sepWidth = Math.max(10, termWidth - 4);
  const separator = "── ".repeat(Math.floor(sepWidth / 3));

  const staticItems = state.displayItems;

  return (
    <>
      {/* ── Static 区域：已完成消息，写入终端滚动缓冲区 ── */}
      <Static items={staticItems}>
        {(item: DisplayItem, idx: number) => {
          if (item.kind === "system") {
            return (
              <Box key={getDisplayItemKey(item, idx)} flexDirection="column">
                <SystemItem text={item.text} termWidth={termWidth} />
              </Box>
            );
          }
          if (item.kind === "command") {
            return (
              <Box key={getDisplayItemKey(item, idx)} flexDirection="column">
                {idx > 0 && (
                  <Box paddingX={1}>
                    <Text dimColor>{separator}</Text>
                  </Box>
                )}
                <CommandItem input={item.input} output={item.output} termWidth={termWidth} />
              </Box>
            );
          }
          if (item.kind === "streaming-chunk") {
            return (
              <Box key={getDisplayItemKey(item, idx)} flexDirection="column">
                <Text>{item.text}</Text>
              </Box>
            );
          }
          const msg = item.message;
          // 找前一个 message 类型的 item 作为 prevMessage
          let prevMsg: Message | undefined;
          for (let i = idx - 1; i >= 0; i--) {
            const prev = staticItems[i];
            if (prev.kind === "message") {
              prevMsg = prev.message;
              break;
            }
          }
          const isUserNonTool = msg.role === "user"
            && !msg.content.every((b: ContentBlock) => b.type === "tool_result");
          const showSep = idx > 0 && isUserNonTool;
          return (
            <Box key={getDisplayItemKey(item, idx)} flexDirection="column">
              {showSep && (
                <Box paddingX={1}>
                  <Text dimColor>{separator}</Text>
                </Box>
              )}
              <MessageItem message={msg} prevMessage={prevMsg} termWidth={termWidth} />
            </Box>
          );
        }}
      </Static>

      {/* ── Live 区域：始终在底部，动态更新 ── */}

      {/* 空状态 logo */}
      {isEmpty && (() => {
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
      })()}

      {/* 状态消息（上下文警告等） */}
      {state.statusMessage ? (
        <Box paddingX={1}>
          <Text color="yellow">{state.statusMessage}</Text>
        </Box>
      ) : null}

      {/* 流式输出未完成行预览 */}
      {state.streamingLine ? (
        <Box paddingX={1}>
          <Text dimColor>{state.streamingLine}</Text>
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
        <PermissionDialog request={state.permissionRequest} />
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
      />
    </>
  );
}
