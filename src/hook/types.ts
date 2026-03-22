/**
 * Hook 系统类型定义
 * 事件枚举、输入/输出接口、HookOutput 类层次、执行计划等
 */

// ============================================================
// 枚举
// ============================================================

/** 事件名称（PascalCase，配置文件中仍支持旧的 snake_case） */
export enum HookEventName {
  PreToolUse = "PreToolUse",
  PostToolUse = "PostToolUse",
  PostToolUseFailure = "PostToolUseFailure",
  UserPromptSubmit = "UserPromptSubmit",
  AfterAgent = "AfterAgent",
  BeforeModel = "BeforeModel",
  AfterModel = "AfterModel",
  SessionStart = "SessionStart",
  SessionEnd = "SessionEnd",
  PreCompact = "PreCompact",
  SubagentStop = "SubagentStop",
  Notification = "Notification",
}

/** 旧 snake_case → 新 PascalCase 映射（向后兼容） */
export const LEGACY_EVENT_MAP: Record<string, HookEventName> = {
  pre_tool_use: HookEventName.PreToolUse,
  post_tool_use: HookEventName.PostToolUse,
  post_tool_use_failure: HookEventName.PostToolUseFailure,
  user_prompt_submit: HookEventName.UserPromptSubmit,
  session_start: HookEventName.SessionStart,
  session_end: HookEventName.SessionEnd,
  pre_compact: HookEventName.PreCompact,
  subagent_stop: HookEventName.SubagentStop,
  notification: HookEventName.Notification,
  permission_request: HookEventName.Notification, // 旧事件映射到 Notification
};

/** 配置来源（优先级从高到低） */
export enum ConfigSource {
  Runtime = "runtime",
  Project = "project",
  User = "user",
  Global = "global",
}

/** Hook 实现类型 */
export enum HookType {
  Command = "command",
  Url = "url",
  Runtime = "runtime",
}

/** 决策类型 */
export type HookDecision = "allow" | "deny" | "block" | undefined;

// ============================================================
// Hook 配置
// ============================================================

/** Command Hook 配置 */
export interface CommandHookConfig {
  type: "command";
  name?: string;
  command: string;
  timeout?: number;
  env?: Record<string, string>;
  source?: ConfigSource;
}

/** URL Hook 配置 */
export interface UrlHookConfig {
  type: "url";
  name?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  source?: ConfigSource;
}

/** Runtime Hook 配置（函数式，仅内部代码可注册） */
export interface RuntimeHookConfig {
  type: "runtime";
  name: string;
  action: (input: HookInput, options?: { signal: AbortSignal }) => Promise<HookOutput | void>;
  timeout?: number;
  source?: ConfigSource;
}

export type HookConfig = CommandHookConfig | UrlHookConfig | RuntimeHookConfig;

/** Hook 定义（配置文件中的一组 hook，带 matcher） */
export interface HookDefinition {
  matcher?: string;
  sequential?: boolean;
  hooks: HookConfig[];
}

/** 新格式配置：按事件名分组 */
export type NewHooksConfig = Partial<Record<HookEventName, HookDefinition[]>>;

/** 生成 hook 唯一 key（用于去重） */
export function getHookKey(hook: HookConfig): string {
  const name = hook.name || "";
  if (hook.type === "command") return `cmd:${name}:${hook.command}`;
  if (hook.type === "url") return `url:${name}:${hook.url}`;
  return `rt:${name}`;
}

// ============================================================
// 输入类型
// ============================================================

/** 基础输入（所有事件共享） */
export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  timestamp: string;
}

/** PreToolUse 输入 */
export interface PreToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** PostToolUse 输入 */
export interface PostToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  is_error?: boolean;
}

/** UserPromptSubmit 输入 */
export interface UserPromptSubmitInput extends HookInput {
  prompt: string;
}

/** AfterAgent 输入 */
export interface AfterAgentInput extends HookInput {
  prompt: string;
  prompt_response: string;
}

/** BeforeModel 输入 */
export interface BeforeModelInput extends HookInput {
  llm_request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    config?: Record<string, unknown>;
  };
}

/** AfterModel 输入 */
export interface AfterModelInput extends HookInput {
  llm_request: { model: string; messages: Array<{ role: string; content: string }> };
  llm_response: { text?: string; usage?: { inputTokens?: number; outputTokens?: number } };
}

/** SessionStart 输入 */
export interface SessionStartInput extends HookInput {
  source: "startup" | "resume" | "clear";
}

/** SessionEnd 输入 */
export interface SessionEndInput extends HookInput {
  reason: "exit" | "clear" | "other";
}

/** PreCompact 输入 */
export interface PreCompactInput extends HookInput {
  trigger: "manual" | "auto";
}

/** Notification 输入 */
export interface NotificationInput extends HookInput {
  notification_type: string;
  message: string;
  details: Record<string, unknown>;
}

// ============================================================
// 输出类型
// ============================================================

/** 基础输出 */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

