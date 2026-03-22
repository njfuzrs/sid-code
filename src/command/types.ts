/**
 * 斜杠命令系统的核心类型
 * 用户在交互式模式下输入 /xxx 即可触发对应的命令
 */

import type { Config } from "../config/config.ts";
import type { Manager as ContextManager } from "../context/manager.ts";
import type { Provider } from "../llm/provider.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { SessionState } from "../session/state.ts";
import type { MCPManager } from "../mcp/manager.ts";
import type { HookSystem } from "../hook/system.ts";

/** 应用上下文 - 将应用内部状态暴露给命令 */
export interface AppContext {
  ctxMgr: ContextManager;
  registry: ToolRegistry;
  config: Config;
  sessionId: string;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  mcpManager?: MCPManager;
  setModel: (model: string) => void;
  exitRequested: boolean;
  sessionState: SessionState;
  /** 将文本注入对话并触发 LLM 响应（自定义命令用） */
  sendToLLM?: (text: string) => Promise<void>;
  /** 自定义命令列表（/help 显示用） */
  customCommands?: Array<{ name: string; description: string }>;
  /** Shell 注入确认回调（自定义命令 !{cmd} 语法用），返回 true 表示用户确认 */
  confirmShellCommands?: (commands: string[]) => Promise<boolean>;
  /** Hook 系统引用（/hooks 命令用） */
  hookSystem?: HookSystem;
}

/** 命令执行结果类型 */
export type CommandResultKind =
  | "message"        // 显示文本消息
  | "submit_prompt"  // 将文本提交给 LLM
  | "clear"          // 清空对话
  | "quit"           // 退出程序
  | "confirm"        // 需要用户确认
  | "error";         // 错误信息

export interface CommandResult {
  kind: CommandResultKind;
  message?: string;  // kind=message/error/confirm 时的文本
  prompt?: string;   // kind=submit_prompt 时的提示词
  /** kind=confirm 时的确认回调 */
  onConfirm?: () => Promise<CommandResult>;
}

/** 命令接口 - 所有斜杠命令必须实现 */
export interface Command {
  name(): string;
  aliases(): string[];
  description(): string;
  /** 子命令列表（可选） */
  subCommands?(): Command[];
  execute(args: string, ctx: AppContext): Promise<CommandResult>;
}
