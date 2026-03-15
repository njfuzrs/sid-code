/**
 * 工具执行状态组件
 * 显示工具调用的 spinner 和结构化工具信息
 */

import React, { useEffect } from "react";
import { Box } from "ink";
import { Spinner } from "@inkjs/ui";
import { getLogger } from "../debug/logger.ts";

interface ToolStatusProps {
  toolName: string | null;
  isExecuting: boolean;
  toolInput?: unknown;
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

export function ToolStatus({ toolName, isExecuting, toolInput }: ToolStatusProps) {
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

  const label = toolInput ? getToolLabel(toolName, toolInput) : toolName;

  return (
    <Box>
      <Spinner label={` ${label}`} />
    </Box>
  );
}
