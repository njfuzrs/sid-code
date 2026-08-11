/**
 * 历史项渲染分发器
 *
 * 接收 HistoryItem，根据 type 字段分发到对应的专用子组件。
 * 替代原来的 MessageItemRenderer（直接解析 LLM Message）。
 *
 * 间距规范（src/ui/CLAUDE.md L2.2）：
 *   历史区由 <Static> 逐项打印进终端 scrollback，Ink 不像 CSS 那样合并相邻 margin。
 *   故统一只用 marginBottom={1}、绝不叠 marginTop —— 任意两项之间恒为 1 行留白。
 *   （旧实现给 user/thinking/tool_group 额外加 marginTop=1，与上一项的 marginBottom 叠成
 *    2 行，造成"有的宽 2 行、有的紧 1 行"的不协调，已废弃。）
 *
 * 参考 gemini-cli HistoryItemDisplay.tsx
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import type { HistoryItem } from "../types.ts";
import { ToolCallStatus } from "../types.ts";
import { formatLargeNumber } from "../utils/format-number.ts";
import { UserMessage } from "./messages/UserMessage.tsx";
import { CommandMessage } from "./messages/CommandMessage.tsx";
import { AssistantMessage } from "./messages/AssistantMessage.tsx";
import { ToolGroupMessage } from "./messages/ToolGroupMessage.tsx";
import { isShellTool } from "./messages/ToolShared.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import { ErrorMessage } from "./messages/ErrorMessage.tsx";
import { PlanReviewMessage } from "./messages/PlanReviewMessage.tsx";
import { TaskNotificationMessage } from "./messages/TaskNotificationMessage.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { theme } from "../semantic-colors.ts";
import { ARROW_PROMPT, WARNING_MARK, THINKING_MARK } from "../constants/figures.ts";

interface HistoryItemDisplayProps {
  item: HistoryItem;
  prevItem?: HistoryItem;
  terminalWidth: number;
  /** v2：思考块折叠状态 */
  thinkCollapsed?: boolean;
  /**
   * 折叠态是否提示「ctrl+o 展开」。AB 虚拟列表模式可即时重渲 → true；
   * 主屏 Static 模式已打印项无法重渲 → false（避免误导）。默认 true。
   */
  thinkExpandable?: boolean;
}

