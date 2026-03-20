/**
 * 退出帧根组件
 *
 * 当 isQuitting=true 时，App.tsx 切换渲染此组件。
 * Ink fork 会在 app.unmount() 时将最终帧输出到主缓冲区，
 * 使用户退出 alternate buffer 后仍可查看完整对话历史。
 *
 * 参考 gemini-cli AlternateBufferQuittingDisplay.tsx
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { DisplayItem } from "../App.tsx";
import { QuittingDisplay } from "./QuittingDisplay.tsx";
import { theme } from "../semantic-colors.ts";

interface AlternateBufferQuittingDisplayProps {
  /** 完整的对话历史 */
  displayItems: DisplayItem[];
  /** 流式输出中的文本（如果退出时正在流式输出） */
  streamingText?: string;
}

export const AlternateBufferQuittingDisplay = React.memo(
  function AlternateBufferQuittingDisplay({
    displayItems,
    streamingText,
  }: AlternateBufferQuittingDisplayProps) {
    const { stdout } = useStdout();
    const termWidth = stdout.columns || 80;

    // 简单的 Header
    const version = require("../../../package.json").version;

    return (
      <Box
        flexDirection="column"
        flexShrink={0}
        flexGrow={0}
        width={termWidth}
      >
        {/* Header */}
        <Box marginBottom={1}>
          <Text color={theme.ui.active} bold>
            sid-code v{version}
          </Text>
          <Text dimColor> · AI-Powered Coding Assistant</Text>
        </Box>

        {/* 完整对话历史 */}
        <QuittingDisplay items={displayItems} />

        {/* 如果退出时正在流式输出，显示未完成的文本 */}
        {streamingText ? (
          <Box paddingRight={4}>
            <Text dimColor>{streamingText}</Text>
          </Box>
        ) : null}

        {/* 退出提示 */}
        <Box marginTop={1}>
          <Text dimColor>── 会话结束 ──</Text>
        </Box>
      </Box>
    );
  },
);
