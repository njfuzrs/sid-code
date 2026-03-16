/**
 * 输入区域组件
 * 使用 @inkjs/ui TextInput 处理用户输入
 */

import React, { useState, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import { getLogger } from "../debug/logger.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const [key, setKey] = useState(0); // 用于强制重新挂载 TextInput
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);

  // 记录 isLoading 状态变化
  useEffect(() => {
    if (prevLoadingRef.current !== isLoading) {
      log.debug("UI:INPUT", `isLoading 变化: ${prevLoadingRef.current} → ${isLoading}`);
      prevLoadingRef.current = isLoading;
    }
  }, [isLoading]);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      log.debug("UI:INPUT", "空输入被忽略");
      return;
    }

    // 防止重复提交相同内容
    if (trimmed === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${trimmed.slice(0, 50)}"`);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${trimmed.slice(0, 100)}"${trimmed.length > 100 ? '...' : ''} (key=${key})`);
    lastSubmittedRef.current = trimmed;
    onSubmit(trimmed);

    // 强制重新挂载 TextInput 以清空输入
    setKey((k) => k + 1);
    log.debug("UI:INPUT", `TextInput 重新挂载 key=${key + 1}`);

    // 1秒后清除防重复标记
    setTimeout(() => {
      lastSubmittedRef.current = "";
      log.debug("UI:INPUT", "防重复标记已清除");
    }, 1000);
  };

  if (isLoading) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>等待响应中...</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{">"} </Text>
      <Box flexGrow={1}>
        <TextInput
          key={key}
          onSubmit={handleSubmit}
          placeholder="输入消息或 /help 查看命令..."
        />
      </Box>
    </Box>
  );
}
