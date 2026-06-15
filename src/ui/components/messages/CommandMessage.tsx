/**
 * 命令消息组件 — CM2（bash 输入/输出区分渲染）
 *
 * 区分两类命令历史项：
 * 1. bash 命令（用户用 `! ` 前缀执行，内部记为 `/bash <cmd>`）：
 *    - 输入行用 `! ` 前缀 + 绿色高亮，呼应 shell 模式的视觉语义。
 *    - 输出按 stdout / stderr 分流：stderr（isError）红色，stdout 默认 dim。
 * 2. 普通斜杠命令（/help、/model 等）：沿用 UserMessage 的 "> " 前缀渲染。
 *
 * 对标 claude-code 的 bash 输入绿底 + 输出 stdout/stderr 分离。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { theme } from "../../semantic-colors.ts";
import { UserMessage } from "./UserMessage.tsx";
import { stringWidth } from "../../../ink/stringWidth.js";

interface CommandMessageProps {
  input: string;
  output: string | null;
  width: number;
  /** 输出是否为错误流（stderr / 执行失败）。 */
  isError?: boolean;
}

/** bash 命令前缀：内部以 `/bash ` 记录，UI 还原为用户视角的 `! `。 */
const BASH_PREFIX = "/bash ";

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
  // ── 普通斜杠命令：沿用 UserMessage ──
  if (!isBashCommand(input)) {
    return (
      <Box flexDirection="column">
        <UserMessage text={input} width={width} />
        {output ? (
          <Box paddingLeft={2} marginTop={1}>
            <Text color={isError ? theme.status.error : undefined} dimColor={!isError}>
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
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width={width}>
        <Box width={stringWidth(prefix)} flexShrink={0}>
          <Text color={theme.status.success} bold>
            {prefix}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={theme.status.success} wrap="wrap">
            {cmd}
          </Text>
        </Box>
      </Box>
      {output ? (
        <Box paddingLeft={2} flexDirection="column" marginTop={1}>
          <Text color={isError ? theme.status.error : theme.text.secondary} wrap="wrap">
            {output}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
