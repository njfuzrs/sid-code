/**
 * 命令契约类型（P2-2 分包：core 侧）
 *
 * ## 为什么这些类型在 core 而不在 cli
 *
 * `src/skill/`（core）需要「把自己注册成一条斜杠命令」——这是 **skill 对外的契约**，
 * 而契约本该由被依赖方定义。原先这三个类型（`UnifiedCommand` / `PromptCommand` /
 * `CommandContext`）住在 `command/types.ts`（cli），导致 core 反向依赖 cli。
 *
 * ## ⛔ 边界铁律：`Command` 与 `AppContext` 绝不下移到这里
 *
 * 旧体系的 `Command.execute(args, ctx: AppContext)` 依赖 `AppContext` —— 一个
 * **60+ 成员的 cli 风味巨型接口**，自身还指向 `ui/statusline`、`command/registry.ts` 等
 * cli 内部路径。把它拖进 core 会引入一长串新的 `core → cli` 越界。
 * 那两个类型**留在 `command/types.ts`（cli）**，本文件只收 skill 真正用到的契约闭包。
 *
 * ## 闭包边界的验证方式
 *
 * 本文件的全部外部依赖都在 core 内或纯 npm 类型：
 * `config` / `context` / `llm` / `tool` / `session` / `mcp` / `hook` / `permission` /
 * `goal` / `trace` / `skill`（全 core）+ `react` 的 `ReactNode`（npm 类型）。
 * 唯一曾经的例外是 `UnifiedCommandRegistry`（cli 的 class），已改为下方的
 * `UnifiedCommandRegistryContract` 结构化契约 —— 见该接口的注释。
 *
 * 越界数由 `scripts/pkg-boundary-scan.ts` 机械校验，不靠人记。见方案 §4.2 修法①。
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
// 对话框类型
// ============================================================

/**
 * 支持的对话框类型。
 *
 * 语义上属 TUI，但它在 `LocalCommandResult` 的闭包里（命令可返回「打开某对话框」），
 * 所以随契约一起留在 core。纯字符串联合，零运行时成本。
 */
export type DialogType =
  | "model"
  | "theme"
  | "settings"
  | "onboarding"
  | "mcp"
  | "effort"
  | "think"
  | "language"
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
  | "claude-md-external-imports"
  // SEC-AUDIT-2026-07-19 P1：首次打开含危险配置的代码库时的信任门控
  | "trust";

// ============================================================
// 命令来源
// ============================================================

export type CommandSource =
  | "builtin" // 内置命令
  | "user" // 用户自定义（~/.sid-code/commands/）
  | "project" // 项目自定义（.sid-code/commands/）
  | "skill" // Skill 系统
  | "plugin" // 插件（带 pluginName: 前缀）
  | "mcp"; // MCP 服务器

// ============================================================
// 统一命令注册表的结构化契约
// ============================================================

/**
 * 统一命令注册表契约（`/reload-plugins` 刷新插件命令用）。
 *
 * **为什么是契约接口而不是直接引用 `UnifiedCommandRegistry`**：那个 class 住在
 * `command/unified-registry.ts`（cli），core 引用它就是越界。而 `CommandContext`
 * 属 core，又确实要携带这个注册表引用给 cli 侧命令用。
 *
 * 解法是在 core 声明一个**结构化契约**：cli 的 class 实例结构上满足它，
 * 赋值天然成立（TS 结构化类型），不需要 class 显式 implements，也不需要 core 认识 cli。
 *
 * ⚠️ 只声明经由 `CommandContext.unifiedRegistry` 真实用到的成员。要用更多方法时
 * 在此补声明，**不要**改回直接 import cli 的 class。
 */
export interface UnifiedCommandRegistryContract {
  /** 重新加载插件命令，返回加载到的命令数。 */
  reloadPlugins(): Promise<number>;
  /** 加载插件命令，返回加载到的命令数。 */
  loadPlugins(): Promise<number>;
  /** 失效 skill 命令缓存（skill 变更后调用）。 */
  invalidateSkillCommands(): void;
}

