/**
 * Composer 组件（底部区域容器）
 *
 * 参考 gemini-cli Composer.tsx，集成：
 * - LoadingIndicator（加载中 spinner + 计时器 + esc 取消提示）
 * - ToolStatus（工具执行状态，内联在 LoadingIndicator 中）
 * - ApprovalModeIndicator（权限模式指示）
 * - RawMarkdownIndicator（原始 Markdown 模式指示）
 * - ContextUsageDisplay（上下文使用量警告）
 * - ShortcutsHint / ShortcutsHelp（? 键展开快捷键帮助）
 * - InputArea（输入框）
 * - 宽窄屏自适应布局
 *
 * Composer 和 DialogRenderer 互斥显示。
 */

import React, { useState, useEffect } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import useStdout from "../../ink/_vendor/use-stdout.js";
import { InputArea } from "../InputArea.tsx";
import { LoadingIndicator } from "./LoadingIndicator.tsx";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";
import { theme } from "../semantic-colors.ts";
import { useStreamingState, StreamingState } from "../contexts/StreamingContext.tsx";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { useConfig } from "../contexts/ConfigContext.tsx";
import { useSession } from "../contexts/SessionContext.tsx";
import { useLoadingIndicator } from "../hooks/useLoadingIndicator.ts";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { CommandInfo } from "../hooks/useSlashCompletion.ts";
import { DEFAULT_TERM_WIDTH } from "../markdown.ts";

/** 窄屏阈值 */
const NARROW_WIDTH_THRESHOLD = 60;

function isNarrowWidth(width: number): boolean {
  return width < NARROW_WIDTH_THRESHOLD;
}

// ── 子指示器组件 ──

/** 权限模式指示器 */
const ApprovalModeIndicator: React.FC<{ permissionMode: string }> = ({ permissionMode }) => {
  let textColor = theme.text.accent;
  let textContent = "";
  let subText = "";

  switch (permissionMode) {
    case "always-allow":
    case "dontAsk":
      textColor = theme.status.error;
      textContent = "YOLO";
      subText = "Ctrl+Shift+A 切换";
      break;
    case "plan":
      textColor = theme.status.success;
      textContent = "plan";
      subText = "Ctrl+Shift+A 切换";
      break;
    case "deny-write":
      textColor = theme.status.warning;
      textContent = "只读";
      subText = "Ctrl+Shift+A 切换";
      break;
    default:
      // 默认模式不显示
      return null;
  }

  return (
    <Box>
      <Text color={textColor}>
        ● {textContent}
        {subText ? <Text color={theme.text.secondary}> {subText}</Text> : null}
      </Text>
    </Box>
  );
};

/** 原始 Markdown 指示器 */
const RawMarkdownIndicator: React.FC = () => (
  <Text color={theme.status.warning}>● RAW</Text>
);

/** 上下文使用量显示 */
const ContextUsageDisplay: React.FC<{ contextPercent: number }> = ({ contextPercent }) => {
  let textColor = theme.text.secondary;
  if (contextPercent >= 90) {
    textColor = theme.status.error;
  } else if (contextPercent >= 70) {
    textColor = theme.status.warning;
  }

  // 低使用量不显示
  if (contextPercent < 50) return null;

  return (
    <Text color={textColor}>
      ctx {contextPercent}%
    </Text>
  );
};

/** 快捷键提示（点击 ? 展开完整列表） */
const ShortcutsHint: React.FC<{ expanded: boolean }> = ({ expanded }) => {
  const highlightColor = expanded ? theme.text.accent : theme.text.secondary;
  return <Text color={highlightColor}> ? 查看快捷键 </Text>;
};

/** 工具完成状态（短暂显示） */
const ToolResultIndicator: React.FC<{
  lastResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
}> = ({ lastResult }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (lastResult) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [lastResult]);

  if (!visible || !lastResult) return null;

  const icon = lastResult.isError ? "✕" : "✓";
  const color = lastResult.isError ? theme.status.error : theme.status.success;
  const elapsed = lastResult.elapsedMs < 1000
    ? `${lastResult.elapsedMs}ms`
    : `${(lastResult.elapsedMs / 1000).toFixed(1)}s`;

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text bold>{lastResult.toolName}</Text>
      <Text dimColor> {elapsed}</Text>
    </Box>
  );
};

// ── 主组件 ──

interface ComposerProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
  commands: CommandInfo[];
  cwd: string;
}

