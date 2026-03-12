/**
 * 内置斜杠命令
 * 提供 /help, /model, /cost, /compact, /clear, /exit, /sessions, /resume, /config
 */

import type { Command, AppContext } from "./types.ts";

/** /help 命令 */
export class HelpCommand implements Command {
  name() { return "help"; }
  aliases() { return ["h", "?"]; }
  description() { return "显示帮助信息"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    console.log("可用命令:");
    console.log("  /help      - 显示帮助信息");
    console.log("  /model     - 显示/切换模型");
    console.log("  /cost      - 显示 token 用量和费用");
    console.log("  /compact   - 压缩对话历史");
    console.log("  /clear     - 清空对话");
    console.log("  /sessions  - 列出历史会话");
    console.log("  /config    - 显示当前配置");
    console.log("  /exit      - 退出");
  }
}

/** /model 命令 */
export class ModelCommand implements Command {
  name() { return "model"; }
  aliases() { return ["m"]; }
  description() { return "显示或切换模型"; }

  async execute(args: string, ctx: AppContext): Promise<void> {
    if (args) {
      ctx.setModel(args.trim());
      console.log(`模型已切换为: ${args.trim()}`);
    } else {
      console.log(`当前模型: ${ctx.config.model}`);
      console.log(`提供商: ${ctx.config.provider}`);
    }
  }
}

/** /cost 命令 */
export class CostCommand implements Command {
  name() { return "cost"; }
  aliases() { return []; }
  description() { return "显示 token 用量和费用"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    const u = ctx.totalUsage;
    console.log(`Token 用量:`);
    console.log(`  输入: ${u.inputTokens}`);
    console.log(`  输出: ${u.outputTokens}`);
    if (u.cacheCreationInputTokens) {
      console.log(`  缓存创建: ${u.cacheCreationInputTokens}`);
    }
    if (u.cacheReadInputTokens) {
      console.log(`  缓存读取: ${u.cacheReadInputTokens}`);
    }

    // 估算费用（基于 Claude Sonnet 定价）
    const inputCost = (u.inputTokens / 1_000_000) * 3;
    const outputCost = (u.outputTokens / 1_000_000) * 15;
    const totalCost = inputCost + outputCost;
    console.log(`  估算费用: $${totalCost.toFixed(4)}`);
  }
}

/** /compact 命令 */
export class CompactCommand implements Command {
  name() { return "compact"; }
  aliases() { return []; }
  description() { return "压缩对话历史"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    const before = ctx.ctxMgr.messageCount();
    if (before <= 4) {
      console.log("对话历史太短，无需压缩");
      return;
    }

    // 使用 LLM 生成摘要
    console.log("正在压缩对话历史...");
    const messages = ctx.ctxMgr.getMessages();
    const summaryText = messages
      .map((m) => {
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text)
          .join("\n");
        return `[${m.role}] ${text.slice(0, 200)}`;
      })
      .join("\n");

    ctx.ctxMgr.compactWithSummary(summaryText.slice(0, 2000));
    const after = ctx.ctxMgr.messageCount();
    console.log(`对话已压缩: ${before} → ${after} 条消息`);
  }
}

/** /clear 命令 */
export class ClearCommand implements Command {
  name() { return "clear"; }
  aliases() { return []; }
  description() { return "清空对话历史"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    ctx.ctxMgr.clear();
    console.log("对话已清空");
  }
}

/** /config 命令 */
export class ConfigCommand implements Command {
  name() { return "config"; }
  aliases() { return []; }
  description() { return "显示当前配置"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    console.log(`提供商: ${ctx.config.provider}`);
    console.log(`模型: ${ctx.config.model}`);
    console.log(`最大 Token: ${ctx.config.maxTokens}`);
    console.log(`权限模式: ${ctx.config.permissionMode}`);
    console.log(`TUI: ${ctx.config.noTUI ? "禁用" : "启用"}`);
    console.log(`工具数量: ${ctx.registry.size()}`);
  }
}

/** /exit 命令 */
export class ExitCommand implements Command {
  name() { return "exit"; }
  aliases() { return ["quit", "q"]; }
  description() { return "退出程序"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    ctx.exitRequested = true;
    console.log("再见！");
  }
}

/** 注册所有内置命令 */
export function registerBuiltins(registry: import("./registry.ts").Registry): void {
  registry.register(new HelpCommand());
  registry.register(new ModelCommand());
  registry.register(new CostCommand());
  registry.register(new CompactCommand());
  registry.register(new ClearCommand());
  registry.register(new ConfigCommand());
  registry.register(new ExitCommand());
}