export const HistoryItemDisplay: React.FC<HistoryItemDisplayProps> = ({
  item,
  terminalWidth,
  thinkCollapsed = false,
  thinkExpandable = true,
}) => {
  const width = terminalWidth;

  switch (item.type) {
    case "app_header":
      // AppHeader 自带上下留白（首屏 logo 单独成块），不再外包 margin。
      return <AppHeader version={item.version} />;

    case "user":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <UserMessage text={item.text} width={width} />
        </Box>
      );

    case "assistant":
      return (
        <Box marginBottom={1}>
          <AssistantMessage
            text={item.text}
            width={width}
          />
        </Box>
      );

    case "assistant_content":
      return (
        <Box marginBottom={1}>
          <AssistantMessage
            text={item.text}
            width={width}
          />
        </Box>
      );

    case "thinking":
      return (
        <Box marginBottom={1}>
          <ThinkingMessage
            text={item.thought.text}
            width={width}
            collapsed={thinkCollapsed}
            thinkingSeconds={item.thought.durationSeconds}
            showExpandHint={thinkExpandable}
          />
        </Box>
      );

    case "hint":
      return (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text color={theme.text.secondary} italic>{item.text}</Text>
        </Box>
      );

    case "info":
      return (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={item.color || theme.text.secondary}>
            {item.icon ? `${item.icon} ` : "· "}{item.text}
          </Text>
          {item.secondaryText && (
            <Text>{" "}{item.secondaryText}</Text>
          )}
        </Box>
      );

    case "warning":
      return (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.status.warning}>{`${WARNING_MARK} `}{item.text}</Text>
        </Box>
      );

    case "error":
      return (
        <Box marginBottom={1}>
          <ErrorMessage text={item.text} width={width} />
        </Box>
      );

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
        // 子代理实时进度（仅 executing 态的 sub_agent 有值），治过程黑盒
        agentProgress: t.agentProgress,
        resultSummary: t.resultSummary,
        // 结构化 diff + 文件名透传(否则在此拍扁丢失,UI 拿不到结构化 patch)
        structuredPatch: t.resultDisplay?.structuredPatch,
        filename: t.resultDisplay?.filename,
        // 呈现档位透传：hidden 由 ToolGroupMessage 整条过滤，summary 只渲染 header。
        // 与 structuredPatch 同理——不透传就在此拍扁丢失，泄漏的提示词会照旧渲染出来。
        displayMode: t.resultDisplay?.displayMode,
        // bash/shell 工具：从 input 提取完整命令行
        shellCommand: isShellTool(t.name) ? (t.input as any)?.command || "" : undefined,
      }));
      return (
        <Box marginBottom={1}>
          <ToolGroupMessage
            tools={tools}
            terminalWidth={width}
          />
        </Box>
      );
    }

    case "compression": {
      // P1-3：优先显示消息数实据（压缩最直观的度量），其次 token 数。
      // 两者都缺才退回裸文案——但正常路径下 queryLoop 一定会带上消息数。
      const evidence =
        item.messageCountBefore !== undefined && item.messageCountAfter !== undefined
          ? `${item.messageCountBefore} → ${item.messageCountAfter} 条消息`
          : item.originalTokenCount && item.newTokenCount
            ? `${item.originalTokenCount} → ${item.newTokenCount} tokens`
            : "";
      return (
        <Box paddingLeft={2} gap={1} marginBottom={1}>
          <Text color={theme.text.accent}>{THINKING_MARK}</Text>
          <Text>
            {"对话已压缩"}
            {evidence ? ` (${evidence})` : ""}
          </Text>
        </Box>
      );
    }

    case "model":
      return (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text color={theme.text.secondary}>{"模型已切换为 "}<Text color={theme.text.primary}>{item.model}</Text></Text>
        </Box>
      );

    case "about":
      return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text color={theme.text.accent} bold>sid-code {item.cliVersion}</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text>模型: {item.model}</Text>
            <Text>提供商: {item.provider}</Text>
          </Box>
        </Box>
      );

    case "help":
      return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text color={theme.text.accent} bold>可用命令：</Text>
          {item.commands.map(cmd => (
            <Box key={cmd.name} paddingLeft={2} flexDirection="column">
              <Box>
                <Text color={theme.text.primary} bold>{"/"}{cmd.name}</Text>
                {cmd.aliases.length > 0 && (
                  <Text>{" ("}{cmd.aliases.map(a => `/${a}`).join(", ")}{")"}</Text>
                )}
              </Box>
              <Text>{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      );

    case "stats":
      return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text color={theme.text.accent} bold>会话统计</Text>
          <Box paddingLeft={2}>
            <Text>时长: {item.duration}</Text>
            <Text>输入 tokens: {formatLargeNumber(item.inputTokens)}</Text>
            <Text>输出 tokens: {formatLargeNumber(item.outputTokens)}</Text>
            <Text>费用: ${item.costUSD.toFixed(4)}</Text>
          </Box>
        </Box>
      );

    case "quit":
      return (
        <Box paddingX={1} marginBottom={1}>
          <Text>{"── 会话结束 (时长: "}{item.duration}{") ──"}</Text>
        </Box>
      );

    case "command":
      return (
        <Box flexDirection="column" marginBottom={1}>
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
        <Box marginBottom={1}>
          <PlanReviewMessage
            planContent={item.planContent}
            planFilePath={item.planFilePath}
            terminalWidth={width}
          />
        </Box>
      );

    case "task_notification":
      return (
        <Box marginBottom={1}>
          <TaskNotificationMessage
            summary={item.summary}
            status={item.status}
            result={item.result}
            agentType={item.agentType}
            terminalWidth={width}
          />
        </Box>
      );

    default:
      return null;
  }
};

/** 将 types.ts 的 ToolCallStatus 枚举映射为 ToolShared 的字符串状态 */
function mapToolCallStatus(status: ToolCallStatus): "pending" | "executing" | "success" | "error" | "cancelled" {
  switch (status) {
    case ToolCallStatus.Pending: return "pending";
    case ToolCallStatus.Executing: return "executing";
    case ToolCallStatus.Success: return "success";
    case ToolCallStatus.Canceled: return "cancelled";
    case ToolCallStatus.Error: return "error";
    default: return "pending";
  }
}
