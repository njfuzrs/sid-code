/**
 * 内置斜杠命令
 * 提供 /help, /model, /cost, /compact, /clear, /exit, /sessions, /resume, /config
 */

import type { Command, AppContext } from "./types.ts";
import { clearPromptCache } from "../config/system-prompt.ts";

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
    console.log("  /undo           - 撤销最近一次文件修改");
    console.log("  /memory         - 管理记忆 (set/get/delete/list/search)");
    console.log("  /mcp            - 显示 MCP 服务器状态");
    console.log("  /exit           - 退出");

    // 显示自定义命令
    if (ctx.customCommands && ctx.customCommands.length > 0) {
      console.log("\n自定义命令:");
      for (const cmd of ctx.customCommands) {
        const desc = cmd.description ? ` - ${cmd.description}` : "";
        console.log(`  /${cmd.name}${desc}`);
      }
    }
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

      // 如果模型配置了特定的 provider、baseURL 或 apiKey，也一起更新
      if (modelConfig.provider && modelConfig.provider !== ctx.config.provider) {
        ctx.config.provider = modelConfig.provider;
        console.log(`提供商已切换为: ${modelConfig.provider}`);
      }
      if (modelConfig.baseURL && modelConfig.baseURL !== ctx.config.baseURL) {
        ctx.config.baseURL = modelConfig.baseURL;
        console.log(`API 地址已更新: ${modelConfig.baseURL}`);
      }
      // 模型级 apiKey 覆盖对应 provider 的全局 key
      if (modelConfig.apiKey) {
        const provider = modelConfig.provider || ctx.config.provider;
        if (provider === "anthropic") {
          ctx.config.anthropicKey = modelConfig.apiKey;
        } else {
          ctx.config.openaiKey = modelConfig.apiKey;
        }
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
    const { SessionState } = await import("../session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();

    // 汇总信息
    console.log(`会话时长: ${SessionState.formatDuration(ss.getElapsedMs())}`);
    console.log(`总费用: $${ss.totalCostUSD.toFixed(4)}`);
    console.log(`API 耗时: ${SessionState.formatDuration(ss.totalAPIDuration)}`);
    console.log(`工具耗时: ${SessionState.formatDuration(ss.totalToolDuration)}`);
    console.log("");

    // 汇总 token
    console.log(`Token 用量（汇总）:`);
    console.log(`  输入: ${totalUsage.inputTokens}`);
    console.log(`  输出: ${totalUsage.outputTokens}`);
    if (totalUsage.cacheCreationInputTokens) {
      console.log(`  缓存创建: ${totalUsage.cacheCreationInputTokens}`);
    }
    if (totalUsage.cacheReadInputTokens) {
      console.log(`  缓存读取: ${totalUsage.cacheReadInputTokens}`);
    }

    // 按模型分开展示
    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      console.log("");
      console.log(`按模型统计:`);
      for (const [model, stats] of models) {
        console.log(`  ${model}: ${stats.requests} 次请求, $${stats.costUSD.toFixed(4)}, input=${stats.inputTokens}, output=${stats.outputTokens}`);
      }
    }
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
    clearPromptCache();
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
    console.log(`TUI: 启用`);
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

/** /undo 命令 */
export class UndoCommand implements Command {
  name() { return "undo"; }
  aliases() { return []; }
  description() { return "撤销最近一次文件修改（回滚到上一个 checkpoint）"; }

  async execute(_args: string, _ctx: AppContext): Promise<void> {
    const { getCheckpointManager } = await import("../checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(process.env.SID_CODE_SESSION_ID || "default");

    const result = await cpMgr.undo();
    if (result) {
      console.log(`已撤销: ${result.filePath}`);
      console.log(`文件已回滚到上一个版本 (${result.restoredContent.length} 字符)`);
    } else {
      console.log("没有可撤销的修改");
    }
  }
}

/** /memory 命令 */
export class MemoryCommand implements Command {
  name() { return "memory"; }
  aliases() { return ["mem"]; }
  description() { return "管理记忆（set/get/delete/list/search）"; }

  async execute(args: string, _ctx: AppContext): Promise<void> {
    const { MemoryStore } = await import("../memory/store.ts");
    const store = new MemoryStore(process.cwd());
    await store.load();

    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0] || "list";

    switch (subCmd) {
      case "set": {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (!key || !value) {
          console.log("用法: /memory set <key> <value> [--global]");
          return;
        }
        const scope = args.includes("--global") ? "global" as const : "project" as const;
        const cleanValue = value.replace("--global", "").trim();
        await store.set(key, cleanValue, scope);
        console.log(`记忆已保存: [${scope}] ${key} = ${cleanValue}`);
        break;
      }

      case "get": {
        const key = parts[1];
        if (!key) {
          console.log("用法: /memory get <key>");
          return;
        }
        const entry = await store.get(key);
        if (entry) {
          const date = new Date(entry.updatedAt).toLocaleString();
          console.log(`[${entry.scope}] ${entry.key} = ${entry.value}`);
          console.log(`  更新时间: ${date}`);
        } else {
          console.log(`未找到记忆: ${key}`);
        }
        break;
      }

      case "delete":
      case "del":
      case "rm": {
        const key = parts[1];
        if (!key) {
          console.log("用法: /memory delete <key>");
          return;
        }
        const deleted = await store.delete(key);
        if (deleted) {
          console.log(`已删除记忆: ${key}`);
        } else {
          console.log(`未找到记忆: ${key}`);
        }
        break;
      }

      case "search": {
        const keyword = parts.slice(1).join(" ");
        if (!keyword) {
          console.log("用法: /memory search <keyword>");
          return;
        }
        const results = await store.search(keyword);
        if (results.length === 0) {
          console.log(`未找到匹配 "${keyword}" 的记忆`);
        } else {
          console.log(`找到 ${results.length} 条匹配:`);
          for (const entry of results) {
            console.log(`  [${entry.scope}] ${entry.key}: ${entry.value}`);
          }
        }
        break;
      }

      case "list":
      case "ls":
      default: {
        const entries = await store.list();
        if (entries.length === 0) {
          console.log("暂无记忆");
          console.log("使用 /memory set <key> <value> 添加记忆");
        } else {
          const stats = await store.getStats();
          console.log(`记忆列表 (全局 ${stats.globalCount} 条, 项目 ${stats.projectCount} 条):`);
          for (const entry of entries) {
            const date = new Date(entry.updatedAt).toLocaleDateString();
            console.log(`  [${entry.scope}] ${entry.key}: ${entry.value} (${date})`);
          }
        }
        break;
      }
    }
  }
}

/** /mcp 命令 */
export class MCPCommand implements Command {
  name() { return "mcp"; }
  aliases() { return []; }
  description() { return "显示 MCP 服务器连接状态"; }

  async execute(_args: string, ctx: AppContext): Promise<void> {
    if (!ctx.mcpManager) {
      console.log("未配置 MCP 服务器");
      console.log("在 ~/.sid-code/config.yaml 或 .mcp.json 中添加 mcp_servers 配置");
      return;
    }

    const statuses = ctx.mcpManager.getStatus();
    if (statuses.length === 0) {
      console.log("没有已连接的 MCP 服务器");
      return;
    }

    console.log("MCP 服务器状态:");
    for (const s of statuses) {
      const status = s.connecting ? "连接中..." : s.connected ? "已连接" : "连接失败";
      const tools = s.connected ? `${s.toolCount} 个工具` : "";
      const error = s.error ? ` (${s.error})` : "";
      console.log(`  ${s.name} [${s.transport}] — ${status} ${tools}${error}`);
    }
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
  registry.register(new UndoCommand());
  registry.register(new MemoryCommand());
  registry.register(new MCPCommand());
  registry.register(new ExitCommand());
}
