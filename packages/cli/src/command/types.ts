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

import type { Config } from "@sid-code/core/config/config.ts";
// 本文件内 CommandResult / CommandExecutionResult 要用 DialogType。
// re-export 语句不产生本地绑定，所以除 re-export 外还需这条 import。
import type { DialogType } from "@sid-code/core/command-contract/types.ts";
import type { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { LanguagePref } from "@sid-code/core/config/prompt-lang.ts";
import type { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import type { SessionState } from "@sid-code/core/session/state.ts";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";
import type { HookSystem } from "@sid-code/core/hook/system.ts";

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
  setEffort?: (level: import("@sid-code/core/llm/effort.ts").EffortSetting, persist?: boolean) => void;
  /** 思考开关旋钮 setter（/think 用）。persist=true 时写 settings.json。 */
  setThinking?: (setting: import("@sid-code/core/llm/effort.ts").ThinkingSetting, persist?: boolean) => void;
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
  setStatusLine?: (config: import("@sid-code/core/config/statusline-types.ts").StatusLineConfig | undefined, persist?: boolean) => void;
  /** 读取当前自定义状态栏配置（/statusline 展示/toggle 用）。 */
  getStatusLine?: () => import("@sid-code/core/config/statusline-types.ts").StatusLineConfig | undefined;
  /** 会话重命名（/rename 用）。name 为空时基于上下文生成。返回最终名字。 */
  renameSession?: (name?: string) => string | Promise<string>;
  /** 读取当前 effort 运行时态 + 能力（/effort 展示用） */
  getEffortState?: () => {
    runtime: import("@sid-code/core/llm/effort.ts").EffortSetting;
    applied: import("@sid-code/core/llm/effort.ts").EffortLevel | undefined;
    isAuto: boolean;
    capability: import("@sid-code/core/llm/effort.ts").EffortCapability;
  };
  /** 读取当前 thinking 运行时态 + 能力（/think 展示用） */
  getThinkingState?: () => {
    runtime: import("@sid-code/core/llm/effort.ts").ThinkingSetting;
    applied: boolean;
    capability: import("@sid-code/core/llm/effort.ts").EffortCapability;
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
  permissionRules?: import("@sid-code/core/permission/types.ts").PermissionRule;
  /** Hook 系统引用（/hooks 命令用） */
  hookSystem?: HookSystem;
  /**
   * §12 P2-4 复审：最近访问文件追踪器（手动 /compact 压缩后重注入最近读过的文件）。
   * 经 toCommandContext 桥接到 CommandContext.fileReadTracker。
   */
  fileReadTracker?: import("@sid-code/core/tool/file-read-tracker.ts").FileReadTracker;
  /** §12 P2-4 复审：会话级临时目录（手动压缩质量报告落盘）。经 toCommandContext 桥接。 */
  sessionDir?: string;
  /** 命令注册表引用（/reload-plugins 重新合并插件命令用） */
  commandRegistry?: import("./registry.ts").Registry;
  /**
   * Skill 管理器引用（/reload-plugins 刷新插件 skills 用）。
   * §18.10：插件带的 skills 需随插件安装/卸载原子替换，否则装了新插件要重启才能用它的
   * skill、卸载后旧 skill 还留着。
   */
  skillManager?: import("@sid-code/core/skill/manager.ts").SkillManager;
  /**
   * 统一命令注册表引用（新体系 /reload-plugins 刷新插件命令用，优先于 commandRegistry）。
   *
   * 用 core 侧的结构化契约而非 cli 的 class：`adapter.ts` 在 AppContext ↔ CommandContext
   * 之间双向桥接这个字段，两侧类型必须一致；而 `CommandContext` 属 core，只能持契约。
   * 实际注入的仍是 cli 的 `UnifiedCommandRegistry` 实例（结构上满足契约）。
   */
  unifiedRegistry?: import("@sid-code/core/command-contract/types.ts").UnifiedCommandRegistryContract;
  /** /goal：读取当前目标状态 */
  getGoalState?: () => import("@sid-code/core/goal/state.ts").GoalState | null;
  /** /goal：设置目标状态（null 表示清除） */
  setGoalState?: (goal: import("@sid-code/core/goal/state.ts").GoalState | null) => void;
  /** /goal：更新目标状态（原地修改） */
  updateGoalState?: (updater: (goal: import("@sid-code/core/goal/state.ts").GoalState) => void) => void;
  /** 轨迹采集器（可选，trace.enabled=false 时为 undefined）—— /debug 命令用 */
  traceCollector?: import("@sid-code/core/trace/collector.ts").TraceCollector;
  /** 权限检查器实例（/allow /deny /add-dir /permissions 用；运行时注入，可能为 null） */
  permissionChecker?: import("@sid-code/core/permission/types.ts").Checker | null;
}

/**
 * 支持的对话框类型。
 *
 * 定义已随命令契约下移到 core（`command-contract/types.ts`）——
 * 它在 `LocalCommandResult` 的闭包里（命令可返回「打开某对话框」），必须与契约同包。
 * 此处 re-export 供 cli 侧既有导入方沿用。
 */
export type { DialogType } from "@sid-code/core/command-contract/types.ts";

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
// 新体系：契约类型已下移到 core（P2-2 分包，修法①）
// ============================================================

/**
 * 新体系的命令契约类型定义在 `src/command-contract/types.ts`（core 包）。
 *
 * 原因：`src/skill/`（core）要「把自己注册成一条命令」，这是它对外的契约，
 * 契约本该由被依赖方定义；类型留在这里会让 core 反向依赖 cli。
 *
 * 本文件（cli）保留旧体系的 `Command` / `AppContext` / `CommandResult` ——
 * 它们依赖 60+ 成员的 cli 风味 `AppContext`，**刻意不下移**（下移会引入一串新越界）。
 *
 * 下面 re-export 让 35 个既有导入方无需改动路径。
 */
export type {
  CommandSource,
  CommandContext,
  CommandBase,
  LocalCommand,
  LocalCommandModule,
  LocalCommandResult,
  LocalJSXCommand,
  LocalJSXCommandModule,
  LocalJSXCommandOnDone,
  LocalJSXDoneOptions,
  PromptCommand,
  UnifiedCommand,
  UnifiedCommandRegistryContract,
} from "@sid-code/core/command-contract/types.ts";


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
