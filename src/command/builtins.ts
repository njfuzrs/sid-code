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
    console.log("  /help           - 显示帮助信息");
    console.log("  /model [name]   - 显示/切换模型");
    console.log("  /model list     - 显示所有可用模型");
    console.log("  /cost           - 显示 token 用量和费用");
    console.log("  /compact        - 压缩对话历史");
    console.log("  /clear          - 清空对话");
    console.log("  /sessions       - 列出历史会话");
    console.log("  /config         - 显示当前配置");
    console.log("  /exit           - 退出");
  }
}

/** /model 命令 */
export class ModelCommand implements Command {
  name() { return "model"; }
  aliases() { return ["m"]; }
  description() { return "显示或切换模型"; }

  async execute(args: string, ctx: AppContext): Promise<void> {
    const trimmedArgs = args.trim();

    // /model list - 显示所有可用模型
    if (trimmedArgs === "list" || trimmedArgs === "ls") {
      this.showAvailableModels(ctx);
      return;
    }

    // /model <name> - 切换模型
    if (trimmedArgs) {
      this.switchModel(trimmedArgs, ctx);
      return;
    }

    // /model - 显示当前模型和可用模型
    this.showCurrentModel(ctx);
  }

  private showCurrentModel(ctx: AppContext): void {
    console.log(`当前模型: ${ctx.config.model}`);
    console.log(`提供商: ${ctx.config.provider}`);

    if (ctx.config.availableModels.length > 0) {
      console.log("\n可用模型:");
      ctx.config.availableModels.forEach((m) => {
        const current = m.name === ctx.config.model ? " (当前)" : "";
        const provider = m.provider ? ` [${m.provider}]` : "";
        console.log(`  - ${m.name}${provider}${current}`);
      });
      console.log("\n使用 /model <name> 切换模型");
      console.log("使用 /model list 查看详细信息");
    }
  }

  private showAvailableModels(ctx: AppContext): void {
    if (ctx.config.availableModels.length === 0) {
      console.log("未配置可用模型列表");
      console.log("请在 ~/.sid-code/config.yaml 中添加 available_models 配置");
      return;
    }

    console.log("可用模型列表:");
    ctx.config.availableModels.forEach((m, idx) => {
      const current = m.name === ctx.config.model ? " ✓ 当前" : "";
      console.log(`\n${idx + 1}. ${m.name}${current}`);
      if (m.provider) {
        console.log(`   提供商: ${m.provider}`);
      }
      if (m.baseURL) {
        console.log(`   API 地址: ${m.baseURL}`);
      }
    });
  }

  private switchModel(modelName: string, ctx: AppContext): void {
    // 如果配置了可用模型列表，验证模型名称
    if (ctx.config.availableModels.length > 0) {
      const modelConfig = ctx.config.availableModels.find((m) => m.name === modelName);

      if (!modelConfig) {
        console.log(`错误: 模型 "${modelName}" 不在可用模型列表中`);
        console.log("\n可用模型:");
        ctx.config.availableModels.forEach((m) => {
          console.log(`  - ${m.name}`);
        });
        console.log("\n使用 /model list 查看详细信息");
        return;
      }

      // 如果模型配置了特定的 provider 或 baseURL，也一起更新
      if (modelConfig.provider && modelConfig.provider !== ctx.config.provider) {
        ctx.config.provider = modelConfig.provider;
        console.log(`提供商已切换为: ${modelConfig.provider}`);
      }
      if (modelConfig.baseURL && modelConfig.baseURL !== ctx.config.baseURL) {
        ctx.config.baseURL = modelConfig.baseURL;
        console.log(`API 地址已更新: ${modelConfig.baseURL}`);
      }
    }

    // 切换模型
    ctx.setModel(modelName);
    console.log(`模型已切换为: ${modelName}`);
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
