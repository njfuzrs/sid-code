/**
 * @deprecated 工具状态已集成到 Composer 的 LoadingIndicator 和 ToolResultIndicator 中
 * 保留向后兼容导出
 */

import React, { useEffect, useState } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { SUCCESS_MARK, ERROR_MARK } from "./constants/figures.ts";
import { formatDuration } from "./utils/format-duration.ts";

interface ToolStatusProps {
  toolName: string | null;
  isExecuting: boolean;
  toolInput?: unknown;
  lastResult?: { toolName: string; isError: boolean; elapsedMs: number } | null;
}

/** 从工具输入中提取简短描述 */
function getToolLabel(name: string, input: unknown): string {
  const inp = input as any;
  const lower = name.toLowerCase();

  if (lower === "read") {
    const fp = inp?.file_path || inp?.filePath || "";
    return `Read ${fp}`;
  }
  if (lower === "edit") {
    const fp = inp?.file_path || inp?.filePath || "";
    return `Edit ${fp}`;
  }
  if (lower === "write") {
    const fp = inp?.file_path || inp?.filePath || "";
    return `Write ${fp}`;
  }
  if (lower === "bash") {
    const cmd = inp?.command || "";
    const short = cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
    return `Bash ${short}`;
  }
  if (lower === "grep") {
    const pattern = inp?.pattern || "";
    return `Grep "${pattern}"`;
  }
  if (lower === "glob") {
    const pattern = inp?.pattern || "";
    return `Glob ${pattern}`;
  }
  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    const agentType = inp?.type || inp?.agentType || "";
    return agentType ? `${name} (${agentType})` : name;
  }
  return name;
}

/** @deprecated 使用 Composer 内置的 ToolResultIndicator 替代 */
export const ToolStatus = React.memo(function ToolStatus({ toolName, isExecuting, toolInput, lastResult }: ToolStatusProps) {
  const log = getLogger();
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    if (isExecuting && toolName) {
      log.debug("UI:TOOL", `显示工具状态: ${toolName}`);
    }
  }, [toolName, isExecuting]);

  useEffect(() => {
    if (lastResult) {
      setShowResult(true);
      const timer = setTimeout(() => setShowResult(false), 1500);
      return () => clearTimeout(timer);
    }
    setShowResult(false);
  }, [lastResult]);

  if (isExecuting && toolName) {
    const label = toolInput ? getToolLabel(toolName, toolInput) : toolName;
    return (
      <Box>
        <Text color={theme.ui.active}>⟳ </Text>
        <Text>{label}</Text>
      </Box>
    );
  }

  if (showResult && lastResult) {
    const icon = lastResult.isError ? ERROR_MARK : SUCCESS_MARK;
    const color = lastResult.isError ? theme.status.error : theme.status.success;
    return (
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold>{lastResult.toolName}</Text>
        <Text dimColor> ({formatDuration(lastResult.elapsedMs)})</Text>
      </Box>
    );
  }

  return null;
});
