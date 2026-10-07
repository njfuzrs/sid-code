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

/**
 * 事件名称（PascalCase，配置文件中仍支持旧的 snake_case）
 *
 * ⚠ 每个成员的注释即 `website/ref/hooks.md` 的「触发时机」列（由
 * `scripts/docs-gen-reference.ts` 提取，见该文件的 extractEnumComments）。
 * 改注释等于改文档，改完需跑 `bun run docs:gen-reference`，否则 pre-commit 拦。
 *
 * 标「预留」的成员：`event-handler.ts` 里有对应的 `fire*Event` 方法，但 hook 子系统
 * **之外没有任何调用者**（已逐个 grep 确认），即用户配了也不会被调用。这类事实必须
 * 写进注释——参考文档说"有这个事件"而实际不触发，比不写更糟。接线后请同步删掉「预留」。
 */
export enum HookEventName {
  /** 工具执行前、权限检查之前触发。可 block（返回 deny 则工具不执行）。 */
  PreToolUse = "PreToolUse",
  /** 工具执行成功返回结果后触发。不可 block，仅可注入附加上下文。 */
  PostToolUse = "PostToolUse",
  /** 工具执行了但失败（返回错误或抛异常）后触发；权限拒绝走 PermissionDenied，不触发本事件。不可 block。 */
  PostToolUseFailure = "PostToolUseFailure",
  /** 用户输入提交后、入上下文前触发。可 block（原 prompt 不入上下文）。 */
  UserPromptSubmit = "UserPromptSubmit",
  /** 模型 end_turn 且无待执行工具后触发。不可 block，仅可请求清除上下文。 */
  AfterAgent = "AfterAgent",
  /** 每轮 LLM 请求发出前触发。可 block（阻止本次请求并结束循环）。 */
  BeforeModel = "BeforeModel",
  /** 每轮 LLM 响应收全后触发。可 block（丢弃响应并结束循环）。 */
  AfterModel = "AfterModel",
  /** 会话启动 / resume / `/clear` 之后 / 压缩之后触发（matcher：source = startup / resume / clear / compact）。stdout 进上下文，不可 block。 */
  SessionStart = "SessionStart",
  /** 会话退出前触发（exit / error / abort）。不可 block，超时即放弃。 */
  SessionEnd = "SessionEnd",
  /** 上下文压缩执行前触发。可 block（跳过本次压缩）。 */
  PreCompact = "PreCompact",
  /** 上下文压缩完成后触发。不可 block，异常也不影响压缩结果。 */
  PostCompact = "PostCompact",
  /** 子代理任务启动前触发。不可 block（block 降级为告警）。 */
  SubagentStart = "SubagentStart",
  /** 子代理任务结束后触发（finally）。不可 block，fire-and-forget。 */
  SubagentStop = "SubagentStop",
  /** TUI 等待权限确认时触发（matcher：permission_prompt；sid 没有空闲提醒，不发 idle_prompt）。仅通知。 */
  Notification = "Notification",
  /** 助手回答收尾、准备停止时触发。可 block（注入错误并重试修复）。 */
  Stop = "Stop",
  /** 轮次因 API 错误终止时触发（matcher：error_type）。仅通知。 */
  StopFailure = "StopFailure",
  /** 刻意不做：sid 没有 `--init` / `--maintenance`，此事件恒不触发。 */
  Setup = "Setup",
  /** 权限需用户确认时触发，与分类器、用户弹窗并行竞争、先到先决。可 block（返回 deny 则拒绝该工具）。 */
  PermissionRequest = "PermissionRequest",
  /** 权限拒绝后触发（主循环弹窗被拒 / 超时 / 规则直拒，子代理规则直拒 / 自动拒），仅通知、不可改判。 */
  PermissionDenied = "PermissionDenied",
  /** settings 文件被外部修改后触发（matcher：user_settings / project_settings / local_settings / policy_settings）。可 block（回退到变更前的设置，policy_settings 除外）。 */
  ConfigChange = "ConfigChange",
  /** 刻意不做：sid 没有监视任意文件的机制，此事件恒不触发。 */
  FileChanged = "FileChanged",
  /** bash `cd` 改变工作目录后触发。仅通知。 */
  CwdChanged = "CwdChanged",
  /** task_create 创建任务成功后触发。仅通知（sid 暂不支持 exit 2 回滚创建）。 */
  TaskCreated = "TaskCreated",
  /** task_update 把任务置为 completed 后触发。仅通知。 */
  TaskCompleted = "TaskCompleted",
  /** 预留（内部事件）：无 fire 方法也无调用点，恒不触发；用户配置会被跳过。原计划供 blocked_on_user span。 */
  BeforePermissionCheck = "BeforePermissionCheck",
  /** 预留（内部事件）：无 fire 方法也无调用点，恒不触发；用户配置会被跳过。 */
  AfterPermissionCheck = "AfterPermissionCheck",
  /** 预留（内部事件）：无 fire 方法也无调用点，恒不触发；用户配置会被跳过。原计划供 hook_execution span。 */
  BeforeHookExecution = "BeforeHookExecution",
  /** 预留（内部事件）：无 fire 方法也无调用点，恒不触发；用户配置会被跳过。 */
  AfterHookExecution = "AfterHookExecution",
  /** G11：指令加载到上下文（CLAUDE.md / rules 加载后触发） */
  InstructionsLoaded = "InstructionsLoaded",
  /** G11：团队代理空闲（可 block，用于团队协作场景） */
  TeammateIdle = "TeammateIdle",
  /** MCP server 发来 elicitation 请求、弹给用户之前触发（matcher：server 名）。仅通知。 */
  Elicitation = "Elicitation",
  /** 用户回复 MCP elicitation 之后触发（matcher：server 名）。仅通知。 */
  ElicitationResult = "ElicitationResult",
  /** 一批工具（含并行）全部执行完、结果回灌模型之前触发。仅通知。 */
  PostToolBatch = "PostToolBatch",
  /** 切换模型之前触发（matcher：trigger = manual / fallback / config）。仅通知（sid 切换路径同步，不支持拒绝）。 */
  PreModelSwitch = "PreModelSwitch",
  /** 模型切换之后触发，含降级链自动切换（matcher：trigger = manual / fallback / config）。仅通知。 */
  PostModelSwitch = "PostModelSwitch",
  /** 斜杠命令 / skill 展开成 prompt 之后、提交之前触发（matcher：命令名）。stdout 进上下文。 */
  UserPromptExpansion = "UserPromptExpansion",
  /** /add-dir 把目录加入会话白名单之后触发。仅通知。 */
  DirectoryAdded = "DirectoryAdded",
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
  post_tool_batch: HookEventName.PostToolBatch,
  pre_model_switch: HookEventName.PreModelSwitch,
  post_model_switch: HookEventName.PostModelSwitch,
  user_prompt_expansion: HookEventName.UserPromptExpansion,
  directory_added: HookEventName.DirectoryAdded,
};

