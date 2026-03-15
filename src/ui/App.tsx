/**
 * 主 TUI 组件
 * 布局：标题栏 + 消息区 + 工具状态 + 输入区
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
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
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  stateRef: { current: TUIState };
}

export function TUIApp({ initialState, callbacks, stateRef }: AppProps) {
  const { exit } = useApp();
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

        if (messagesChanged || streamingChanged || loadingChanged ||
            toolChanged || modelChanged || usageChanged) {
          const changes: string[] = [];
          if (messagesChanged) changes.push(`messages(${prev.messages.length}→${s.messages.length})`);
          if (streamingChanged) changes.push(`streaming(${prev.streamingText.length}→${s.streamingText.length})`);
          if (loadingChanged) changes.push(`loading(${prev.isLoading}→${s.isLoading})`);
          if (toolChanged) changes.push(`tool(${prev.toolName}→${s.toolName})`);
          if (modelChanged) changes.push(`model(${prev.model}→${s.model})`);
          if (usageChanged) changes.push(`usage`);
          log.debug("UI:SYNC", `状态同步触发重渲染: ${changes.join(", ")}`);
          return { ...s };
        }
        return prev;
      });
    }, 50);
    return () => clearInterval(interval);
  }, [stateRef]);

  // Ctrl+C 退出
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      log.info("UI:APP", "用户按下 Ctrl+C，退出");
      exit();
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

  const costText = state.costUSD > 0 ? `$${state.costUSD.toFixed(4)}` : "$0";

  return (
    <Box flexDirection="column" height="100%">
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

      {/* 消息区 */}
      <MessageList messages={state.messages} streamingText={state.streamingText} />

      {/* 工具状态 */}
      <ToolStatus toolName={state.toolName} isExecuting={state.isToolExecuting} toolInput={state.toolInput} />

      {/* 输入区 */}
      <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />

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
