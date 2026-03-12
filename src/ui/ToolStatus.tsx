/**
 * 工具执行状态组件
 * 显示工具调用的 spinner 和工具名
 */

import React from "react";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";

interface ToolStatusProps {
  toolName: string | null;
  isExecuting: boolean;
}

export function ToolStatus({ toolName, isExecuting }: ToolStatusProps) {
  if (!isExecuting || !toolName) {
    return null;
  }

  return (
    <Box>
      <Spinner label={` 执行工具: ${toolName}`} />
    </Box>
  );
}
