/**
 * 通知组件
 *
 * 显示启动警告、初始化错误等持久性通知。
 * （更新提示不在这里：启动时由 App.tsx 消费 pendingNotice 走 showTransientMessage。
 *  此处曾有一个 UpdateNotification，但 setUpdateInfo 全仓零调用方，是永不渲染的死接线，已删。）
 * 参考 gemini-cli/packages/cli/src/ui/components/Notifications.tsx
 *
 * 增强：
 * - 支持 startupWarnings（按优先级过滤）
 * - 支持 initError（流式响应时隐藏）
 * - 按任意键关闭启动警告
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { useStreamingState, StreamingState } from "../contexts/StreamingContext.tsx";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { ERROR_MARK, WARNING_MARK } from "../constants/figures.ts";

/** 启动警告 */
export interface StartupWarning {
  id: string;
  message: string;
}

interface NotificationsProps {
  /** 启动警告列表 */
  startupWarnings?: StartupWarning[];
  /** 初始化错误 */
  initError?: string | null;
}

export const Notifications: React.FC<NotificationsProps> = ({
  startupWarnings = [],
  initError,
}) => {
  const { streamingState } = useStreamingState();
  const [dismissed, setDismissed] = useState(false);

  // 流式响应时隐藏初始化错误（含连接期，避免活动指示器与 init error 同屏抢眼）
  const showInitError =
    initError &&
    streamingState !== StreamingState.Responding &&
    streamingState !== StreamingState.Connecting;

  // 过滤可见警告
  const visibleWarnings = useMemo(() => {
    if (dismissed) return [];
    return startupWarnings;
  }, [startupWarnings, dismissed]);

  const showStartupWarnings = visibleWarnings.length > 0;

  // 按任意键关闭启动警告。
  // 可插入字符（字母、空格、粘贴）关闭后继续传给 InputArea：消费掉它等于吞掉用户的第一个键，
  // 用户看到「打了字没上屏」只能重打，违反 ui/CLAUDE.md L4-A「永不丢失用户输入」。
  // 非插入键（Esc / 方向键 / 回车等）照旧消费，只关警告，避免误触发提交或其他动作。
  useKeypress(
    KeypressPriority.Critical,
    useCallback(
      (key: Key) => {
        if (showStartupWarnings) {
          setDismissed(true);
          return !key.insertable;
        }
        return false;
      },
      [showStartupWarnings],
    ),
  );

  if (!showStartupWarnings && !showInitError) {
    return null;
  }

  return (
    <>
      {showStartupWarnings && (
        <Box marginY={1} flexDirection="column">
          {visibleWarnings.map((warning, index) => (
            // 按行渲染而不是把整段交给一个 Text：文案里的 \n 是为了让 URL 不被按列
            // 硬切，但整段换行后续行不再经过左侧 3 列标记，会顶格且标记列对不齐。
            <Box key={index} flexDirection="column">
              {warning.message.split("\n").map((line, lineIndex) => (
                <Box key={lineIndex} flexDirection="row">
                  <Box width={3}>
                    <Text color={theme.status.warning}>
                      {lineIndex === 0 ? `${WARNING_MARK} ` : ""}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={theme.status.warning}>{line}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
          <Text>按任意键关闭</Text>
        </Box>
      )}
      {showInitError && (
        // 不画框：初始化错误里常有路径 / 报错原文，用户会复制去搜，round 框的竖线会被一并选中（L2.2）。
        // 与启动警告同构：3 列标记列 + 正文，错误语义由 ERROR_MARK + 红色承担。
        <Box flexDirection="row" marginBottom={1}>
          <Box width={3}>
            <Text color={theme.status.error}>{`${ERROR_MARK} `}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={theme.status.error}>初始化错误: {initError}</Text>
          </Box>
        </Box>
      )}
    </>
  );
};
