/**
 * 斜杠命令系统的核心类型
 * 用户在交互式模式下输入 /xxx 即可触发对应的命令
 *
 * 本文件包含两套类型体系：
 * 1. 旧体系（Command / CommandResult / AppContext）—— 方法式接口，标记 deprecated，
 *    通过 src/command/adapter.ts 桥接到新体系，迁移期间保留可用
 * 2. 新体系（UnifiedCommand）—— 判别联合类型（local / local-jsx / prompt），
 *    对齐 Claude Code 命令系统架构，支持延迟加载、多来源聚合、命令队列
 */

import type { ReactNode } from "react";
import type { Config } from "../config/config.ts";
import type { Manager as ContextManager } from "../context/manager.ts";
import type { Provider } from "../llm/provider.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { LanguagePref } from "../config/prompt-lang.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { SessionState } from "../session/state.ts";
import type { MCPManager } from "../mcp/manager.ts";
import type { HookSystem } from "../hook/system.ts";

// ============================================================
// 旧体系（deprecated，迁移期间保留）
// ============================================================

/**
 * 应用上下文 - 将应用内部状态暴露给命令
 * @deprecated 新命令请使用 {@link CommandContext}，旧命令通过 adapter.ts 桥接
 */
export interface AppContext {
  ctxMgr: ContextManager;
  registry: ToolRegistry;
  config: Config;
  sessionId: string;
  /**
   * 逻辑会话 id（resume 时=被恢复会话 id，否则=本进程会话 id），用于 checkpoint 归属。
   * /undo 等回滚命令须用它，才能在 `-c` 恢复后够到 resume 之前的检查点。
   * 缺省时回退 sessionState.sessionId。
   */
  checkpointSessionId?: string;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  mcpManager?: MCPManager;
  setModel: (model: string, persist?: boolean) => void;
  /** 切换 fallback 模型（/model fallback 用）。persist=true 时写 settings.json。 */
  setFallbackModel?: (model: string | undefined, persist?: boolean) => void;
  /** 切换子代理模型（/model sub 用）。persist=true 时写 settings.json。 */
  setSubAgentModel?: (type: string, model: string | undefined, persist?: boolean) => void;
  /** 推理强度旋钮 setter（/effort 用）。persist=true 时写 settings.json。 */
  setEffort?: (level: import("../llm/effort.ts").EffortSetting, persist?: boolean) => void;
  /** 思考开关旋钮 setter（/think 用）。persist=true 时写 settings.json。 */
  setThinking?: (setting: import("../llm/effort.ts").ThinkingSetting, persist?: boolean) => void;
  /** 输出语言 setter（/language 用）。persist=true 时写 settings.json；lang=undefined 回退默认。 */
  setLanguage?: (lang: LanguagePref | undefined, persist?: boolean) => void | Promise<void>;
  /** Vim 输入模式 setter（/vim 用）。persist=true 时写 settings.json vimMode。 */
  setVimMode?: (enabled: boolean, persist?: boolean) => void;
  /** 读取当前 Vim 输入模式开关（/vim 无参 toggle 时用）。 */
  getVimMode?: () => boolean;
  /**
   * M2：auto-memory 后台提取开关 setter（/memory auto 用）。
   * 运行时热接线/断线后台提取；persist=true 时写 settings.json autoMemory。
   */
  setAutoMemory?: (enabled: boolean, persist?: boolean) => void | Promise<void>;
  /** M2：读取当前 auto-memory 运行时启用态（/memory auto status 用）。 */
  getAutoMemoryState?: () => { enabled: boolean; source: "env" | "settings" | "default" };
  /**
   * M4-5：CLAUDE.md 外部 @import 审批 setter（/memory external allow|deny 用）。
   * 持久化批准位到 project 级 config；allow 时重载 CLAUDE.md 展开外部导入并重建系统提示词。
   */
  setExternalImportsApproved?: (approved: boolean) => void | Promise<void>;
  /** M4-5：读取当前外部导入审批态（/memory external status 用）。undefined=尚未询问。 */
  getExternalImportsState?: () => { approved: boolean | undefined };
  /** 自定义状态栏 setter（/statusline 用，P1-5）。config=undefined 禁用；persist=true 写 settings.json。 */
  setStatusLine?: (config: import("../ui/statusline/run-statusline.ts").StatusLineConfig | undefined, persist?: boolean) => void;
  /** 读取当前自定义状态栏配置（/statusline 展示/toggle 用）。 */
  getStatusLine?: () => import("../ui/statusline/run-statusline.ts").StatusLineConfig | undefined;
  /** 会话重命名（/rename 用）。name 为空时基于上下文生成。返回最终名字。 */
  renameSession?: (name?: string) => string | Promise<string>;
  /** 读取当前 effort 运行时态 + 能力（/effort 展示用） */
  getEffortState?: () => {
    runtime: import("../llm/effort.ts").EffortSetting;
    applied: import("../llm/effort.ts").EffortLevel | undefined;
    isAuto: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  /** 读取当前 thinking 运行时态 + 能力（/think 展示用） */
  getThinkingState?: () => {
    runtime: import("../llm/effort.ts").ThinkingSetting;
    applied: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  exitRequested: boolean;
  sessionState: SessionState;
  /** 将文本注入对话并触发 LLM 响应（自定义命令用） */
  sendToLLM?: (text: string) => Promise<void>;
  /** 自定义命令列表（/help 显示用） */
  customCommands?: Array<{ name: string; description: string }>;
  /** Shell 注入确认回调（自定义命令 !{cmd} 语法用），返回 true 表示用户确认 */
  confirmShellCommands?: (commands: string[]) => Promise<boolean>;
  /**
   * P0-3：通用用户确认回调（skill 权限 ask 决策用），返回 true 表示用户批准。
   * 用户斜杠路径的 skill 若含敏感能力（hooks/allowedTools/shell）触发 ask 时，弹此确认。
   */
  requestUserConfirmation?: (desc: string) => Promise<boolean>;
  /**
   * P0-3：原始权限规则（permissions.allow/deny/ask，含 `Skill(<name>)` 形态）。
   * 经 toCommandContext 桥接给新体系，供 skill 授权判定使用。
   */
  permissionRules?: import("../permission/types.ts").PermissionRule;
  /** Hook 系统引用（/hooks 命令用） */
  hookSystem?: HookSystem;
  /**
   * §12 P2-4 复审：最近访问文件追踪器（手动 /compact 压缩后重注入最近读过的文件）。
   * 经 toCommandContext 桥接到 CommandContext.fileReadTracker。
   */
  fileReadTracker?: import("../tool/file-read-tracker.ts").FileReadTracker;
  /** §12 P2-4 复审：会话级临时目录（手动压缩质量报告落盘）。经 toCommandContext 桥接。 */
  sessionDir?: string;
  /** 命令注册表引用（/reload-plugins 重新合并插件命令用） */
  commandRegistry?: import("./registry.ts").Registry;
  /**
   * Skill 管理器引用（/reload-plugins 刷新插件 skills 用）。
   * §18.10：插件带的 skills 需随插件安装/卸载原子替换，否则装了新插件要重启才能用它的
   * skill、卸载后旧 skill 还留着。
   */
  skillManager?: import("../skill/manager.ts").SkillManager;
  /** 统一命令注册表引用（新体系 /reload-plugins 刷新插件命令用，优先于 commandRegistry） */
  unifiedRegistry?: import("./unified-registry.ts").UnifiedCommandRegistry;
  /** /goal：读取当前目标状态 */
  getGoalState?: () => import("../goal/state.ts").GoalState | null;
  /** /goal：设置目标状态（null 表示清除） */
  setGoalState?: (goal: import("../goal/state.ts").GoalState | null) => void;
  /** /goal：更新目标状态（原地修改） */
  updateGoalState?: (updater: (goal: import("../goal/state.ts").GoalState) => void) => void;
  /** 轨迹采集器（可选，trace.enabled=false 时为 undefined）—— /debug 命令用 */
  traceCollector?: import("../trace/collector.ts").TraceCollector;
  /** 权限检查器实例（/allow /deny /add-dir /permissions 用；运行时注入，可能为 null） */
  permissionChecker?: import("../permission/types.ts").Checker | null;
}

/** 支持的对话框类型 */
export type DialogType =
  | "model"
  | "theme"
  | "settings"
  | "onboarding"
  | "mcp"
  | "effort"
  | "think"
  | "permissions"
  | "memory"
  | "config"
  | "hooks"
  | "stats"
  | "skills"
  | "agents"
  | "commands"
  | "help"
  | "export"
  | "context"
  | "rewind"
  | "claude-md-external-imports";

/** 命令执行结果类型 */
export type CommandResultKind =
  | "message"        // 显示文本消息
  | "submit_prompt"  // 将文本提交给 LLM
  | "clear"          // 清空对话
  | "quit"           // 退出程序
  | "confirm"        // 需要用户确认
  | "dialog"         // 打开交互式对话框
  | "error";         // 错误信息

export interface CommandResult {
  kind: CommandResultKind;
  message?: string;  // kind=message/error/confirm 时的文本
  prompt?: string;   // kind=submit_prompt 时的提示词
  /** kind=confirm 时的确认回调 */
  onConfirm?: () => Promise<CommandResult>;
  /** kind=dialog 时指定打开哪个对话框 */
  dialog?: DialogType;
}

/**
 * 命令接口 - 所有斜杠命令必须实现
 * @deprecated 新命令请直接定义为 {@link UnifiedCommand}，旧命令通过 adaptLegacyCommand 桥接
 */
export interface Command {
  name(): string;
  aliases(): string[];
  description(): string;
  /** 参数提示（可选，展示在 /commands 面板；如 "<zh|en|auto> [-p]"） */
  argumentHint?(): string;
  /** 子命令列表（可选） */
  subCommands?(): Command[];
  execute(args: string, ctx: AppContext): Promise<CommandResult>;
}

// ============================================================
// 新体系：命令来源
// ============================================================

export type CommandSource =
  | "builtin"       // 内置命令
  | "user"          // 用户自定义（~/.sid-code/commands/）
  | "project"       // 项目自定义（.sid-code/commands/）
  | "skill"         // Skill 系统
  | "plugin"        // 插件（带 pluginName: 前缀）
  | "mcp";          // MCP 服务器

// ============================================================
// 新体系：命令上下文（替代 AppContext，更精简）
// ============================================================

export interface CommandContext {
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  config: Config;
  sessionId: string;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  mcpManager?: MCPManager;
  sessionState: SessionState;
  hookSystem?: HookSystem;
  cwd: string;
  /**
   * §12 P2-4 复审：最近访问文件追踪器。手动 /compact 压缩后据它重注入最近读过的文件
   * （与自动压缩共用 query/compact/post-compact.ts 的收尾）。未注入则跳过文件恢复。
   */
  fileReadTracker?: import("../tool/file-read-tracker.ts").FileReadTracker;
  /**
   * §12 P2-4 复审：会话级临时目录。手动压缩的摘要质量报告落盘到此；未注入则只算不落盘。
   */
  sessionDir?: string;
  /**
   * 切换主模型回调。persist=true 时同时写 settings.json 顶层 model（跨会话生效）。
   * 对齐 /effort 的 -p 语义：默认仅当会话生效，-p 才落盘。
   */
  setModel?: (model: string, persist?: boolean) => void;
  /**
   * 切换 fallback 模型回调（/model fallback 用）。model=undefined 表示清除 fallback。
   * persist=true 时写 settings.json 顶层 fallbackModel。
   */
  setFallbackModel?: (model: string | undefined, persist?: boolean) => void;
  /**
   * 切换子代理模型回调（/model sub 用）。model=undefined 表示清除该类型映射（回退 default/主模型）。
   * persist=true 时写 settings.json subAgentModels[type]。
   */
  setSubAgentModel?: (type: string, model: string | undefined, persist?: boolean) => void;
  /**
   * 推理强度旋钮 setter（/effort 用）。level=undefined 表示 auto。
   * persist=true 时同时写 settings.json（跨会话生效）。
   */
  setEffort?: (level: import("../llm/effort.ts").EffortSetting, persist?: boolean) => void;
  /**
   * 思考开关旋钮 setter（/think 用）。setting=undefined 表示 auto。
   * persist=true 时同时写 settings.json。
   */
  setThinking?: (setting: import("../llm/effort.ts").ThinkingSetting, persist?: boolean) => void;
  /** 输出语言 setter（/language 用）。persist=true 时写 settings.json；lang=undefined 回退默认。 */
  setLanguage?: (lang: LanguagePref | undefined, persist?: boolean) => void | Promise<void>;
  /**
   * Vim 输入模式 setter（/vim 用）。写运行时态让状态栏即时反映；
   * persist=true 时写 settings.json vimMode（跨会话生效）。
   */
  setVimMode?: (enabled: boolean, persist?: boolean) => void;
  /** 读取当前 Vim 输入模式开关（/vim 无参 toggle 时用）。 */
  getVimMode?: () => boolean;
  /** 自定义状态栏 setter（/statusline 用，P1-5）。config=undefined 禁用；persist=true 写 settings.json。 */
  setStatusLine?: (config: import("../ui/statusline/run-statusline.ts").StatusLineConfig | undefined, persist?: boolean) => void;
  /** 读取当前自定义状态栏配置（/statusline 展示/toggle 用）。 */
  getStatusLine?: () => import("../ui/statusline/run-statusline.ts").StatusLineConfig | undefined;
  /**
   * 会话重命名（/rename 用）。写 session_name 元数据（跨 resume 生效）并更新状态栏/终端标题。
   * name 为空时由实现方基于上下文生成一个名字（复用标题生成启发式）。返回最终生效的名字。
   */
  renameSession?: (name?: string) => string | Promise<string>;
  /** 读取当前 effort/thinking 运行时态 + 能力描述（/effort、/think 无参时展示用） */
  getEffortState?: () => {
    runtime: import("../llm/effort.ts").EffortSetting;
    applied: import("../llm/effort.ts").EffortLevel | undefined;
    isAuto: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  getThinkingState?: () => {
    runtime: import("../llm/effort.ts").ThinkingSetting;
    applied: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  /** 将文本注入对话并触发 LLM 响应 */
  sendToLLM?: (text: string) => Promise<void>;
  /** Shell 注入确认回调，返回 true 表示用户确认 */
  confirmShellCommands?: (commands: string[]) => Promise<boolean>;
  /**
   * P0-3：通用用户确认回调（skill 权限 ask 决策用），返回 true 表示用户批准。
   * 用户斜杠路径的 skill 若含敏感能力（hooks/allowedTools/shell 等）触发 ask 时弹此确认。
   * 未注入时 ask 决策会保守拒绝（不静默放行）。
   */
  requestUserConfirmation?: (desc: string) => Promise<boolean>;
  /**
   * P0-3：原始权限规则（permissions.allow/deny/ask，含 `Skill(<name>)` 形态）。
   * 供 skill 授权判定使用——注意必须是**原始规则**而非子代理 checker，
   * 否则 ask 会被 dontAsk 语义直接降级为 deny。
   */
  permissionRules?: import("../permission/types.ts").PermissionRule;
  /**
   * 权限检查器（fork 子代理内的工具权限判定沿用主会话规则）。
   * 注意与 permissionRules 的分工：checker 用于**工具调用**判定（子代理内 dontAsk 语义），
   * permissionRules 用于 skill 自身的 allow/deny/ask 判定（需要原始规则，不能被 checker 降级）。
   */
  permissionChecker?: import("../permission/types.ts").Checker | null;
  /** 自定义命令摘要（/help 显示用） */
  customCommands?: Array<{ name: string; description: string }>;
  /** 统一命令注册表引用（/reload-plugins 刷新插件命令用） */
  unifiedRegistry?: import("./unified-registry.ts").UnifiedCommandRegistry;
  /** /goal：读取当前目标状态 */
  getGoalState?: () => import("../goal/state.ts").GoalState | null;
  /** /goal：设置目标状态（null 表示清除） */
  setGoalState?: (goal: import("../goal/state.ts").GoalState | null) => void;
  /** /goal：更新目标状态（原地修改） */
  updateGoalState?: (updater: (goal: import("../goal/state.ts").GoalState) => void) => void;
  /** 轨迹采集器（可选，trace.enabled=false 时为 undefined）—— /debug 命令用 */
  traceCollector?: import("../trace/collector.ts").TraceCollector;
}

// ============================================================
// 新体系：命令基础属性（所有命令共享）
// ============================================================

export interface CommandBase {
  // === 身份标识 ===
  name: string;                       // 命令名（唯一标识，如 "compact"）
  aliases?: string[];                 // 别名（如 ["q"] 对应 /exit）
  description: string;                // 描述（显示在补全列表和 /help 中）
  argumentHint?: string;              // 参数提示（如 "session-id"）

  // === 可见性控制 ===
  isEnabled?: () => boolean;          // 运行时条件门控（feature flag 等）
  isHidden?: boolean;                 // 从补全列表/help 中隐藏

  // === 调用控制 ===
  userInvocable?: boolean;            // 用户能否通过 /name 调用（false = 仅模型可用）
  disableModelInvocation?: boolean;   // 模型能否通过 SkillTool 调用
  immediate?: boolean;                // 是否绕过队列立即执行（模型运行时可用）
  requiresArgs?: boolean;             // 无参数就无法工作（如 /btw）。true = 补全列表回车仅回填等待输入；
                                      // 默认 false = 补全列表回车直接执行（无参开对话框/显示状态的命令）

  // === 来源追踪 ===
  source?: CommandSource;             // 来源标记

  // === 模型集成 ===
  whenToUse?: string;                 // 告诉模型何时应该使用此命令

  // === 子命令 ===
  subCommands?: () => UnifiedCommand[];
}

// ============================================================
// 新体系：三种命令变体
// ============================================================

/** local 命令：同步执行，返回文本/压缩结果/跳过 */
export interface LocalCommand {
  type: "local";
  load: () => Promise<LocalCommandModule>;
}

export interface LocalCommandModule {
  call(args: string, ctx: CommandContext): Promise<LocalCommandResult>;
}

export type LocalCommandResult =
  | { type: "text"; value: string }           // 显示文本
  | { type: "compact"; summary: string }      // 上下文压缩结果
  | { type: "skip" }                          // 静默完成
  | { type: "clear" }                         // 清空对话
  | { type: "quit"; message?: string }        // 退出程序
  | { type: "dialog"; dialog: DialogType }    // 打开交互式对话框
  | { type: "submit_prompt"; prompt: string } // 将文本提交给 LLM
  | { type: "confirm"; message: string; onConfirm: () => Promise<LocalCommandResult> }; // 需要用户确认

/** local-jsx 命令：渲染 Ink 交互式 UI */
export interface LocalJSXCommand {
  type: "local-jsx";
  load: () => Promise<LocalJSXCommandModule>;
}

export interface LocalJSXCommandModule {
  call(
    onDone: LocalJSXCommandOnDone,
    ctx: CommandContext,
    args: string,
  ): Promise<ReactNode | null>;
}

export type LocalJSXCommandOnDone = (
  result?: string,
  options?: LocalJSXDoneOptions,
) => void;

export interface LocalJSXDoneOptions {
  display?: "skip" | "system" | "user";   // 结果如何显示
  shouldQuery?: boolean;                   // 完成后是否触发模型调用
  nextInput?: string;                      // 链式命令：设置下一个输入
  submitNextInput?: boolean;               // 链式命令：自动提交下一个输入
}

/** prompt 命令：生成 prompt 注入对话，触发模型调用 */
export interface PromptCommand {
  type: "prompt";
  context?: "inline" | "fork";             // inline=当前对话展开，fork=子代理执行
  getPromptForCommand(
    args: string,
    ctx: CommandContext,
  ): Promise<string>;
  allowedTools?: string[];                 // 限制模型可用的工具集（fork 模式）
  maxTurns?: number;                       // 最大轮次（fork 模式）
  timeoutMins?: number;                    // 子代理超时(分钟，fork 模式)；默认 2，最大 30
  /**
   * 来源 skill 定义（仅 skill 适配出的 prompt 命令有）。
   *
   * 为什么要挂在命令上：TUI 的斜杠命令执行走 UnifiedCommandRegistry → CommandExecutor，
   * 这是用户调用 skill 的**真实路径**。skill 的权限判定（P0-3）、生命周期 hooks（P0-2）、
   * effort/agent 透传（P1-1）都需要原始 SkillDefinition，而 PromptCommand 只携带
   * prompt/allowedTools/maxTurns 等投影字段，信息不足。挂原定义让 executor 能复用
   * skill/executor.ts 的同一套内核，避免两条路径实现漂移。
   */
  skill?: import("../skill/types.ts").SkillDefinition;
}

// ============================================================
// 新体系：统一命令类型 = 基础属性 + 三种变体之一
// ============================================================

export type UnifiedCommand = CommandBase &
  (LocalCommand | LocalJSXCommand | PromptCommand);

// ============================================================
// 新体系：命令执行结果（执行引擎返回给应用层）
// ============================================================

export type CommandExecutionResult =
  | { type: "message"; value: string; shouldQuery?: boolean }
  | { type: "submit_prompt"; value: string; shouldQuery: boolean }
  | { type: "dialog"; dialog: DialogType }
  | { type: "clear" }
  | { type: "quit"; message?: string }
  | { type: "compact"; summary: string }
  | { type: "confirm"; message: string; onConfirm: () => Promise<CommandExecutionResult> }
  | { type: "error"; message: string }
  | { type: "passthrough"; value: string }  // 当作普通文本发给模型
  | { type: "skip" };                       // 静默完成
