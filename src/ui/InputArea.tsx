/**
 * 输入区域组件
 * 使用 @inkjs/ui TextInput 处理用户输入
 */

import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const [key, setKey] = useState(0); // 用于强制重新挂载 TextInput

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 防止重复提交相同内容
    if (trimmed === lastSubmittedRef.current) {
      return;
    }

    lastSubmittedRef.current = trimmed;
    onSubmit(trimmed);

    // 强制重新挂载 TextInput 以清空输入
    setKey((k) => k + 1);

    // 1秒后清除防重复标记
    setTimeout(() => {
      lastSubmittedRef.current = "";
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
      <TextInput
        key={key}
        onSubmit={handleSubmit}
        placeholder="输入消息或 /help 查看命令..."
      />
    </Box>
  );
}
