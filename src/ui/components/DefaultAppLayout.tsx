/**
 * 默认应用布局
 *
 * 从 TUIAppInner 提取的布局结构，负责：
 * - 消息区域（上方）：MainContent / EmptyLogo
 * - 底部固定区域：通知 / Composer 或 DialogRenderer / Footer
 *
 * 参考 gemini-cli DefaultAppLayout.tsx
 */

import React, { useRef, useCallback, useEffect } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { DOMElement } from "../../ink/dom.js";
import { Composer } from "./Composer.tsx";
import { Footer } from "./Footer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { MainContent } from "./MainContent.tsx";
import { CopyModeWarning } from "./CopyModeWarning.tsx";
import { Notifications } from "./Notifications.tsx";
import { RetryStatus } from "./RetryStatus.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { ExitWarning } from "./ExitWarning.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import { OnboardingDialog } from "./OnboardingDialog.tsx";
import { McpDialog } from "./McpDialog.tsx";
import type { OnboardingResult } from "./OnboardingDialog.tsx";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, AskUserQuestionRequestInfo, TaskDisplayInfo } from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { MCPManager } from "../../mcp/manager.ts";
import type { SessionState } from "../../session/state.ts";
import type { Usage } from "../../llm/types.ts";
import type { TodoItem } from "../../tool/todo-write.ts";
import { theme } from "../semantic-colors.ts";
import { PAUSED_MARK } from "../constants/figures.ts";
import { useFlickerDetector } from "../hooks/useFlickerDetector.ts";
import { useStreamingScroll } from "../hooks/useStreamingScroll.ts";

interface DefaultAppLayoutProps {
  // 消息区域
  listData: HistoryItem[];
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** v2：流式思考开始时间戳（ms），透传给 MainContent → ThinkingMessage */
  streamingThinkingStartMs?: number;
  /** v2：思考块折叠状态 */
  thinkCollapsed: boolean;
  isStreaming: boolean;
  isEmpty: boolean;
  termWidth: number;
  rows: number;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: HistoryItem, index: number) => string;
  copyModeEnabled: boolean;

  // 底部区域
  statusMessage: string;
  /** CM3/CM4：LLM 重试/限流状态（null = 无）。 */
  retryStatus: import("../App.tsx").RetryStatusInfo | null;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  askUserQuestionRequest: AskUserQuestionRequestInfo | null;
  isLoading: boolean;
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  cwd: string;
  onSubmit: (text: string) => void;
  /** 流式中已排队待接续的输入条数 */
  queuedCount?: number;
  /** Ctrl+D（输入框为空时）请求退出的回调，透传给 Composer→InputArea。 */
  onExitRequest?: () => void;

  // Footer
  permissionMode: string;
  isPlanMode: boolean;
  gitBranch: string;
  debug: boolean;
  usage: Usage;
  stockInputTokens: number;
  costUSD: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD?: number;
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
  /** 首次启动引导完成回调（写 settings.json + 热加载 Provider） */
  onCompleteOnboarding?: (result: OnboardingResult) => void;
  /** MCP 管理器引用（/mcp 面板用） */
  mcpManager?: MCPManager;
  /** 会话状态引用（/mcp 面板启用/禁用用） */
  sessionState?: SessionState;
  /** 当前 todo 列表（来自 TodoWrite 工具） */
  todos: TodoItem[];
  /** 当前后台任务列表（Shell/Agent） */
  tasks: TaskDisplayInfo[];
}