/** 配置来源（优先级从高到低） */
export enum ConfigSource {
  Runtime = "runtime",
  /** 仓库内 `.sid-code/settings.json`——随 git clone 而来，过信任门 */
  Project = "project",
  /**
   * HC1：`.sid-code/settings.local.json`。未被 git 追踪 = 本机私有，与用户级同等可信；
   * 被追踪 = 随仓库分发，与 Project 一样过信任门（判据见 TrustManager.untrustedSettingsFiles）。
   */
  Local = "local",
  User = "user",
  Global = "global",
  /** 插件提供的 hook（可被 replacePluginHooks 原子替换） */
  Plugin = "plugin",
  /**
   * H27：来自企业 managed-settings（系统级托管配置）的 hook——allowManagedHooksOnly 唯一该放行的用户态来源。
   * 原先没有这个值，`Project`（仓库内 `.sid-code/settings.json`，随 git clone 而来、任何有 push 权限的人都能改）
   * 被拿来充数放行。⚠️ 目前尚无代码路径产生 Managed 源：开启 allowManagedHooksOnly 后只剩内部 runtime hook。
   */
  Managed = "managed",
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
  /**
   * CC exec 形式：有 args 时不经 shell，`[command, ...args]` 直接 spawn，路径占位符
   * （`${CLAUDE_PROJECT_DIR}` / `${CLAUDE_PLUGIN_ROOT}` …）在 command 与每个 arg 上做纯字符串替换。
   * 省略 = shell 形式（`sh -c command`，变量由 shell 从环境变量展开）。
   */
  args?: string[];
  timeout?: number;
  env?: Record<string, string>;
  /**
   * 来源相关的路径变量（插件根 / 插件数据目录 / skill 目录），由归一化层填。
   * runner 把它们导出为环境变量（shell 形式靠 shell 展开），exec 形式另做字符串替换。
   * 与 env 分开存：env 是用户写的，pathVars 是来源决定的，/hooks 面板展示时要区分。
   */
  pathVars?: Record<string, string>;
  async?: boolean;
  asyncRewake?: boolean;
  /** CC：hook 运行时显示的提示文案（TUI 经 HookSystem.onHookLifecycle 显示在状态行） */
  statusMessage?: string;
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
  statusMessage?: string;
  source?: ConfigSource;
}

