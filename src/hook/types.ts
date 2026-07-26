/**
 * Hook 系统类型定义
 * 事件枚举、输入/输出接口、HookOutput 类层次、执行计划等
 */

// HookExecutionPlan.entries 需要 registry 条目类型。registry.ts 反向依赖本文件，
// 故用 `import type`（编译期擦除，不产生运行时循环依赖）。
import type { HookRegistryEntry } from "./registry.ts";

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
  PostCompact = "PostCompact",
  SubagentStart = "SubagentStart",
  SubagentStop = "SubagentStop",
  Notification = "Notification",
  Stop = "Stop",
  StopFailure = "StopFailure",
  Setup = "Setup",
  PermissionRequest = "PermissionRequest",
  PermissionDenied = "PermissionDenied",
  ConfigChange = "ConfigChange",
  FileChanged = "FileChanged",
  CwdChanged = "CwdChanged",
  TaskCreated = "TaskCreated",
  TaskCompleted = "TaskCompleted",
  /** 权限检查开始（spec 17 §6.1.3，用于 blocked_on_user span） */
  BeforePermissionCheck = "BeforePermissionCheck",
  /** 权限检查结束 */
  AfterPermissionCheck = "AfterPermissionCheck",
  /** Hook 执行开始（用于 hook_execution span） */
  BeforeHookExecution = "BeforeHookExecution",
  /** Hook 执行结束 */
  AfterHookExecution = "AfterHookExecution",
  /** G11：指令加载到上下文（CLAUDE.md / rules 加载后触发） */
  InstructionsLoaded = "InstructionsLoaded",
  /** G11：团队代理空闲（可 block，用于团队协作场景） */
  TeammateIdle = "TeammateIdle",
  /** G11：hook 反向向用户提问的协议（action: accept/decline/cancel），需配套 UI，先占位 */
  Elicitation = "Elicitation",
  /** G11：Elicitation 的用户响应结果 */
  ElicitationResult = "ElicitationResult",
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
  post_compact: HookEventName.PostCompact,
  subagent_start: HookEventName.SubagentStart,
  subagent_stop: HookEventName.SubagentStop,
  notification: HookEventName.Notification,
  permission_request: HookEventName.PermissionRequest,
  permission_denied: HookEventName.PermissionDenied,
  stop: HookEventName.Stop,
  stop_failure: HookEventName.StopFailure,
  setup: HookEventName.Setup,
  config_change: HookEventName.ConfigChange,
  file_changed: HookEventName.FileChanged,
  cwd_changed: HookEventName.CwdChanged,
  task_created: HookEventName.TaskCreated,
  task_completed: HookEventName.TaskCompleted,
  instructions_loaded: HookEventName.InstructionsLoaded,
  teammate_idle: HookEventName.TeammateIdle,
  elicitation: HookEventName.Elicitation,
  elicitation_result: HookEventName.ElicitationResult,
};

/** 配置来源（优先级从高到低） */
export enum ConfigSource {
  Runtime = "runtime",
  Project = "project",
  User = "user",
  Global = "global",
  /** 插件提供的 hook（可被 replacePluginHooks 原子替换） */
  Plugin = "plugin",
}

/** Hook 实现类型 */
export enum HookType {
  Command = "command",
  Url = "url",
  Runtime = "runtime",
  Prompt = "prompt",
  Agent = "agent",
}

/**
 * 顶层决策类型（老式 decision 字段）
 * CC utils/hooks.ts:525-543：`approve` 等价 allow（放行），`block`/`deny` 阻塞。
 */
export type HookDecision = "allow" | "approve" | "deny" | "block" | undefined;

/**
 * PreToolUse 权限决策三值（对齐 CC hookSpecificOutput.permissionDecision）
 * - allow：跳过交互提示，但仍跑规则检查（有 deny 规则仍拒、有 ask 规则仍弹框）
 * - deny：阻止执行，reason 反馈给模型
 * - ask：升级为用户确认，弹框展示 hook 的 message
 */
export type HookPermissionDecision = "allow" | "deny" | "ask";

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
  async?: boolean;
  asyncRewake?: boolean;
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
  allowedEnvVars?: string[];
  source?: ConfigSource;
}

/** Prompt Hook 配置（LLM 验证） */
export interface PromptHookConfig {
  type: "prompt";
  name?: string;
  prompt: string;
  model?: string;
  timeout?: number;
  source?: ConfigSource;
}

