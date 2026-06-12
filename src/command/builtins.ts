/**
 * 内置斜杠命令
 * 提供 /help, /model, /cost, /compact, /clear, /exit, /sessions, /resume, /config
 * /rewind, /stats, /telemetry, /init
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { clearPromptCache } from "../config/system-prompt.ts";

/** /help 命令 */
export class HelpCommand implements Command {
  name() { return "help"; }
  aliases() { return ["h", "?"]; }
  description() { return "显示帮助信息"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const trimmed = args.trim();

    // 如果指定了命令名，显示该命令的详细帮助
    if (trimmed) {
      return this.showCommandHelp(trimmed, ctx);
    }

    // 显示所有命令列表
    const lines = [
      "可用命令:",
      "  /help [command]  - 显示帮助信息（可指定命令查看详情）",
      "  /model [name]    - 显示/切换模型",
      "  /model list      - 显示所有可用模型",
      "  /cost            - 显示 token 用量和费用",
      "  /cache           - 缓存命中率/省钱长期统计（--period|--model|--breaks|--prune）",
      "  /compact         - 压缩对话历史",
      "  /clear           - 清空对话",
      "  /rewind [n]      - 回退最近 n 轮对话（默认 1 轮）",
      "  /stats           - 显示会话统计",
      "  /telemetry       - 显示遥测摘要（Span 树 + Metric 汇总）",
      "  /sessions        - 列出历史会话",
      "  /config          - 显示当前配置",
      "  /undo [file]     - 撤销最近一次文件修改（可指定文件路径）",
      "  /checkpoints     - 查看快照历史",
      "  /restore <id>    - 恢复到指定快照点",
      "  /memory          - 管理记忆 (set/get/delete/list/search/show/reload)",
      "  /mcp             - MCP 服务器管理 (list/add/remove/enable/disable)",
      "  /skills          - Skills 管理 (list/enable/disable)",
      "  /agents          - 自定义 Agents 管理 (list)",
      "  /commands        - 列出自定义命令",
      "  /hooks           - Hook 管理 (list/enable/disable/enable-all/disable-all)",
      "  /plugin          - 插件管理 (list/info/install/uninstall/enable/disable)",
      "  /reload-plugins  - 重新加载所有插件组件",
      "  /plan            - 进入计划模式（先规划后执行）",
      "  /theme           - 显示或切换主题",
      "  /init            - 初始化项目 .sid-code/ 配置目录",
      "  /exit            - 退出",
    ];

    if (ctx.customCommands && ctx.customCommands.length > 0) {
      lines.push("", "自定义命令:");
      for (const cmd of ctx.customCommands) {
        const desc = cmd.description ? ` - ${cmd.description}` : "";
        lines.push(`  /${cmd.name}${desc}`);
      }
    }

    lines.push("", "提示: 使用 /help <command> 查看命令详情（如 /help mcp）");

    return { kind: "message", message: lines.join("\n") };
  }

