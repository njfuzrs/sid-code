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
  | { type: "stop_hook_retry" }
  | { type: "timeout_retry" }
  | { type: "todo_gate_retry" }
  | { type: "empty_param_retry" };

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
  /**
   * P0-2：上次回注 todo system-reminder 时的轮次（两次回注间隔节流用）。
   * 0/undefined 表示尚未回注过。
   */
  lastTodoReminderTurn?: number;
  /**
   * P0-2：上次回注时观察到的 todo writeVersion 快照。
   * writeVersion 变化说明模型更新过清单，回注计时随之刷新。
   */
  lastSeenTodoWriteVersion?: number;
  /** P0-3：end_turn 完成度硬校验已软续命的次数 */
  todoGateRetryCount?: number;
  /** P2-2：上次回注工作日志摘要时的轮次（每 N 轮回注一次） */
  lastProgressReminderTurn?: number;
  /**
   * F1：空参数 tool_use 退化的连续重试次数（DeepSeek 大上下文退化兜底）。
   * 工具成功执行或正常 end_turn 收尾后清零，确保只对"连续退化"计数。
   */
  emptyParamRetryCount?: number;
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
  /** 处理流式响应，累积内容块。onThinking 对标 Claude Code 的独立思考流通道 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
    onThinking?: (text: string) => void,
  ) => Promise<AccumulatedResponse>;
  /** 执行工具调用（含权限检查）。返回 results + 可选 followup（ADR-019） */
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
  /** 自动压缩 */
  autoCompact: () => Promise<void>;
  /** 处理上下文溢出，返回调整后的 maxTokens 或 null */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
  /**
   * 主动中断当前 LLM 请求（abort 当前 AbortController）。可选。
   * 用途：L1 单轮硬超时触发时，配合 Promise.race 让出控制权的同时，
   * 主动 abort 上游 fetch，尽量让已 hang 的底层流尽快释放（双保险）。
   * 注意：即使 abort 对已 hang 的 reader 无效，race 也已让 queryLoop 恢复——
   * 此回调是"尽力而为"的资源释放，不是兜底的唯一手段。
   */
  abortCurrentRequest?: (reason?: string) => void;
  /**
   * L1 单轮硬超时阈值（毫秒）。默认 10 分钟。
   * 仅用于覆盖（如单测传短值快速触发超时路径）。生产无需注入。
   */
  maxTurnDurationMs?: number;
  /** UUID 生成（可 mock） */
  uuid: () => string;
  /** 检查本轮是否发生了模型降级（用于 tombstone） */
  checkFallbackOccurred?: () => boolean;
  /** 重置降级标志 */
  resetFallbackFlag?: () => void;
  /** Plan Mode 系统提醒（对标 Claude Code 每轮 system-reminder 注入） */
  getPlanModeReminder?: () => Promise<string | null>;
  /**
   * P0-2 / P0-3：读取当前 todo 状态快照（用于回注 + 完成度校验）。
   * 返回 null 表示无 todo 工具或无 todo 项。可 mock。
   */
  getTodoState?: () => { todos: import("../tool/todo-write.ts").TodoItem[]; writeVersion: number } | null;
  /**
   * B2：会话持久化写入端（方案 a）。queryLoop 在 ctxMgr.addMessage(toolResults) 的同时，
   * 通过它把 tool_result 直接写入 jsonl。可选——未注入则不持久化。
   */
  sessionStore?: import("../session/store.ts").SessionStore;
  /**
   * Step 0：Session Memory 提取触发（每轮收尾调用，fire-and-forget）。
   * 内部按双阈值（token 增长 + 工具调用次数/自然断点）决定是否真正提取。可选。
   */
  updateSessionMemory?: () => Promise<void>;
  /**
   * Step 0：记录一次工具调用（用于 Session Memory 双阈值计数）。可选。
   */
  recordSessionMemoryToolCall?: () => void;
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
  | { kind: "hook_blocked"; reason: string }
  // §3.2（fdb47f30）：queryLoop 内部抛出的异常（如 processStream throw）原会穿透
  // engine.ts 的 for-await，跳过 done 收尾。现统一封装为此事件走 yield 通道，
  // 让 done 收尾可达、app 层把具体错误持久化展示（对标 §3.3）。
  // recoverable=false 表示本轮已无法继续（与用户 ESC 主动中断区分）。
  | { kind: "fatal_error"; message: string; stack?: string; recoverable: boolean };
