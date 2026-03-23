/**
 * 工具执行状态组件
 * 显示工具调用的 spinner、成功/失败状态和耗时
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";

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

/** 格式化耗时 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const ToolStatus = React.memo(function ToolStatus({ toolName, isExecuting, toolInput, lastResult }: ToolStatusProps) {
  const log = getLogger();
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    if (isExecuting && toolName) {
      log.debug("UI:TOOL", `显示工具状态: ${toolName}`);
    }
  }, [toolName, isExecuting]);

  // 工具完成后显示结果，1.5 秒后消失
  useEffect(() => {
    if (lastResult) {
      setShowResult(true);
      const timer = setTimeout(() => setShowResult(false), 1500);
      return () => clearTimeout(timer);
    }
    setShowResult(false);
  }, [lastResult]);

  // 执行中：⟳ spinner（对齐 gemini-cli）
  if (isExecuting && toolName) {
    const label = toolInput ? getToolLabel(toolName, toolInput) : toolName;
    return (
      <Box>
        <Text color={theme.ui.active}>⟳ </Text>
        <Text>{label}</Text>
      </Box>
    );
  }

  // 刚完成：显示成功/失败状态 + 耗时
  if (showResult && lastResult) {
    // gemini-cli 状态图标：
    // Success → ✓ (success green)
    // Error → ✕ (error red)
    const icon = lastResult.isError ? "✕" : "✓";
    const color = lastResult.isError ? theme.status.error : theme.status.success;
    return (
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold>{lastResult.toolName}</Text>
        <Text dimColor> {formatElapsed(lastResult.elapsedMs)}</Text>
      </Box>
    );
  }

  return null;
});