  private showCommandHelp(cmdName: string, ctx: AppContext): CommandResult {
    // 这里需要访问 CommandRegistry，但当前 AppContext 没有暴露
    // 简化实现：只显示已知命令的帮助
    const helpTexts: Record<string, string> = {
      "mcp": `MCP 服务器管理

子命令:
  /mcp list              - 列出所有 MCP 服务器状态
  /mcp add <name> <cmd>  - 添加 MCP 服务器
    --scope user|project   配置作用域（默认 project）
    --transport stdio|http|sse  传输方式（默认 stdio）
    --timeout <ms>         连接超时（毫秒）
    --trust                信任服务器（跳过工具确认）
  /mcp remove <name>     - 移除 MCP 服务器
    --scope user|project   配置作用域
  /mcp enable <name>     - 启用 MCP 服务器
    --session              仅在当前会话启用
  /mcp disable <name>    - 禁用 MCP 服务器
    --session              仅在当前会话禁用
  /mcp test <name>       - 测试 MCP 服务器连接
  /mcp prompts           - 列出所有 MCP 提示词
  /mcp resources         - 列出所有 MCP 资源

示例:
  /mcp add myserver npx -y @modelcontextprotocol/server-filesystem /tmp
  /mcp add remote http://localhost:3000 --transport http
  /mcp disable myserver --session`,

      "skills": `Skills 管理

子命令:
  /skills list           - 列出所有 skills
    --all                  显示所有（含内置）
  /skills enable <name>  - 启用 skill
    --scope user|project   配置作用域（默认 user）
  /skills disable <name> - 禁用 skill
    --scope user|project   配置作用域

示例:
  /skills list
  /skills enable my-skill --scope project
  /skills disable my-skill`,

      "memory": `记忆管理

子命令:
  /memory set <key> <value>  - 设置记忆
    --scope global|project     作用域（默认 project）
  /memory get <key>          - 获取记忆
  /memory delete <key>       - 删除记忆
  /memory list               - 列出所有记忆
  /memory search <keyword>   - 搜索记忆
  /memory show               - 显示当前注入系统提示词的记忆内容
  /memory reload             - 重新加载记忆并刷新系统提示词

示例:
  /memory set api_key sk-xxx --scope global
  /memory get api_key
  /memory search api
  /memory show`,

      "model": `模型管理

用法:
  /model              - 显示当前模型
  /model list         - 显示所有可用模型
  /model <name>       - 切换到指定模型

示例:
  /model claude-opus-4-20250514
  /model list`,
    };

    const helpText = helpTexts[cmdName];
    if (helpText) {
      return { kind: "message", message: helpText };
    }

    return {
      kind: "message",
      message: `未找到命令 "${cmdName}" 的帮助信息\n使用 /help 查看所有可用命令`,
    };
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

    // 无参数且有可用模型时，打开交互式选择对话框
    if (ctx.config.availableModels.length > 0) {
      return { kind: "dialog", dialog: "model" };
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
      return "未配置可用模型列表\n请在 ~/.sid-code/settings.json 中添加 availableModels 配置";
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

    // 模块 B：本会话缓存命中率 + 省钱（经归一化单一事实源）
    const cacheView = ss.getNormalizedCacheUsage();
    if (cacheView.cacheHitTokens > 0 && cacheView.promptTotal > 0) {
      const rate = ((cacheView.cacheHitTokens / cacheView.promptTotal) * 100).toFixed(1);
      const savings = ss.getTotalCacheSavings();
      lines.push("", `缓存命中率: ${rate}%   省钱: $${savings.toFixed(4)}`);
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

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { getCheckpointManager } = await import("../checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    const trimmed = args.trim();

    // 如果指定了文件路径，回滚单个文件
    if (trimmed) {
      const result = await cpMgr.undoFile(trimmed);
      if (result) {
        const fileActions = result.files.map(f =>
          `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`
        ).join("\n");
        return {
          kind: "message",
          message: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
        };
      }
      return { kind: "message", message: `文件 ${trimmed} 没有可撤销的修改` };
    }

    // 回滚最近一次快照（可能包含多个文件）
    const result = await cpMgr.undo();
    if (result) {
      const fileActions = result.files.map(f =>
        `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`
      ).join("\n");
      return {
        kind: "message",
        message: `已撤销快照 ${result.snapshotId}:\n${fileActions}`,
      };
    }
    return { kind: "message", message: "没有可撤销的修改" };
  }
}

/** /checkpoints 命令 */
export class CheckpointsCommand implements Command {
  name() { return "checkpoints"; }
  aliases() { return ["cp"]; }
  description() { return "查看快照历史"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const { getCheckpointManager } = await import("../checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    const snapshots = cpMgr.listSnapshots();

    if (snapshots.length === 0) {
      return { kind: "message", message: "暂无快照历史" };
    }

    const lines = ["快照历史（最近 10 条）:", ""];

    // 只显示最近 10 条
    const recent = snapshots.slice(-10).reverse();

    for (const s of recent) {
      const time = new Date(s.timestamp);
      const timeStr = this.formatTime(time);
      const fileCountStr = `${s.fileCount} 个文件`;
      lines.push(`  ${s.id}  ${timeStr}  ${s.toolName.padEnd(8)}  ${s.toolSummary.slice(0, 40)}  (${fileCountStr})`);
    }

    lines.push("");
    lines.push("使用 /restore <ID> 恢复到指定快照点");
    lines.push("使用 /undo 撤销最近一次变更");

    return { kind: "message", message: lines.join("\n") };
  }

  private formatTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }
}

/** /restore 命令 */
export class RestoreCommand implements Command {
  name() { return "restore"; }
  aliases() { return []; }
  description() { return "恢复到指定快照点"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const snapshotId = args.trim();

    if (!snapshotId) {
      return { kind: "error", message: "用法: /restore <快照ID>\n使用 /checkpoints 查看可用快照" };
    }

    const { getCheckpointManager } = await import("../checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    // 获取快照详情
    const snapshot = cpMgr.getSnapshotDetail(snapshotId);
    if (!snapshot) {
      return { kind: "error", message: `快照不存在: ${snapshotId}` };
    }

    // 显示确认信息（需要用户确认）
    const allSnapshots = cpMgr.listSnapshots();
    const targetIndex = allSnapshots.findIndex(s => s.id === snapshotId);
    const snapshotsToRollback = allSnapshots.slice(targetIndex + 1);

    if (snapshotsToRollback.length === 0) {
      return { kind: "message", message: `快照 ${snapshotId} 已经是最新状态，无需恢复` };
    }

    const lines = [
      `将回滚以下 ${snapshotsToRollback.length} 个快照:`,
      "",
    ];

    for (const s of snapshotsToRollback.reverse()) {
      lines.push(`  ${s.id}: ${s.toolName} ${s.toolSummary.slice(0, 40)}`);
    }

    // 收集受影响的文件
    const affectedFiles = new Set<string>();
    for (const s of snapshotsToRollback) {
      const detail = cpMgr.getSnapshotDetail(s.id);
      if (detail) {
        for (const f of detail.files) {
          affectedFiles.add(f.filePath);
        }
      }
    }

    lines.push("");
    lines.push(`涉及 ${affectedFiles.size} 个文件:`);
    for (const file of Array.from(affectedFiles).slice(0, 10)) {
      lines.push(`  ${file}`);
    }
    if (affectedFiles.size > 10) {
      lines.push(`  ... 还有 ${affectedFiles.size - 10} 个文件`);
    }

    lines.push("");
    lines.push("⚠️ 此操作将丢失这些快照之后的所有变更！");
    lines.push("");
    lines.push("确认恢复？请回复 'yes' 确认，或其他任意内容取消。");

    // 返回需要确认的消息
    return {
      kind: "confirm",
      message: lines.join("\n"),
      onConfirm: async () => {
        const result = await cpMgr.restoreToSnapshot(snapshotId);
        if (result) {
          const fileActions = result.files.map(f =>
            `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`
          ).join("\n");
          return {
            kind: "message",
            message: `已恢复到快照 ${result.targetSnapshotId}，回滚了 ${result.snapshotsRolledBack} 个快照:\n${fileActions}`,
          };
        }
        return { kind: "error", message: "恢复失败" };
      },
    };
  }
}

/** /memory 命令 */
export class MemoryCommand implements Command {
  name() { return "memory"; }
  aliases() { return ["mem"]; }
  description() { return "管理记忆（set/get/delete/list/search/show/reload）"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
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

      case "show": {
        // 显示当前注入系统提示词的记忆内容
        const summary = await store.generateSummary();
        if (!summary) {
          return { kind: "message", message: "当前没有记忆被注入系统提示词" };
        }
        const stats = await store.getStats();
        const lines = [
          `当前注入系统提示词的记忆 (全局 ${stats.globalCount} 条, 项目 ${stats.projectCount} 条):`,
          "",
          summary,
        ];
        return { kind: "message", message: lines.join("\n") };
      }

      case "reload": {
        // 重新加载记忆并刷新系统提示词
        const freshStore = new MemoryStore(process.cwd());
        const freshSummary = await freshStore.generateSummary() || undefined;

        if (freshSummary) {
          // 重建系统提示词
          const { buildSystemPrompt } = await import("../config/system-prompt.ts");
          const { loadAllCLAUDEmd } = await import("../config/rules.ts");
          const projectRules = await loadAllCLAUDEmd(process.cwd());

          const newPrompt = buildSystemPrompt({
            tools: ctx.registry.all(),
            projectRules: projectRules?.rawContent || undefined,
            projectRulesPath: projectRules?.sourcePath,
            appendPrompt: ctx.config.appendSystemPrompt || undefined,
            workingDir: process.cwd(),
            permissionMode: ctx.config.permissionMode,
            gitStatus: true,
            memorySummary: freshSummary,
            preferredLanguage: ctx.config.language,
            model: ctx.config.model,
            maxTokens: 180000,
          });
          ctx.ctxMgr.setSystemPrompt(newPrompt);
          clearPromptCache();

          return { kind: "message", message: `记忆已重新加载，系统提示词已刷新 (${newPrompt.length} 字符)` };
        }

        return { kind: "message", message: "记忆为空，无需刷新" };
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
  description() { return "MCP 管理：/mcp [status|prompts|resources|prompt <server>:<name>]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return {
        kind: "message",
        message: "未配置 MCP 服务器\n在 ~/.sid-code/settings.json 或项目 .mcp.json 中添加 mcpServers 配置",
      };
    }

    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase() || "status";

    switch (subCmd) {
      case "status":
      case "":
        return this.showStatus(ctx);
      case "prompts":
        return this.listPrompts(ctx);
      case "prompt":
        return this.usePrompt(parts.slice(1).join(" "), ctx);
      case "resources":
        return this.listResources(ctx);
      default:
        return this.showStatus(ctx);
    }
  }

  private showStatus(ctx: AppContext): CommandResult {
    const statuses = ctx.mcpManager!.getStatus();
    if (statuses.length === 0) {
      return { kind: "message", message: "没有已连接的 MCP 服务器" };
    }

    const lines = ["MCP 服务器状态:"];
    for (const s of statuses) {
      const statusText = {
        connected: "已连接",
        connecting: "连接中...",
        reconnecting: "重连中...",
        failed: "连接失败",
        disabled: "已禁用",
        disconnected: "未连接",
      }[s.status] || s.status;
      const counts: string[] = [];
      if (s.status === "connected") {
        counts.push(`${s.toolCount} 个工具`);
        if (s.resourceCount > 0) counts.push(`${s.resourceCount} 个资源`);
        if (s.promptCount > 0) counts.push(`${s.promptCount} 个提示词`);
      }
      const reconnect = s.reconnectAttempts ? ` 重连 ${s.reconnectAttempts}/5` : "";
      const error = s.error ? ` (${s.error})` : "";
      lines.push(`  ${s.name} [${s.transport}] — ${statusText} ${counts.join(", ")}${reconnect}${error}`);
    }
    return { kind: "message", message: lines.join("\n") };
  }

  private listPrompts(ctx: AppContext): CommandResult {
    const prompts = ctx.mcpManager!.getAllPrompts();
    if (prompts.length === 0) {
      return { kind: "message", message: "没有可用的 MCP 提示词" };
    }

    const lines = ["MCP 提示词:"];
    for (const { serverName, prompt } of prompts) {
      const argList = prompt.arguments?.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(" ") || "";
      const desc = prompt.description ? ` — ${prompt.description}` : "";
      lines.push(`  /mcp prompt ${serverName}:${prompt.name} ${argList}${desc}`);
    }
    return { kind: "message", message: lines.join("\n") };
  }

  private async usePrompt(args: string, ctx: AppContext): Promise<CommandResult> {
    // 格式：<server>:<promptName> [arg1=val1 arg2=val2 ...]
    const match = args.match(/^(\S+?):(\S+)(?:\s+(.*))?$/);
    if (!match) {
      return {
        kind: "error",
        message: "用法: /mcp prompt <server>:<name> [arg1=val1 arg2=val2 ...]",
      };
    }

    const [, serverName, promptName, argStr] = match;
    const promptArgs: Record<string, string> = {};
    if (argStr) {
      for (const pair of argStr.split(/\s+/)) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          promptArgs[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
    }

    try {
      const messages = await ctx.mcpManager!.getPrompt(serverName, promptName, Object.keys(promptArgs).length > 0 ? promptArgs : undefined);
      // 将提示词消息拼接为文本，提交给 LLM
      const text = messages.map(m => m.content).join("\n\n");
      return { kind: "submit_prompt", prompt: text };
    } catch (err: any) {
      return { kind: "error", message: `获取提示词失败: ${err.message}` };
    }
  }

  private listResources(ctx: AppContext): CommandResult {
    const resources = ctx.mcpManager!.getAllResources();
    if (resources.length === 0) {
      return { kind: "message", message: "没有可用的 MCP 资源" };
    }

    const lines = ["MCP 资源:"];
    for (const { serverName, resource } of resources) {
      const desc = resource.description ? ` — ${resource.description}` : "";
      const mime = resource.mimeType ? ` [${resource.mimeType}]` : "";
      lines.push(`  ${serverName}: ${resource.name} (${resource.uri})${mime}${desc}`);
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

/** /hooks 命令 — Hook 管理 */
export class HooksCommand implements Command {
  name() { return "hooks"; }
  aliases() { return []; }
  description() { return "管理 Hook (list/enable/disable/enable-all/disable-all)"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.hookSystem) {
      return { kind: "error", message: "Hook 系统未初始化" };
    }

    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0] || "";
    const hookName = parts.slice(1).join(" ");

    switch (subCmd) {
      case "":
      case "list":
        return this.listHooks(ctx);
      case "enable":
        if (!hookName) return { kind: "error", message: "用法: /hooks enable <name>" };
        ctx.hookSystem.setHookEnabled(hookName, true);
        return { kind: "message", message: `已启用 hook: ${hookName}` };
      case "disable":
        if (!hookName) return { kind: "error", message: "用法: /hooks disable <name>" };
        ctx.hookSystem.setHookEnabled(hookName, false);
        return { kind: "message", message: `已禁用 hook: ${hookName}` };
      case "enable-all":
        ctx.hookSystem.setAllEnabled(true);
        return { kind: "message", message: "已启用所有 hook" };
      case "disable-all":
        ctx.hookSystem.setAllEnabled(false);
        return { kind: "message", message: "已禁用所有 hook" };
      default:
        return { kind: "error", message: `未知子命令: ${subCmd}\n用法: /hooks [list|enable|disable|enable-all|disable-all]` };
    }
  }

  private listHooks(ctx: AppContext): CommandResult {
    const hooks = ctx.hookSystem!.getAllHooks();
    if (hooks.length === 0) {
      return { kind: "message", message: "没有已注册的 hook" };
    }

    const lines = ["已注册的 Hook:"];
    for (const entry of hooks) {
      const status = entry.enabled ? "✓" : "✗";
      const name = entry.config.name
        || (entry.config.type === "command" ? entry.config.command : "")
        || (entry.config.type === "url" ? entry.config.url : "")
        || "unknown";
      const type = entry.config.type || "command";
      const matcher = entry.matcher ? ` [${entry.matcher}]` : "";
      const source = entry.source;
      lines.push(`  ${status} [${entry.eventName}] ${name} (${type}, ${source})${matcher}`);
    }
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /plan 命令 — 进入/退出计划模式 */
export class PlanCommand implements Command {
  name() { return "plan"; }
  aliases() { return []; }
  description() { return "进入计划模式（先规划后执行）"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { PlanModeManager } = await import("../plan/state.ts");

    // 从 App 获取 planManager（通过 sendToLLM 间接触发）
    // /plan 命令的实现方式：注入提示词让 LLM 调用 enter_plan_mode 工具
    const trimmed = args.trim();

    if (trimmed === "exit" || trimmed === "quit") {
      return {
        kind: "submit_prompt",
        prompt: "请退出计划模式。如果你有未完成的计划，先保存到计划文件，然后调用 exit_plan_mode 工具提交审批。",
      };
    }

    if (trimmed === "status") {
      const mode = ctx.config.permissionMode;
      if (mode === "plan") {
        return { kind: "message", message: "当前处于计划模式" };
      }
      return { kind: "message", message: "当前不在计划模式" };
    }

    // 默认：进入计划模式
    const taskDesc = trimmed ? `\n\n用户的任务描述: ${trimmed}` : "";
    return {
      kind: "submit_prompt",
      prompt: `请调用 enter_plan_mode 工具进入计划模式，然后开始分析代码库并制定实现方案。${taskDesc}`,
    };
  }
}

/** /telemetry 命令 — 展示当前会话的 Span 树和 Metric 汇总 */
export class TelemetryCommand implements Command {
  name() { return "telemetry"; }
  aliases() { return ["tele"]; }
  description() { return "显示当前会话遥测摘要（Span 树 + Metric 汇总）"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getTelemetryBus } = await import("../telemetry/index.ts");
    const { ATTR } = await import("../telemetry/types.ts");
    const bus = getTelemetryBus();

    if (!bus.isEnabled()) {
      return { kind: "message", message: "遥测未启用。在 ~/.sid-code/app.json 中设置 telemetry.enabled: true" };
    }

    const spans = bus.getCompletedSpans();
    const metrics = bus.getCompletedMetrics();

    if (spans.length === 0 && metrics.length === 0) {
      return { kind: "message", message: "当前会话暂无遥测数据" };
    }

    const lines: string[] = ["遥测摘要", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];

    const chatSpans = spans.filter(s => s.kind === "chat");
    const toolSpans = spans.filter(s => s.kind === "execute_tool");

    // === 总览（最重要的信息放最前面）===
    if (chatSpans.length > 0) {
      let totalIn = 0, totalOut = 0, totalCost = 0, totalCacheSavings = 0;
      const ttfts: number[] = [];
      for (const s of chatSpans) {
        totalIn += (s.attributes[ATTR.INPUT_TOKENS] as number) || 0;
        totalOut += (s.attributes[ATTR.OUTPUT_TOKENS] as number) || 0;
        totalCost += (s.attributes[ATTR.COST_USD] as number) || 0;
        totalCacheSavings += (s.attributes[ATTR.CACHE_SAVINGS_USD] as number) || 0;
        const ttft = s.attributes["sidcode.ttft_ms"] as number;
        if (ttft) ttfts.push(ttft);
      }

      // 按工具名统计
      const toolCounts = new Map<string, number>();
      for (const s of toolSpans) {
        const name = (s.attributes[ATTR.TOOL_NAME] as string) || "unknown";
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }

      lines.push("");
      lines.push(`  LLM 调用: ${chatSpans.length} 轮`);
      lines.push(`  Token 消耗: ${fmtNum(totalIn + totalOut)} (输入 ${fmtNum(totalIn)} / 输出 ${fmtNum(totalOut)})`);
      if (totalCost > 0) {
        lines.push(`  费用: $${totalCost.toFixed(4)}`);
      }
      if (totalCacheSavings > 0) {
        lines.push(`  缓存节省: $${totalCacheSavings.toFixed(4)}`);
      }
      if (ttfts.length > 0) {
        const avgTtft = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
        lines.push(`  首 Token 延迟 (TTFT): 平均 ${Math.round(avgTtft)}ms`);
      }
      if (toolSpans.length > 0) {
        const toolSummary = Array.from(toolCounts.entries())
          .map(([n, c]) => `${n}×${c}`)
          .join(", ");
        lines.push(`  工具调用: ${toolSpans.length} 次 (${toolSummary})`);
      }
    }

    // === 调用时间线 ===
    if (spans.length > 0) {
      lines.push("", "调用时间线:");
      const tree = buildSpanTree(spans);
      for (let i = 0; i < tree.length; i++) {
        renderSpanNode(tree[i], lines, "  ", ATTR, i + 1);
      }
    }

    // === Metric 明细（仅在有非 token/cost 的额外指标时展示）===
    if (metrics.length > 0) {
      const agg = aggregateMetrics(metrics);
      // 过滤掉已在总览中展示的指标
      const extraMetrics = Object.entries(agg).filter(([name]) =>
        name !== "gen_ai.client.token.usage" && name !== "sidcode.cost.usd"
      );
      if (extraMetrics.length > 0) {
        lines.push("", "其他指标:");
        for (const [name, info] of extraMetrics) {
          const label = METRIC_LABELS[name] || name;
          if (info.type === "counter") {
            lines.push(`  ${label}: ${fmtNum(info.sum)}`);
          } else if (info.type === "gauge") {
            lines.push(`  ${label}: ${fmtNum(info.last)}`);
          } else {
            lines.push(`  ${label}: ${info.count} 次, 平均 ${fmtNum(info.sum / info.count)}, 最大 ${fmtNum(info.max)}`);
          }
        }
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

// --- TelemetryCommand 辅助函数 ---

/** Metric 名称 → 中文标签映射 */
const METRIC_LABELS: Record<string, string> = {
  "gen_ai.client.token.usage": "Token 消耗",
  "sidcode.cost.usd": "费用 (USD)",
  "sidcode.cost.cache_savings_usd": "缓存节省 (USD)",
  "sidcode.budget.remaining_usd": "预算剩余 (USD)",
  "sidcode.budget.usage_percent": "预算使用率 (%)",
};

interface SpanTreeNode {
  span: import("../telemetry/types.ts").SpanData;
  children: SpanTreeNode[];
}

/** 将扁平 span 列表构建为树 */
function buildSpanTree(spans: readonly import("../telemetry/types.ts").SpanData[]): SpanTreeNode[] {
  const nodeMap = new Map<string, SpanTreeNode>();
  const roots: SpanTreeNode[] = [];

  // 创建所有节点
  for (const span of spans) {
    nodeMap.set(span.spanId, { span, children: [] });
  }

  // 建立父子关系
  for (const span of spans) {
    const node = nodeMap.get(span.spanId)!;
    if (span.parentSpanId && nodeMap.has(span.parentSpanId)) {
      nodeMap.get(span.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/** Span kind → 中文标签 */
const SPAN_KIND_LABELS: Record<string, string> = {
  invoke_agent: "Agent",
  chat: "LLM 调用",
  execute_tool: "工具",
};

/** 递归渲染 span 树节点 */
function renderSpanNode(
  node: SpanTreeNode,
  lines: string[],
  prefix: string,
  ATTR: typeof import("../telemetry/types.ts").ATTR,
  index?: number,
): void {
  const s = node.span;
  const dur = fmtDuration(s.durationMs);
  const statusMark = s.status === "error" ? " ✗" : "";
  const kindLabel = SPAN_KIND_LABELS[s.kind] || s.kind;
  const indexStr = index !== undefined ? `#${index} ` : "";

  let detail = "";
  if (s.kind === "chat") {
    const model = (s.attributes[ATTR.REQUEST_MODEL] as string) || "?";
    const shortModel = model.split("/").pop() || model;
    const ttft = s.attributes["sidcode.ttft_ms"] as number;
    const inTok = (s.attributes[ATTR.INPUT_TOKENS] as number) || 0;
    const outTok = (s.attributes[ATTR.OUTPUT_TOKENS] as number) || 0;
    const cost = (s.attributes[ATTR.COST_USD] as number) || 0;
    const parts = [dur];
    if (ttft) parts.push(`TTFT ${Math.round(ttft)}ms`);
    parts.push(`输入 ${fmtNum(inTok)} / 输出 ${fmtNum(outTok)}`);
    if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
    detail = ` ${shortModel} — ${parts.join(", ")}`;
  } else if (s.kind === "execute_tool") {
    const toolName = (s.attributes[ATTR.TOOL_NAME] as string) || "?";
    const toolDur = s.attributes["sidcode.tool.duration_ms"] as number;
    detail = ` ${toolName} — ${toolDur ? fmtDuration(toolDur) : dur}`;
  } else {
    detail = ` — ${dur}`;
  }

  lines.push(`${prefix}${indexStr}${kindLabel}${detail}${statusMark}`);

  for (let i = 0; i < node.children.length; i++) {
    const isLast = i === node.children.length - 1;
    const connector = isLast ? "└─ " : "├─ ";
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const childLines: string[] = [];
    renderSpanNode(node.children[i], childLines, childPrefix, ATTR);
    if (childLines.length > 0) {
      lines.push(`${prefix}${connector}${childLines[0].trimStart()}`);
      for (let j = 1; j < childLines.length; j++) {
        lines.push(childLines[j]);
      }
    }
  }
}

/** 聚合 metric 数据 */
function aggregateMetrics(metrics: readonly import("../telemetry/types.ts").MetricPoint[]): Record<string, {
  type: string; sum: number; count: number; max: number; last: number;
}> {
  const agg: Record<string, { type: string; sum: number; count: number; max: number; last: number }> = {};
  for (const m of metrics) {
    if (!agg[m.name]) {
      agg[m.name] = { type: m.type, sum: 0, count: 0, max: -Infinity, last: 0 };
    }
    const a = agg[m.name];
    a.sum += m.value;
    a.count++;
    if (m.value > a.max) a.max = m.value;
    a.last = m.value;
  }
  return agg;
}

/** 格式化数字（千分位） */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/** 格式化毫秒为可读时长 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${min}m${sec}s`;
}

/** 把 0~1 的比率序列渲染成 ▁▃▅▆▇█ sparkline */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values
    .map((v) => {
      const clamped = Math.max(0, Math.min(1, v));
      const idx = Math.min(chars.length - 1, Math.round(clamped * (chars.length - 1)));
      return chars[idx];
    })
    .join("");
}

/** /cache 命令 — 缓存命中长期统计与退化监测（模块 C3 + D3） */
export class CacheCommand implements Command {
  name() { return "cache"; }
  aliases() { return []; }
  description() { return "显示缓存命中率/省钱长期统计（--period day|week|month --model <name> --breaks --prune <N>）"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const { aggregateUsage, aggregateOverall } = await import("../telemetry/usage-aggregator.ts");
    const { pruneUsageLedger } = await import("../telemetry/usage-ledger.ts");
    const { getRecentCacheBreaks, getCacheHealthAdvice, formatCacheBreakReport } =
      await import("../api/cache-detection.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);

    // ── 参数解析 ──
    let granularity: "day" | "week" | "month" = "day";
    let model: string | undefined;
    let showBreaks = false;
    let pruneN: number | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--period" && tokens[i + 1]) {
        const p = tokens[++i];
        if (p === "day" || p === "week" || p === "month") granularity = p;
      } else if (t === "--model" && tokens[i + 1]) {
        model = tokens[++i];
      } else if (t === "--breaks") {
        showBreaks = true;
      } else if (t === "--prune" && tokens[i + 1]) {
        pruneN = parseInt(tokens[++i], 10);
      }
    }

    // ── --prune：滚动裁剪账本 ──
    if (pruneN !== undefined) {
      if (!Number.isFinite(pruneN) || pruneN < 0) {
        return { kind: "error", message: "--prune 需要一个非负整数" };
      }
      const kept = pruneUsageLedger(pruneN);
      return {
        kind: "message",
        message: kept >= 0 ? `账本已裁剪，保留最近 ${kept} 行` : "账本裁剪失败（文件不可写）",
      };
    }

    // ── --breaks：最近缓存中断记录 + 健康度建议（D3） ──
    if (showBreaks) {
      const breaks = getRecentCacheBreaks(20);
      const advice = getCacheHealthAdvice();
      const lines: string[] = ["缓存中断记录（最近 20 条）:"];
      if (breaks.length === 0) {
        lines.push("  （本会话暂无检测到缓存中断）");
      } else {
        for (const b of breaks) {
          const time = new Date(b.ts * 1000).toLocaleTimeString();
          lines.push(`  [${time}] ${b.model}: ${formatCacheBreakReport(b)}`);
        }
      }
      if (advice.length > 0) {
        lines.push("", "健康度建议:");
        for (const a of advice) lines.push(`  ⚠ ${a}`);
      }
      return { kind: "message", message: lines.join("\n") };
    }

    // ── 默认：长期命中率/省钱统计 ──
    const overall = aggregateOverall({ granularity, model });
    if (overall.totalSessions === 0) {
      return {
        kind: "message",
        message:
          "暂无用量账本数据。账本在每次会话结束时落一行到 ~/.sid-code/usage-ledger.jsonl，\n" +
          "跑完至少一个会话后再查。（当前会话的实时命中率见状态栏 ⚡ 列与 /stats）",
      };
    }

    const periods = aggregateUsage({ granularity, model });
    const lines: string[] = [];
    const periodLabel = granularity === "day" ? "按天" : granularity === "week" ? "按周" : "按月";
    lines.push(`缓存统计 (${periodLabel}${model ? `, 模型=${model}` : ""})`);

    // 总览
    const fmtTok = (n: number) =>
      n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
    const totalHit = Object.values(overall.byModel).reduce((s, m) => s + m.cacheHit, 0);
    const totalPrompt = Object.values(overall.byModel).reduce((s, m) => s + m.promptTotal, 0);
    const hitPct = (overall.totalHitRate * 100).toFixed(1);
    lines.push(`  总命中率:   ${hitPct}%   (${fmtTok(totalHit)} / ${fmtTok(totalPrompt)} tokens)`);
    lines.push(`  累计省钱:   $${overall.totalSavingsUSD.toFixed(4)}`);
    lines.push(`  累计成本:   $${overall.totalCostUSD.toFixed(4)}   (${overall.totalSessions} 会话)`);

    // Usage by model（按命中 token 降序）
    const models = Object.entries(overall.byModel);
    if (models.length > 0) {
      lines.push("  Usage by model:");
      models.sort(([, a], [, b]) => b.cacheHit - a.cacheHit);
      for (const [name, m] of models) {
        const rate = m.promptTotal > 0 ? Math.round((m.cacheHit / m.promptTotal) * 100) : 0;
        lines.push(`    ${name}:  命中 ${rate}%  省 $${m.savingsUSD.toFixed(4)}  (${m.sessions} 会话)`);
      }
    }

    // 趋势 sparkline（各周期命中率）
    if (periods.length >= 2) {
      const rates = periods.map((p) => p.totalHitRate);
      const unit = granularity === "day" ? "日" : granularity === "week" ? "周" : "月";
      lines.push(`  趋势(${periods.length}${unit}命中率): ${sparkline(rates)}   ← 上升=前缀越来越稳定`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** 注册所有内置命令 */
export async function registerBuiltins(registry: import("./registry.ts").Registry): Promise<void> {
  registry.register(new HelpCommand());
  registry.register(new ModelCommand());
  registry.register(new CostCommand());
  registry.register(new CacheCommand());
  registry.register(new CompactCommand());
  registry.register(new ClearCommand());
  registry.register(new ConfigCommand());
  registry.register(new UndoCommand());
  registry.register(new CheckpointsCommand());
  registry.register(new RestoreCommand());
  registry.register(new MemoryCommand());

  // 使用增强版 MCP 命令
  const { MCPEnhancedCommand } = await import("./mcp-enhanced.ts");
  registry.register(new MCPEnhancedCommand());

  // IDE 集成命令
  const { IDECommand } = await import("./ide.ts");
  registry.register(new IDECommand());

  // 注册扩展管理命令
  const { SkillsCommand, AgentsCommand, CommandsListCommand } = await import("./extensions.ts");
  registry.register(new SkillsCommand());
  registry.register(new AgentsCommand());
  registry.register(new CommandsListCommand());

  registry.register(new ExitCommand());
  registry.register(new RewindCommand());
  registry.register(new StatsCommand());
  registry.register(new TelemetryCommand());
  registry.register(new InitCommand());
  registry.register(new HooksCommand());
  registry.register(new PlanCommand());

  // 主题切换命令
  const { ThemeCommand } = await import("./theme.ts");
  registry.register(new ThemeCommand());

  // 权限管理命令
  const { AllowCommand, DenyCommand, PermissionsCommand } = await import("./permissions.ts");
  registry.register(new AllowCommand());
  registry.register(new DenyCommand());
  registry.register(new PermissionsCommand());

  // 插件管理命令
  const { PluginCommand, ReloadPluginsCommand } = await import("./plugin.ts");
  registry.register(new PluginCommand());
  registry.register(new ReloadPluginsCommand());

  // Spec 18 高级特性命令
  const { PsCommand, WorktreeCommand, CronCommand } = await import("./advanced.ts");
  registry.register(new PsCommand());
  registry.register(new WorktreeCommand());
  registry.register(new CronCommand());
}