/** Prompt Hook 配置（LLM 验证） */
export interface PromptHookConfig {
  type: "prompt";
  name?: string;
  prompt: string;
  model?: string;
  timeout?: number;
  statusMessage?: string;
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
  statusMessage?: string;
  source?: ConfigSource;
}

/** Runtime Hook 配置（函数式，仅内部代码可注册） */
export interface RuntimeHookConfig {
  type: "runtime";
  name: string;
  action: (input: HookInput, options?: { signal: AbortSignal }) => Promise<HookOutput | void>;
  /** 超时（秒），与其他四种类型同单位。H10：原先 runtime 这一个字段按毫秒解释，同一个 1 差 1000 倍 */
  timeout?: number;
  /** 亚秒级超时（毫秒），内部代码专用，优先于 timeout。单位写进字段名，不再靠注释约定 */
  timeoutMs?: number;
  source?: ConfigSource;
}

export type HookConfig =
  | CommandHookConfig
  | UrlHookConfig
  | RuntimeHookConfig
  | PromptHookConfig
  | AgentHookConfig;

/**
 * H10：`timeout` 字段的单位与缺省值的唯一事实源。五种类型统一按**秒**解释。
 * runner 的五个执行分支与企业策略的 maxHookTimeout 判定都调它——原先五处各写一遍换算，
 * runtime 那处漏乘 1000，日志里各自的「超时 (1s)」「超时 (1ms)」都对，单看任何一条都看不出不一致。
 *
 * 缺省值按 Q5 裁决对齐 CC（HC20）：command / url(http) 600s、prompt 30s、agent 60s；
 * UserPromptSubmit 上的 command / url 30s；SessionStart 上的 command / url 30s（偏离 CC：
 * SessionStart 在第一轮之前同步等待，挂住的 hook 让启动卡 10 分钟会被当成 sid 卡死）。
 * 不传 eventName（企业策略判定）时按事件无关的缺省值算——它比的是「这条 hook 最多能跑多久」。
 * 用户显式写的 timeout 一律优先。SessionEnd 的共享预算不在这里，见 SESSION_END_BUDGET_MS。
 */
export function resolveHookTimeoutMs(hook: HookConfig, eventName?: string): number {
  if (hook.type === "runtime" && typeof hook.timeoutMs === "number") return hook.timeoutMs;
  if (typeof hook.timeout === "number") return hook.timeout * 1000;
  return defaultHookTimeoutSeconds(hook.type, eventName) * 1000;
}

/** 缺省超时（秒），见 resolveHookTimeoutMs 注释 */
export function defaultHookTimeoutSeconds(type: HookConfig["type"], eventName?: string): number {
  if (type === "prompt") return 30;
  if (type === "agent") return 60;
  if (type === "runtime") return 60;
  if (eventName === HookEventName.UserPromptSubmit || eventName === HookEventName.SessionStart) {
    return 30;
  }
  return 600;
}

/**
 * SessionEnd 所有 hook 共享的时间预算（对齐 CC）：缺省 1.5s；某条 hook 显式配了更长的 timeout 时
 * 预算提高到它的值，上限 60s。退出路径上不能让一个慢 hook 把关窗口卡住。
 */
export const SESSION_END_BUDGET_MS = { default: 1500, max: 60_000 } as const;

export function sessionEndBudgetMs(hooks: HookConfig[]): number {
  let budget: number = SESSION_END_BUDGET_MS.default;
  for (const h of hooks) {
    if (h.type !== "runtime" && typeof h.timeout === "number") {
      budget = Math.max(budget, h.timeout * 1000);
    }
  }
  return Math.min(budget, SESSION_END_BUDGET_MS.max);
}

/**
 * 生成 hook 内容 key（用于去重）。
 *
 * H19：这是**内容**去重，刻意不含 matcher / if——同一条命令经两个都命中的 matcher（或 if）进来，
 * 本次事件只跑一次，这是语义而不是 bug。正确性依赖「planner 先按 matcher / if 过滤、再去重」
 * 的顺序：过滤掉的条目不参与去重，所以「A 的 if 不命中、B 的 if 命中」时留下的一定是 B。
 * 这个顺序由 tests/hook/hook-p3-*.test.ts 锁住，改 planner 时别把去重挪到过滤之前。
 *
 * 但 key 必须覆盖**执行内容**：prompt / agent 原先只用 `rt:${name}`，两个未命名的 prompt hook
 * key 相同、后一个被静默丢弃——内容不同却被当成同一个 hook。
 */