// ============================================================
// 命令上下文（新体系，替代 AppContext，更精简）
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
  setStatusLine?: (
    config: import("../config/statusline-types.ts").StatusLineConfig | undefined,
    persist?: boolean,
  ) => void;
  /** 读取当前自定义状态栏配置（/statusline 展示/toggle 用）。 */
  getStatusLine?: () => import("../config/statusline-types.ts").StatusLineConfig | undefined;
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
  /**
   * 统一命令注册表引用（/reload-plugins 刷新插件命令用）。
   * 类型是 core 侧的结构化契约，不是 cli 的 class —— 见 `UnifiedCommandRegistryContract`。
   */
  unifiedRegistry?: UnifiedCommandRegistryContract;
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
// 命令基础属性（所有命令共享）
// ============================================================

export interface CommandBase {
  // === 身份标识 ===
  name: string; // 命令名（唯一标识，如 "compact"）
  aliases?: string[]; // 别名（如 ["q"] 对应 /exit）
  description: string; // 描述（显示在补全列表和 /help 中）
  argumentHint?: string; // 参数提示（如 "session-id"）

  // === 可见性控制 ===
  isEnabled?: () => boolean; // 运行时条件门控（feature flag 等）
  isHidden?: boolean; // 从补全列表/help 中隐藏

  // === 调用控制 ===
  userInvocable?: boolean; // 用户能否通过 /name 调用（false = 仅模型可用）
  disableModelInvocation?: boolean; // 模型能否通过 SkillTool 调用
  immediate?: boolean; // 是否绕过队列立即执行（模型运行时可用）
  requiresArgs?: boolean; // 无参数就无法工作（如 /btw）。true = 补全列表回车仅回填等待输入；
  // 默认 false = 补全列表回车直接执行（无参开对话框/显示状态的命令）

  // === 来源追踪 ===
  source?: CommandSource; // 来源标记

  // === 模型集成 ===
  whenToUse?: string; // 告诉模型何时应该使用此命令

  // === 子命令 ===
  subCommands?: () => UnifiedCommand[];
}

// ============================================================
// 三种命令变体
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
  | { type: "text"; value: string } // 显示文本
  | { type: "compact"; summary: string } // 上下文压缩结果
  | { type: "skip" } // 静默完成
  | { type: "clear" } // 清空对话
  | { type: "quit"; message?: string } // 退出程序
  | { type: "dialog"; dialog: DialogType } // 打开交互式对话框
  | { type: "submit_prompt"; prompt: string } // 将文本提交给 LLM
  | { type: "confirm"; message: string; onConfirm: () => Promise<LocalCommandResult> }; // 需要用户确认

/** local-jsx 命令：渲染 Ink 交互式 UI */
export interface LocalJSXCommand {
  type: "local-jsx";
  load: () => Promise<LocalJSXCommandModule>;
}

export interface LocalJSXCommandModule {
  call(onDone: LocalJSXCommandOnDone, ctx: CommandContext, args: string): Promise<ReactNode | null>;
}

export type LocalJSXCommandOnDone = (result?: string, options?: LocalJSXDoneOptions) => void;

export interface LocalJSXDoneOptions {
  display?: "skip" | "system" | "user"; // 结果如何显示
  shouldQuery?: boolean; // 完成后是否触发模型调用
  nextInput?: string; // 链式命令：设置下一个输入
  submitNextInput?: boolean; // 链式命令：自动提交下一个输入
}

/** prompt 命令：生成 prompt 注入对话，触发模型调用 */
export interface PromptCommand {
  type: "prompt";
  context?: "inline" | "fork"; // inline=当前对话展开，fork=子代理执行
  getPromptForCommand(args: string, ctx: CommandContext): Promise<string>;
  allowedTools?: string[]; // 限制模型可用的工具集（fork 模式）
  maxTurns?: number; // 最大轮次（fork 模式）
  timeoutMins?: number; // 子代理超时(分钟，fork 模式)；默认 2，最大 30
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
// 统一命令类型 = 基础属性 + 三种变体之一
// ============================================================

export type UnifiedCommand = CommandBase & (LocalCommand | LocalJSXCommand | PromptCommand);
