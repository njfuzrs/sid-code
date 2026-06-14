/**
 * 历史项渲染分发器
 *
 * 接收 HistoryItem，根据 type 字段分发到对应的专用子组件。
 * 替代原来的 MessageItemRenderer（直接解析 LLM Message）。
 *
 * 参考 gemini-cli HistoryItemDisplay.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { HistoryItem } from "../types.ts";
import { ToolCallStatus } from "../types.ts";
import { UserMessage } from "./messages/UserMessage.tsx";
import { CommandMessage } from "./messages/CommandMessage.tsx";
import { AssistantMessage } from "./messages/AssistantMessage.tsx";
import { ToolGroupMessage } from "./messages/ToolGroupMessage.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import { ErrorMessage } from "./messages/ErrorMessage.tsx";
import { PlanReviewMessage } from "./messages/PlanReviewMessage.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { theme } from "../semantic-colors.ts";

interface HistoryItemDisplayProps {
  item: HistoryItem;
  prevItem?: HistoryItem;
  terminalWidth: number;
  isPending?: boolean;
  availableTerminalHeight?: number;
  /** v2：思考块折叠状态 */
  thinkCollapsed?: boolean;
}

export const HistoryItemDisplay: React.FC<HistoryItemDisplayProps> = ({
  item,
  prevItem,
  terminalWidth,
  isPending = false,
  availableTerminalHeight,
  thinkCollapsed = false,
}) => {
  const width = terminalWidth;
  // 用户轮边界：靠留白区隔，不画分隔符（对标 cc）。首项不留白。
  const turnSpacing = prevItem ? 1 : 0;

  switch (item.type) {
    case "app_header":
      return <AppHeader version={item.version} />;

    case "user":
      return (
        <Box flexDirection="column" marginTop={turnSpacing}>
          <UserMessage text={item.text} width={width} />
        </Box>
      );

    case "assistant":
      return (
        <AssistantMessage
          text={item.text}
          width={width}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
        />
      );

    case "assistant_content":
      return (
        <AssistantMessage
          text={item.text}
          width={width}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
        />
      );

    case "thinking":
      return (
        <ThinkingMessage
          text={item.thought.text}
          width={width}
          collapsed={thinkCollapsed}
          thinkingSeconds={item.thought.durationSeconds}
        />
      );

    case "hint":
      return (
        <Box paddingX={1}>
          <Text color={theme.text.secondary} italic>{"💡 "}{item.text}</Text>
        </Box>
      );

    case "info":
      return (
        <Box paddingX={1}>
          <Text color={item.color || theme.text.secondary}>
            {item.icon ? `${item.icon} ` : "ℹ "}{item.text}
          </Text>
          {item.secondaryText && (
            <Text dimColor>{" "}{item.secondaryText}</Text>
          )}
        </Box>
      );

    case "warning":
      return (
        <Box paddingX={1}>
          <Text color={theme.status.warning}>{"⚠ "}{item.text}</Text>
        </Box>
      );

    case "error":
      return <ErrorMessage text={item.text} width={width} />;

    case "tool_group": {
      // 将 IndividualToolCallDisplay 转换为 ToolGroupMessage 需要的格式
      const tools = item.tools.map(t => ({
        id: t.callId,
        name: t.name,
        input: t.input,
        description: t.description,
        status: mapToolCallStatus(t.status),
        result: t.resultDisplay?.content,
        isError: t.resultDisplay?.isError,
        renderOutputAsMarkdown: t.renderOutputAsMarkdown,
        progressMessage: t.progressMessage,
        resultSummary: t.resultSummary,
      }));
      return (
        <ToolGroupMessage
          tools={tools}
          terminalWidth={width}
        />
      );
    }

    case "compression":
      return (
        <Box paddingX={1} gap={1}>
          <Text color={theme.text.accent}>✻</Text>
          <Text dimColor>
            {"对话已压缩"}
            {item.originalTokenCount && item.newTokenCount
              ? ` (${item.originalTokenCount} → ${item.newTokenCount} tokens)`
              : ""}
          </Text>
        </Box>
      );

    case "model":
      return (
        <Box paddingX={1}>
          <Text color={theme.text.accent}>{"🔄 模型已切换为 "}{item.model}</Text>
        </Box>
      );

    case "about":
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.text.accent} bold>sid-code {item.cliVersion}</Text>
          <Text dimColor>模型: {item.model}</Text>
          <Text dimColor>提供商: {item.provider}</Text>
        </Box>
      );

    case "help":
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.text.accent} bold>可用命令：</Text>
          {item.commands.map(cmd => (
            <Box key={cmd.name}>
              <Text color={theme.text.primary} bold>{"  /"}{cmd.name}</Text>
              {cmd.aliases.length > 0 && (
                <Text dimColor>{" ("}{cmd.aliases.map(a => `/${a}`).join(", ")}{")"}</Text>
              )}
              <Text dimColor>{" — "}{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      );

    case "stats":
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.text.accent} bold>会话统计</Text>
          <Text dimColor>时长: {item.duration}</Text>
          <Text dimColor>输入 tokens: {item.inputTokens.toLocaleString()}</Text>
          <Text dimColor>输出 tokens: {item.outputTokens.toLocaleString()}</Text>
          <Text dimColor>费用: ${item.costUSD.toFixed(4)}</Text>
        </Box>
      );

    case "quit":
      return (
        <Box paddingX={1}>
          <Text dimColor>{"── 会话结束 (时长: "}{item.duration}{") ──"}</Text>
        </Box>
      );

    case "command":
      return (
        <Box flexDirection="column" marginTop={turnSpacing}>
          <CommandMessage
            input={item.input}
            output={item.output}
            width={width}
            isError={item.isError}
          />
        </Box>
      );

    case "plan_review":
      return (
        <PlanReviewMessage
          planContent={item.planContent}
          planFilePath={item.planFilePath}
          terminalWidth={width}
        />
      );

    default:
      return null;
  }
};

/** 将 types.ts 的 ToolCallStatus 枚举映射为 ToolShared 的字符串状态 */
function mapToolCallStatus(status: ToolCallStatus): "pending" | "executing" | "success" | "error" | "cancelled" | "confirming" {
  switch (status) {
    case ToolCallStatus.Pending: return "pending";
    case ToolCallStatus.Confirming: return "confirming";
    case ToolCallStatus.Executing: return "executing";
    case ToolCallStatus.Success: return "success";
    case ToolCallStatus.Canceled: return "cancelled";
    case ToolCallStatus.Error: return "error";
    default: return "pending";
  }
}