export function getHookKey(hook: HookConfig): string {
  const name = hook.name || "";
  if (hook.type === "command") return `cmd:${name}:${hook.command}`;
  if (hook.type === "url") return `url:${name}:${hook.url}`;
  if (hook.type === "prompt" || hook.type === "agent") {
    return `${hook.type}:${name}:${hook.model ?? ""}:${hook.prompt}`;
  }
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
  /**
   * 当前权限模式，取 CC 的取值（HC11）：default / acceptEdits / plan / dontAsk / auto / bypassPermissions。
   * sid 原值另放 sid_permission_mode（always-allow 与 deny-write 在 CC 里没有对应）。
   */
  permission_mode?: string;
  sid_permission_mode?: string;
  /** 会话对话记录文件（sid 的会话 jsonl），对齐 CC transcript_path */
  transcript_path?: string;
  /** 每次用户提交生成一个 UUID，同一轮里的所有事件共用（对齐 CC prompt_id） */
  prompt_id?: string;
  /** M1 本机持久 deviceId。四方落盘共用，未配置 identity 时仍有值。 */
  device_id?: string;
  user_id?: string;
  org_id?: string;
  team_id?: string;
}

/**
 * CC 规定：工具事件在子代理里触发时带 agent_id / agent_type（主循环不带）。
 * 不放进 HookInput 基础字段：基础字段由 createBaseInput 统一组装、与「在哪条执行链上」无关，
 * 而这两个字段恰恰只由执行链决定，由各工具事件 fire 方法按调用方传入的 agent 条件展开。
 */
export interface HookAgentFields {
  agent_id?: string;
  agent_type?: string;
}

/** 子代理执行链身份（工具事件 fire 方法的可选入参，见 HookAgentFields） */
export interface HookAgentRef {
  agent_id: string;
  agent_type: string;
}

/** PreToolUse 输入 */
export interface PreToolUseInput extends HookInput, HookAgentFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** LLM 分配的工具调用 ID，用于关联 action↔observation */
  tool_use_id?: string;
}

/** Q7：工具失败成因 */
export type ToolFailureKind = "tool_error" | "exception" | "validation" | "hook_blocked";

/** PostToolUse 输入 */
export interface PostToolUseInput extends HookInput, HookAgentFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  is_error?: boolean;
  /** PostToolUseFailure：顶层错误信息（CC 字段，HC12；tool_response.error 保留） */
  error?: string;
  /** PostToolUseFailure：是否因用户中断而失败（CC 字段） */
  is_interrupt?: boolean;
  /**
   * Q7：sid 内部字段，失败成因。只有 tool_error / exception 会送到用户 hook（CC 语义）；
   * validation / hook_blocked 只送 runtime hook（关 execute_tool span 用，见 event-handler）。
   * 内部消费者据此保持切换前的口径（session-metrics 只数 tool_error，与原先「PostToolUse 带 is_error」等价）。
   */
  sid_failure_kind?: ToolFailureKind;
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
    /**
     * 本次请求解析后的**思考开关**（内部表示，非 wire body）。
     *
     * ## 为什么要采（2026-08-17 的教训，代价是整整一轮方向被带偏）
     *
     * 排查 GLM-5.3 的 400「该模型始终思考」时，查 `raw.jsonl` 得到
     * `thinking=None reasoning_effort=None`，据此判定"两个字段都没下发"，
     * 于是一路查到"模型未注册 → 能力退化"这个**错误根因**上。
     *
     * 真相是：**这个采集点的 schema 里从来就没有这两个字段位**。
     * "没在这里出现"被读成了"没发到线上"—— 仪器空洞被当成了事实。
     * 补上字段位，下次同类问题不必再靠 `bun -e` 重放生产序列化函数才能定位。
     *
     * ## ⚠ 它是**内部表示**，不是线上请求体，两者不可互推
     *
     * 真正发到线上的形状由各族方言决定：`{enabled:false}` 在 GLM/DeepSeek 线上
     * 序列化成 `thinking:{type:"disabled"}`，在 Grok/o-series 线上**根本不发**，
     * 在恒思考模型上（见 `dialect/always-thinking.ts`）会被降级为不发。
     * 判"线上到底发了什么"仍需看 provider 侧，别拿这个字段当 wire body 的替身 ——
     * 那正是上面那个坑的同型错误。
     *
     * ## ⚠ 覆盖面：side-call **不经过**本 hook
     *
     * 压缩 / 目标评估 / 工具分类 / 记忆召回这些辅助调用是影子调用，不触发
     * BeforeModel（见 `trace/side-call-sink.ts` 的模块注释）。而 2026-08-17 那 11 次
     * 400 恰恰**全部来自 side-call** —— 所以本字段能防的是"下次别再把仪器空洞当事实"，
     * **不是**"下次能直接看到那 11 次请求"。side-call 的请求参数采集是另一个缺口。
     */
    thinking?: { enabled: boolean; budgetTokens?: number };
    /** 本次请求解析后的推理强度档位（内部表示，注意事项同 `thinking`） */
    reasoning_effort?: string;
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
    /**
     * P2-6：网关下发的请求标识（`{ header, value }`），供怀疑"网关在排队/限流/丢包"时
     * 拿去找网关方核对**具体是哪一次请求**。
     *
     * 头名必须与值一起留：本仓两族网关的头名不同（`x-oneapi-request-id` /
     * `x-shellapi-request-id`），只留值就分不清该找哪一方对账。
     * 缺席 = 该端点没下发这类头（合法情况，不要填空串）。
     */
    gateway_request_id?: { header: string; value: string };
  };

  // ── Harness 扩展点 ──
  /** Harness 每轮上下文 */
  harness_context?: HarnessHookContext;
}