/** Agent Hook 配置（多轮 Agent 验证） */
export interface AgentHookConfig {
  type: "agent";
  name?: string;
  prompt: string;
  model?: string;
  timeout?: number;
  tools?: string[];
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

export type HookConfig = CommandHookConfig | UrlHookConfig | RuntimeHookConfig | PromptHookConfig | AgentHookConfig;

/** Hook 定义（配置文件中的一组 hook，带 matcher） */
export interface HookDefinition {
  matcher?: string;
  /**
   * G10：在 matcher（工具名）之上的细粒度 tool_input 条件（权限规则语法）。
   * 例：`Bash(git *)` 仅当命令匹配 git 开头才触发；`Read(*.ts)` 仅当读 .ts 文件才触发。
   * 仅 PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest 事件支持（有 tool_input）。
   */
  if?: string;
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
  /** 当前权限模式（与 claude-trace collector.py 对齐） */
  permission_mode?: string;
}

/** PreToolUse 输入 */
export interface PreToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** LLM 分配的工具调用 ID，用于关联 action↔observation */
  tool_use_id?: string;
}

/** PostToolUse 输入 */
export interface PostToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  is_error?: boolean;
  /** 与 PreToolUse 中的 tool_use_id 对应 */
  tool_use_id?: string;

  // ── 整合新增：工具执行耗时 ──
  /** 工具执行耗时（毫秒） */
  duration_ms?: number;

  // ── Harness 扩展点 ──
  /** 编辑元数据（仅 edit/write 工具） */
  edit_meta?: HarnessEditMeta;
  /** 是否触发了自动验证 */
  verify_triggered?: boolean;
  /** Harness 每轮上下文 */
  harness_context?: HarnessHookContext;
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
    /** 原始 content blocks 结构（不 stringify，采集器用） */
    raw_messages?: unknown[];
    /** system prompt（每次请求都有，但采集器只取首次） */
    system?: unknown;
    /** 工具定义列表（完整 tool schema） */
    tools?: unknown[];
  };

  // ── Harness 扩展点 ──
  /** Harness 每轮上下文 */
  harness_context?: HarnessHookContext;

  /**
   * 流快照定位信息（发现 1 修复）：queryLoop 侧 StreamPhase 快照的 key 是 `${loop_id}:${turn_index}`
   * （turn_index = 每条用户消息内自增的 state.turnCount，loop_id = 每次 queryLoop 唯一 ID）。
   * 采集器的配对看门狗此前用「累计 pair 数 + 1」查快照，与此 key 语义不同 → 除首条用户消息外永远
   * 查不到,stream_snapshot 恒 null（死代码）。透传这两个字段，让看门狗用同一 key 查快照。
   * 可选：非 queryLoop 来源（如直接调 hook）不带，看门狗退化为原行为。
   */
  stream_snapshot_ref?: {
    turn_index: number;
    loop_id: string;
  };
}

/** AfterModel 输入 */
export interface AfterModelInput extends HookInput {
  llm_request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    config?: Record<string, unknown>;
    /** 原始 content blocks 结构（不 stringify，采集器用） */
    raw_messages?: unknown[];
    /** system prompt（首次请求时有值） */
    system?: unknown;
    /** 工具定义列表 */
    tools?: unknown[];
  };
  llm_response: {
    text?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      /** 缓存读取 token 数 */
      cacheReadInputTokens?: number;
      /** 缓存创建 token 数 */
      cacheCreationInputTokens?: number;
      /** 缺口分析二类：推理/思考 token 数（output 子集，thinking 模型隐藏成本单独计） */
      reasoningTokens?: number;
    };
    /** 完整的 assistant content blocks（含 tool_use） */
    content_blocks?: unknown[];
    /** end_turn / tool_use / max_tokens / stop */
    stop_reason?: string;
    /** 原始 thinking blocks（Anthropic 特有） */
    thinking_blocks?: unknown[];

    // ── 整合新增：成本与耗时 ──
    /** 本次 LLM 调用成本（美元） */
    cost_usd?: number;
    /** 本次 LLM 调用耗时（毫秒） */
    api_duration_ms?: number;
    /** 缓存节省金额（美元） */
    cache_savings_usd?: number;
    /** 首 token 延迟（毫秒），供 telemetry probe 消费 */
    ttft_ms?: number;
    /** T12.3：Provider 名称（"anthropic" | "openai" | "ollama" 等） */
    provider?: string;
    /** 端点维度：本次请求实际走的 base_url，区分同模型不同渠道（如公司网关 vs 官方），
     *  供轨迹排查 + cost-recompute 按 (model, endpoint) 复合键精确重算成本。 */
    base_url?: string;
  };

  // ── Harness 扩展点 ──
  /** Harness 每轮上下文 */
  harness_context?: HarnessHookContext;
}

