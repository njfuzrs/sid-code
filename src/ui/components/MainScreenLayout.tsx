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
import { Footer } from "./Footer.tsx";
import { DialogSwitch } from "./DialogSwitch.tsx";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import { RetryStatus } from "./RetryStatus.tsx";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import { Notifications, type StartupWarning } from "./Notifications.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { ExitWarning } from "./ExitWarning.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import type { OnboardingResult } from "./OnboardingDialog.tsx";
import type { HistoryItem } from "../types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, AskUserQuestionRequestInfo, TaskDisplayInfo, TUICallbacks } from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { MCPManager } from "../../mcp/manager.ts";
import type { SessionState } from "../../session/state.ts";
import type { Usage } from "../../llm/types.ts";
import type { TodoItem } from "../../tool/todo-write.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { theme } from "../semantic-colors.ts";

interface MainScreenLayoutProps {
  /**
   * 全部历史项（含 app_header + 执行中的 tool_group，但不含流式虚拟项）；进 <Static> 打印到 scrollback。
   * 执行中工具作为普通 tool_group 直接在此列表，完成时原地 reconcile 成终态（对齐 cc inline 路）。
   * 幽灵行残留的物理根治靠默认走 alt-screen 有界视口（DefaultAppLayout）；本 inline 路是 `--inline`
   * 逃生舱，不再做静动拆分/视口封顶（那套自创缝补已删除，见 App.tsx staticItems 注释与根治方案 §6.3）。
   */
  staticItems: HistoryItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** v2：流式思考开始时间戳（ms），透传给 ThinkingMessage 计时器 */
  streamingThinkingStartMs?: number;
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
  /** 统一错误面板条目列表 */
  errorPanel: import("../App.tsx").ErrorPanelItem[];
  /** 关闭错误面板回调 */
  onDismissErrorPanel: () => void;
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
  /** P1-G6：按优先级分组的排队条数，透传给 Composer→InputArea。 */
  queuedByPriority?: { now: number; next: number; later: number };
  /** P2-G6：↑ 弹回编辑——取队尾排队输入回输入框，透传给 Composer→InputArea。 */
  onPopQueuedForEdit?: () => string | null;
  /** Ctrl+D（输入框为空时）请求退出的回调，透传给 Composer→InputArea。 */
  onExitRequest?: () => void;
  /** Shift+Tab 权限模式循环切换回调，透传给 Composer→InputArea。 */
  onCyclePermissionMode?: () => void;

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
  /** P1-2：压缩触发点百分比（Footer 显示「17%/82%」） */
  contextTriggerPercent?: number;
  /** P1-5：真实压缩档位（Footer 变色据此） */
  contextLevel?: "none" | "soft" | "hard" | "emergency";
  model: string;

  // 通用对话框系统
  activeDialog: DialogType | null;
  onDialogClose: () => void;
  /** modelId = 厂商真名（缺省 = name），仅供面板族识别，见 model-grouping.ts ModelOption */
  availableModels: Array<{ name: string; modelId?: string; provider: string; description?: string }>;
  onModelSelect: (modelName: string) => void;
  availableThemes: Array<{ name: string; type: "light" | "dark"; description?: string }>;
  currentTheme: string;
  onThemeSelect: (themeName: string) => void;
  /** /language 面板：选定语言偏好（"unset" 表示清除偏好） */
  onLanguageSelect: (choice: import("./LanguageDialog.tsx").LanguageChoice) => void;
  /** 首次启动引导完成回调 */
  onCompleteOnboarding?: (result: OnboardingResult) => void;
  /** MCP 管理器引用（/mcp 面板用） */
  mcpManager?: MCPManager;
  /** 会话状态引用（/mcp 面板启用/禁用用） */
  sessionState?: SessionState;
  /** TUI 回调集合（各交互面板所需的 setter/getter/引用，稳定引用） */
  callbacks: TUICallbacks;
  /** 当前 provider（/stats 面板展示用） */
  provider: string;
  /** 当前 todo 列表（来自 TodoWrite 工具） */
  todos: TodoItem[];
  /** 当前后台任务列表（Shell/Agent） */
  tasks: TaskDisplayInfo[];
  /** 配置校验诊断转换成的启动警告列表（App 构造时算好的一次性初始值，见 App.tsx TUIState.startupWarnings） */
  startupWarnings?: StartupWarning[];
}

