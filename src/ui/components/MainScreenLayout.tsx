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

import React, { memo, useMemo } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import Static from "../../ink/_vendor/Static.js";
import { tailToFit, estimateChromeLines, computeStreamBudgets } from "../streaming-viewport.ts";
import { Composer } from "./Composer.tsx";
import { Footer } from "./Footer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import { RetryStatus } from "./RetryStatus.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import { Notifications } from "./Notifications.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { ExitWarning } from "./ExitWarning.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { ToolConfirmationQueue } from "./messages/ToolConfirmationQueue.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import { useConfirmingTool } from "../hooks/useConfirmingTool.ts";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, TaskDisplayInfo } from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { Usage } from "../../llm/types.ts";
import type { TodoItem } from "../../tool/todo-write.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { theme } from "../semantic-colors.ts";

interface MainScreenLayoutProps {
  /** 已完成历史项（含 app_header，但不含流式虚拟项）；进 <Static> 打印到 scrollback */
  staticItems: HistoryItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** v2：思考块折叠状态（Static 模式始终 false） */
  thinkCollapsed: boolean;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 是否空会话（无历史且未流式） */
  isEmpty: boolean;
  /** 终端宽度 */
  termWidth: number;
  /** 终端高度（行数）——用于流式动态区视口裁剪，防止 stock ink clearTerminal 全屏重打 */
  rows: number;
  /** key 提取器（供 Static 子项 key） */
  keyExtractor: (item: HistoryItem, index: number) => string;

  // 底部固定区
  statusMessage: string;
  /** CM3/CM4：LLM 重试/限流状态（null = 无）。 */
  retryStatus: import("../App.tsx").RetryStatusInfo | null;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  isLoading: boolean;
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  cwd: string;
  onSubmit: (text: string) => void;
  /** 流式中已排队待接续的输入条数 */
  queuedCount?: number;

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
  /** 当前 todo 列表（来自 TodoWrite 工具） */
  todos: TodoItem[];
  /** 当前后台任务列表（Shell/Agent） */
  tasks: TaskDisplayInfo[];
}

export const MainScreenLayout: React.FC<MainScreenLayoutProps> = memo(function MainScreenLayout({
  staticItems,
  streamingText,
  streamingThinking,
  thinkCollapsed,
  isStreaming,
  isEmpty,
  termWidth,
  rows,
  keyExtractor,
  statusMessage,
  retryStatus,
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  isLoading,
  commands,
  cwd,
  onSubmit,
  queuedCount = 0,
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
  todos,
  tasks,
}) {
  const confirmingTool = useConfirmingTool(staticItems);

  // 流式动态区视口裁剪（ADR-040 防闪烁，见 streaming-viewport.ts）：
  // stock ink 在「动态区高度 >= 终端行数」时每帧 clearTerminal 重打全部 → 全屏闪烁。
  // 故对会随流式增长的正文/思考做尾部截断，保证动态区高度 < 终端行数。
  // 完成后整条消息进 <Static> → 终端 scrollback，可原生上滚回看完整内容。
  const hasText = isStreaming && !!streamingText;
  const hasThinking = isStreaming && !!streamingThinking;
  const { visibleText, visibleThinking } = useMemo(() => {
    if (!hasText && !hasThinking) return { visibleText: "", visibleThinking: "" };
    const chrome = estimateChromeLines({
      todoCount: todos.length,
      taskCount: tasks.length,
      hasStatusMessage: !!statusMessage,
    });
    const { thinkingLines, textLines } = computeStreamBudgets(rows, chrome, hasThinking, hasText);
    // 正文带 "⏺ " 前缀，有效宽度略减
    const textWidth = Math.max(1, termWidth - 2);
    return {
      visibleText: hasText ? tailToFit(streamingText, textWidth, textLines) : "",
      visibleThinking: hasThinking ? tailToFit(streamingThinking, Math.max(1, termWidth - 4), thinkingLines) : "",
    };
  }, [hasText, hasThinking, streamingText, streamingThinking, rows, termWidth, todos.length, tasks.length, statusMessage]);

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
            thinkCollapsed={thinkCollapsed}
          />
        )}
      </Static>

      {/* 动态区（log-update 只重绘这部分，历史不动） */}
      <Box flexDirection="column" flexShrink={0} width={termWidth} paddingBottom={1}>
        {/* 空会话：欢迎屏（首条消息到达后即随 Static 滚走） */}
        {isEmpty ? <EmptyLogo termWidth={termWidth} /> : null}

        {/* v2：流式思考区域 — 独立于 streamingText（对标 Claude Code）
            思考在正文之前渲染（模型先思考后回答），顺序与语义一致。
            同样按视口高度尾部截断，避免与正文叠加把动态区撑高触发闪烁 */}
        {hasThinking && visibleThinking ? (
          <ThinkingMessage text={visibleThinking} width={termWidth} collapsed={false} streaming={true} />
        ) : null}

        {/* 正在生成的流式消息（完成后由父层并入 staticItems，此处清空）
            注意：visibleText 已按视口高度做尾部截断（防 stock ink 全屏重打闪烁，见 streaming-viewport.ts） */}
        {hasText && visibleText ? (
          <StreamingMessage fullText={visibleText} maxWidth={termWidth} />
        ) : null}

        <Notifications />
        <TodoPanel todos={todos} tasks={tasks} termWidth={termWidth} />
        <ToastDisplay />

        {/* CM3/CM4：LLM 重试/限流提示（实时倒计时 + 限流升级建议） */}
        <RetryStatus status={retryStatus} />

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

        {/* 分区边界：
            Composer 自身的状态行（? 快捷键 / LoadingIndicator）自然分隔消息区与输入区，
            无需额外 margin，符合 L2 排版 > 颜色 > 边框 的优先级 */}

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
            queuedCount={queuedCount}
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
