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

/** 应用上下文 - 将应用内部状态暴露给命令 */
export interface AppContext {
  ctxMgr: ContextManager;
  registry: ToolRegistry;
  config: Config;
  sessionId: string;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  setModel: (model: string) => void;
  exitRequested: boolean;
  sessionState: SessionState;
  /** 将文本注入对话并触发 LLM 响应（自定义命令用） */
  sendToLLM?: (text: string) => Promise<void>;
  /** 自定义命令列表（/help 显示用） */
  customCommands?: Array<{ name: string; description: string }>;
}

/** 命令接口 - 所有斜杠命令必须实现 */
export interface Command {
  name(): string;
  aliases(): string[];
  description(): string;
  execute(args: string, ctx: AppContext): Promise<void>;
}
