/**
 * 空状态 Logo 组件
 *
 * 当没有对话历史时显示的欢迎界面。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";

interface EmptyLogoProps {
  termWidth: number;
}

export function EmptyLogo({ termWidth }: EmptyLogoProps) {
  const logoLines = [
    "   _____ _     _     _____          _      ",
    "  / ____(_)   | |   / ____|        | |     ",
    " | (___  _  __| |  | |     ___   __| | ___ ",
    "  \\___ \\| |/ _` |  | |    / _ \\ / _` |/ _ \\",
    "  ____) | | (_| |  | |___| (_) | (_| |  __/",
    " |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|",
  ];
  const margin = 2;
  const boxInner = Math.max(47, termWidth - margin * 2 - 2);
  const topLine = "╭" + "─".repeat(boxInner) + "╮";
  const botLine = "╰" + "─".repeat(boxInner) + "╯";
  const emptyLine = "│" + " ".repeat(boxInner) + "│";
  const version = `v${require("../../../package.json").version}  ·  AI-Powered Coding Assistant`;
  const vLeft = Math.floor(Math.max(0, boxInner - version.length) / 2);
  const vRight = Math.max(0, boxInner - version.length - vLeft);

  return (
    <Box flexDirection="column" paddingX={margin} paddingY={1}>
      <Text color={theme.ui.active}>{topLine}</Text>
      <Text color={theme.ui.active}>{emptyLine}</Text>
      {logoLines.map((line, i) => {
        const left = Math.floor(Math.max(0, boxInner - line.length) / 2);
        const right = Math.max(0, boxInner - line.length - left);
        return (
          <Box key={`logo-${i}`}>
            <Text color={theme.ui.active}>{"│"}</Text>
            <Text>{" ".repeat(left)}</Text>
            <Text color={theme.ui.active} bold>{line}</Text>
            <Text>{" ".repeat(right)}</Text>
            <Text color={theme.ui.active}>{"│"}</Text>
          </Box>
        );
      })}
      <Text color={theme.ui.active}>{emptyLine}</Text>
      <Box>
        <Text color={theme.ui.active}>{"│"}</Text>
        <Text>{" ".repeat(vLeft)}</Text>
        <Text dimColor>{version}</Text>
        <Text>{" ".repeat(vRight)}</Text>
        <Text color={theme.ui.active}>{"│"}</Text>
      </Box>
      <Text color={theme.ui.active}>{emptyLine}</Text>
      <Text color={theme.ui.active}>{botLine}</Text>
    </Box>
  );
}