export const Composer: React.FC<ComposerProps> = ({
  onSubmit,
  isLoading,
  commands,
  cwd,
}) => {
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  const isNarrow = isNarrowWidth(termWidth);

  const streaming = useStreamingState();
  const uiState = useUIState();
  const config = useConfig();
  const session = useSession();

  // 快捷键帮助展开状态
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);

  const { elapsedTime, currentLoadingPhrase } = useLoadingIndicator({
    streamingState: streaming.streamingState,
    toolName: streaming.toolName,
  });

  const isResponding = streaming.streamingState === StreamingState.Responding;
  const isWaiting = streaming.streamingState === StreamingState.WaitingForConfirmation;
  const isIdle = streaming.streamingState === StreamingState.Idle;
  const showLoadingIndicator = isResponding || isWaiting;
  const showRawMarkdownIndicator = !uiState.renderMarkdown;
  const showContextUsage = session.contextPercent >= 50;

  // ? 键展开/收起快捷键帮助（仅空闲且输入为空时）
  useKeypress(KeypressPriority.Normal, (key) => {
    if (!isIdle || isLoading) return false;
    if (key.insertable && key.sequence === "?" && !shortcutsHelpVisible) {
      // 仅在输入框为空时触发（避免输入 ? 字符时误触发）
      // 这里无法直接判断输入框是否为空，所以用 debounce 方式：
      // 如果 200ms 内没有其他按键，则展开
      setShortcutsHelpVisible(true);
      return false; // 不消费，让 InputArea 也能收到 ?
    }
    if (shortcutsHelpVisible && key.name !== "?" && key.sequence !== "?") {
      // 任意非 ? 键关闭帮助
      setShortcutsHelpVisible(false);
    }
    return false;
  });

  // 非空闲时自动关闭帮助
  useEffect(() => {
    if (!isIdle && shortcutsHelpVisible) {
      setShortcutsHelpVisible(false);
    }
  }, [isIdle, shortcutsHelpVisible]);

  return (
    <Box flexDirection="column" width={termWidth} flexGrow={0} flexShrink={0}>
      {/* 快捷键帮助（展开时显示在输入框上方） */}
      {shortcutsHelpVisible && isIdle && <ShortcutsHelp />}

      {/* 上方区域：状态指示器（宽窄屏自适应） */}
      <Box
        width="100%"
        flexDirection={isNarrow ? "column" : "row"}
        alignItems={isNarrow ? "flex-start" : "center"}
        justifyContent={isNarrow ? "flex-start" : "space-between"}
      >
        {/* 左侧：LoadingIndicator / ToolResult / 模式指示器 */}
        <Box
          marginLeft={1}
          marginRight={isNarrow ? 0 : 1}
          flexDirection="row"
          alignItems="center"
          flexGrow={1}
        >
          {/* 瞬态消息优先显示 */}
          {uiState.transientMessage ? (
            <Text color={
              uiState.transientMessage.type === "warning" ? theme.status.warning
              : uiState.transientMessage.type === "hint" ? theme.text.accent
              : theme.text.primary
            }>
              {uiState.transientMessage.text}
            </Text>
          ) : showLoadingIndicator ? (
            <LoadingIndicator
              inline
              streamingState={streaming.streamingState}
              elapsedTime={elapsedTime}
              currentLoadingPhrase={currentLoadingPhrase}
              toolName={streaming.toolName}
            />
          ) : (
            <Box flexDirection={isNarrow ? "column" : "row"} alignItems={isNarrow ? "flex-start" : "center"}>
              {/* 工具完成状态（短暂显示） */}
              <ToolResultIndicator lastResult={streaming.lastToolResult} />
              {/* 权限模式指示 */}
              {!streaming.lastToolResult && (
                <ApprovalModeIndicator permissionMode={config.permissionMode} />
              )}
              {showRawMarkdownIndicator && (
                <Box marginLeft={isNarrow ? 0 : 1}>
                  <RawMarkdownIndicator />
                </Box>
              )}
            </Box>
          )}
        </Box>

        {/* 右侧：上下文使用量 / 快捷键提示 */}
        <Box
          flexDirection="row"
          alignItems="center"
          marginRight={1}
        >
          {showContextUsage && !showLoadingIndicator && (
            <Box marginRight={1}>
              <ContextUsageDisplay contextPercent={session.contextPercent} />
            </Box>
          )}
          {isIdle && <ShortcutsHint expanded={shortcutsHelpVisible} />}
        </Box>
      </Box>

      {/* 输入框 */}
      <InputArea
        onSubmit={onSubmit}
        isLoading={isLoading}
        commands={commands}
        cwd={cwd}
      />
    </Box>
  );
};
