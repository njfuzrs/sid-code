/**
 * 内置斜杠命令
 * 提供 /help, /model, /cost, /compact, /clear, /exit, /sessions, /resume, /config
 * /rewind, /stats, /init
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { clearPromptCache } from "../config/system-prompt.ts";

/** /help 命令 */
export class HelpCommand implements Command {
  name() { return "help"; }
  aliases() { return ["h", "?"]; }
  description() { return "显示帮助信息"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const lines = [
      "可用命令:",
      "  /help           - 显示帮助信息",
      "  /model [name]   - 显示/切换模型",
      "  /model list     - 显示所有可用模型",
      "  /cost           - 显示 token 用量和费用",
      "  /compact        - 压缩对话历史",
      "  /clear          - 清空对话",
      "  /rewind [n]     - 回退最近 n 轮对话（默认 1 轮）",
      "  /stats          - 显示会话统计",
      "  /sessions       - 列出历史会话",
      "  /config         - 显示当前配置",
      "  /undo           - 撤销最近一次文件修改",
      "  /memory         - 管理记忆 (set/get/delete/list/search)",
      "  /mcp            - 显示 MCP 服务器状态",
      "  /init           - 初始化项目 .sid-code/ 配置目录",
      "  /exit           - 退出",
    ];

    if (ctx.customCommands && ctx.customCommands.length > 0) {
      lines.push("", "自定义命令:");
      for (const cmd of ctx.customCommands) {
        const desc = cmd.description ? ` - ${cmd.description}` : "";
        lines.push(`  /${cmd.name}${desc}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /model 命令 */
export class ModelCommand implements Command {
  name() { return "model"; }
  aliases() { return ["m"]; }
  description() { return "显示或切换模型"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const trimmedArgs = args.trim();

    if (trimmedArgs === "list" || trimmedArgs === "ls") {
      return { kind: "message", message: this.buildAvailableModels(ctx) };
    }

    if (trimmedArgs) {
      return this.switchModel(trimmedArgs, ctx);
    }

    return { kind: "message", message: this.buildCurrentModel(ctx) };
  }

  private buildCurrentModel(ctx: AppContext): string {
    const lines = [
      `当前模型: ${ctx.config.model}`,
      `提供商: ${ctx.config.provider}`,
    ];
    if (ctx.config.availableModels.length > 0) {
      lines.push("", "可用模型:");
      ctx.config.availableModels.forEach((m) => {
        const current = m.name === ctx.config.model ? " (当前)" : "";
        const provider = m.provider ? ` [${m.provider}]` : "";
        lines.push(`  - ${m.name}${provider}${current}`);
      });
      lines.push("", "使用 /model <name> 切换模型");
      lines.push("使用 /model list 查看详细信息");
    }
    return lines.join("\n");
  }

  private buildAvailableModels(ctx: AppContext): string {
    if (ctx.config.availableModels.length === 0) {
      return "未配置可用模型列表\n请在 ~/.sid-code/config.yaml 中添加 available_models 配置";
    }
    const lines = ["可用模型列表:"];
    ctx.config.availableModels.forEach((m, idx) => {
      const current = m.name === ctx.config.model ? " ✓ 当前" : "";
      lines.push(`\n${idx + 1}. ${m.name}${current}`);
      if (m.provider) lines.push(`   提供商: ${m.provider}`);
      if (m.baseURL) lines.push(`   API 地址: ${m.baseURL}`);
    });
    return lines.join("\n");
  }

  private switchModel(modelName: string, ctx: AppContext): CommandResult {
    if (ctx.config.availableModels.length > 0) {
      const modelConfig = ctx.config.availableModels.find((m) => m.name === modelName);
      if (!modelConfig) {
        const available = ctx.config.availableModels.map((m) => `  - ${m.name}`).join("\n");
        return {
          kind: "error",
          message: `模型 "${modelName}" 不在可用模型列表中\n\n可用模型:\n${available}\n\n使用 /model list 查看详细信息`,
        };
      }

      const notices: string[] = [];
      if (modelConfig.provider && modelConfig.provider !== ctx.config.provider) {
        ctx.config.provider = modelConfig.provider;
        notices.push(`提供商已切换为: ${modelConfig.provider}`);
      }
      if (modelConfig.baseURL && modelConfig.baseURL !== ctx.config.baseURL) {
        ctx.config.baseURL = modelConfig.baseURL;
        notices.push(`API 地址已更新: ${modelConfig.baseURL}`);
      }
      if (modelConfig.apiKey) {
        const provider = modelConfig.provider || ctx.config.provider;
        if (provider === "anthropic") {
          ctx.config.anthropicKey = modelConfig.apiKey;
        } else {
          ctx.config.openaiKey = modelConfig.apiKey;
        }
      }
      if (modelConfig.maxOutputTokens) {
        ctx.config.maxTokens = modelConfig.maxOutputTokens;
        notices.push(`最大输出 tokens 已更新: ${modelConfig.maxOutputTokens}`);
      }
      if (notices.length > 0) {
        // 通知会附在切换消息后
      }
    }

    ctx.setModel(modelName);
    return { kind: "message", message: `模型已切换为: ${modelName}` };
  }
}

/** /cost 命令 */
export class CostCommand implements Command {
  name() { return "cost"; }
  aliases() { return []; }
  description() { return "显示 token 用量和费用"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const { SessionState } = await import("../session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();

    const lines = [
      `会话时长: ${SessionState.formatDuration(ss.getElapsedMs())}`,
      `总费用: $${ss.totalCostUSD.toFixed(4)}`,
      `API 耗时: ${SessionState.formatDuration(ss.totalAPIDuration)}`,
      `工具耗时: ${SessionState.formatDuration(ss.totalToolDuration)}`,
      "",
      "Token 用量（汇总）:",
      `  输入: ${totalUsage.inputTokens}`,
      `  输出: ${totalUsage.outputTokens}`,
    ];

    if (totalUsage.cacheCreationInputTokens) {
      lines.push(`  缓存创建: ${totalUsage.cacheCreationInputTokens}`);
    }
    if (totalUsage.cacheReadInputTokens) {
      lines.push(`  缓存读取: ${totalUsage.cacheReadInputTokens}`);
    }

    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      lines.push("", "按模型统计:");
      for (const [model, stats] of models) {
        lines.push(`  ${model}: ${stats.requests} 次请求, $${stats.costUSD.toFixed(4)}, input=${stats.inputTokens}, output=${stats.outputTokens}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /compact 命令 */
export class CompactCommand implements Command {
  name() { return "compact"; }
  aliases() { return []; }
  description() { return "压缩对话历史"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const before = ctx.ctxMgr.messageCount();
    if (before <= 4) {
      return { kind: "message", message: "对话历史太短，无需压缩" };
    }

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
    return { kind: "message", message: `对话已压缩: ${before} → ${after} 条消息` };
  }
}

/** /clear 命令 */
export class ClearCommand implements Command {
  name() { return "clear"; }
  aliases() { return []; }
  description() { return "清空对话历史"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    return { kind: "clear" };
  }
}

/** /config 命令 */
export class ConfigCommand implements Command {
  name() { return "config"; }
  aliases() { return []; }
  description() { return "显示当前配置"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const lines = [
      `提供商: ${ctx.config.provider}`,
      `模型: ${ctx.config.model}`,
      `最大 Token: ${ctx.config.maxTokens}`,
      `权限模式: ${ctx.config.permissionMode}`,
      `TUI: 启用`,
      `工具数量: ${ctx.registry.size()}`,
    ];
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /exit 命令 */
export class ExitCommand implements Command {
  name() { return "exit"; }
  aliases() { return ["quit", "q"]; }
  description() { return "退出程序"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    return { kind: "quit", message: "再见！" };
  }
}

/** /undo 命令 */
export class UndoCommand implements Command {
  name() { return "undo"; }
  aliases() { return []; }
  description() { return "撤销最近一次文件修改（回滚到上一个 checkpoint）"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getCheckpointManager } = await import("../checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(process.env.SID_CODE_SESSION_ID || "default");

    const result = await cpMgr.undo();
    if (result) {
      return {
        kind: "message",
        message: `已撤销: ${result.filePath}\n文件已回滚到上一个版本 (${result.restoredContent.length} 字符)`,
      };
    }
    return { kind: "message", message: "没有可撤销的修改" };
  }
}

/** /memory 命令 */
export class MemoryCommand implements Command {
  name() { return "memory"; }
  aliases() { return ["mem"]; }
  description() { return "管理记忆（set/get/delete/list/search）"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
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
          return { kind: "error", message: "用法: /memory set <key> <value> [--global]" };
        }
        const scope = args.includes("--global") ? "global" as const : "project" as const;
        const cleanValue = value.replace("--global", "").trim();
        await store.set(key, cleanValue, scope);
        return { kind: "message", message: `记忆已保存: [${scope}] ${key} = ${cleanValue}` };
      }

      case "get": {
        const key = parts[1];
        if (!key) {
          return { kind: "error", message: "用法: /memory get <key>" };
        }
        const entry = await store.get(key);
        if (entry) {
          const date = new Date(entry.updatedAt).toLocaleString();
          return { kind: "message", message: `[${entry.scope}] ${entry.key} = ${entry.value}\n  更新时间: ${date}` };
        }
        return { kind: "message", message: `未找到记忆: ${key}` };
      }

      case "delete":
      case "del":
      case "rm": {
        const key = parts[1];
        if (!key) {
          return { kind: "error", message: "用法: /memory delete <key>" };
        }
        const deleted = await store.delete(key);
        return { kind: "message", message: deleted ? `已删除记忆: ${key}` : `未找到记忆: ${key}` };
      }

      case "search": {
        const keyword = parts.slice(1).join(" ");
        if (!keyword) {
          return { kind: "error", message: "用法: /memory search <keyword>" };
        }
        const results = await store.search(keyword);
        if (results.length === 0) {
          return { kind: "message", message: `未找到匹配 "${keyword}" 的记忆` };
        }
        const lines = [`找到 ${results.length} 条匹配:`];
        for (const entry of results) {
          lines.push(`  [${entry.scope}] ${entry.key}: ${entry.value}`);
        }
        return { kind: "message", message: lines.join("\n") };
      }

      case "list":
      case "ls":
      default: {
        const entries = await store.list();
        if (entries.length === 0) {
          return { kind: "message", message: "暂无记忆\n使用 /memory set <key> <value> 添加记忆" };
        }
        const stats = await store.getStats();
        const lines = [`记忆列表 (全局 ${stats.globalCount} 条, 项目 ${stats.projectCount} 条):`];
        for (const entry of entries) {
          const date = new Date(entry.updatedAt).toLocaleDateString();
          lines.push(`  [${entry.scope}] ${entry.key}: ${entry.value} (${date})`);
        }
        return { kind: "message", message: lines.join("\n") };
      }
    }
  }
}

/** /mcp 命令 */
export class MCPCommand implements Command {
  name() { return "mcp"; }
  aliases() { return []; }
  description() { return "显示 MCP 服务器连接状态"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return {
        kind: "message",
        message: "未配置 MCP 服务器\n在 ~/.sid-code/config.yaml 或 .mcp.json 中添加 mcp_servers 配置",
      };
    }

    const statuses = ctx.mcpManager.getStatus();
    if (statuses.length === 0) {
      return { kind: "message", message: "没有已连接的 MCP 服务器" };
    }

    const lines = ["MCP 服务器状态:"];
    for (const s of statuses) {
      const status = s.connecting ? "连接中..." : s.connected ? "已连接" : "连接失败";
      const tools = s.connected ? `${s.toolCount} 个工具` : "";
      const error = s.error ? ` (${s.error})` : "";
      lines.push(`  ${s.name} [${s.transport}] — ${status} ${tools}${error}`);
    }
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /rewind 命令 — 回退最近 n 轮对话 */
export class RewindCommand implements Command {
  name() { return "rewind"; }
  aliases() { return []; }
  description() { return "回退最近 n 轮对话（默认 1 轮）"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const n = Math.max(1, parseInt(args.trim()) || 1);
    const removed = ctx.ctxMgr.rewindTurns(n);
    if (removed === 0) {
      return { kind: "message", message: "没有可回退的对话" };
    }
    return {
      kind: "message",
      message: `已回退 ${removed} 轮对话，当前共 ${ctx.ctxMgr.getTurnCount()} 轮`,
    };
  }
}

/** /stats 命令 — 会话统计 */
export class StatsCommand implements Command {
  name() { return "stats"; }
  aliases() { return []; }
  description() { return "显示当前会话统计信息"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const { SessionState } = await import("../session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();
    const totalToolCalls = Object.values(ss.modelUsage).reduce((sum, m) => sum + m.requests, 0);

    const lines = [
      "会话统计",
      "─────────────────────",
      `对话轮数：${ctx.ctxMgr.getTurnCount()}`,
      `消息总数：${ctx.ctxMgr.messageCount()}`,
      `Token 用量：输入 ${totalUsage.inputTokens} / 输出 ${totalUsage.outputTokens}`,
      `API 请求：${totalToolCalls} 次`,
      `预估费用：$${ss.totalCostUSD.toFixed(4)}`,
      `会话时长：${SessionState.formatDuration(ss.getElapsedMs())}`,
    ];
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /init 命令 — 初始化项目配置目录 */
export class InitCommand implements Command {
  name() { return "init"; }
  aliases() { return []; }
  description() { return "在当前项目初始化 .sid-code/ 配置目录"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const fs = await import("fs/promises");
    const path = await import("path");
    const cwd = process.cwd();

    const dirs = [
      ".sid-code/commands",
      ".sid-code/skills",
      ".sid-code/agents",
    ];

    const created: string[] = [];
    const skipped: string[] = [];

    for (const dir of dirs) {
      const fullPath = path.join(cwd, dir);
      try {
        await fs.mkdir(fullPath, { recursive: true });
        created.push(dir);
      } catch {
        skipped.push(dir);
      }
    }

    // 创建示例 CLAUDE.md（如不存在）
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    let claudeMdCreated = false;
    try {
      await fs.access(claudeMdPath);
    } catch {
      // 不存在，创建示例
      const example = `# 项目说明\n\n在此描述项目背景、技术栈、编码约定等，sid-code 会将此文件注入系统提示词。\n`;
      await fs.writeFile(claudeMdPath, example, "utf-8");
      claudeMdCreated = true;
    }

    const lines: string[] = [];
    if (created.length > 0) lines.push(`已创建目录:\n${created.map(d => `  ${d}/`).join("\n")}`);
    if (skipped.length > 0) lines.push(`已存在（跳过）:\n${skipped.map(d => `  ${d}/`).join("\n")}`);
    if (claudeMdCreated) lines.push("已创建 CLAUDE.md 示例文件");

    lines.push("\n提示：", "  .sid-code/commands/ — 放置自定义斜杠命令 (.md)", "  .sid-code/skills/   — 放置 Skills 提示词模板 (.md)", "  .sid-code/agents/   — 放置自定义 Agent 定义 (.md)");

    return { kind: "message", message: lines.join("\n") };
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
  registry.register(new RewindCommand());
  registry.register(new StatsCommand());
  registry.register(new InitCommand());
}