/** SessionStart 输入 */
export interface SessionStartInput extends HookInput {
  /**
   * 对齐 CC：startup / resume / clear（/clear 之后）/ compact（压缩之后）。
   * clear / compact 两次只发给用户 hook（userOnly），runtime 消费者（collector / hook-probe）
   * 把 SessionStart 当「开新轨迹 / 新 invoke_agent span」，再收一次会把同一会话劈成两段。
   */
  source: "startup" | "resume" | "clear" | "compact";
  /** 当前使用的模型 */
  model?: string;
  /** system prompt 的 MD5 hash */
  system_prompt_hash?: string;
  /** Bug3 桥接：source="resume" 时携带被恢复的旧会话 id，使 trajectory 能反查对话历史。 */
  resumed_from?: string;
  /**
   * sid-code 自身版本号（`getRawVersion()` 的裸 x.y.z，如 "0.1.601"）。
   *
   * 北极星四方向的第 3 级都是「release-over-release 曲线」，而**版本是那条曲线唯一的维度**。
   * 在此之前轨迹里一个版本字段都没有（`session.traj` 的 metadata 47 个键含 `ver` 的 0 个），
   * 于是任何指标都归属不到某个 release —— 能力从来不缺（`getRawVersion()` 一直可用），
   * 缺的是没人把它写进采集链。
   *
   * 可选而非必填：hook input 可能由旧版本或测试构造，消费侧（collector）自己兜底取真值。
   */
  app_version?: string;
}

/** SessionEnd 输入 */
export interface SessionEndInput extends HookInput {
  reason: "exit" | "clear" | "other" | "error" | "abort";
  /**
   * sid-code 自身版本号，语义同 `SessionStartInput.app_version`。
   *
   * 两端都记的理由：版本在一个进程内恒定（不像 `/model` 可中途切换），
   * 两端都写是为了让**只有 SessionEnd 存活**的会话也能归因 ——
   * 实测本机 `SessionStart 55 : SessionEnd 25`，两侧都有缺失，靠单端会丢样本。
   */
  app_version?: string;
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
  /** 子代理最后一条 assistant 文本（CC 字段）。拿不到（如中途异常、spawn 无结果退出）时缺省 */
  last_assistant_message?: string;
  /** 子代理 sidechain 对话记录 jsonl 路径（CC 字段）。sidechain 未启用 / 未落盘时缺省 */
  agent_transcript_path?: string;
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
  /** 模型最后一次回复的文本（sid 旧字段名，保留） */
  assistant_response: string;
  /** 同上，CC 字段名（HC12） */
  last_assistant_message: string;
  /** 本次 Stop 是否由之前的 Stop hook 回炉引起（CC 字段，HC12）：hook 据此避免无限回炉 */
  stop_hook_active: boolean;
}

