/**
 * 对话框调度中枢（DialogSwitch）
 *
 * 两个布局（MainScreenLayout 全屏 / DefaultAppLayout alt-buffer）此前各维护一份
 * 完全相同的对话框分支链，新增一个面板要改两处（接线模式文档「坑 1」）。
 * 本组件把整条分支链 + Composer 兜底收口到一处，两个布局都渲染它，
 * 新增 dialog 只改这一个文件，从构造上根治「漏改一个 Layout」。
 *
 * 优先级：权限/Shell 确认 > Plan 审批 > AskUserQuestion > activeDialog 各面板 > Composer。
 */

import React from "react";
import { Composer } from "./Composer.tsx";
import { DialogRenderer } from "./DialogManager.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import { OnboardingDialog } from "./OnboardingDialog.tsx";
import { McpDialog } from "./McpDialog.tsx";
import { EffortDialog } from "./EffortDialog.tsx";
import { ThinkDialog } from "./ThinkDialog.tsx";
import { PermissionsDialog } from "./PermissionsDialog.tsx";
import { MemoryDialog } from "./MemoryDialog.tsx";
import { ConfigDialog } from "./ConfigDialog.tsx";
import { HooksDialog } from "./HooksDialog.tsx";
import { StatsDialog } from "./StatsDialog.tsx";
import { SkillsDialog } from "./SkillsDialog.tsx";
import { AgentsDialog } from "./AgentsDialog.tsx";
import { CommandsDialog } from "./CommandsDialog.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { ContextDialog } from "./ContextDialog.tsx";
import { RewindDialog } from "./RewindDialog.tsx";
import { ClaudeMdExternalImportDialog } from "./ClaudeMdExternalImportDialog.tsx";
import type { OnboardingResult } from "./OnboardingDialog.tsx";
import type {
  PermissionRequestInfo,
  ShellConfirmRequestInfo,
  PlanApprovalRequestInfo,
  AskUserQuestionRequestInfo,
  TUICallbacks,
} from "../App.tsx";
import type { DialogType } from "../../command/types.ts";
import type { MCPManager } from "../../mcp/manager.ts";
import type { SessionState } from "../../session/state.ts";
import type { Usage } from "../../llm/types.ts";
import { resolvePricing } from "../../api/cost-tracker.ts";

export interface DialogSwitchProps {
  // 高优先级请求（覆盖 activeDialog）
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  askUserQuestionRequest: AskUserQuestionRequestInfo | null;

  // 通用对话框系统
  activeDialog: DialogType | null;
  onDialogClose: () => void;
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  onModelSelect: (modelName: string) => void;
  availableThemes: Array<{ name: string; type: "light" | "dark"; description?: string }>;
  currentTheme: string;
  onThemeSelect: (themeName: string) => void;
  onCompleteOnboarding?: (result: OnboardingResult) => void;
  model: string;

  // 面板所需外部引用（稳定引用，来自 TUICallbacks）
  mcpManager?: MCPManager;
  sessionState?: SessionState;
  callbacks: TUICallbacks;

  // /stats 面板展示所需的运行时数据
  usage: Usage;
  stockInputTokens: number;
  costUSD: number;
  cacheSavingsUSD?: number;
  costLimit: number;
  contextPercent: number;
  provider: string;

  // Composer 兜底所需
  onSubmit: (text: string) => void;
  isLoading: boolean;
  commands: Array<{ name: string; aliases: string[]; description: string }>;
  cwd: string;
  queuedCount?: number;
  /** P1-G6：按优先级分组的排队条数，透传给 Composer→InputArea。 */
  queuedByPriority?: { now: number; next: number; later: number };
  /** P2-G6：↑ 弹回编辑，透传给 Composer→InputArea。 */
  onPopQueuedForEdit?: () => string | null;
  onExitRequest?: () => void;
  /** Shift+Tab 权限模式循环切换回调，透传给 Composer→InputArea。 */
  onCyclePermissionMode?: () => void;
  isEmpty: boolean;
}

