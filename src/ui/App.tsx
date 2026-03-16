/**
 * 主 TUI 组件
 * 布局：Static（消息历史，终端滚动缓冲区）+ Live 区域（流式文本 + 输入 + 状态栏）
 * 消息通过 Static 写入终端原生滚动缓冲区，鼠标滚轮可滚动浏览历史
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { MessageItem } from "./MessageList.tsx";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import { renderMarkdown } from "./markdown.ts";
import type { Message, Usage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 终端宽度 hook */
function useTerminalWidth() {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns);
  useEffect(() => {
    const onResize = () => setWidth(stdout.columns);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
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
  streamingText: string;
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
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  stateRef: { current: TUIState };
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
function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
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
}

export function TUIApp({ initialState, callbacks, stateRef }: AppProps) {
  const { exit } = useApp();
  const termWidth = useTerminalWidth();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();
  const renderCountRef = useRef(0);

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（主缓冲区模式）");
    return () => { log.info("UI:APP", "TUIApp 组件已卸载"); };
  }, []);

  // 同步外部状态
  useEffect(() => {
    const interval = setInterval(() => {
      const s = stateRef.current;
      setState((prev) => {
        const messagesChanged = prev.messages.length !== s.messages.length || prev.messages !== s.messages;
        const streamingChanged = prev.streamingText !== s.streamingText;
        const loadingChanged = prev.isLoading !== s.isLoading;
        const toolChanged = prev.toolName !== s.toolName || prev.isToolExecuting !== s.isToolExecuting;
        const modelChanged = prev.model !== s.model || prev.provider !== s.provider;
        const usageChanged = prev.usage.inputTokens !== s.usage.inputTokens || prev.usage.outputTokens !== s.usage.outputTokens;
        const permChanged = prev.permissionRequest !== s.permissionRequest;

        if (messagesChanged || streamingChanged || loadingChanged ||
            toolChanged || modelChanged || usageChanged || permChanged) {
          log.debug("UI:SYNC", `状态同步`);
          return { ...s };
        }
        return prev;
      });
    }, 50);
    return () => clearInterval(interval);
  }, [stateRef]);

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

  /** 权限模式 badge 颜色 */
  const permColor = (() => {
    switch (state.permissionMode) {
      case "plan": return "cyan";
      case "deny-write": return "red";
      case "always-allow": case "dontAsk": return "yellow";
      default: return "green";
    }
  })();

  const costColor = (() => {
    if (state.costLimit <= 0 || state.costUSD <= 0) return undefined;
    const pct = (state.costUSD / state.costLimit) * 100;
    if (pct >= 95) return "red" as const;
    if (pct >= 80) return "yellow" as const;
    return undefined;
  })();

  const costText = state.costUSD > 0 ? `$${state.costUSD.toFixed(4)}` : "$0";
  const isEmpty = state.messages.length === 0 && !state.streamingText;

  // 分隔线
  const sepWidth = Math.max(10, termWidth - 4);
  const separator = "── ".repeat(Math.floor(sepWidth / 3));

  // 流式文本：排除已在 messages 中的最后一条助手消息
  let streamingText = state.streamingText;
  // Static 只展示 messages 数组中确定的消息
  const staticMessages = state.messages;

  return (
    <>
      {/* ── Static 区域：已完成消息，写入终端滚动缓冲区 ── */}
      <Static items={staticMessages}>
        {(msg: Message, idx: number) => {
          const prevMsg = idx > 0 ? staticMessages[idx - 1] : undefined;
          const isUserNonTool = msg.role === "user"
            && !msg.content.every((b) => b.type === "tool_result");
          const showSep = idx > 0 && isUserNonTool;
          return (
            <Box key={`msg-${idx}`} flexDirection="column">
              {showSep && (
                <Box paddingX={1}>
                  <Text dimColor>{separator}</Text>
                </Box>
              )}
              <MessageItem message={msg} prevMessage={prevMsg} />
            </Box>
          );
        }}
      </Static>

      {/* ── Live 区域：始终在底部，动态更新 ── */}

      {/* 空状态 logo */}
      {isEmpty && (
        <Box flexDirection="column" alignItems="center" paddingY={2}>
          <Text color="blue" bold>
            {`   _____ _     _     _____          _
  / ____(_)   | |   / ____|        | |
 | (___  _  __| |  | |     ___   __| | ___
  \\___ \\| |/ _\` |  | |    / _ \\ / _\` |/ _ \\
  ____) | | (_| |  | |___| (_) | (_| |  __/
 |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|`}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>输入消息开始对话，或输入 /help 查看可用命令</Text>
          </Box>
        </Box>
      )}

      {/* 状态消息（上下文警告等） */}
      {state.statusMessage ? (
        <Box paddingX={1}>
          <Text color="yellow">{state.statusMessage}</Text>
        </Box>
      ) : null}

      {/* 流式文本 */}
      {streamingText ? (
        <Box flexDirection="column">
          <Box>
            <Text bold color="green">{"助手 "}</Text>
            <Text color="green">●</Text>
          </Box>
          <Text>{renderMarkdown(streamingText)}</Text>
        </Box>
      ) : null}

      {/* 工具状态 */}
      <ToolStatus toolName={state.toolName} isExecuting={state.isToolExecuting} toolInput={state.toolInput} />

      {/* 权限确认对话框 或 输入区 */}
      {state.permissionRequest ? (
        <PermissionDialog request={state.permissionRequest} />
      ) : (
        <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />
      )}

      {/* 状态栏 */}
      <Box paddingX={1} justifyContent="space-between">
        <Text wrap="truncate">
          <Text bold color="blue">sid-code</Text>
          <Text dimColor> | </Text>
          <Text color={permColor}>{state.permissionMode}</Text>
          {state.gitBranch ? <><Text dimColor> | </Text><Text color="cyan">{state.gitBranch}</Text></> : null}
          {state.debug ? <><Text dimColor> | </Text><Text color="yellow">DEBUG</Text></> : null}
          <Text dimColor> | </Text>
          <Text dimColor>{state.usage.inputTokens}↓ {state.usage.outputTokens}↑</Text>
          <Text dimColor> | </Text>
          <Text color={costColor} dimColor={!costColor}>{costText}</Text>
          <Text dimColor> | ctx {state.contextPercent}%</Text>
        </Text>
        <Text dimColor wrap="truncate">
          {state.model} | Ctrl+C 退出
        </Text>
      </Box>
    </>
  );
}
