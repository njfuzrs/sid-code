/**
 * 默认应用布局
 *
 * 从 TUIAppInner 提取的布局结构，负责：
 * - 消息区域（上方）：MainContent / EmptyLogo
 * - 底部固定区域：通知 / Composer 或 DialogRenderer / Footer
 *
 * 参考 gemini-cli DefaultAppLayout.tsx
 */

import React, { useRef } from "react";
import { Box, Text, type DOMElement } from "ink";
import { Composer } from "./Composer.tsx";
import { Footer } from "./Footer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { MainContent } from "./MainContent.tsx";
import { CopyModeWarning } from "./CopyModeWarning.tsx";
import { Notifications } from "./Notifications.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { ExitWarning } from "./ExitWarning.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { ToolConfirmationQueue } from "./messages/ToolConfirmationQueue.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import { useConfirmingTool } from "../hooks/useConfirmingTool.ts";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo } from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { Usage } from "../../llm/types.ts";
import { theme } from "../semantic-colors.ts";
import { useFlickerDetector } from "../hooks/useFlickerDetector.ts";

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
  planApprovalRequest: PlanApprovalRequestInfo | null;
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

  // 通用对话框系统
  activeDialog: DialogType | null;
  onDialogClose: () => void;
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  onModelSelect: (modelName: string) => void;
  availableThemes: Array<{ name: string; type: "light" | "dark"; description?: string }>;
  currentTheme: string;
  onThemeSelect: (themeName: string) => void;
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
  planApprovalRequest,
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
  activeDialog,
  onDialogClose,
  availableModels,
  onModelSelect,
  availableThemes,
  currentTheme,
  onThemeSelect,
}) => {
  const hasDialog = !!(permissionRequest || shellConfirmRequest || planApprovalRequest || activeDialog);
  const rootRef = useRef<DOMElement>(null);
  useFlickerDetector(rootRef, rows);
  const confirmingTool = useConfirmingTool(listData);

  return (
    <Box
      ref={rootRef}
      flexDirection="column"
      width={termWidth}
      height={rows}
      paddingBottom={copyModeEnabled ? 0 : 1}
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
    >
      {/* 消息区域：直接作为根 Box 子元素，ScrollableList 自身 flexGrow=1 会填充剩余空间 */}
      {isEmpty ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" width={termWidth}>
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

      {/* 底部固定区域：与 gemini-cli mainControlsRef 对齐 */}
      <Box flexDirection="column" flexShrink={0} flexGrow={0} width={termWidth}>
        <CopyModeWarning enabled={copyModeEnabled} />
        <Notifications />
        <ToastDisplay />

        {statusMessage ? (
          <Box paddingX={1}>
            <Text color={theme.status.warning}>{statusMessage}</Text>
          </Box>
        ) : null}

        {/* 工具确认队列 */}
        {confirmingTool && (
          <ToolConfirmationQueue
            confirmingTool={confirmingTool}
            terminalWidth={termWidth}
          />
        )}

        {/* Composer / 权限对话框 / Plan 审批对话框 / 交互式对话框 互斥显示 */}
        {permissionRequest || shellConfirmRequest ? (
          <DialogRenderer
            permissionRequest={permissionRequest}
            shellConfirmRequest={shellConfirmRequest ?? null}
            planApprovalRequest={null}
          />
        ) : planApprovalRequest ? (
          <DialogRenderer
            permissionRequest={null}
            shellConfirmRequest={null}
            planApprovalRequest={planApprovalRequest}
          />
        ) : activeDialog === "model" ? (
          <ModelDialog
            onClose={onDialogClose}
            currentModel={model}
            availableModels={availableModels}
            onModelSelect={onModelSelect}
          />
        ) : activeDialog === "theme" ? (
          <ThemeDialog
            onClose={onDialogClose}
            currentTheme={currentTheme}
            availableThemes={availableThemes}
            onThemeSelect={onThemeSelect}
          />
        ) : (
          <Composer
            onSubmit={onSubmit}
            isLoading={isLoading}
            commands={commands}
            cwd={cwd}
          />
        )}

        <ExitWarning />

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