export const DialogSwitch: React.FC<DialogSwitchProps> = ({
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  askUserQuestionRequest,
  activeDialog,
  onDialogClose,
  availableModels,
  onModelSelect,
  availableThemes,
  currentTheme,
  onThemeSelect,
  onCompleteOnboarding,
  model,
  mcpManager,
  sessionState,
  callbacks,
  usage,
  stockInputTokens,
  costUSD,
  cacheSavingsUSD,
  costLimit,
  contextPercent,
  provider,
  onSubmit,
  isLoading,
  commands,
  cwd,
  queuedCount,
  queuedByPriority,
  onPopQueuedForEdit,
  onExitRequest,
  onCyclePermissionMode,
  isEmpty,
}) => {
  if (permissionRequest || shellConfirmRequest) {
    return (
      <DialogRenderer
        permissionRequest={permissionRequest}
        shellConfirmRequest={shellConfirmRequest ?? null}
        planApprovalRequest={null}
      />
    );
  }
  if (planApprovalRequest) {
    return (
      <DialogRenderer
        permissionRequest={null}
        shellConfirmRequest={null}
        planApprovalRequest={planApprovalRequest}
      />
    );
  }
  if (askUserQuestionRequest) {
    return (
      <DialogRenderer
        permissionRequest={null}
        shellConfirmRequest={null}
        planApprovalRequest={null}
        askUserQuestionRequest={askUserQuestionRequest}
      />
    );
  }
  if (activeDialog === "model") {
    return (
      <ModelDialog
        onClose={onDialogClose}
        currentModel={model}
        availableModels={availableModels}
        onModelSelect={onModelSelect}
        getEffortState={callbacks.getEffortState}
        setEffort={callbacks.setEffort}
      />
    );
  }
  if (activeDialog === "theme") {
    return (
      <ThemeDialog
        onClose={onDialogClose}
        currentTheme={currentTheme}
        availableThemes={availableThemes}
        onThemeSelect={onThemeSelect}
      />
    );
  }
  if (activeDialog === "onboarding" && onCompleteOnboarding) {
    return <OnboardingDialog onComplete={onCompleteOnboarding} onClose={onDialogClose} />;
  }
  if (activeDialog === "mcp" && mcpManager && sessionState) {
    return <McpDialog onClose={onDialogClose} mcpManager={mcpManager} sessionState={sessionState} />;
  }
  if (activeDialog === "effort") {
    return (
      <EffortDialog
        onClose={onDialogClose}
        getEffortState={callbacks.getEffortState}
        setEffort={callbacks.setEffort}
      />
    );
  }
  if (activeDialog === "think") {
    return (
      <ThinkDialog
        onClose={onDialogClose}
        getThinkingState={callbacks.getThinkingState}
        setThinking={callbacks.setThinking}
      />
    );
  }
  if (activeDialog === "permissions" && sessionState) {
    return <PermissionsDialog onClose={onDialogClose} config={callbacks.config} sessionState={sessionState} />;
  }
  if (activeDialog === "memory") {
    return <MemoryDialog onClose={onDialogClose} cwd={cwd} />;
  }
  if (activeDialog === "claude-md-external-imports") {
    const paths = callbacks.getSkippedExternalImports?.() ?? [];
    return (
      <ClaudeMdExternalImportDialog
        paths={paths}
        onDecision={async (approved) => {
          await callbacks.onClaudeMdExternalImportDecision?.(approved);
          onDialogClose();
        }}
        onClose={onDialogClose}
      />
    );
  }
  if (activeDialog === "config" && callbacks.config) {
    return <ConfigDialog onClose={onDialogClose} config={callbacks.config} sessionState={sessionState} />;
  }
  if (activeDialog === "hooks" && callbacks.hookSystem) {
    return <HooksDialog onClose={onDialogClose} hookSystem={callbacks.hookSystem} />;
  }
  if (activeDialog === "stats") {
    return (
      <StatsDialog
        onClose={onDialogClose}
        usage={usage}
        stockInputTokens={stockInputTokens}
        costUSD={costUSD}
        cacheSavingsUSD={cacheSavingsUSD}
        costLimit={costLimit}
        contextPercent={contextPercent}
        model={model}
        provider={provider}
        sessionState={sessionState}
        pricing={resolvePricing(model, availableModels) ?? undefined}
      />
    );
  }
  if (activeDialog === "skills" && callbacks.unifiedRegistry) {
    return <SkillsDialog onClose={onDialogClose} registry={callbacks.unifiedRegistry} />;
  }
  if (activeDialog === "agents") {
    return <AgentsDialog onClose={onDialogClose} />;
  }
  if (activeDialog === "commands" && callbacks.unifiedRegistry) {
    return <CommandsDialog onClose={onDialogClose} registry={callbacks.unifiedRegistry} mcpManager={mcpManager} />;
  }
  if (activeDialog === "help" && callbacks.unifiedRegistry) {
    return <HelpDialog onClose={onDialogClose} registry={callbacks.unifiedRegistry} />;
  }
  if (activeDialog === "export" && callbacks.onExportConversation) {
    return (
      <ExportDialog
        onClose={onDialogClose}
        onExport={callbacks.onExportConversation}
      />
    );
  }
  // /context：上下文分类 token 拆解可视化
  if (activeDialog === "context" && callbacks.getContextBreakdown) {
    return (
      <ContextDialog
        onClose={onDialogClose}
        getBreakdown={callbacks.getContextBreakdown}
      />
    );
  }
  // P2-1：Esc+Esc 会话回退选择器
  if (activeDialog === "rewind") {
    return (
      <RewindDialog
        onClose={onDialogClose}
        getRewindPoints={callbacks.getRewindPoints}
        onRewind={callbacks.onRewind}
      />
    );
  }
  return (
    <Composer
      onSubmit={onSubmit}
      isLoading={isLoading}
      commands={commands}
      cwd={cwd}
      queuedCount={queuedCount}
      queuedByPriority={queuedByPriority}
      onPopQueuedForEdit={onPopQueuedForEdit}
      onExitRequest={onExitRequest}
      onCyclePermissionMode={onCyclePermissionMode}
      hideShortcutsHint={true}
    />
  );
};
