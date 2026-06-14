/**
 * AppHeader 组件
 *
 * 显示在消息列表顶部，随消息一起滚动。
 * 包含：Logo（渐变文本）、版本号、Tips。
 *
 * 参考 gemini-cli AppHeader.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { ThemedGradient } from "./ThemedGradient.tsx";
import { theme } from "../semantic-colors.ts";

const LOGO = `   _____ _     _     _____          _
  / ____(_)   | |   / ____|        | |
 | (___  _  __| |  | |     ___   __| | ___
  \\___ \\| |/ _\` |  | |    / _ \\ / _\` |/ _ \\
  ____) | | (_| |  | |___| (_) | (_| |  __/
 |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|`;

/** 随机 Tips */
const TIPS = [
  "按 Ctrl+S 进入 Copy Mode 选择和复制文本",
  "按 Ctrl+O 展开/折叠长回复",
  "按 Alt+M 切换 Markdown 渲染模式",
  "使用 /compact 压缩对话历史节省 token",
  "使用 /undo 撤销最近一次文件修改",
  "使用 /theme 切换主题",
  "使用 @ 引用文件路径，/ 触发命令补全",
  "使用 /memory set <key> <value> 保存记忆",
  "使用 /rewind 回退最近一轮对话",
  "按 ? 查看快捷键帮助",
];

function getRandomTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

interface AppHeaderProps {
  version: string;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ version }) => {
  const tip = getRandomTip();

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Logo + 版本 */}
      <Box flexDirection="row" paddingLeft={2}>
        <Box flexShrink={0}>
          <ThemedGradient>{LOGO}</ThemedGradient>
        </Box>
      </Box>

      <Box paddingLeft={2} marginTop={0}>
        <Text bold color={theme.text.primary}>Sid Code</Text>
        <Text color={theme.text.secondary}> v{version}</Text>
      </Box>

      {/* Tip：品牌色小标记 + dim 文本，降低花哨感 */}
      <Box paddingLeft={2} marginTop={1}>
        <Text color={theme.ui.active}>{"› "}</Text>
        <Text color={theme.text.secondary} dimColor>{tip}</Text>
      </Box>
    </Box>
  );
};
