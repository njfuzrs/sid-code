/**
 * Query Loop 核心类型定义
 * 统一消息类型系统 + 循环状态 + 依赖注入接口
 */

import type {
  Message,
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";

// ─── 扩展消息类型 ───

/** 压缩边界标记消息 */
export interface CompactBoundaryMessage {
  type: "compact_boundary";
  /** 压缩时间戳 */
  timestamp: number;
  /** 压缩前的消息数 */
  messageCountBefore: number;
  /** 压缩摘要 */
  summary?: string;
}

/** 墓碑消息：标记需撤回的消息（降级时使用） */
export interface TombstoneMessage {
  type: "tombstone";
  /** 被撤回的原始消息 */
  message: Message;
  /** 撤回原因 */
  reason: string;
}

/** 流式元数据消息 */
export interface StreamEventMessage {
  type: "stream_event";
  /** 事件子类型 */
  event: "stream_start" | "stream_end" | "fallback_start" | "fallback_end";
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/** 系统通知消息 */
export interface SystemNotification {
  type: "system";
  level: "info" | "warning" | "error";
  text: string;
}

/** 进度消息 */
export interface ProgressNotification {
  type: "progress";
  toolName: string;
  status: "start" | "end";
  input?: unknown;
  result?: { isError?: boolean; elapsedMs?: number };
}

/** queryLoop yield 的消息类型 */
export type QueryLoopYield =
  | { kind: "assistant_message"; message: Message }
  | { kind: "tool_start"; toolName: string; toolInput?: unknown }
  | { kind: "tool_end"; toolName: string; result?: { isError?: boolean; elapsedMs?: number } }
  | { kind: "stream_text"; text: string }
  | { kind: "compact"; }
  | { kind: "context_warning"; remaining: number }
  | { kind: "max_turns"; maxTurns: number }
  | { kind: "loop_detected"; detail: string }
  | { kind: "loop_recovery"; attempt: number; maxAttempts: number }
  | { kind: "tombstone"; message: Message; reason: string }
  | { kind: "system"; level: "info" | "warning" | "error"; text: string }
  | { kind: "done"; turns: number };

// ─── 循环继续原因 ───

/** 循环继续的原因（可测试性：记录上一次为何 continue） */
export type ContinueReason =
  | { type: "tool_use" }
  | { type: "max_tokens_continuation" }
  | { type: "reactive_compact" }
  | { type: "loop_recovery" }
  | { type: "context_overflow_retry" }
  | { type: "stop_hook_retry" };

// ─── 循环状态 ───

/** queryLoop 跨迭代状态 */
export interface LoopState {
  /** 当前轮次 */
  turnCount: number;
  /** 最大轮次 */
  maxTurns: number;
  /** max_output_tokens 恢复次数 */
  maxOutputTokensRecoveryCount: number;
  /** 是否已尝试过响应式压缩 */
  hasAttemptedReactiveCompact: boolean;
  /** 上一次 continue 的原因 */
  transition: ContinueReason | undefined;
  /** Stop Hook 重试次数 */
  stopHookRetryCount?: number;
}

/** 创建初始循环状态 */
export function createInitialLoopState(maxTurns: number): LoopState {
  return {
    turnCount: 0,
    maxTurns,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    transition: undefined,
  };
}

// ─── 依赖注入 ───

/** queryLoop 的可 mock 依赖 */
export interface QueryDeps {
  /** 调用 LLM（含重试和回退） */
  sendWithRetry: (params: SendParams, signal?: AbortSignal) => AsyncIterable<StreamEvent>;
  /** 处理流式响应，累积内容块 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ) => Promise<AccumulatedResponse>;
  /** 执行工具调用（含权限检查）。返回 results + 可选 followup（ADR-019） */
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
  /** 自动压缩 */
  autoCompact: () => Promise<void>;
  /** 处理上下文溢出，返回调整后的 maxTokens 或 null */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
  /** UUID 生成（可 mock） */
  uuid: () => string;
  /** 检查本轮是否发生了模型降级（用于 tombstone） */
  checkFallbackOccurred?: () => boolean;
  /** 重置降级标志 */
  resetFallbackFlag?: () => void;
}

// ─── QueryEngine 配置 ───

/** QueryEngine 提交消息的选项 */
export interface SubmitOptions {
  /** Extended Thinking 配置 */
  thinking?: { enabled: boolean; budgetTokens: number };
  /** 是否跳过 hook */
  skipHooks?: boolean;
}

/** QueryEngine 事件（yield 给外部消费者） */
export type QueryEngineEvent =
  | QueryLoopYield
  | { kind: "user_message_added" }
  | { kind: "hook_blocked"; reason: string };