/** SessionStart 输入 */
export interface SessionStartInput extends HookInput {
  source: "startup" | "resume" | "clear";
  /** 当前使用的模型 */
  model?: string;
  /** system prompt 的 MD5 hash */
  system_prompt_hash?: string;
  /** Bug3 桥接：source="resume" 时携带被恢复的旧会话 id，使 trajectory 能反查对话历史。 */
  resumed_from?: string;
}

/** SessionEnd 输入 */
export interface SessionEndInput extends HookInput {
  reason: "exit" | "clear" | "other" | "error" | "abort";
  /** 当 reason=error 时，可携带错误信息用于 trajectory 诊断 */
  error?: { message: string; name?: string; stack?: string };
  /** 会话统计汇总 */
  stats?: {
    model?: string;
    total_tokens_sent?: number;
    total_tokens_received?: number;
    /** DISP-1：累计输入 prompt token（flow 口径，与累计 cost 可比） */
    total_cumulative_prompt_tokens?: number;
    total_cache_read_tokens?: number;
    total_cache_creation_tokens?: number;
    total_cost_usd?: number;
    total_api_calls?: number;
    total_tool_calls?: number;
    tools_used?: string[];
    files_edited?: string[];
    has_thinking?: boolean;
    duration_ms?: number;
  };

  // ── Harness 扩展点 ──
  /** Harness 会话级汇总 */
  harness_summary?: HarnessSessionSummary;
}

/** PreCompact 输入 */
export interface PreCompactInput extends HookInput {
  trigger: "manual" | "auto";
}

/** SubagentStart 输入 */
export interface SubagentStartInput extends HookInput {
  agent_id: string;
  /** explore / task / plan / summarize / verify / custom */
  agent_type: string;
  parent_session_id?: string;
  /** 子代理任务描述（模型为什么派这个子代理）。排查时无需回 raw.jsonl 找原始 prompt。 */
  description?: string;
  /** 子代理实际使用的模型（遥测按 model 分类/计费用；start 时为预期模型） */
  model?: string;
  /** 子代理实际使用的 provider（缺省由 model 推断） */
  provider?: string;
}

/** SubagentStop 输入（携带子代理实际用量，供遥测单独计费 / 按 model 分类） */
export interface SubagentStopInput extends HookInput {
  agent_id?: string;
  agent_type?: string;
  /** 子代理实际使用的模型 */
  model?: string;
  /** 子代理实际使用的 provider */
  provider?: string;
  /** 子代理是否成功结束 */
  success?: boolean;
  /** 子代理执行轮次 */
  turns?: number;
  /** 子代理工具调用次数 */
  tool_use_count?: number;
  /** 子代理 LLM 用量明细 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /** 子代理执行耗时（毫秒） */
  duration_ms?: number;
  /** 兼容旧调用：允许携带任意附加字段（如 toolName） */
  [key: string]: unknown;
}

/** Notification 输入 */
export interface NotificationInput extends HookInput {
  notification_type: string;
  message: string;
  details: Record<string, unknown>;
}

/** BeforePermissionCheck / AfterPermissionCheck 输入（spec 17 §6.1.3） */
export interface PermissionCheckInput extends HookInput {
  tool_name: string;
  tool_use_id?: string;
}

/** BeforeHookExecution / AfterHookExecution 输入（spec 17 §6.1.3） */
export interface HookExecutionInput extends HookInput {
  /** 被执行 hook 的名称 */
  hook_name: string;
  /** 触发该 hook 的事件名 */
  triggering_event?: string;
}

/** Stop 事件输入（模型 end_turn 后执行检查） */
export interface StopInput extends HookInput {
  /** 模型最后一次回复的文本 */
  assistant_response: string;
}

/** StopFailure 事件输入（API 错误导致的非正常结束） */
export interface StopFailureInput extends HookInput {
  error: string;
  error_type: "api_error" | "rate_limit" | "context_overflow" | "abort" | "unknown";
}

