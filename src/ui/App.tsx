/**
 * 主 TUI 组件
 * 布局：标题栏 + 消息区 + 工具状态 + 输入区
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useScreenSize } from "fullscreen-ink";
import { MessageList } from "./MessageList.tsx";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import type { Message, Usage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

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
  /** 临时状态消息（上下文警告、hook 阻塞等），几秒后自动清除 */
  statusMessage: string;
  /** 当前待确认的权限请求 */
  permissionRequest: PermissionRequestInfo | null;
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
  const { height: termHeight, width: termWidth } = useScreenSize();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false); // 防止重复提交
  const log = getLogger();
  const renderCountRef = useRef(0);

  // 组件挂载/卸载日志
  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载");
    return () => {
      log.info("UI:APP", "TUIApp 组件已卸载");
    };
  }, []);

  // 同步外部状态（使用深度比较避免不必要的重新渲染）
  useEffect(() => {
    const interval = setInterval(() => {
      const s = stateRef.current;
      setState((prev) => {
        // 检查是否真的有变化
        const messagesChanged = prev.messages.length !== s.messages.length ||
          prev.messages !== s.messages;
        const streamingChanged = prev.streamingText !== s.streamingText;
        const loadingChanged = prev.isLoading !== s.isLoading;
        const toolChanged = prev.toolName !== s.toolName ||
          prev.isToolExecuting !== s.isToolExecuting;
        const modelChanged = prev.model !== s.model || prev.provider !== s.provider;
        const usageChanged = prev.usage.inputTokens !== s.usage.inputTokens ||
          prev.usage.outputTokens !== s.usage.outputTokens;
        const permChanged = prev.permissionRequest !== s.permissionRequest;

        if (messagesChanged || streamingChanged || loadingChanged ||
            toolChanged || modelChanged || usageChanged || permChanged) {
          const changes: string[] = [];
          if (messagesChanged) changes.push(`messages(${prev.messages.length}→${s.messages.length})`);
          if (streamingChanged) changes.push(`streaming(${prev.streamingText.length}→${s.streamingText.length})`);
          if (loadingChanged) changes.push(`loading(${prev.isLoading}→${s.isLoading})`);
          if (toolChanged) changes.push(`tool(${prev.toolName}→${s.toolName})`);
          if (modelChanged) changes.push(`model(${prev.model}→${s.model})`);
          if (usageChanged) changes.push(`usage`);
          if (permChanged) changes.push(`permission(${prev.permissionRequest ? 'active' : 'none'}→${s.permissionRequest ? 'active' : 'none'})`);
          log.debug("UI:SYNC", `状态同步触发重渲染: ${changes.join(", ")}`);
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
    // 权限对话框快捷键
    const perm = state.permissionRequest;
    if (perm) {
      const lower = input.toLowerCase();
      if (lower === "y") {
        log.info("UI:PERM", "用户批准权限请求 (y)");
        perm.resolve("yes");
      } else if (lower === "n") {
        log.info("UI:PERM", "用户拒绝权限请求 (n)");
        perm.resolve("no");
      } else if (lower === "a") {
        log.info("UI:PERM", "用户始终允许权限请求 (a)");
        perm.resolve("always");
      }
    }
  });

  const handleSubmit = useCallback(async (text: string) => {
    log.info("UI:INPUT", `handleSubmit 被调用: "${text.slice(0, 100)}"${text.length > 100 ? '...' : ''}`);

    // 防止重复提交
    if (isSubmittingRef.current) {
      log.warn("UI:INPUT", "重复提交被拦截，当前正在处理中");
      return;
    }
    isSubmittingRef.current = true;

    try {
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        if (cmd === "exit" || cmd === "quit") {
          log.info("UI:INPUT", "用户输入退出命令");
          exit();
          return;
        }
        log.debug("UI:INPUT", `路由到斜杠命令: /${cmd} ${rest.join(" ")}`);
        await callbacks.onSlashCommand(cmd, rest.join(" "));
      } else {
        log.debug("UI:INPUT", "路由到 LLM 对话");
        await callbacks.onUserInput(text);
      }
    } catch (err: any) {
      log.error("UI:INPUT", `handleSubmit 异常`, { error: err.message, stack: err.stack });
    } finally {
      isSubmittingRef.current = false;
      log.debug("UI:INPUT", "handleSubmit 完成，解除提交锁");
    }
  }, [callbacks, exit]);

  // 渲染计数日志
  renderCountRef.current++;
  if (renderCountRef.current % 20 === 1) {
    log.debug("UI:RENDER", `TUIApp 渲染 #${renderCountRef.current}`, {
      messagesLen: state.messages.length,
      streamingTextLen: state.streamingText.length,
      isLoading: state.isLoading,
      toolName: state.toolName,
    });
  }

  /** 权限模式 badge 颜色 */
  const permColor = (() => {
    switch (state.permissionMode) {
      case "plan": return "cyan";
      case "deny-write": return "red";
      case "always-allow": return "yellow";
      case "dontAsk": return "yellow";
      default: return "green";
    }
  })();

  /** 费用颜色：根据配额百分比变色 */
  const costColor = (() => {
    if (state.costLimit <= 0 || state.costUSD <= 0) return undefined; // dimColor
    const pct = (state.costUSD / state.costLimit) * 100;
    if (pct >= 95) return "red" as const;
    if (pct >= 80) return "yellow" as const;
    return undefined;
  })();

  // 计算消息区可用高度
  // 标题栏(border): 3行, 输入区(border): 3行, 状态栏: 1行, 工具状态: 1行(可能0)
  // 权限对话框: 6行, 状态消息: 1行(可能0)
  const fixedRows = 3 /* 标题栏 */ + 3 /* 输入区/权限框 */ + 1 /* 状态栏 */
    + (state.isToolExecuting && state.toolName ? 1 : 0)
    + (state.statusMessage ? 1 : 0)
    + (state.permissionRequest ? 3 : 0); // 权限框比输入区多占几行
  const messageHeight = Math.max(3, termHeight - fixedRows);

  const costText = state.costUSD > 0 ? `$${state.costUSD.toFixed(4)}` : "$0";

  return (
    <Box flexDirection="column" height={termHeight} width={termWidth}>
      {/* 标题栏 */}
      <Box borderStyle="single" borderColor="blue" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="blue">sid-code</Text>
          <Text dimColor> | </Text>
          <Text color={permColor}>{state.permissionMode}</Text>
          {state.gitBranch ? <><Text dimColor> | </Text><Text color="cyan">{state.gitBranch}</Text></> : null}
        </Box>
        <Text dimColor>{state.model} | {state.provider}</Text>
      </Box>

      {/* 状态消息（上下文警告、hook 阻塞等） */}
      {state.statusMessage ? (
        <Box paddingX={1}>
          <Text color="yellow">{state.statusMessage}</Text>
        </Box>
      ) : null}

      {/* 消息区（固定高度，overflow hidden 自动裁剪顶部） */}
      <MessageList messages={state.messages} streamingText={state.streamingText} height={messageHeight} />

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
        <Text>
          <Text dimColor>{state.usage.inputTokens}↓ {state.usage.outputTokens}↑ tokens | </Text>
          <Text color={costColor} dimColor={!costColor}>{costText}</Text>
          <Text dimColor> | ctx {state.contextPercent}%</Text>
        </Text>
        <Text dimColor>
          Ctrl+C 退出 | /help 帮助
        </Text>
      </Box>
    </Box>
  );
}