/** StopFailure 事件输入（API 错误导致的非正常结束） */
export interface StopFailureInput extends HookInput {
  error: string;
  /** 取值对齐 CC 的 StopFailure matcher（rate_limit / authentication_failed / billing_error /
   *  invalid_request / server_error / max_output_tokens / unknown），另保留 sid 原有的
   *  api_error / context_overflow / abort / timeout */
  error_type:
    | "rate_limit"
    | "authentication_failed"
    | "billing_error"
    | "invalid_request"
    | "server_error"
    | "max_output_tokens"
    | "timeout"
    | "api_error"
    | "context_overflow"
    | "abort"
    | "unknown";
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
export interface PermissionDeniedInput extends HookInput, HookAgentFields {
  /** Q7：供 runtime 消费者关闭对应的 execute_tool span */
  tool_use_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  denial_reason: string;
  denial_source: "user" | "rule" | "hook" | "auto";
}

/** ConfigChange 输入 */
export interface ConfigChangeInput extends HookInput {
  changed_keys: string[];
  /** 对齐 CC 的 ConfigChange matcher：user_settings / project_settings / local_settings /
   *  policy_settings；旧值 file / command / env 保留兼容 */
  source:
    | "user_settings"
    | "project_settings"
    | "local_settings"
    | "policy_settings"
    | "file"
    | "command"
    | "env";
  /** 变更的文件路径（文件来源时有） */
  file_path?: string;
}

/** FileChanged 输入 */
export interface FileChangedInput extends HookInput {
  file_path: string;
  change_type: "created" | "modified" | "deleted";
}

/** CwdChanged 输入 */
export interface CwdChangedInput extends HookInput, HookAgentFields {
  old_cwd: string;
  new_cwd: string;
}

/** TaskCreated 输入 */
export interface TaskCreatedInput extends HookInput, HookAgentFields {
  task_id: string;
  task_description: string;
}

/** TaskCompleted 输入 */
export interface TaskCompletedInput extends HookInput, HookAgentFields {
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
/** Elicitation / ElicitationResult 共有：发起请求的 MCP server（matcher 按它匹配） */
export interface ElicitationServerField {
  mcp_server_name?: string;
}

/** PostToolBatch 输入 */
export interface PostToolBatchInput extends HookInput {
  /** 本批每个工具的结果摘要（tool_name 为内部名，外部 handler 不做换名——它是数组） */
  tool_calls: Array<{ tool_name: string; tool_use_id: string; is_error: boolean }>;
}

/** PreModelSwitch / PostModelSwitch 输入 */
export interface ModelSwitchInput extends HookInput {
  from_model: string;
  to_model: string;
  /** manual = /model；fallback = 降级链自动切换；config = CLAUDE.md `# Model` 等配置驱动 */
  trigger: "manual" | "fallback" | "config";
  /** fallback 时的降级原因 */
  reason?: string;
}

/** UserPromptExpansion 输入 */
export interface UserPromptExpansionInput extends HookInput {
  /** 触发展开的命令名（不带 /） */
  command_name: string;
  /** 用户原始输入（如 `/commit -m x`） */
  original_prompt: string;
  /** 展开后的 prompt */
  expanded_prompt: string;
}

/** DirectoryAdded 输入 */
export interface DirectoryAddedInput extends HookInput {
  directory: string;
}

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
export function createHookOutput(
  eventName: HookEventName,
  data: Partial<HookOutput>,
): DefaultHookOutput {
  switch (eventName) {
    // H3：PermissionRequest 与 PreToolUse 同为工具类决策事件（输入都有 tool_name + tool_input），
    // 必须认同一套 permissionDecision 协议。原先落到 default 拿父类，`permissionDecision:"deny"` 不算阻塞。
    case HookEventName.PreToolUse:
    case HookEventName.PermissionRequest:
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
    task_type?: string; // "read_only" | "single_file_edit" | "multi_file_edit" | ...
    risk_level?: string; // "low" | "medium" | "high" | "critical"
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
  runtime_mode?: string; // "local-inline" | "managed-worktree" | "sandbox-remote"
  runtime_id?: string; // worktree/sandbox 实例 ID
  /** Phase 4: 候选并行 */
  candidate_id?: string;
  candidate_total?: number;
  /** 通用扩展 */
  extra?: Record<string, unknown>;
}

/** Harness 编辑元数据——附加在 PostToolUseInput 上（仅 edit/write 工具） */
export interface HarnessEditMeta {
  protocol?: string; // "replace" | "hashline" | "hybrid"
  first_pass_success?: boolean;
  retry_count?: number;
  match_strategy?: string; // "exact" | "flexible" | "regex" | "fuzzy"
  hashline_address?: string; // hashline 地址（如 "42:k9f2"）
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
