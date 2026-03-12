/**
 * 输入区域组件
 * 使用 @inkjs/ui TextInput 处理用户输入
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setValue("");
    onSubmit(trimmed);
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
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="输入消息或 /help 查看命令..."
      />
    </Box>
  );
}
