/**
 * 加载指示器组件
 *
 * 显示 spinner + 加载短语 + 计时器 + esc 取消提示
 * 参考 gemini-cli LoadingIndicator.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { StreamingState } from "../types.ts";
import { useIsAccessibilityEnabled } from "../accessibility/AccessibilityContext.tsx";
import { BULLET } from "../constants/figures.ts";

/** Spinner 帧 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface LoadingIndicatorProps {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 已过秒数 */
  elapsedTime: number;
  /** 当前加载短语 */
  currentLoadingPhrase?: string | null;
  /** 工具名称（执行工具时显示） */
  toolName?: string | null;
  /** 是否内联模式（单行） */
  inline?: boolean;
  /** 是否显示取消和计时器 */
  showCancelAndTimer?: boolean;
}

/** 格式化时间 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  streamingState,
  elapsedTime,
  currentLoadingPhrase,
  toolName,
  inline = false,
  showCancelAndTimer = true,
}) => {
  // Spinner 动画
  const a11y = useIsAccessibilityEnabled();
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    // LY2：无障碍模式下不跑动画——屏幕阅读器会把每帧字符变化读成噪声。
    if (a11y) return;
    if (streamingState === StreamingState.Idle) return;
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [streamingState, a11y]);

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  // LY2：无障碍模式用静态可朗读标记替代动画 spinner。
  const spinner = a11y ? BULLET : SPINNER_FRAMES[frame];
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;

  // 主文本
  const primaryText = toolName
    ? `执行 ${toolName}...`
    : currentLoadingPhrase || "思考中...";

  // 取消和计时器
  const cancelAndTimer = showCancelAndTimer && !isWaiting
    ? `(esc 取消, ${formatDuration(elapsedTime)})`
    : null;

  if (inline) {
    return (
      <Box>
        <Text color={theme.ui.active}>{isWaiting ? "⠏" : spinner} </Text>
        <Text color={theme.text.primary} italic wrap="truncate-end">
          {primaryText}
        </Text>
        {cancelAndTimer && (
          <>
            <Text> </Text>
            <Text color={theme.text.secondary}>{cancelAndTimer}</Text>
          </>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.ui.active}>{isWaiting ? "⠏" : spinner} </Text>
        <Text color={theme.text.primary} italic wrap="truncate-end">
          {primaryText}
        </Text>
        {cancelAndTimer && (
          <>
            <Text> </Text>
            <Text color={theme.text.secondary}>{cancelAndTimer}</Text>
          </>
        )}
      </Box>
    </Box>
  );
};