// ============================================================
// HookOutput 类层次
// ============================================================

/** 默认输出实现 */
export class DefaultHookOutput implements HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;

  constructor(data: Partial<HookOutput> = {}) {
    this.continue = data.continue;
    this.stopReason = data.stopReason;
    this.suppressOutput = data.suppressOutput;
    this.systemMessage = data.systemMessage;
    this.decision = data.decision;
    this.reason = data.reason;
    this.hookSpecificOutput = data.hookSpecificOutput;
  }

  /** 是否为阻塞决策 */
  isBlockingDecision(): boolean {
    return this.decision === "block" || this.decision === "deny";
  }

  /** 是否应停止执行 */
  shouldStopExecution(): boolean {
    return this.continue === false;
  }

  /** 获取有效原因 */
  getEffectiveReason(): string {
    return this.stopReason || this.reason || "无原因";
  }

  /** 获取附加上下文（已清理 HTML 标签注入） */
  getAdditionalContext(): string | undefined {
    if (this.hookSpecificOutput && "additionalContext" in this.hookSpecificOutput) {
      const ctx = this.hookSpecificOutput["additionalContext"];
      if (typeof ctx !== "string") return undefined;
      return ctx.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    return undefined;
  }

  /** 获取阻塞错误信息 */
  getBlockingError(): { blocked: boolean; reason: string } {
    if (this.isBlockingDecision()) {
      return { blocked: true, reason: this.getEffectiveReason() };
    }
    return { blocked: false, reason: "" };
  }

  /** 获取尾调用工具请求 */
  getTailToolCallRequest(): { name: string; args: Record<string, unknown> } | undefined {
    if (this.hookSpecificOutput && "tailToolCallRequest" in this.hookSpecificOutput) {
      const req = this.hookSpecificOutput["tailToolCallRequest"];
      if (typeof req === "object" && req !== null && !Array.isArray(req)) {
        return req as { name: string; args: Record<string, unknown> };
      }
    }
    return undefined;
  }

  /** 是否应清除上下文 */
  shouldClearContext(): boolean {
    return false;
  }
}

/** PreToolUse 输出 */
export class PreToolUseHookOutput extends DefaultHookOutput {
  /** 获取修改后的工具输入 */
  getModifiedToolInput(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && "tool_input" in this.hookSpecificOutput) {
      const input = this.hookSpecificOutput["tool_input"];
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        return input as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/** AfterAgent 输出 */
export class AfterAgentHookOutput extends DefaultHookOutput {
  override shouldClearContext(): boolean {
    if (this.hookSpecificOutput && "clearContext" in this.hookSpecificOutput) {
      return this.hookSpecificOutput["clearContext"] === true;
    }
    return false;
  }
}

/** BeforeModel 输出 */
export class BeforeModelHookOutput extends DefaultHookOutput {
  /** 获取修改后的 LLM 请求 */
  getModifiedLLMRequest(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && "llm_request" in this.hookSpecificOutput) {
      const req = this.hookSpecificOutput["llm_request"];
      if (typeof req === "object" && req !== null) {
        return req as Record<string, unknown>;
      }
    }
    return undefined;
  }

  /** 获取合成响应（跳过 LLM 调用） */
  getSyntheticResponse(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && "llm_response" in this.hookSpecificOutput) {
      const resp = this.hookSpecificOutput["llm_response"];
      if (typeof resp === "object" && resp !== null) {
        return resp as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/** AfterModel 输出 */
export class AfterModelHookOutput extends DefaultHookOutput {
  /** 获取修改后的 LLM 响应 */
  getModifiedResponse(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && "llm_response" in this.hookSpecificOutput) {
      const resp = this.hookSpecificOutput["llm_response"];
      if (typeof resp === "object" && resp !== null) {
        return resp as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/** 根据事件名创建对应的 HookOutput 子类 */
export function createHookOutput(eventName: HookEventName, data: Partial<HookOutput>): DefaultHookOutput {
  switch (eventName) {
    case HookEventName.PreToolUse:
      return new PreToolUseHookOutput(data);
    case HookEventName.AfterAgent:
      return new AfterAgentHookOutput(data);
    case HookEventName.BeforeModel:
      return new BeforeModelHookOutput(data);
    case HookEventName.AfterModel:
      return new AfterModelHookOutput(data);
    default:
      return new DefaultHookOutput(data);
  }
}

// ============================================================
// 执行结果 & 计划
// ============================================================

/** 单个 Hook 执行结果 */
export interface HookExecutionResult {
  hookConfig: HookConfig;
  eventName: HookEventName;
  success: boolean;
  output?: HookOutput;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration: number;
  error?: Error;
}

/** Hook 执行计划 */
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;
}

/** 聚合后的结果 */
export interface AggregatedHookResult {
  success: boolean;
  finalOutput?: DefaultHookOutput;
  allOutputs: HookOutput[];
  errors: Error[];
  totalDuration: number;
}
