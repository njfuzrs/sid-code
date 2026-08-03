/**
 * UI 层类型系统
 *
 * 独立于 LLM Message 的 UI 渲染数据类型。
 * 参考 gemini-cli types.ts，适配 sid-code 的 Anthropic 消息格式。
 *
 * 核心设计：
 * - HistoryItem 是 UI 渲染的唯一数据源，与 LLM Message 解耦
 * - 每种类型有专用渲染组件，通过 type 字段 switch 分发
 * - ToolCallStatus 覆盖工具生命周期的 6 种状态
 */

import type { ThoughtSummary } from "./history-adapter.ts";

// ── 流式状态 ──

export enum StreamingState {
  /** 空闲，等待用户输入 */
  Idle = "idle",
  /** 已提交请求，等待 LLM 首个 token（首字延迟期间）。
   *  对标用户感知：从回车到首字到达这段，必须有活动反馈，
   *  否则用户面对纹丝不动的界面，不知是卡死、出错还是仍在进行。 */
  Connecting = "connecting",
  /** 正在接收 LLM 响应 */
  Responding = "responding",
  /** 等待用户确认（权限/工具） */
  WaitingForConfirmation = "waiting_for_confirmation",
}

// ── 工具调用状态 ──

export enum ToolCallStatus {
  /** 等待执行 */
  Pending = "pending",
  /** 正在执行 */
  Executing = "executing",
  /** 执行成功 */
  Success = "success",
  /** 用户取消 */
  Canceled = "canceled",
  /** 执行出错 */
  Error = "error",
}

/** 工具结果展示类型 */
export interface ToolResultDisplay {
  /** 结果文本内容 */
  content: string;
  /** 是否为错误结果 */
  isError?: boolean;
  /** 是否为 diff 格式 */
  isDiff?: boolean;
  /** 文件名（用于 diff 语法高亮） */
  filename?: string;
  /**
   * 结构化 diff(edit/write 工具)。优先于 content 文本渲染,
   * 缺失时 DiffRenderer 降级到从 content 正则解析。
   */
  structuredPatch?: import("diff").StructuredPatchHunk[];
}

/** 单个工具调用的展示数据 */
export interface IndividualToolCallDisplay {
  /** 工具调用 ID */
  callId: string;
  /** 工具名称 */
  name: string;
  /** 工具描述（参数摘要） */
  description: string;
  /** 工具输入参数（原始） */
  input: unknown;
  /** 执行状态 */
  status: ToolCallStatus;
  /** 结果展示 */
  resultDisplay?: ToolResultDisplay;
  /** 是否渲染输出为 Markdown */
  renderOutputAsMarkdown?: boolean;
  /** 进度消息（MCP 工具） */
  progressMessage?: string;
  /**
   * 子代理实时进度（仅执行中的 `sub_agent` 工具卡片有值）。
   *
   * 单独一个字段而不复用 progressMessage：后者是 shell 的多行 stdout 尾部快照（纯文本），
   * 这里是结构化统计 + 活动列表，渲染成三档降级形态（见 ui/agent-progress-view.ts）。
   * 塞进同一个 string 就得在渲染层反向解析文本，那是口径漂移的温床。
   *
   * 由 app.ts 的 liveAgentProgress 侧信道注入，轮末随侧信道 clear 退场——工具一旦完成，
   * 权威路径渲染的完成态卡片不带此字段，进度自然让位给真实结果。
   */
  agentProgress?: import("../agent/progress.ts").AgentProgressSnapshot;
  /** 结果摘要（一行文字，如 "862 字符"、"替换完成"） */
  resultSummary?: string;
  /** 工具执行耗时（毫秒），完成态时由后端填入。缺省时不显示 */
  elapsedMs?: number;
}

// ── HistoryItem 基础 ──

export interface HistoryItemBase {
  text?: string;
}

// ── 具体 HistoryItem 类型 ──

/** 用户消息 */
export type HistoryItemUser = HistoryItemBase & {
  type: "user";
  text: string;
};

/** 助手消息（带 ⏺ 前缀） */
export type HistoryItemAssistant = HistoryItemBase & {
  type: "assistant";
  text: string;
};

/** 助手消息（纯内容，无前缀） */
export type HistoryItemAssistantContent = HistoryItemBase & {
  type: "assistant_content";
  text: string;
};

/** 思考过程 */
export type HistoryItemThinking = HistoryItemBase & {
  type: "thinking";
  thought: ThoughtSummary;
};

/** 提示信息 */
export type HistoryItemHint = HistoryItemBase & {
  type: "hint";
  text: string;
};

/** 信息消息（带图标、颜色） */
export type HistoryItemInfo = HistoryItemBase & {
  type: "info";
  text: string;
  secondaryText?: string;
  icon?: string;
  color?: string;
};

/** 警告消息 */
export type HistoryItemWarning = HistoryItemBase & {
  type: "warning";
  text: string;
};