/** PostCompact 输入 */
export interface PostCompactInput extends HookInput {
  trigger: "manual" | "auto";
  messages_before: number;
  messages_after: number;
  tokens_saved: number;
}

/** Setup 输入 */
export interface SetupInput extends HookInput {
  trigger: "first_run" | "dependency_change" | "manual";
  project_dir: string;
}

/** PermissionRequest 输入 */
export interface PermissionRequestInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_mode: string;
}

/** PermissionDenied 输入 */
export interface PermissionDeniedInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  denial_reason: string;
  denial_source: "user" | "rule" | "hook" | "auto";
}

/** ConfigChange 输入 */
export interface ConfigChangeInput extends HookInput {
  changed_keys: string[];
  source: "file" | "command" | "env";
}

/** FileChanged 输入 */
export interface FileChangedInput extends HookInput {
  file_path: string;
  change_type: "created" | "modified" | "deleted";
}

/** CwdChanged 输入 */
export interface CwdChangedInput extends HookInput {
  old_cwd: string;
  new_cwd: string;
}

/** TaskCreated 输入 */
export interface TaskCreatedInput extends HookInput {
  task_id: string;
  task_description: string;
}

/** TaskCompleted 输入 */
export interface TaskCompletedInput extends HookInput {
  task_id: string;
  task_description: string;
  success: boolean;
  result?: string;
}

/** G11：InstructionsLoaded 输入——指令（CLAUDE.md / rules）加载到上下文时 */
export interface InstructionsLoadedInput extends HookInput {
  /** 已加载的指令来源路径列表（CLAUDE.md、规则文件等） */
  sources: string[];
  /** 加载的指令总字符数（可观测性） */
  total_chars?: number;
}

/** G11：TeammateIdle 输入——团队代理空闲时（可 block） */
export interface TeammateIdleInput extends HookInput {
  /** 空闲的队友代理 ID */
  teammate_id: string;
  /** 队友名称 */
  teammate_name?: string;
  /** 已空闲时长（毫秒） */
  idle_ms?: number;
}

/** G11：Elicitation 输入——hook 反向向用户提问（需配套 UI，先占位） */
export interface ElicitationInput extends HookInput {
  /** 向用户展示的提问消息 */
  message: string;
  /** 可选的结构化 schema（约束用户回答） */
  requestedSchema?: Record<string, unknown>;
}

/** G11：ElicitationResult 输入——Elicitation 的用户响应结果 */
export interface ElicitationResultInput extends HookInput {
  /** 用户动作 */
  action: "accept" | "decline" | "cancel";
  /** 用户填写的内容（action=accept 时） */
  content?: Record<string, unknown>;
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

  /** 是否为阻塞决策（block/deny，approve/allow 不阻塞） */
  isBlockingDecision(): boolean {
    return this.decision === "block" || this.decision === "deny";
  }

