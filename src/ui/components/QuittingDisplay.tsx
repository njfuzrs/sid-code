/**
 * 退出时的消息列表组件
 *
 * 当用户退出 alternate buffer 时，渲染完整对话历史到主缓冲区，
 * 使用户可以在退出后继续查看对话内容。
 *
 * 参考 gemini-cli QuittingDisplay.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.tsx";
import useStdout from "../../ink/_vendor/use-stdout.ts";
import type { HistoryItem } from "../types.ts";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";

interface QuittingDisplayProps {
  /** 要渲染的所有 HistoryItem */
  items: HistoryItem[];
}

export const QuittingDisplay = React.memo(function QuittingDisplay({
  items,
}: QuittingDisplayProps) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;

  if (items.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" width={termWidth} marginBottom={1}>
      {items.map((item, index) => (
        <HistoryItemDisplay
          key={item.id}
          item={item}
          prevItem={index > 0 ? items[index - 1] : undefined}
          terminalWidth={termWidth}
        />
      ))}
    </Box>
  );
});