/** 错误消息 */
export type HistoryItemError = HistoryItemBase & {
  type: "error";
  text: string;
};

/** 工具调用分组 */
export type HistoryItemToolGroup = HistoryItemBase & {
  type: "tool_group";
  tools: IndividualToolCallDisplay[];
  borderTop?: boolean;
  borderBottom?: boolean;
};

/**
 * 上下文压缩通知。
 *
 * P1-3：横幅**必须携带实据**。此前本项只有 type 一个必填字段，渲染成一句无条件的
 * 「对话已压缩」——2026-07-29 事故里消息一条都没少却照样画出这条横幅，用户完全无法
 * 从界面判断压缩是否真的发生。现在消息数由 queryLoop 的实测结果透传进来并显示出来，
 * 「有横幅」与「真压了」在界面上可被用户自己核对。
 */
export type HistoryItemCompression = HistoryItemBase & {
  type: "compression";
  originalTokenCount?: number;
  newTokenCount?: number;
  /** 压缩前消息数（实测） */
  messageCountBefore?: number;
  /** 压缩后消息数（实测，必然 < before——否则上游不会发出本事件） */
  messageCountAfter?: number;
};

/** 模型切换通知 */
export type HistoryItemModel = HistoryItemBase & {
  type: "model";
  model: string;
};

/** /about 命令输出 */
export type HistoryItemAbout = HistoryItemBase & {
  type: "about";
  cliVersion: string;
  model: string;
  provider: string;
};

/** /help 命令输出 */
export type HistoryItemHelp = HistoryItemBase & {
  type: "help";
  commands: Array<{ name: string; aliases: string[]; description: string }>;
};

/** /stats 命令输出 */
export type HistoryItemStats = HistoryItemBase & {
  type: "stats";
  duration: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

/** 退出摘要 */
export type HistoryItemQuit = HistoryItemBase & {
  type: "quit";
  duration: string;
};

/** 命令输出（斜杠命令的输入+输出） */
export type HistoryItemCommand = HistoryItemBase & {
  type: "command";
  input: string;
  output: string | null;
  /** 输出是否为错误流（stderr / 执行失败）。CM2：bash 错误输出红色区分。 */
  isError?: boolean;
};

/** AppHeader（消息列表顶部，随消息滚动） */
export type HistoryItemAppHeader = HistoryItemBase & {
  type: "app_header";
  version: string;
};

/** 计划审阅（带边框高亮的计划内容展示） */
export type HistoryItemPlanReview = HistoryItemBase & {
  type: "plan_review";
  planContent: string;
  planFilePath: string;
};

/**
 * 后台任务完成通知（<task-notification>）。
 *
 * 背景：后台子代理/shell 完成后，主循环把 <task-notification> XML 作为一条
 * user 文本消息注入对话（query/loop.ts）。此前它走 UserMessage 全量渲染（`>` 前缀、
 * 不折叠），与同一子代理的 task_output 工具结果（走折叠路径）视觉割裂——
 * 用户看到「有的折叠、有的不折叠」。本类型让通知走专用折叠组件，统一对齐工具结果样式。
 */
export type HistoryItemTaskNotification = HistoryItemBase & {
  type: "task_notification";
  /** 任务 ID（如 "axcpyv1qa"） */
  taskId: string;
  /** 任务终态：completed / failed / killed 等 */
  status: string;
  /** 一行摘要（如 'Agent "核查 X" 执行完成'） */
  summary: string;
  /** 结构化结果正文（completed 时为子代理结论；failed/killed 时为错误信息或空） */
  result?: string;
  /** 完整输出落盘文件路径（供「展开看完整」指引） */
  outputFile?: string;
  /**
   * P1-2：子代理类型（如 explore / 自定义 agent 名）。用于给摘要行的 agent 名标一个
   * 稳定的身份色（frontmatter 声明色优先，否则按类型哈希分配），多代理并行时便于区分。
   * 缺省则不着色，保持原样。
   */
  agentType?: string;
};

// ── 联合类型 ──

/** 不含 id 的 HistoryItem（用于创建时） */
export type HistoryItemWithoutId =
  | HistoryItemUser
  | HistoryItemAssistant
  | HistoryItemAssistantContent
  | HistoryItemThinking
  | HistoryItemHint
  | HistoryItemInfo
  | HistoryItemWarning
  | HistoryItemError
  | HistoryItemToolGroup
  | HistoryItemCompression
  | HistoryItemModel
  | HistoryItemAbout
  | HistoryItemHelp
  | HistoryItemStats
  | HistoryItemQuit
  | HistoryItemCommand
  | HistoryItemAppHeader
  | HistoryItemPlanReview
  | HistoryItemTaskNotification;

/** 带 id 的 HistoryItem（渲染用） */
export type HistoryItem = HistoryItemWithoutId & { id: number };
