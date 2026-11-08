/**
 * 底部区域：两套布局（MainScreenLayout 主屏 / DefaultAppLayout 全屏）共享。
 *
 * 为什么抽出来：这一块（通知、Todo、Toast、重试、错误面板、状态提示、Composer 与对话框二选一、
 * 退出警告、Footer）原先在两个布局里各写一份，历史上 8 次改动都是同一个提交两边一起改，
 * 漏一边两种模式的界面就漂移。现在只改这里。
 *
 * 两种布局的差异只留给两个插槽，不在这里写 if 分支判断「我是哪种布局」：
 * - `leading`：留白区最前面的块（主屏放欢迎屏 + 流式思考/正文；全屏放 Copy Mode 警告）；
 * - `beforeStatus`：错误面板与状态提示之间（全屏放「已暂停跟随输出」提示）。
 * 插槽传 Fragment 即可：Fragment 的子节点会被展开成留白区的直接子节点，gap 照常生效；
 * 空块返回 null 不产生节点，也就不产生幻影间距。
 *
 * 间距规范（src/ui/CLAUDE.md L2.2）：瞬态块与输入框由 gap={1} 提供块间恰好 1 行留白，
 * 子组件不带外部 margin（TodoPanel 曾自带 marginTop/Bottom，与 gap 叠成 2 行）；
 * ExitWarning / Footer 紧贴输入框底部（对标 cc，无空行）。
 *
 * 瞬态行占位（hooks/useHeldRows.ts）的策略由布局经 `heldRows` 下发：主屏占住并在历史新增时放掉，
 * 全屏高度固定、不存在整帧重画，不占位。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { Footer } from "./Footer.tsx";
import { DialogSwitch } from "./DialogSwitch.tsx";
import { RetryStatus } from "./RetryStatus.tsx";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { Notifications, type StartupWarning } from "./Notifications.tsx";
import { ToastDisplay } from "./ToastDisplay.tsx";
import { ExitWarning } from "./ExitWarning.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import type { OnboardingResult } from "./OnboardingDialog.tsx";
import { HeldRowsContext, useHeldRows, type HeldRowsPolicy } from "../hooks/useHeldRows.ts";

/**
 * 状态提示行。出现过就占住一行到下一轮开始（useHeldRows），消失不让主屏帧变矮。
 * 占位态返回一个空行，留白区的 gap 照常算——只在它出现过之后才有这一行。
 */
const StatusMessageRow: React.FC<{ text: string; busy: boolean }> = ({ text, busy }) => {
  const rows = useHeldRows(text ? 1 : 0, busy, { releaseWhenIdle: true });
  if (rows === 0) return null;
  return (
    <Box paddingX={1} minHeight={rows}>
      {text ? <Text color={theme.status.warning}>{text}</Text> : null}
    </Box>
  );
};
import type {
  PermissionRequestInfo,
  ShellConfirmRequestInfo,
  PlanApprovalRequestInfo,
  AskUserQuestionRequestInfo,
  TaskDisplayInfo,
  TUICallbacks,
} from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";
import type { SessionState } from "@sid-code/core/session/state.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { useKeybindings } from "../contexts/KeybindingContext.tsx";
import { deriveWaitSourcesHint } from "../wait-sources-hint.ts";
import { theme } from "../semantic-colors.ts";

/** 两套布局都要传给底部区域的数据（布局的 props 在此基础上加消息区自己的字段）。 */
export interface BottomRegionSharedProps {
  /** 是否空会话（无历史且未流式）；DialogSwitch 据此决定 Composer 占位文案 */
  isEmpty: boolean;
  /** 终端宽度 */
  termWidth: number;

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
  conflictRequest: import("../App.tsx").ConflictRequestInfo | null;
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
  /** 会话累计 API 调用次数（状态栏 `⟳ N` 列）。省略 → Footer 不渲染该列。 */
  totalRequests?: number;
  /** 其中作废（重试白烧）的次数，是 totalRequests 的子集。 */
  discardedRequests?: number;
  costLimit: number;
  contextPercent: number;
  /** P1-2：压缩触发点百分比（Footer 显示「17%/82%」） */
  contextTriggerPercent?: number;
  /** P1-5：真实压缩档位（Footer 变色据此） */
  contextLevel?: "none" | "soft" | "hard" | "emergency";
  model: string;
  /** 滚动位置百分比，只有全屏虚拟滚动有；主屏不传 → Footer 不渲染该列 */
  scrollPercent?: number;