  /**
   * 是否为顶层放行决策（G9：对齐 CC decision:"approve"）
   * CC utils/hooks.ts:525-543 把顶层 `approve` 视为放行信号（等价 allow）。
   * 我们既有 `allow` 也视为放行，兼容两种写法。
   */
  isApproveDecision(): boolean {
    return this.decision === "approve" || this.decision === "allow";
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
  /**
   * 获取修改后的工具输入（G1：对齐 CC hookSpecificOutput.updatedInput，整体替换）
   *
   * CC 规范（utils/hooks.ts:618-620）用 `updatedInput` 整体替换 input。我们同时认两个字段名：
   * `updatedInput` 优先（对齐 CC），`tool_input` 兜底（向后兼容我们的旧行为）。
   */
  getModifiedToolInput(): Record<string, unknown> | undefined {
    const so = this.hookSpecificOutput;
    if (!so) return undefined;
    const candidate =
      ("updatedInput" in so ? so["updatedInput"] : undefined) ??
      ("tool_input" in so ? so["tool_input"] : undefined);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
    return undefined;
  }

  /**
   * 获取权限决策三值（G2：对齐 CC hookSpecificOutput.permissionDecision）
   * allow / deny / ask，无有效值返回 undefined。
   */
  getPermissionDecision(): HookPermissionDecision | undefined {
    const d = this.hookSpecificOutput?.["permissionDecision"];
    if (d === "allow" || d === "deny" || d === "ask") return d;
    return undefined;
  }

  /** 获取权限决策的说明文本（CC permissionDecisionReason） */
  getPermissionDecisionReason(): string | undefined {
    const r = this.hookSpecificOutput?.["permissionDecisionReason"];
    return typeof r === "string" ? r : undefined;
  }

  /**
   * 是否为阻塞决策（override）
   * 除顶层 block/deny 外，permissionDecision:"deny" 也算阻塞（G2）。
   */
  override isBlockingDecision(): boolean {
    if (super.isBlockingDecision()) return true;
    return this.getPermissionDecision() === "deny";
  }

  /** override getEffectiveReason：permissionDecisionReason 优先于 stopReason/reason */
  override getEffectiveReason(): string {
    return this.getPermissionDecisionReason() || super.getEffectiveReason();
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
  /** G7：该 hook 以异步后台模式启动（不阻塞本轮，结果由 AsyncHookRegistry 收集） */
  async?: boolean;
}

/** Hook 执行计划 */
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;
  /**
   * 与 hookConfigs **下标一一对应**的 registry 条目（承载 once/skillName 等元数据）。
   *
   * 为什么需要：`once: true` 的一次性 hook 执行后必须失效，而 hookConfigs 是纯配置、
   * 丢失了「这条来自哪个 entry」的身份，导致 registry.markOnceExecuted 无从调用
   * （历史上该方法零调用点 → once 语义完全不生效）。计划里带回 entry 引用，
   * 执行成功后按下标回标即可。
   *
   * 下标对齐前提：runner 的 executeHooksParallel/Sequential 均按入参顺序返回结果。
   */
  entries?: HookRegistryEntry[];
}

/** 聚合后的结果 */
export interface AggregatedHookResult {
  success: boolean;
  finalOutput?: DefaultHookOutput;
  allOutputs: HookOutput[];
  errors: Error[];
  totalDuration: number;
}

// ============================================================
// Harness 扩展类型（当前只定义不填充，Harness Phase 0+ 时填值）
// ============================================================

/** Harness 每轮上下文——附加在 BeforeModel / AfterModel / PostToolUse 载荷上 */
export interface HarnessHookContext {
  /** Phase 0: 任务画像 */
  task_profile?: {
    task_type?: string;       // "read_only" | "single_file_edit" | "multi_file_edit" | ...
    risk_level?: string;      // "low" | "medium" | "high" | "critical"
    estimated_files?: number;
    needs_verification?: boolean;
  };
  /** Phase 2: 本轮暴露给模型的工具列表 */
  tool_subset?: string[];
  /** Phase 2: 工具搜索查询 */
  tool_search_queries?: string[];
  /** Phase 2: 当前上下文压力百分比 */
  context_pressure_percent?: number;
  /** Phase 2: 本轮上下文动作 */
  context_actions?: Array<{ action: string; reason: string }>;
  /** Phase 3: 运行时模式 */
  runtime_mode?: string;      // "local-inline" | "managed-worktree" | "sandbox-remote"
  runtime_id?: string;        // worktree/sandbox 实例 ID
  /** Phase 4: 候选并行 */
  candidate_id?: string;
  candidate_total?: number;
  /** 通用扩展 */
  extra?: Record<string, unknown>;
}

/** Harness 编辑元数据——附加在 PostToolUseInput 上（仅 edit/write 工具） */
export interface HarnessEditMeta {
  protocol?: string;            // "replace" | "hashline" | "hybrid"
  first_pass_success?: boolean;
  retry_count?: number;
  match_strategy?: string;      // "exact" | "flexible" | "regex" | "fuzzy"
  hashline_address?: string;    // hashline 地址（如 "42:k9f2"）
}

/** Harness 会话级汇总——附加在 SessionEndInput 上 */
export interface HarnessSessionSummary {
  task_profile?: Record<string, unknown>;
  edit_stats?: {
    total_edits: number;
    first_pass_success: number;
    retry_count: number;
    protocols_used: Record<string, number>;
  };
  verify_stats?: {
    total_runs: number;
    pass_count: number;
    auto_repair_success: number;
    commands_used: string[];
  };
  context_stats?: {
    trimmed_tokens: number;
    expired_items: number;
    tool_subset_sizes: number[];
    compression_actions: number;
  };
  runtime_mode?: string;
  candidate_stats?: {
    spawned: number;
    selected: number;
    selector_reason?: string;
  };
}
