/**
 * 主 TUI 组件
 * 布局：标题栏 + 消息区 + 工具状态 + 输入区
 */

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { MessageList } from "./MessageList.tsx";
import { InputArea } from "./InputArea.tsx";
import { ToolStatus } from "./ToolStatus.tsx";
import type { Message, Usage } from "../llm/types.ts";

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
  isToolExecuting: boolean;
  model: string;
  provider: string;
  usage: Usage;
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  stateRef: { current: TUIState };
}

export function TUIApp({ initialState, callbacks, stateRef }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<TUIState>(initialState);

  // 同步外部状态
  useEffect(() => {
    const interval = setInterval(() => {
      const s = stateRef.current;
      setState((prev) => {
        if (
          prev.messages !== s.messages ||
          prev.streamingText !== s.streamingText ||
          prev.isLoading !== s.isLoading ||
          prev.toolName !== s.toolName ||
          prev.isToolExecuting !== s.isToolExecuting
        ) {
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
      exit();
    }
  });

  const handleSubmit = useCallback(async (text: string) => {
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(" ");
      if (cmd === "exit" || cmd === "quit") {
        exit();
        return;
      }
      await callbacks.onSlashCommand(cmd, rest.join(" "));
    } else {
      await callbacks.onUserInput(text);
    }
  }, [callbacks, exit]);

  return (
    <Box flexDirection="column" height="100%">
      {/* 标题栏 */}
      <Box borderStyle="single" borderColor="blue" paddingX={1} justifyContent="space-between">
        <Text bold color="blue">sid-code</Text>
        <Text dimColor>{state.model} | {state.provider}</Text>
      </Box>

      {/* 消息区 */}
      <MessageList messages={state.messages} streamingText={state.streamingText} />

      {/* 工具状态 */}
      <ToolStatus toolName={state.toolName} isExecuting={state.isToolExecuting} />

      {/* 输入区 */}
      <InputArea onSubmit={handleSubmit} isLoading={state.isLoading} />

      {/* 状态栏 */}
      <Box paddingX={1}>
        <Text dimColor>
          Token: {state.usage.inputTokens}↓ {state.usage.outputTokens}↑ | Ctrl+C 退出 | /help 帮助
        </Text>
      </Box>
    </Box>
  );
}
