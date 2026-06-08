/**
 * 主屏渲染布局（ADR-040，默认模式）
 *
 * 对标 claude-code 外部用户默认 REPL：
 * - 已完成历史用 Ink <Static> 一次性打印进终端 scrollback（print-and-forget），
 *   落入终端真实行缓冲 → 边流式边可用鼠标原生选中复制、原生无限滚动。
 * - 仅"正在生成的流式消息 + 输入框 + 状态栏/对话框"留在小动态区（log-update 只重绘这几行）。
 * - 不设固定 height / 不 overflow hidden：内容自然纵向增长，旧行滚出进终端 scrollback。
 *
 * 与 DefaultAppLayout（--alternate-buffer 全屏虚拟滚动）互斥；不抢鼠标、无 Copy Mode。
 */

import React, { memo } from "react";
import { Box, Text, Static } from "ink";
import { Composer } from "./Composer.tsx";
import { Footer } from "./Footer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
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

interface MainScreenLayoutProps {
  /** 已完成历史项（含 app_header，但不含流式虚拟项）；进 <Static> 打印到 scrollback */
  staticItems: HistoryItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 是否空会话（无历史且未流式） */
  isEmpty: boolean;
  /** 终端宽度 */
  termWidth: number;
  /** key 提取器（供 Static 子项 key） */
  keyExtractor: (item: HistoryItem, index: number) => string;

  // 底部固定区
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
  isPlanMode: boolean;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  costUSD: number;
  costLimit: number;
  contextPercent: number;
  model: string;

  // 通用对话框系统
  activeDialog: DialogType | null;
  onDialogClose: () => void;
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  onModelSelect: (modelName: string) => void;
  availableThemes: Array<{ name: string; type: "light" | "dark"; description?: string }>;
  currentTheme: string;
  onThemeSelect: (themeName: string) => void;
}

export const MainScreenLayout: React.FC<MainScreenLayoutProps> = memo(function MainScreenLayout({
  staticItems,
  streamingText,
  isStreaming,
  isEmpty,
  termWidth,
  keyExtractor,
  statusMessage,
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  isLoading,
  commands,
  cwd,
  onSubmit,
  permissionMode,
  isPlanMode,
  gitBranch,
  debug,
  usage,
  costUSD,
  costLimit,
  contextPercent,
  model,
  activeDialog,
  onDialogClose,
  availableModels,
  onModelSelect,
  availableThemes,
  currentTheme,
  onThemeSelect,
}) {
  const confirmingTool = useConfirmingTool(staticItems);

  return (
    // 根 Box 不设固定高度 / 不 overflow hidden：让内容顺序增长，Static 落 scrollback、动态区在末尾。
    <Box flexDirection="column" width={termWidth}>
      {/* 历史区：Static print-and-forget → 终端 scrollback（原生可选/可滚） */}
      <Static items={staticItems}>
        {(item: HistoryItem, index: number) => (
          <HistoryItemDisplay
            key={keyExtractor(item, index)}
            item={item}
            prevItem={index > 0 ? staticItems[index - 1] : undefined}
            terminalWidth={termWidth}
          />
        )}
      </Static>

      {/* 动态区（log-update 只重绘这部分，历史不动） */}
      <Box flexDirection="column" flexShrink={0} width={termWidth} paddingBottom={1}>
        {/* 空会话：欢迎 Logo（首条消息到达后即随 Static 滚走） */}
        {isEmpty ? (
          <Box flexDirection="column" alignItems="center" width={termWidth} paddingY={1}>
            <EmptyLogo termWidth={termWidth} />
          </Box>
        ) : null}

        {/* 正在生成的流式消息（完成后由父层并入 staticItems，此处清空） */}
        {isStreaming && streamingText ? (
          <StreamingMessage fullText={streamingText} maxWidth={termWidth} />
        ) : null}

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

        {/* Composer / 权限对话框 / Plan 审批 / 交互式对话框 互斥显示 */}
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
          isPlanMode={isPlanMode}
          gitBranch={gitBranch}
          debug={debug}
          usage={usage}
          costUSD={costUSD}
          costLimit={costLimit}
          contextPercent={contextPercent}
          model={model}
        />
      </Box>
    </Box>
  );
});
