/**
 * 命令消息组件 — CM2（bash 输入/输出区分渲染）
 *
 * 区分两类命令历史项：
 * 1. bash 命令（用户用 `! ` 前缀执行，内部记为 `/bash <cmd>`）：
 *    - 输入行用 `! ` 前缀 + 绿色高亮，呼应 shell 模式的视觉语义。
 *      命令本身默认截断到 2 行 / 160 字符（对标 cc BashTool/UI.tsx），ctrl+o 展开。
 *    - 输出按 stdout / stderr 分流：stderr（isError）红色，stdout 默认 dim。
 *      输出默认折叠到 3 行（对标 cc MAX_LINES_TO_SHOW），ctrl+o 阶梯展开。
 * 2. 普通斜杠命令（/help、/model 等）：沿用 UserMessage 的 "> " 前缀渲染。
 *    输出同样折叠到 3 行 + ctrl+o 展开。
 *
 * 对标 claude-code 的 bash 输入绿底 + 输出 stdout/stderr 分离 + 长内容折叠。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { UserMessage } from "./UserMessage.tsx";
import { stringWidth } from "../../../ink/stringWidth.js";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { useExpandLevel, useExpandedMaxLines } from "../../contexts/UIStateContext.tsx";
import { truncateShellCommand } from "../../constants/collapse.ts";

interface CommandMessageProps {
  input: string;
  output: string | null;
  width: number;
  /** 输出是否为错误流（stderr / 执行失败）。 */
  isError?: boolean;
}

/** bash 命令前缀：内部以 `/bash ` 记录，UI 还原为用户视角的 `! `。 */
const BASH_PREFIX = "/bash ";

/** 输出折叠后留给摘要/缩进的安全边距（与树枝缩进对齐节奏一致）。 */
const OUTPUT_WIDTH_PADDING = 4;

/** 判断该命令是否为 bash（shell 模式）命令。 */
export function isBashCommand(input: string): boolean {
  return input.startsWith(BASH_PREFIX);
}

/** 把内部 `/bash <cmd>` 还原为用户敲入的原始 shell 命令。 */
export function extractBashCommand(input: string): string {
  return input.slice(BASH_PREFIX.length);
}

export const CommandMessage: React.FC<CommandMessageProps> = ({
  input,
  output,
  width,
  isError = false,
}) => {
  const expandLevel = useExpandLevel();
  // 输出折叠：复用全局 expandLevel → maxLines 映射，与工具结果区共享 ctrl+o 阶梯展开。
  const outputMaxLines = useExpandedMaxLines(3);
  // 命令行截断：level >= 1 时展开完整命令（与 ToolMessage 一致）。
  const isFullyExpanded = expandLevel >= 1;
  // 折叠时保留顶部（命令输出的开头通常最关键）；宽度感知换行兜住单条超长行。
  const outputMaxColumnWidth = Math.max(width - OUTPUT_WIDTH_PADDING, 20);

  // ── 普通斜杠命令：沿用 UserMessage ──
  // 内置斜杠命令（/think、/help、/model 等）的输出是我们自己生产的 UI 文本，
  // 长度可控、需被完整阅读，不应像工具结果 / bash 输出那样被折叠。
  // 故此处不套 SlicingMaxSizedBox，直接全量渲染（仍按列宽换行）。
  if (!isBashCommand(input)) {
    return (
      <Box flexDirection="column">
        <UserMessage text={input} width={width} />
        {output ? (
          <Box paddingLeft={2} marginTop={1}>
            <Text
              color={isError ? theme.status.error : undefined}
              dimColor={!isError}
              wrap="wrap"
            >
              {output}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // ── bash 命令：! 前缀 + 绿色高亮输入，stdout/stderr 分流输出 ──
  const cmd = extractBashCommand(input);
  const prefix = "! ";
  const command = truncateShellCommand(cmd, isFullyExpanded);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box flexDirection="row" width={width}>
          <Box width={stringWidth(prefix)} flexShrink={0}>
            <Text color={theme.status.success} bold>
              {prefix}
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text
              color={theme.status.success}
              wrap={command.truncated ? "truncate-end" : "wrap"}
            >
              {command.text}
            </Text>
          </Box>
        </Box>
        {command.truncated ? (
          <Box flexDirection="row">
            <Box width={stringWidth(prefix)} flexShrink={0}>
              <Text> </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.text.secondary} dimColor>
                {command.summary}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      {output ? (
        <Box paddingLeft={2} flexDirection="column" marginTop={1}>
          <SlicingMaxSizedBox
            text={output}
            maxLines={outputMaxLines}
            overflowDirection="bottom"
            maxColumnWidth={outputMaxColumnWidth}
            color={isError ? theme.status.error : theme.text.secondary}
          />
        </Box>
      ) : null}
    </Box>
  );
};
