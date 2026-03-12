/**
 * 工具执行状态组件
 * 显示工具调用的 spinner 和工具名
 */

import React, { useEffect } from "react";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import { getLogger } from "../debug/logger.ts";

interface ToolStatusProps {
  toolName: string | null;
  isExecuting: boolean;
}

export function ToolStatus({ toolName, isExecuting }: ToolStatusProps) {
  const log = getLogger();

  useEffect(() => {
    if (isExecuting && toolName) {
      log.debug("UI:TOOL", `显示工具状态: ${toolName}`);
    } else {
      log.debug("UI:TOOL", `隐藏工具状态`);
    }
  }, [toolName, isExecuting]);

  if (!isExecuting || !toolName) {
    return null;
  }

  return (
    <Box>
      <Spinner label={` 执行工具: ${toolName}`} />
    </Box>
  );
}