export const MainScreenLayout: React.FC<MainScreenLayoutProps> = memo(function MainScreenLayout({
  staticItems,
  streamingText,
  streamingThinking,
  streamingThinkingStartMs,
  thinkCollapsed,
  isStreaming,
  isEmpty,
  termWidth,
  keyExtractor,
  statusMessage,
  retryStatus,
  errorPanel,
  onDismissErrorPanel,
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  askUserQuestionRequest,
  isLoading,
  commands,
  cwd,
  onSubmit,
  queuedCount = 0,
  queuedByPriority,
  onPopQueuedForEdit,
  onExitRequest,
  onCyclePermissionMode,
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
  contextTriggerPercent,
  contextLevel,
  model,
  activeDialog,
  onDialogClose,
  availableModels,
  onModelSelect,
  availableThemes,
  currentTheme,
  onThemeSelect,
  onLanguageSelect,
  onCompleteOnboarding,
  mcpManager,
  sessionState,
  callbacks,
  provider,
  todos,
  tasks,
  startupWarnings,
}) {
  // 流式正文**不做视口裁剪**：渲染完整 streamingText，靠 StreamingMarkdown 的
  // 稳定前缀切分 + log-update fork 的增量增长路径防闪烁（见 StreamingMarkdown.tsx）。
  // 旧的 tailToFitByBlocks 视口窗口已废弃——那是 stock ink 时代的 workaround，
  // 导致流式中只见尾部一小段。完成后整条进 <Static> → scrollback，原生上滚回看。
  const { taskPanelHidden } = useUIState();
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
          {isEmpty ? <EmptyLogo termWidth={termWidth} cwd={cwd} gitBranch={gitBranch} model={model} needsOnboarding={activeDialog === "onboarding"} /> : null}

          {/* 执行中工具不再单独渲染：作为普通 tool_group（status=executing）随 staticItems 进 Static，
              完成时原地 reconcile 成终态（对齐 cc inline 路「同一 keyed 行原地变态」）。此前的独立
              动态区 live 渲染 + 视口封顶摘要是自创缝补（治标，见根治方案 §6.3），已删除。 */}

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
              streaming={isStreaming}
              thinkingStartMs={streamingThinkingStartMs}
              showExpandHint={false}
            />
          ) : null}

          {/* 正在生成的流式消息（完成后由父层并入 staticItems，此处清空）
              渲染完整 streamingText，不做视口裁剪；防闪烁由 StreamingMarkdown 的稳定前缀切分负责。 */}
          {hasText && streamingText ? (
            <StreamingMessage fullText={streamingText} maxWidth={termWidth} />
          ) : null}

          <Notifications startupWarnings={startupWarnings} />
          <TodoPanel todos={todos} tasks={tasks} termWidth={termWidth} tasksHidden={taskPanelHidden} />
          <ToastDisplay />

          {/* CM3/CM4：LLM 重试/限流提示（实时倒计时 + 限流升级建议） */}
          <RetryStatus status={retryStatus} />

          {/* 统一错误面板：常驻直到 Ctrl+E 关闭 */}
          <ErrorPanel items={errorPanel} onDismiss={onDismissErrorPanel} width={termWidth} />

          {statusMessage ? (
            <Box paddingX={1}>
              <Text color={theme.status.warning}>{statusMessage}</Text>
            </Box>
          ) : null}

          {/* Composer / 权限对话框 / Plan 审批 / 交互式对话框 互斥显示（收口到 DialogSwitch）
              作为留白区最后一块，与上方瞬态块自动隔 1 行 */}
          <DialogSwitch
            permissionRequest={permissionRequest}
            shellConfirmRequest={shellConfirmRequest}
            planApprovalRequest={planApprovalRequest}
            askUserQuestionRequest={askUserQuestionRequest}
            activeDialog={activeDialog}
            onDialogClose={onDialogClose}
            availableModels={availableModels}
            onModelSelect={onModelSelect}
            availableThemes={availableThemes}
            currentTheme={currentTheme}
            onThemeSelect={onThemeSelect}
            onLanguageSelect={onLanguageSelect}
            onCompleteOnboarding={onCompleteOnboarding}
            model={model}
            mcpManager={mcpManager}
            sessionState={sessionState}
            callbacks={callbacks}
            usage={usage}
            stockInputTokens={stockInputTokens}
            costUSD={costUSD}
            cacheSavingsUSD={cacheSavingsUSD}
            costLimit={costLimit}
            contextPercent={contextPercent}
            provider={provider}
            onSubmit={onSubmit}
            isLoading={isLoading}
            commands={commands}
            cwd={cwd}
            queuedCount={queuedCount}
            queuedByPriority={queuedByPriority}
            onPopQueuedForEdit={onPopQueuedForEdit}
            onExitRequest={onExitRequest}
            onCyclePermissionMode={onCyclePermissionMode}
            isEmpty={isEmpty}
          />
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
          contextTriggerPercent={contextTriggerPercent}
          contextLevel={contextLevel}
          model={model}
          termWidth={termWidth}
        />
      </Box>
    </Box>
  );
});