export const DefaultAppLayout: React.FC<DefaultAppLayoutProps> = ({
  listData,
  streamingText,
  streamingThinking,
  streamingThinkingStartMs,
  thinkCollapsed,
  isStreaming,
  isEmpty,
  termWidth,
  rows,
  estimatedItemHeight,
  keyExtractor,
  copyModeEnabled,
  statusMessage,
  retryStatus,
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  askUserQuestionRequest,
  isLoading,
  commands,
  cwd,
  onSubmit,
  queuedCount = 0,
  onExitRequest,
  permissionMode,
  isPlanMode,
  gitBranch,
  debug,
  usage,
  stockInputTokens,
  costUSD,
  cacheSavingsUSD,
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
  onCompleteOnboarding,
  mcpManager,
  sessionState,
  todos,
  tasks,
}) => {
  const rootRef = useRef<DOMElement>(null);
  useFlickerDetector(rootRef, rows);

  // ST8：流式↔滚动协调。粘底状态来自 MainContent 的 VirtualizedList；
  // 流式期间用户滚离底部 → paused，显示「跟随已暂停」提示。
  const streamScroll = useStreamingScroll();
  const onStickyChange = useCallback(
    (sticky: boolean) => {
      if (sticky) streamScroll.onReachBottom();
      else streamScroll.onUserScrollUp();
    },
    [streamScroll],
  );
  // 流式结束 → 复位为跟随，下一轮重新粘底。
  useEffect(() => {
    if (!isStreaming) streamScroll.onStreamEnd();
  }, [isStreaming, streamScroll]);
  const showFollowPausedHint = isStreaming && streamScroll.paused;

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
          <EmptyLogo termWidth={termWidth} cwd={cwd} gitBranch={gitBranch} model={model} needsOnboarding={activeDialog === "onboarding"} />
        </Box>
      ) : (
        <MainContent
          listData={listData}
          streamingText={streamingText}
          streamingThinking={streamingThinking}
          streamingThinkingStartMs={streamingThinkingStartMs}
          isStreaming={isStreaming}
          termWidth={termWidth}
          hasFocus={true}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          copyModeEnabled={copyModeEnabled}
          thinkCollapsed={thinkCollapsed}
          onStickyChange={onStickyChange}
        />
      )}

      {/* 底部固定区域：与 gemini-cli mainControlsRef 对齐
          间距规范（src/ui/CLAUDE.md L2.2）：瞬态块 + 输入框统一由 gap={1} 提供块间 1 行留白，
          子组件不带外部 margin；Footer / ExitWarning 紧贴输入框底部。 */}
      <Box flexDirection="column" flexShrink={0} flexGrow={0} width={termWidth}>
        <Box flexDirection="column" gap={1}>
          <CopyModeWarning enabled={copyModeEnabled} />
          <Notifications />
          <TodoPanel todos={todos} tasks={tasks} termWidth={termWidth} />
          <ToastDisplay />

          {/* CM3/CM4：LLM 重试/限流提示 */}
          <RetryStatus status={retryStatus} />

          {/* ST8：流式跟随已暂停提示（用户上滚阅读历史时） */}
          {showFollowPausedHint ? (
            <Box paddingX={1}>
              <Text color={theme.status.warning}>
                {`${PAUSED_MARK} 已暂停跟随输出（滚动到底部恢复）`}
              </Text>
            </Box>
          ) : null}

          {statusMessage ? (
            <Box paddingX={1}>
              <Text color={theme.status.warning}>{statusMessage}</Text>
            </Box>
          ) : null}

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
          ) : askUserQuestionRequest ? (
            <DialogRenderer
              permissionRequest={null}
              shellConfirmRequest={null}
              planApprovalRequest={null}
              askUserQuestionRequest={askUserQuestionRequest}
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
          ) : activeDialog === "onboarding" && onCompleteOnboarding ? (
            <OnboardingDialog
              onComplete={onCompleteOnboarding}
              onClose={onDialogClose}
            />
          ) : activeDialog === "mcp" && mcpManager && sessionState ? (
            <McpDialog
              onClose={onDialogClose}
              mcpManager={mcpManager}
              sessionState={sessionState}
            />
          ) : (
            <Composer
              onSubmit={onSubmit}
              isLoading={isLoading}
              commands={commands}
              cwd={cwd}
              queuedCount={queuedCount}
              onExitRequest={onExitRequest}
              hideShortcutsHint={isEmpty}
            />
          )}
        </Box>

        {/* 输入框下方紧贴：退出警告 + 状态栏，无额外空行 */}
        <ExitWarning />

        <Footer
          permissionMode={permissionMode}
          isPlanMode={isPlanMode}
          gitBranch={gitBranch}
          debug={debug}
          usage={usage}
          stockInputTokens={stockInputTokens}
          costUSD={costUSD}
          cacheSavingsUSD={cacheSavingsUSD}
          costLimit={costLimit}
          contextPercent={contextPercent}
          model={model}
          scrollPercent={scrollPercent}
        />
      </Box>
    </Box>
  );
};