  // 通用对话框系统
  activeDialog: DialogType | null;
  onDialogClose: () => void;
  /** 命令输出面板（null = 未打开），见 CommandOutputDialog */
  commandPanel: import("./CommandOutputDialog.tsx").CommandPanelInfo | null;
  onCommandPanelClose: () => void;
  /** modelId = 厂商真名（缺省 = name），仅供面板族识别，见 model-grouping.ts ModelOption */
  availableModels: Array<{
    name: string;
    modelId?: string;
    provider: string;
    description?: string;
  }>;
  onModelSelect: (modelName: string) => void;
  availableThemes: Array<{ name: string; type: "light" | "dark"; description?: string }>;
  currentTheme: string;
  onThemeSelect: (themeName: string) => void;
  /** /language 面板：选定语言偏好（"unset" 表示清除偏好） */
  onLanguageSelect: (choice: import("./LanguageDialog.tsx").LanguageChoice) => void;
  /** 首次启动引导完成回调（写 settings.json + 热加载 Provider） */
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

interface BottomRegionProps extends BottomRegionSharedProps {
  /** 留白区最前面的块（布局各自的内容，见文件头） */
  leading?: React.ReactNode;
  /** 错误面板与状态提示之间的块（布局各自的提示，见文件头） */
  beforeStatus?: React.ReactNode;
  /** 底部留白行数：主屏 0（帧写完光标停在下一行，那一行就是与终端底边的间隔）；全屏由根 Box 统一处理，传 0 */
  paddingBottom?: number;
  /** 瞬态行占位策略（见 hooks/useHeldRows.ts）；缺省 = 占住、只在下一轮开始时放掉 */
  heldRows?: HeldRowsPolicy;
}

export const BottomRegion: React.FC<BottomRegionProps> = ({
  leading,
  beforeStatus,
  paddingBottom = 0,
  heldRows,
  isEmpty,
  termWidth,
  statusMessage,
  retryStatus,
  errorPanel,
  onDismissErrorPanel,
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  askUserQuestionRequest,
  conflictRequest,
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
  totalRequests,
  discardedRequests,
  costLimit,
  contextPercent,
  contextTriggerPercent,
  contextLevel,
  model,
  scrollPercent,
  activeDialog,
  onDialogClose,
  commandPanel,
  onCommandPanelClose,
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
}) => {
  const { taskPanelHidden } = useUIState();
  // 面板藏起来之后，「还有唤醒挂着」这件事在屏幕上就只剩这里能看见（§5.7.6）。
  // 判据三条（面板隐藏 / 有唤醒 / 零等待源不出）都在纯函数里，组件只负责喂数据。
  // 键位显示名走运行时绑定表：用户把 Ctrl+T 改掉后这里跟着变。
  const { bindingFor } = useKeybindings();
  const waitSourcesHint = deriveWaitSourcesHint({
    tasks,
    panelHidden: taskPanelHidden,
    toggleDisplay: bindingFor("app:toggleTaskPanel")?.display,
  });

  const region = (
    <Box
      flexDirection="column"
      flexShrink={0}
      flexGrow={0}
      width={termWidth}
      paddingBottom={paddingBottom}
    >
      {/* 留白区：瞬态块与输入框，块间恒为 1 行（gap） */}
      <Box flexDirection="column" gap={1}>
        {leading}

        <Notifications startupWarnings={startupWarnings} />
        <TodoPanel
          todos={todos}
          tasks={tasks}
          termWidth={termWidth}
          tasksHidden={taskPanelHidden}
        />
        <ToastDisplay busy={isLoading} />

        {/* CM3/CM4：LLM 重试/限流提示（实时倒计时 + 限流升级建议） */}
        <RetryStatus status={retryStatus} />

        {/* 统一错误面板：常驻直到 Ctrl+E 关闭 */}
        <ErrorPanel items={errorPanel} onDismiss={onDismissErrorPanel} width={termWidth} />

        {beforeStatus}

        <StatusMessageRow text={statusMessage} busy={isLoading} />

        {/* Composer / 权限对话框 / Plan 审批 / 交互式对话框 互斥显示（收口到 DialogSwitch）
            作为留白区最后一块，与上方瞬态块自动隔 1 行 */}
        <DialogSwitch
          permissionRequest={permissionRequest}
          shellConfirmRequest={shellConfirmRequest}
          planApprovalRequest={planApprovalRequest}
          askUserQuestionRequest={askUserQuestionRequest}
          conflictRequest={conflictRequest}
          activeDialog={activeDialog}
          onDialogClose={onDialogClose}
          commandPanel={commandPanel}
          onCommandPanelClose={onCommandPanelClose}
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
      <ExitWarning busy={isLoading} />

      <Footer
        permissionMode={permissionMode}
        isPlanMode={isPlanMode}
        gitBranch={gitBranch}
        debug={debug}
        usage={usage}
        stockInputTokens={stockInputTokens}
        costUSD={costUSD}
        cacheSavingsUSD={cacheSavingsUSD}
        totalRequests={totalRequests}
        discardedRequests={discardedRequests}
        costLimit={costLimit}
        contextPercent={contextPercent}
        contextTriggerPercent={contextTriggerPercent}
        contextLevel={contextLevel}
        model={model}
        scrollPercent={scrollPercent}
        termWidth={termWidth}
        waitSourcesHint={waitSourcesHint}
      />
    </Box>
  );
  return heldRows ? (
    <HeldRowsContext.Provider value={heldRows}>{region}</HeldRowsContext.Provider>
  ) : (
    region
  );
};
