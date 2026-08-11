/**
 * AppState — 会话级应用状态类型定义
 * 合并 TUIState + StreamingContext + SessionContext + UIStateContext + ConfigContext
 * 纯数据部分用 DeepImmutable 包裹，包含函数/可变引用的部分排除在外
 */

import type { Message, Usage } from "@sid-code/core/llm/types.ts";
import type { HistoryItem } from "../ui/types.ts";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, AskUserQuestionRequestInfo } from "../ui/App.tsx";
import type { DialogType } from "../command/types.ts";

/** 深度不可变类型工具 */
type DeepImmutable<T> =
  T extends (infer U)[] ? readonly DeepImmutable<U>[] :
  T extends Map<infer K, infer V> ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>> :
  T extends Set<infer U> ? ReadonlySet<DeepImmutable<U>> :
  T extends object ? { readonly [K in keyof T]: DeepImmutable<T[K]> } :
  T;

/** 流式状态枚举 */
export type StreamingStatus = "idle" | "streaming" | "tool_executing" | "loading";

/** MCP 连接状态 */
export interface MCPConnectionState {
  name: string;
  status: "connected" | "connecting" | "disconnected" | "reconnecting";
  tools: string[];
  error?: string;
}

/** 子代理任务状态 */
export interface SubAgentTaskState {
  id: string;
  type: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * AppState — 会话级应用状态
 *
 * 设计原则：
 * - 纯数据部分用 DeepImmutable 包裹，防止意外修改
 * - 包含函数/可变引用的部分排除在 DeepImmutable 之外
 * - 所有 UI 驱动的状态都在这里，替代 TUIState + 多个 Context
 */
export type AppState = DeepImmutable<{
  // ═══ 核心配置 ═══
  model: string;
  provider: string;
  permissionMode: string;
  debug: boolean;
  cwd: string;

  // ═══ 流式与工具状态（替代 StreamingContext） ═══
  streamingStatus: StreamingStatus;
  streamingText: string;
  toolName: string | null;
  toolInput: unknown;
  lastToolResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
  statusMessage: string;

  // ═══ 会话统计（替代 SessionContext） ═══
  usage: Usage;
  costUSD: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD: number;
  costLimit: number;
  contextPercent: number;

  // ═══ UI 状态（替代 UIStateContext） ═══
  renderMarkdown: boolean;
  constrainHeight: boolean;
  copyModeEnabled: boolean;
  isQuitting: boolean;
  gitBranch: string;

  // ═══ 对话框状态 ═══
  activeDialog: DialogType | null;
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  commands: Array<{ name: string; aliases: string[]; description: string }>;
}> & {
  // ═══ 可变部分（包含函数/引用，排除在 DeepImmutable 之外） ═══

  messages: Message[];
  historyItems: HistoryItem[];

  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  askUserQuestionRequest: AskUserQuestionRequestInfo | null;

  mcpConnections: MCPConnectionState[];
  subAgentTasks: Record<string, SubAgentTaskState>;
  transientMessage: { text: string; type: "warning" | "hint" | "info" } | null;
};

/** 默认 AppState */
export function getDefaultAppState(): AppState {
  return {
    model: "",
    provider: "",
    permissionMode: "default",
    debug: false,
    cwd: process.cwd(),

    streamingStatus: "idle",
    streamingText: "",
    toolName: null,
    toolInput: null,
    lastToolResult: null,
    statusMessage: "",

    usage: { inputTokens: 0, outputTokens: 0 },
    costUSD: 0,
    cacheSavingsUSD: 0,
    costLimit: 0,
    contextPercent: 0,

    renderMarkdown: true,
    constrainHeight: true,
    copyModeEnabled: false,
    isQuitting: false,
    gitBranch: "",

    activeDialog: null,
    availableModels: [],
    commands: [],

    messages: [],
    historyItems: [],
    permissionRequest: null,
    shellConfirmRequest: null,
    planApprovalRequest: null,
    askUserQuestionRequest: null,
    mcpConnections: [],
    subAgentTasks: {},
    transientMessage: null,
  };
}
