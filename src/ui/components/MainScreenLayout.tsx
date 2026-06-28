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
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import Static from "../../ink/_vendor/Static.js";
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
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, AskUserQuestionRequestInfo, TaskDisplayInfo } from "../App.tsx";
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
  /** key 提取器（供 Static 子项 key） */
  keyExtractor: (item: HistoryItem, index: number) => string;

  // 底部固定区
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
  keyExtractor,
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
  // 流式正文**不做视口裁剪**：渲染完整 streamingText，靠 StreamingMarkdown 的
  // 稳定前缀切分 + log-update fork 的增量增长路径防闪烁（见 StreamingMarkdown.tsx）。
  // 旧的 tailToFitByBlocks 视口窗口已废弃——那是 stock ink 时代的 workaround，
  // 导致流式中只见尾部一小段。完成后整条进 <Static> → scrollback，原生上滚回看。
  const hasText = isStreaming && !!streamingText;
  const hasThinking = isStreaming && !!streamingThinking;
  // 思考恒折叠为单行摘要（对标 cc）：ThinkingMessage 内部只渲染一行摘要 + 字符数 + 实时计时，
  // 高度稳定、全程零跳动。把全文传给它即可，由它自行折叠。
  const thinkingCollapsed = true;

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
              thinkExpandable={false}
            />
          )}
        </Static>

      {/* 动态区（log-update 只重绘这部分，历史不动）
          间距规范（src/ui/CLAUDE.md L2.2）：
          瞬态块 + 输入框统一由外层 gap={1} 提供「块间恰好 1 行留白」，
          子组件自身不再带外部 margin（否则与 gap 叠加 → 忽宽忽窄）。
          Footer / ExitWarning 紧贴输入框底部（对标 cc：状态栏贴着输入框，无空行）。 */}
      <Box flexDirection="column" flexShrink={0} width={termWidth} paddingBottom={1}>
        {/* 留白区：瞬态块与输入框，块间恒为 1 行（gap）；空块返回 null 不产生幻影间距 */}
        <Box flexDirection="column" gap={1}>
          {/* 空会话：欢迎屏（首条消息到达后即随 Static 滚走） */}
          {isEmpty ? <EmptyLogo termWidth={termWidth} cwd={cwd} gitBranch={gitBranch} model={model} /> : null}

          {/* v2：流式思考区域 — 独立于 streamingText（对标 Claude Code）
              思考在正文之前渲染（模型先思考后回答），顺序与语义一致。
              思考全程折叠为单行摘要（thinkingCollapsed 恒为 true），实时计时原地更新、
              高度恒定 → 页面零跳动；不再有「纯思考逐字展开 → 正文开始时塌缩」的高度突变。
              Static 模式 ctrl+o 无法重渲已打印项，故折叠态不显示展开提示（showExpandHint=false）。 */}
          {hasThinking && streamingThinking ? (
            <ThinkingMessage
              text={streamingThinking}
              width={termWidth}
              collapsed={thinkingCollapsed}
              streaming={true}
              showExpandHint={false}
            />
          ) : null}

          {/* 正在生成的流式消息（完成后由父层并入 staticItems，此处清空）
              渲染完整 streamingText，不做视口裁剪；防闪烁由 StreamingMarkdown 的稳定前缀切分负责。 */}
          {hasText && streamingText ? (
            <StreamingMessage fullText={streamingText} maxWidth={termWidth} />
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

          {/* Composer / 权限对话框 / Plan 审批 / 交互式对话框 互斥显示
              作为留白区最后一块，与上方瞬态块自动隔 1 行 */}
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
        />
      </Box>
    </Box>
  );
});
