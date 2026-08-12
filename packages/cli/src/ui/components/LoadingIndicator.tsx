/**
 * 加载指示器组件
 *
 * 显示 spinner + 加载短语 + 计时器 + token 累计 + esc 取消提示。
 * 对标 claude-code 底部那行 `✻ Recombobulating… (18m 38s · ↑ 11.4k tokens)`。
 * 参考 gemini-cli LoadingIndicator.tsx
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import useStdout from "@sid-code/tui-renderer/_vendor/use-stdout.ts";
import { theme } from "../semantic-colors.ts";
import { StreamingState } from "../types.ts";
import { useIsAccessibilityEnabled } from "../accessibility/AccessibilityContext.tsx";
import { BULLET } from "../constants/figures.ts";
import { TOOL_TIMER_THRESHOLD_SEC, formatToolElapsed } from "../constants/loading-phrases.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";
import { formatLargeNumber } from "../utils/format-number.ts";

/** Spinner 帧 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface LoadingIndicatorProps {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 已过秒数 */
  elapsedTime: number;
  /** 当前加载短语 */
  currentLoadingPhrase?: string | null;
  /** 慢响应渐进提示（达阈值才出现）。暗色追加，不抢主文案。 */
  slowHint?: string | null;
  /** 工具名称（执行工具时显示） */
  toolName?: string | null;
  /** L3：当前工具已执行秒数。超过阈值时在工具文案后追加「· 已执行 Xs」。 */
  toolElapsedTime?: number;
  /** 本轮新增的输出 token 数（↑ 上行，= 会话累计 − 本轮起点）。0 或缺省时不显示 token 段。 */
  outputTokens?: number;
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
  slowHint,
  toolName,
  toolElapsedTime = 0,
  outputTokens = 0,
  inline = false,
  showCancelAndTimer = true,
}) => {
  // Spinner 动画
  const a11y = useIsAccessibilityEnabled();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || DEFAULT_TERM_WIDTH;
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    // LY2：无障碍模式下不跑动画——屏幕阅读器会把每帧字符变化读成噪声。
    if (a11y) return;
    if (streamingState === StreamingState.Idle) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 50); // 对齐 cc 的 ~50ms 帧率（此前 80ms 略显迟滞）
    return () => clearInterval(timer);
  }, [streamingState, a11y]);

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  // LY2：无障碍模式用静态可朗读标记替代动画 spinner。
  const spinner = a11y ? BULLET : SPINNER_FRAMES[frame];
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;

  // 主文本（动词，最高优先级，任何宽度都保留）
  // L3：工具执行超过阈值时，在工具名后追加「· 已执行 Xs」，让长工具（git clone /
  // 测试套件 / sub-agent）的内部进展可见，与整轮计时区分。短工具不打扰。
  const showToolTimer = !!toolName && toolElapsedTime >= TOOL_TIMER_THRESHOLD_SEC;
  const primaryText = toolName
    ? showToolTimer
      ? `执行 ${toolName}… · ${formatToolElapsed(toolElapsedTime)}`
      : `执行 ${toolName}…`
    : currentLoadingPhrase || "思考中…";

  // 窄终端渐进隐藏：按「动词 > 计时 > token > 取消提示」优先级降级。
  // - 宽 (≥72)：esc 取消 + 计时 + token（对标 cc 完整形态）
  // - 中宽 (60–71)：计时 + token（省 esc 文案）
  // - 中 (40–59)：仅计时
  // - 窄 (<40)：只留动词 + spinner
  // token 仅在有实际输出（>0）且非等待态时显示。
  const elapsed = formatDuration(elapsedTime);
  const tokenStr =
    !isWaiting && outputTokens > 0 ? `↑ ${formatLargeNumber(outputTokens)} tokens` : null;
  let cancelAndTimer: string | null = null;
  if (showCancelAndTimer && !isWaiting) {
    if (termWidth >= 72) {
      cancelAndTimer = tokenStr ? `(esc 取消, ${elapsed} · ${tokenStr})` : `(esc 取消, ${elapsed})`;
    } else if (termWidth >= 60) {
      cancelAndTimer = tokenStr ? `(${elapsed} · ${tokenStr})` : `(${elapsed})`;
    } else if (termWidth >= 40) {
      cancelAndTimer = `(${elapsed})`;
    } else {
      cancelAndTimer = null;
    }
  }

  // inline / block 两种容器复用同一内容片段，避免渲染逻辑重复。
  // 慢提示用 text.secondary 中性灰追加，不抢主文案、不报警（遵守交互铁律 C 渐进衰减、
  // D 反馈活而不吵——文字本身不动，达静默阈值才出现）。
  // ⚠️ 不用 status.warning（黄）：慢提示只陈述「还在等」的客观事实，不是错误/告警，
  // 黄色会让用户误判为出问题；模型正常输出（含思考）时静默计时归零，根本不会进这里。
  const showSlowHint = !!slowHint && !isWaiting;
  const content = (
    <>
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
      {showSlowHint && (
        <>
          <Text> </Text>
          <Text color={theme.text.secondary}>· {slowHint}</Text>
        </>
      )}
    </>
  );

  if (inline) {
    return <Box>{content}</Box>;
  }

  return (
    <Box flexDirection="column">
      <Box>{content}</Box>
    </Box>
  );
};
