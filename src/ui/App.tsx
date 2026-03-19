/**
 * 主 TUI 组件（Alternate Screen Buffer 模式）
 *
 * 布局：
 * - 消息区域：由 ScrollBuffer + RenderController 直接写入屏幕上方（不经过 React）
 * - Live 区域：Ink 渲染，固定在屏幕底部（流式预览/工具状态/输入框/状态栏）
 *
 * 用户可用 PageUp/PageDown/Shift+↑↓ 滚动浏览消息历史
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import { StatusBar } from "./StatusBar.tsx";
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
  /** 流式输出的未完成行预览（在 Live 区域显示） */
  streamingLine: string;
  /** 滚动百分比（0-100），100 表示在底部 */
  scrollPercent?: number;
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  bridge: StateBridge;
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

export function TUIApp({ initialState, callbacks, bridge }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  const log = getLogger();

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（alternate screen 模式）");
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

  // 快捷键处理：Ctrl+C 退出 + 权限对话框 + 鼠标滚轮 + 键盘滚动
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      exit();
      return;
    }

    // SGR 鼠标事件拦截（\x1b[<btn;col;row[Mm]，Ink 去掉 ESC 后变成 [<btn;col;row[Mm]）
    const mouseMatch = /^\[<(\d+);\d+;\d+[Mm]$/.exec(input);
    if (mouseMatch) {
      const button = parseInt(mouseMatch[1], 10);
      if (button === 64) bridge.emit("scroll", "up");       // 滚轮上
      else if (button === 65) bridge.emit("scroll", "down"); // 滚轮下
      return; // 所有鼠标事件都拦截，不传给其他组件
    }

    // 权限对话框快捷键
    const perm = state.permissionRequest;
    if (perm) {
      const lower = input.toLowerCase();
      if (lower === "y") { perm.resolve("yes"); }
      else if (lower === "n") { perm.resolve("no"); }
      else if (lower === "a") { perm.resolve("always"); }
      return;
    }

    // 滚动快捷键
    if (key.pageUp) {
      bridge.emit("scroll", "pageup");
    } else if (key.pageDown) {
      bridge.emit("scroll", "pagedown");
    } else if (key.shift && key.upArrow) {
      bridge.emit("scroll", "up");
    } else if (key.shift && key.downArrow) {
      bridge.emit("scroll", "down");
    } else if (key.home) {
      bridge.emit("scroll", "top");
    } else if (key.end) {
      bridge.emit("scroll", "bottom");
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

  const isEmpty = state.displayItems.length === 0;
  const termWidth = stdout.columns || 80;

  return (
    <>
      {/* ── Live 区域：固定在屏幕底部 ── */}

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
        <Box>
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
        scrollPercent={state.scrollPercent}
      />
    </>
  );
}
