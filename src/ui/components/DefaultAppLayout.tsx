/**
 * 默认应用布局
 *
 * 从 TUIAppInner 提取的布局结构，负责：
 * - 消息区域（上方）：MainContent / EmptyLogo
 * - 底部固定区域：通知 / Composer 或 DialogRenderer / Footer
 *
 * 参考 gemini-cli DefaultAppLayout.tsx
 */

import React from "react";
import { Box, Text } from "ink";
import { Composer } from "./Composer.tsx";
import { Footer } from "./Footer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { MainContent } from "./MainContent.tsx";
import { CopyModeWarning } from "./CopyModeWarning.tsx";
import { Notifications } from "./Notifications.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo } from "../App.tsx";
import type { Usage } from "../../llm/types.ts";
import { theme } from "../semantic-colors.ts";

interface DefaultAppLayoutProps {
  // 消息区域
  listData: HistoryItem[];
  streamingText: string;
  isStreaming: boolean;
  isEmpty: boolean;
  termWidth: number;
  rows: number;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: HistoryItem, index: number) => string;
  copyModeEnabled: boolean;

  // 底部区域
  statusMessage: string;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  isLoading: boolean;
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  cwd: string;
  onSubmit: (text: string) => void;

  // Footer
  permissionMode: string;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;
  scrollPercent?: number;
}

export const DefaultAppLayout: React.FC<DefaultAppLayoutProps> = ({
  listData,
  streamingText,
  isStreaming,
  isEmpty,
  termWidth,
  rows,
  estimatedItemHeight,
  keyExtractor,
  copyModeEnabled,
  statusMessage,
  permissionRequest,
  shellConfirmRequest,
  isLoading,
  commands,
  cwd,
  onSubmit,
  permissionMode,
  gitBranch,
  debug,
  usage,
  costUSD,
  costLimit,
  contextPercent,
  model,
  scrollPercent,
}) => {
  const hasDialog = !!(permissionRequest || shellConfirmRequest);

  return (
    <Box
      flexDirection="column"
      width={termWidth}
      height={rows}
      paddingBottom={copyModeEnabled ? 0 : 1}
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
    >
      {/* 消息区域 */}
      <Box flexGrow={1}>
        {isEmpty ? (
          <Box flexDirection="column" justifyContent="center" alignItems="center" width={termWidth}>
            <EmptyLogo termWidth={termWidth} />
          </Box>
        ) : (
          <MainContent
            listData={listData}
            streamingText={streamingText}
            isStreaming={isStreaming}
            termWidth={termWidth}
            hasFocus={true}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            copyModeEnabled={copyModeEnabled}
          />
        )}
      </Box>

      {/* 底部固定区域 */}
      <Box flexDirection="column" flexShrink={0}>
        <CopyModeWarning enabled={copyModeEnabled} />
        <Notifications />
        <ToastDisplay />

        {statusMessage ? (
          <Box paddingX={1}>
            <Text color={theme.status.warning}>{statusMessage}</Text>
          </Box>
        ) : null}

        {/* Composer 和 DialogRenderer 互斥显示 */}
        {hasDialog ? (
          <DialogRenderer
            permissionRequest={permissionRequest}
            shellConfirmRequest={shellConfirmRequest ?? null}
          />
        ) : (
          <Composer
            onSubmit={onSubmit}
            isLoading={isLoading}
            commands={commands}
            cwd={cwd}
          />
        )}

        <Footer
          permissionMode={permissionMode}
          gitBranch={gitBranch}
          debug={debug}
          usage={usage}
          costUSD={costUSD}
          costLimit={costLimit}
          contextPercent={contextPercent}
          model={model}
          scrollPercent={scrollPercent}
        />
      </Box>
    </Box>
  );
};
