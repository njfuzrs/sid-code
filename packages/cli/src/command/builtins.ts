/**
 * 内置斜杠命令
 * 提供 /help, /model, /cost, /compact, /clear, /exit, /sessions, /resume, /config
 * /rewind, /stats, /telemetry, /init
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

/** /help 命令 */
export class HelpCommand implements Command {
  name() {
    return "help";
  }
  aliases() {
    return ["h", "?"];
  }
  description() {
    return "显示帮助信息";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const trimmed = args.trim();

    // 如果指定了命令名，显示该命令的详细帮助
    if (trimmed) {
      return this.showCommandHelp(trimmed, ctx);
    }

    // 无参数 → 打开交互式帮助面板
    return { kind: "dialog", dialog: "help" };
  }

  private showCommandHelp(cmdName: string, ctx: AppContext): CommandResult {
    // 这里需要访问 CommandRegistry，但当前 AppContext 没有暴露
    // 简化实现：只显示已知命令的帮助
    const helpTexts: Record<string, string> = {
      mcp: `MCP 服务器管理

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

      skills: `Skills 管理

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

      memory: `记忆管理

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

      model: `模型管理

用法:
  /model                          - 打开模型选择对话框
  /model list                     - 显示所有可用模型 + 当前 fallback / 子代理映射
  /model <name> [-p]              - 切换主模型（-p 持久化到 settings.json）
  /model fallback <name> [-p]     - 切换 fallback 降级模型
  /model fallback clear [-p]      - 清除 fallback
  /model sub <type> <name> [-p]   - 切换子代理模型（type: default/explore/task/plan/summarize/verify）
  /model sub clear <type> [-p]    - 清除某类型子代理映射
  /model discover [--apply]       - 自动发现模型参数

持久化: 默认仅当会话生效；加 -p（别名 --persist / save）才写入 settings.json 跨会话保留。
对话框选择模型会自动持久化。

示例:
  /model glm-5.2 -p
  /model fallback deepseek-v4-flash -p
  /model sub verify glm-5.2 -p`,

      theme: `主题管理

用法:
  /theme              - 打开主题选择对话框
  /theme list         - 显示当前主题和可用主题列表
  /theme <name> [-p]  - 切换主题（-p 持久化到 settings.json）

持久化: 默认仅当会话生效；加 -p 才跨会话保留。对话框选择主题会自动持久化。
注意: 多词主题名直接写，如 /theme "Default Light" 或 /theme Default Light`,

      language: `输出语言偏好

用法:
  /language            - 显示当前语言偏好
  /language zh [-p]    - 中文优先
  /language en [-p]    - 英文优先
  /language auto [-p]  - 跟随用户输入语言（每轮按用户所用语言应答）
  /language unset [-p] - 清除偏好，回落缺省（中文优先）

注意: auto 与 unset 不同。auto 是"有偏好，内容是跟随用户"；unset 是"没有偏好，
回落产品缺省（中文优先）"。

别名: /lang
持久化: 默认仅当会话生效；加 -p 才写入 settings.json 跨会话保留。
切换后立即重建系统提示词，下一轮对话即用新语言（子代理同步生效）。
也可用启动参数 --language 或环境变量 SID_LANGUAGE。
优先级: --language > SID_LANGUAGE > settings.json > 缺省(中文优先)。

语言只是偏好，不是硬锁: 你随时可以在单轮里要求"用英文回答"，
模型会当轮照办，不会以"系统约束"为由拒绝。`,

      hooks: `Hook 管理

子命令:
  /hooks                    - 打开 Hook 管理面板
  /hooks list               - 列出所有已注册 hook 及启用状态
  /hooks enable <name> [-p] - 启用指定 hook
  /hooks disable <name> [-p]- 禁用指定 hook
  /hooks enable-all [-p]    - 启用所有 hook
  /hooks disable-all [-p]   - 禁用所有 hook

持久化: 默认仅当会话生效；加 -p 写入 settings.json disabledHooks 跨会话保留。`,

      allow: `添加 allow 权限规则

用法:
  /allow <规则> [-p] [--scope user|project]

持久化: 默认仅当会话生效；加 -p 写入 settings.json permissions.allow。
  --scope user      写入用户级配置（默认）
  --scope project   写入项目级配置

示例:
  /allow Bash(npm *)
  /allow Bash(npm *) -p
  /allow Read(*) -p --scope project`,

      deny: `添加 deny 权限规则

用法:
  /deny <规则> [-p] [--scope user|project]

持久化: 默认仅当会话生效；加 -p 写入 settings.json permissions.deny。
  --scope user      写入用户级配置（默认）
  --scope project   写入项目级配置

示例:
  /deny Bash(rm -rf *)
  /deny Bash(rm -rf *) -p
  /deny Bash(curl *) -p --scope project`,

      trace: `会话轨迹排查 —— 把当前/指定会话嚼碎成结构化排查摘要

用法:
  /trace                 分析当前正在跑的会话(进程内拿 sessionId,比时间猜测准)
  /trace latest          分析最近一次结束的历史会话
  /trace <id>            指定会话,支持前缀(如 /trace c857)
  /trace --list          列出最近 20 个会话(异常会话一眼可见)
  /trace --full          附带更多思维链/工具参数细节
  /trace --health        Provider 健康度看板(成功率/超时/TTFT 含缓存命中分桶,跨会话聚合)
  /trace --health 1h     指定聚合周期(1h|24h|7d,默认 24h)
  /trace --cache         跨会话缓存视图(命中率/省钱/中断归因/渠道可信度)
  /trace --cache --days 7  只看最近 N 天(不传=全部历史)
  /digest                /trace 的别名

输出内容:
  · 退出状态(end_turn/error/abort/user_interrupt)+ 是否异常
  · 异常信号(高/中/低):异常退出、孤儿 tool_use、工具失败、疑似循环、
    成本归零、协议违规、数据格式异常 —— 每条附"该看哪个原始文件"指针
  · 工具序列(· 正常 / ✗ 报错 / ○ 孤儿)+ 思维链要点 + 崩溃归因

排查 sid-code 自身问题(报错/崩溃/变慢/Agent 跑偏)时第一个该敲的命令,
读完摘要通常已知根因方向,不必从头翻原始 jsonl。详见 observability-debug skill。`,
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
  name() {
    return "model";
  }
  aliases() {
    return ["m"];
  }
  description() {
    return "显示或切换模型";
  }

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
    const lines = [`当前模型: ${ctx.config.model}`, `提供商: ${ctx.config.provider}`];
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
  name() {
    return "cost";
  }
  aliases() {
    return [];
  }
  description() {
    return "显示 token 用量和费用";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    const ss = ctx.sessionState;
    const totalUsage = ss.getTotalUsage();

    const lines = [
      `会话时长: ${SessionState.formatDuration(ss.getElapsedMs())}`,
      `总费用: $${ss.getEffectiveTotalCostUSD().toFixed(4)}`,
      ...(ss.sideCostUSD > 0
        ? [`  其中辅助调用: $${ss.sideCostUSD.toFixed(4)}（标题/记忆/分类/摘要等）`]
        : []),
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
      // P2-2：openai 协议路径为服务端隐式缓存（无客户端主动写入 cache_control，
      // cacheCreation 恒 0），命中率结构性上限约 60-70%，不同于 anthropic 族显式缓存的 90%+。
      // 对该族标注正常上限，避免用户把 60-70% 误判为 harness bug。以协议路径为准，非按模型名单。
      if (ctx.config.provider === "openai" && !totalUsage.cacheCreationInputTokens) {
        lines.push("  （openai 协议为隐式缓存，60-70% 属正常上限；90%+ 需 anthropic 族显式缓存）");
      }
    }

    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      lines.push("", "按模型统计（input 为 flow 累计口径，与上方汇总一致）:");
      for (const [model, stats] of models) {
        // ⚠️ 必须用 cumulativePromptTokens（flow 累计）而非 inputTokens（stock 末次值）。
        // 汇总 input 走 getTotalUsage() = ΣcumulativePromptTokens（flow），若此处用末次 stock，
        // 两者口径不一致：分模型之和 ≪ 汇总（末次值只保留最后一次请求的 prompt 长度），
        // 用户会看到"汇总 input 远大于分模型 input 之和"的诡异对不上。统一为 flow 口径。
        lines.push(
          `  ${model}: ${stats.requests} 次请求, $${stats.costUSD.toFixed(4)}, input=${stats.cumulativePromptTokens}, output=${stats.outputTokens}`,
        );
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /compact 命令 */
export class CompactCommand implements Command {
  name() {
    return "compact";
  }
  aliases() {
    return [];
  }
  description() {
    return "压缩对话历史";
  }

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
  name() {
    return "clear";
  }
  aliases() {
    return ["reset", "new"];
  }
  description() {
    return "清空对话历史";
  }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    return { kind: "clear" };
  }
}

/** /config 命令 */
export class ConfigCommand implements Command {
  name() {
    return "config";
  }
  aliases() {
    return ["settings"];
  }
  description() {
    return "显示当前配置";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    // 无参数 → 打开结构化配置浏览面板
    if (!_args.trim()) {
      return { kind: "dialog", dialog: "config" };
    }

    // 有参数（向后兼容文本模式）
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
  name() {
    return "exit";
  }
  aliases() {
    return ["quit", "q"];
  }
  description() {
    return "退出程序";
  }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    return { kind: "quit", message: "再见！" };
  }
}

/** /undo 命令 */
export class UndoCommand implements Command {
  name() {
    return "undo";
  }
  aliases() {
    return [];
  }
  description() {
    return "撤销最近一次文件修改（回滚到上一个 checkpoint）";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    const trimmed = args.trim();

    // 如果指定了文件路径，回滚单个文件
    if (trimmed) {
      const result = await cpMgr.undoFile(trimmed);
      if (result) {
        const fileActions = result.files
          .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
          .join("\n");
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
      const fileActions = result.files
        .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
        .join("\n");
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
  name() {
    return "checkpoints";
  }
  aliases() {
    return ["cp"];
  }
  description() {
    return "查看快照历史";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
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
      lines.push(
        `  ${s.id}  ${timeStr}  ${s.toolName.padEnd(8)}  ${s.toolSummary.slice(0, 40)}  (${fileCountStr})`,
      );
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
  name() {
    return "restore";
  }
  aliases() {
    return [];
  }
  description() {
    return "恢复到指定快照点";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const snapshotId = args.trim();

    if (!snapshotId) {
      return { kind: "error", message: "用法: /restore <快照ID>\n使用 /checkpoints 查看可用快照" };
    }

    const { getCheckpointManager } = await import("@sid-code/core/checkpoint/manager.ts");
    const cpMgr = await getCheckpointManager(
      ctx.checkpointSessionId ?? ctx.sessionState.sessionId,
      ctx.config.checkpoint,
    );

    // 获取快照详情
    const snapshot = cpMgr.getSnapshotDetail(snapshotId);
    if (!snapshot) {
      return { kind: "error", message: `快照不存在: ${snapshotId}` };
    }

    // 显示确认信息（需要用户确认）
    const allSnapshots = cpMgr.listSnapshots();
    const targetIndex = allSnapshots.findIndex((s) => s.id === snapshotId);
    const snapshotsToRollback = allSnapshots.slice(targetIndex + 1);

    if (snapshotsToRollback.length === 0) {
      return { kind: "message", message: `快照 ${snapshotId} 已经是最新状态，无需恢复` };
    }

    const lines = [`将回滚以下 ${snapshotsToRollback.length} 个快照:`, ""];

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
          const fileActions = result.files
            .map((f) => `  ${f.filePath}: ${f.action === "deleted" ? "已删除" : "已恢复"}`)
            .join("\n");
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
  name() {
    return "memory";
  }
  aliases() {
    return ["mem"];
  }
  description() {
    return "管理记忆（auto/external/set/get/delete/list/search/show/reload）";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 无参数 → 打开交互式记忆面板（auto-memory 条目管理 + f 键切回 CLAUDE.md 浏览）
    if (!args.trim()) {
      return { kind: "dialog", dialog: "memory" };
    }

    const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
    const store = new MemoryStore(process.cwd());
    await store.load();

    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0] || "list";

    switch (subCmd) {
      case "auto": {
        // M2：auto-memory 后台提取开关。/memory auto on|off|status [-p]
        const action = (parts[1] || "status").toLowerCase();
        const persist = args.includes("-p") || args.includes("--persist");

        if (action === "status" || action === "") {
          if (!ctx.getAutoMemoryState) {
            return { kind: "message", message: "auto-memory 状态不可用（运行环境未接线）" };
          }
          const st = ctx.getAutoMemoryState();
          const sourceLabel = {
            env: "环境变量 SID_CODE_AUTO_MEMORY",
            settings: "settings.json",
            default: "默认",
          }[st.source];
          const stateLabel = st.enabled ? "已启用（extraction on）" : "已禁用（extraction off）";
          return {
            kind: "message",
            message: [
              `auto-memory: ${stateLabel}`,
              `  来源: ${sourceLabel}`,
              "",
              "用法: /memory auto on|off [-p]（-p 持久化到 settings.json）",
            ].join("\n"),
          };
        }

        if (action !== "on" && action !== "off" && action !== "enable" && action !== "disable") {
          return { kind: "error", message: "用法: /memory auto on|off|status [-p]" };
        }

        const enable = action === "on" || action === "enable";
        if (!ctx.setAutoMemory) {
          return { kind: "message", message: "auto-memory 开关不可用（运行环境未接线）" };
        }
        // env 覆盖优先级更高：若 env 显式设值，运行时切换仍生效但重启后被 env 覆盖，提示用户。
        const envSet =
          process.env.SID_CODE_AUTO_MEMORY !== undefined && process.env.SID_CODE_AUTO_MEMORY !== "";
        await ctx.setAutoMemory(enable, persist);
        const lines = [
          `auto-memory 后台提取已${enable ? "启用" : "禁用"}${persist ? "（已持久化到 settings.json）" : "（仅本会话）"}`,
        ];
        if (envSet) {
          lines.push("⚠️ 检测到环境变量 SID_CODE_AUTO_MEMORY 已设置，重启后将以环境变量为准。");
        }
        return { kind: "message", message: lines.join("\n") };
      }

      case "external": {
        // M4-5：CLAUDE.md 外部 @import 审批开关。/memory external allow|deny|status
        // 让用户在启动对话框拒绝后仍有命令入口改主意（对齐 CC Config.tsx toggle）。
        const action = (parts[1] || "status").toLowerCase();

        if (action === "status" || action === "") {
          if (!ctx.getExternalImportsState) {
            return { kind: "message", message: "外部导入审批状态不可用（运行环境未接线）" };
          }
          const { approved } = ctx.getExternalImportsState();
          const stateLabel =
            approved === undefined
              ? "尚未询问（首次遇到外部导入时会弹审批对话框）"
              : approved
                ? "已允许（项目外的 @import 会被展开加载）"
                : "已禁用（项目外的 @import 会被跳过）";
          return {
            kind: "message",
            message: [
              `CLAUDE.md 外部导入: ${stateLabel}`,
              "",
              "用法: /memory external allow|deny|status",
              "  allow — 允许加载项目根之外（含 ~/）的 @import",
              "  deny  — 跳过所有项目外的 @import",
            ].join("\n"),
          };
        }

        if (action !== "allow" && action !== "deny" && action !== "on" && action !== "off") {
          return { kind: "error", message: "用法: /memory external allow|deny|status" };
        }

        if (!ctx.setExternalImportsApproved) {
          return { kind: "message", message: "外部导入审批开关不可用（运行环境未接线）" };
        }
        const approved = action === "allow" || action === "on";
        await ctx.setExternalImportsApproved(approved);
        return {
          kind: "message",
          message: approved
            ? "已允许 CLAUDE.md 外部导入，规则已重载（项目外的 @import 现在会被展开）。"
            : "已禁用 CLAUDE.md 外部导入，项目外的 @import 将被跳过。",
        };
      }

      case "set": {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (!key || !value) {
          return { kind: "error", message: "用法: /memory set <key> <value> [--global]" };
        }
        const scope = args.includes("--global") ? ("global" as const) : ("project" as const);
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
          return {
            kind: "message",
            message: `[${entry.scope}] ${entry.key} = ${entry.value}\n  更新时间: ${date}`,
          };
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
        // M11：重新加载记忆并刷新系统提示词。
        // 走 memorySystemPrompt 索引指针路径（与启动 init-helpers 一致），
        // 不再用 memorySummary 全文摘要（已下线双轨注入）。
        const freshStore = new MemoryStore(process.cwd());
        await freshStore.load();
        const { buildMemorySystemPrompt } = await import("@sid-code/core/memory/prompt.ts");
        const indexContent = await freshStore.getIndexContent();

        // 团队记忆索引一并注入（若启用）
        let teamIndexContent: string | null = null;
        try {
          const { isTeamMemoryEnabled } = await import("@sid-code/core/memory/team/paths.ts");
          if (isTeamMemoryEnabled(ctx.config.teamMemory)) {
            const { getTeamIndexContent } = await import("@sid-code/core/memory/team/store.ts");
            teamIndexContent = await getTeamIndexContent(process.cwd());
          }
        } catch {
          /* 团队记忆索引注入失败不阻断 reload */
        }

        const memorySystemPrompt = buildMemorySystemPrompt(indexContent, teamIndexContent);
        if (!memorySystemPrompt) {
          return { kind: "message", message: "记忆为空，无需刷新" };
        }

        // 重建系统提示词（索引指针进 core 区）
        const { buildSystemPrompt } = await import("@sid-code/core/config/system-prompt.ts");
        const { loadAllCLAUDEmd } = await import("@sid-code/core/config/rules.ts");
        const projectRules = await loadAllCLAUDEmd(process.cwd());

        const newPrompt = buildSystemPrompt({
          tools: ctx.registry.all(),
          projectRules: projectRules?.rawContent || undefined,
          projectRulesPath: projectRules?.sourcePath,
          appendPrompt: ctx.config.appendSystemPrompt || undefined,
          workingDir: process.cwd(),
          permissionMode: ctx.config.permissionMode,
          gitStatus: true,
          memorySystemPrompt,
          preferredLanguage: ctx.config.language,
          model: ctx.config.model,
          availableModels: ctx.config.availableModels,
          // 不再写死 maxTokens：交由 buildSystemPrompt 按模型 contextWindow 的 90% 动态推导
        });
        ctx.ctxMgr.setSystemPrompt(newPrompt);
        clearPromptCache();

        return {
          kind: "message",
          message: `记忆已重新加载，系统提示词已刷新 (${newPrompt.length} 字符)`,
        };
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

// B2：原 `/mcp` 命令类 MCPCommand 已删除（死代码，从未 new/register）。
// 唯一实现为 src/command/mcp-enhanced.ts 的 MCPEnhancedCommand；
// 其 usePrompt 逻辑已迁至 MCPPromptRunCommand（/mcp prompt 子命令，见 B3）。

/** /rewind 命令 — 回退最近 n 轮对话 */
export class RewindCommand implements Command {
  name() {
    return "rewind";
  }
  // P0-B2：`/checkpoint`（单数）作为别名——CC 用户敲这个词期待的是「回退到某个检查点」，
  // 语义落在本命令而非 `/checkpoints`（复数，只列快照，别名 /cp）。不加别名会让 CC 习惯落空。
  aliases() {
    return ["checkpoint"];
  }
  description() {
    return "回退会话（可选代码/对话/两者），等价 Esc+Esc";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const trimmed = args.trim();

    // P2-2：无参数 → 打开统一回退选择器（对标 CC 的 Esc+Esc 菜单）。
    // 让用户在交互面板里选「回退点」+「仅对话 / 对话+代码」，实现代码/对话/两者的统一入口。
    if (!trimmed) {
      return { kind: "dialog", dialog: "rewind" };
    }

    // 向后兼容：`/rewind <n>` 保留「仅回退 n 轮对话」的脚本化快捷路径（不弹面板、不动文件）。
    const n = Math.max(1, parseInt(trimmed) || 1);
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
  name() {
    return "stats";
  }
  aliases() {
    return [];
  }
  description() {
    return "显示当前会话统计信息";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    // 无参数 → 打开结构化统计面板（交互式）
    if (!_args.trim()) {
      return { kind: "dialog", dialog: "stats" };
    }

    // 有参数（如 /stats text）→ 文本模式（向后兼容脚本化场景）
    const { SessionState } = await import("@sid-code/core/session/state.ts");
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
      `预估费用：$${ss.getEffectiveTotalCostUSD().toFixed(4)}`,
      `会话时长：${SessionState.formatDuration(ss.getElapsedMs())}`,
    ];

    // P2-3：git 操作度量（commit/push/PR 创建等），有计数才展示，避免空行噪音。
    const { getGitOperationStats } = await import("@sid-code/core/tool/git-operation-tracking.ts");
    const git = getGitOperationStats();
    if (git.total > 0) {
      const detail = Object.entries(git.byKind)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`)
        .join(" / ");
      lines.push(`Git 操作：${git.total} 次（${detail}）`);
    }
    return { kind: "message", message: lines.join("\n") };
  }
}

/** /init 命令 — 初始化项目配置目录 */
/**
 * M1：`/init` 代码库分析 prompt（中文，对齐全局中文约定）。
 * 驱动模型 agentic 地扫描仓库、发现 build/test/lint 命令与项目约定，
 * 生成（或改进）一份真实、具体、可验证的 CLAUDE.md，而非占位符。
 * 对齐 CC commands/init.ts 的 type: 'prompt' 做法。
 */
const INIT_ANALYSIS_PROMPT = `请为当前代码库生成（或改进）一份 \`CLAUDE.md\` 文件，用于给未来在此仓库工作的 AI 编码助手提供指导。

## 执行步骤

1. **扫描项目结构**：用 glob/ls 查看项目根与关键子目录，识别整体布局与模块划分。
2. **识别技术栈与工具链**：读取以下文件（存在才读）推断语言、框架、包管理器：
   - \`package.json\` / \`bun.lockb\` / \`pnpm-lock.yaml\`（Node/前端）
   - \`Cargo.toml\`（Rust）、\`go.mod\`（Go）、\`pom.xml\` / \`build.gradle\`（Java/Kotlin）
   - \`pyproject.toml\` / \`requirements.txt\` / \`setup.py\`（Python）
   - \`Makefile\` / \`Justfile\` / \`Taskfile.yml\`（任务运行器）
3. **提取关键命令**：从上述文件的 scripts/targets 中找出真实的 **构建 / 测试 / lint / 类型检查 / 启动** 命令，务必写实际命令（如 \`bun test\`、\`make build\`），不要写占位符。
4. **提炼项目约定**：读 \`README\`、现有 \`CLAUDE.md\`、\`.gitignore\`、CI 配置（\`.github/workflows/\` 等），提炼编码风格、目录约定、提交规范、测试要求等。
5. **检查现有 CLAUDE.md**：
   - **若已存在**：先读取全文，以「改进建议」形式提出具体修改（缺什么、哪里过时），**不要静默覆盖**。除非用户明确要求重写，否则保留用户已有内容，只做增量补充。
   - **若不存在**：写一份新的 CLAUDE.md。

## CLAUDE.md 内容要求

- **语言**：用中文撰写（对齐本项目约定）。
- **长度**：目标 200 行以内，聚焦高价值信息，不要冗余。
- **结构建议**：项目简介 / 技术栈 / 常用命令（build、test、lint、run）/ 目录结构说明 / 编码约定 / 注意事项。
- **具体可验证**：每条命令、每个约定都应能被实际执行或核对，避免空泛描述。
- 若发现 \`.cursorrules\`、\`.github/copilot-instructions.md\` 等其它 AI 规则文件，可整合其有价值内容。

完成后，简要说明你做了哪些改动（新建还是改进、包含哪些关键命令），并提示用户可运行 \`/init --dirs-only\` 初始化 \`.sid-code/\` 自定义目录脚手架。`;

/**
 * M1：`/init` 命令。
 * - 默认（无参 / 非 --dirs-only）：返回 submit_prompt，驱动模型 agentic 分析代码库生成真实 CLAUDE.md。
 * - \`--dirs-only\`：仅执行 \`.sid-code/\` 目录脚手架（保留旧行为，不再写占位 CLAUDE.md）。
 */
export class InitCommand implements Command {
  name() {
    return "init";
  }
  aliases() {
    return [];
  }
  description() {
    return "分析代码库并生成 CLAUDE.md（--dirs-only 仅初始化 .sid-code/ 目录）";
  }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const dirsOnly = /(^|\s)--dirs-only(\s|$)/.test(args);

    // 默认路径：注入代码库分析 prompt，交给模型 agentic 执行（对齐 CC type: 'prompt'）。
    if (!dirsOnly) {
      return { kind: "submit_prompt", prompt: INIT_ANALYSIS_PROMPT };
    }

    // --dirs-only：仅做目录脚手架（旧脚手架能力保留，但不再写占位 CLAUDE.md）。
    const fs = await import("fs/promises");
    const path = await import("path");
    const cwd = process.cwd();

    const dirs = [".sid-code/commands", ".sid-code/skills", ".sid-code/agents"];

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

    const lines: string[] = [];
    if (created.length > 0) lines.push(`已创建目录:\n${created.map((d) => `  ${d}/`).join("\n")}`);
    if (skipped.length > 0)
      lines.push(`已存在（跳过）:\n${skipped.map((d) => `  ${d}/`).join("\n")}`);

    lines.push(
      "\n提示：",
      "  .sid-code/commands/ — 放置自定义斜杠命令 (.md)",
      "  .sid-code/skills/   — 放置 Skills 提示词模板 (.md)",
      "  .sid-code/agents/   — 放置自定义 Agent 定义 (.md)",
      "\n运行不带参数的 /init 可分析代码库并生成 CLAUDE.md。",
    );

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /hooks 命令 — Hook 管理 */
export class HooksCommand implements Command {
  name() {
    return "hooks";
  }
  aliases() {
    return [];
  }
  description() {
    return "管理 Hook (list/enable/disable/enable-all/disable-all，-p 持久化)";
  }
  argumentHint() {
    return "[list|enable|disable|enable-all|disable-all] [name] [-p]";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.hookSystem) {
      return { kind: "error", message: "Hook 系统未初始化" };
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    // 剥离持久化标志（-p / --persist / save），其余按 子命令 + hook 名解析。
    const persist = parts.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = parts.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const subCmd = rest[0] || "";
    const hookName = rest.slice(1).join(" ");
    const persistNote = persist ? "（已持久化到 settings.json）" : "（仅当前会话，加 -p 可持久化）";

    switch (subCmd) {
      case "":
        // 无参数 → 打开交互式 Hooks 管理面板
        return { kind: "dialog", dialog: "hooks" };
      case "list":
        return this.listHooks(ctx);
      case "enable":
        if (!hookName) return { kind: "error", message: "用法: /hooks enable <name> [-p]" };
        ctx.hookSystem.setHookEnabled(hookName, true);
        if (persist) this.persistHookDisabled(hookName, false);
        return { kind: "message", message: `已启用 hook: ${hookName}${persistNote}` };
      case "disable":
        if (!hookName) return { kind: "error", message: "用法: /hooks disable <name> [-p]" };
        ctx.hookSystem.setHookEnabled(hookName, false);
        if (persist) this.persistHookDisabled(hookName, true);
        return { kind: "message", message: `已禁用 hook: ${hookName}${persistNote}` };
      case "enable-all":
        ctx.hookSystem.setAllEnabled(true);
        // 全部启用 = 清空 disabledHooks（仅在 -p 时落盘）。
        if (persist) this.clearPersistedDisabled();
        return { kind: "message", message: `已启用所有 hook${persistNote}` };
      case "disable-all":
        ctx.hookSystem.setAllEnabled(false);
        // 全部禁用：把当前所有 hook 名写入 disabledHooks（仅在 -p 时落盘）。
        if (persist) this.persistAllDisabled(ctx);
        return { kind: "message", message: `已禁用所有 hook${persistNote}` };
      default:
        return {
          kind: "error",
          message: `未知子命令: ${subCmd}\n用法: /hooks [list|enable|disable|enable-all|disable-all] [-p]`,
        };
    }
  }

  /**
   * 增删 settings.json 顶层 disabledHooks（/hooks enable|disable -p 持久化端）。
   * 复用 /skills 的读-合并-补丁范式（禁整体覆盖，见 settings 有损 round-trip 陷阱）。
   * disable=true 追加 hook 名，false 移除。
   */
  private persistHookDisabled(hookName: string, disable: boolean): void {
    try {
      const {
        getSettingsForSource,
        patchSettingsFile,
      } = require("@sid-code/core/config/settings/index.ts");
      const { settings } = getSettingsForSource("userSettings");
      const set = new Set<string>(settings?.disabledHooks ?? []);
      if (disable) set.add(hookName);
      else set.delete(hookName);
      patchSettingsFile("userSettings", "disabledHooks", [...set]);
    } catch (e) {
      getLogger().warn("HOOK", `持久化 disabledHooks 失败（不阻断）: ${(e as Error)?.message}`);
    }
  }

  /** 清空 disabledHooks（/hooks enable-all -p）。 */
  private clearPersistedDisabled(): void {
    try {
      const { patchSettingsFile } = require("@sid-code/core/config/settings/index.ts");
      patchSettingsFile("userSettings", "disabledHooks", []);
    } catch (e) {
      getLogger().warn("HOOK", `清空 disabledHooks 失败（不阻断）: ${(e as Error)?.message}`);
    }
  }

  /** 把当前所有 hook 名写入 disabledHooks（/hooks disable-all -p）。 */
  private persistAllDisabled(ctx: AppContext): void {
    try {
      const names = ctx
        .hookSystem!.getAllHooks()
        .map((e) => ctx.hookSystem!.getHookName(e))
        .filter(Boolean);
      const { patchSettingsFile } = require("@sid-code/core/config/settings/index.ts");
      patchSettingsFile("userSettings", "disabledHooks", [...new Set(names)]);
    } catch (e) {
      getLogger().warn(
        "HOOK",
        `持久化 disabledHooks（全部）失败（不阻断）: ${(e as Error)?.message}`,
      );
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
      const name =
        entry.config.name ||
        (entry.config.type === "command" ? entry.config.command : "") ||
        (entry.config.type === "url" ? entry.config.url : "") ||
        "unknown";
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
  name() {
    return "plan";
  }
  aliases() {
    return [];
  }
  description() {
    return "进入计划模式（先规划后执行）";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 从 App 获取 planManager（通过 sendToLLM 间接触发）
    // /plan 命令的实现方式：注入提示词让 LLM 调用 enter_plan_mode 工具
    const trimmed = args.trim();

    if (trimmed === "exit" || trimmed === "quit") {
      return {
        kind: "submit_prompt",
        prompt:
          "请退出计划模式。如果你有未完成的计划，先保存到计划文件，然后调用 exit_plan_mode 工具提交审批。",
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
  name() {
    return "telemetry";
  }
  aliases() {
    return ["tele"];
  }
  description() {
    return "显示当前会话遥测摘要（Span 树 + Metric 汇总）";
  }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getTelemetryBus } = await import("@sid-code/core/telemetry/index.ts");
    const { ATTR } = await import("@sid-code/core/telemetry/types.ts");
    const bus = getTelemetryBus();

    if (!bus.isEnabled()) {
      return {
        kind: "message",
        message: "遥测未启用。在 ~/.sid-code/app.json 中设置 telemetry.enabled: true",
      };
    }

    const spans = bus.getCompletedSpans();
    const metrics = bus.getCompletedMetrics();

    if (spans.length === 0 && metrics.length === 0) {
      return { kind: "message", message: "当前会话暂无遥测数据" };
    }

    const lines: string[] = ["遥测摘要", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];

    const chatSpans = spans.filter((s) => s.kind === "chat");
    const toolSpans = spans.filter((s) => s.kind === "execute_tool");

    // === 总览（最重要的信息放最前面）===
    if (chatSpans.length > 0) {
      let totalIn = 0,
        totalOut = 0,
        totalCost = 0,
        totalCacheSavings = 0;
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
      lines.push(
        `  Token 消耗: ${fmtNum(totalIn + totalOut)} (输入 ${fmtNum(totalIn)} / 输出 ${fmtNum(totalOut)})`,
      );
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
      const extraMetrics = Object.entries(agg).filter(
        ([name]) => name !== "gen_ai.client.token.usage" && name !== "sidcode.cost.usd",
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
            lines.push(
              `  ${label}: ${info.count} 次, 平均 ${fmtNum(info.sum / info.count)}, 最大 ${fmtNum(info.max)}`,
            );
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
  span: import("@sid-code/core/telemetry/types.ts").SpanData;
  children: SpanTreeNode[];
}

/** 将扁平 span 列表构建为树 */
function buildSpanTree(
  spans: readonly import("@sid-code/core/telemetry/types.ts").SpanData[],
): SpanTreeNode[] {
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
  ATTR: typeof import("@sid-code/core/telemetry/types.ts").ATTR,
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
function aggregateMetrics(
  metrics: readonly import("@sid-code/core/telemetry/types.ts").MetricPoint[],
): Record<
  string,
  {
    type: string;
    sum: number;
    count: number;
    max: number;
    last: number;
  }
> {
  const agg: Record<
    string,
    { type: string; sum: number; count: number; max: number; last: number }
  > = {};
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
  name() {
    return "cache";
  }
  aliases() {
    return [];
  }
  description() {
    return "显示缓存命中率/省钱长期统计（--period day|week|month --model <name> --breaks --history --prune <N>）";
  }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const { aggregateUsage, aggregateOverall } =
      await import("@sid-code/core/telemetry/usage-aggregator.ts");
    const { pruneUsageLedger } = await import("@sid-code/core/telemetry/usage-ledger.ts");
    const { getRecentCacheBreaks, getCacheHealthAdvice, formatCacheBreakReport } =
      await import("@sid-code/core/api/cache-detection.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);

    // ── 参数解析 ──
    let granularity: "day" | "week" | "month" = "day";
    let model: string | undefined;
    let showBreaks = false;
    let showHistory = false;
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
      } else if (t === "--history") {
        showHistory = true;
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

    // ── --history：跨会话缓存中断遥测历史聚合（G13） ──
    if (showHistory) {
      const { queryCacheBreakHistory, summarizeCacheBreakHistory } =
        await import("@sid-code/core/telemetry/cache-telemetry.ts");
      const recent = queryCacheBreakHistory(20);
      const summary = summarizeCacheBreakHistory(500);
      const lines: string[] = ["缓存中断历史（跨会话，最近 20 条）:"];
      if (recent.length === 0) {
        lines.push("  （暂无历史中断记录。中断检测到时落 ~/.sid-code/cache-breaks.jsonl）");
        return { kind: "message", message: lines.join("\n") };
      }
      for (const e of recent) {
        const time = new Date(e.ts * 1000).toLocaleString();
        lines.push(
          `  [${time}] ${e.model}: 下降 ${e.dropPercent}% (${e.dropTokens} tok): ${e.changes.join("; ")}`,
        );
      }
      const cats = Object.entries(summary.byCategory).sort(([, a], [, b]) => b - a);
      if (cats.length > 0) {
        const labelOf: Record<string, string> = {
          model: "模型切换",
          system_prompt: "System prompt 变化",
          tool_order: "工具顺序变化",
          tools: "工具增删改",
          cache_policy: "缓存策略变化",
          beta_headers: "Beta headers 变化",
          compact: "压缩(消息骤减)",
          ttl_expiry: "TTL 过期",
          unknown: "未知",
        };
        lines.push("", `归因分布（最近 ${summary.total} 条中断）:`);
        for (const [cat, n] of cats) {
          lines.push(`  ${labelOf[cat] ?? cat}: ${n} 次`);
        }
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
    lines.push(
      `  累计成本:   $${overall.totalCostUSD.toFixed(4)}   (${overall.totalSessions} 会话)`,
    );

    // P0-4：排除了多少行必须显式写出来 —— 静默排除读起来像"全部数据都在这儿"。
    // 不打印被排除的数字本身：把假数字印出来，迟早有人当真数字抄走。
    if (overall.excludedUntrustedRows > 0) {
      lines.push(
        `  ⚠ 已排除 ${overall.excludedUntrustedRows} 个会话（渠道 usage 不可信，未计入以上数字）:`,
      );
      for (const h of overall.untrustedHosts) {
        lines.push(`      ${h.host}${h.reason ? `：${h.reason}` : ""}`);
      }
      lines.push(`      判定来自 cache-trust-probe 实测，见 ~/.sid-code/channel-trust.json`);
    }
    // P0-4 覆盖盲区：**排除数为 0 时也要说**。否则"没排除"读起来像"总计干净"，
    // 而实际是这些行没带 endpointHost、根本没进可信度判定（机制上线 ≠ 数据被治理）。
    if (overall.sessionsWithoutHost > 0) {
      lines.push(
        `  ⚠ ${overall.sessionsWithoutHost} 个会话无渠道标记（账本 2026-08-08 前不记 endpointHost），`,
      );
      lines.push(`      未参与可信度判定 —— 以上总计里可能仍混有不可信渠道的数字`);
    }

    // Usage by model（按命中 token 降序）
    const models = Object.entries(overall.byModel);
    if (models.length > 0) {
      lines.push("  Usage by model:");
      models.sort(([, a], [, b]) => b.cacheHit - a.cacheHit);
      for (const [name, m] of models) {
        const rate = m.promptTotal > 0 ? Math.round((m.cacheHit / m.promptTotal) * 100) : 0;
        // P0-4：渠道与数字同行出现 —— 同一模型经不同网关可信度不同，
        // 数字与"这个数的前提"分开放会让人只抄走数字。
        // 多渠道时全列出来：合并成一个百分比恰恰掩盖了渠道差异。
        const host =
          m.hosts.length === 0
            ? ""
            : m.hosts.length === 1
              ? `  @${m.hosts[0]}`
              : `  @${m.hosts.join(",")}`;
        lines.push(
          `    ${name}:  命中 ${rate}%  省 $${m.savingsUSD.toFixed(4)}  (${m.sessions} 会话)${host}`,
        );
      }
      // hosts 为空不是"没有渠道"，是"这些行早于渠道字段上线"——不点破会被读成前者
      if (models.some(([, m]) => m.hosts.length === 0)) {
        lines.push(`    （无 @渠道 标注的行来自 2026-08-08 之前的账本，那时还没记端点）`);
      }
    }

    // 趋势 sparkline（各周期命中率）
    if (periods.length >= 2) {
      const rates = periods.map((p) => p.totalHitRate);
      const unit = granularity === "day" ? "日" : granularity === "week" ? "周" : "月";
      lines.push(
        `  趋势(${periods.length}${unit}命中率): ${sparkline(rates)}   ← 上升=前缀越来越稳定`,
      );
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/**
 * /trace 命令 —— 把当前/指定会话的轨迹嚼碎成结构化排查摘要。
 * 与 scripts/trace-digest.ts 共用 src/trace/digest.ts 核心逻辑。
 *
 *   /trace            分析当前正在跑的会话(ctx.sessionId,比 mtime 猜测准)
 *   /trace latest     分析最近一次结束的历史会话
 *   /trace <id>       指定会话(支持前缀)
 *   /trace --list     列出最近 20 个会话(异常会话优先排查)
 *   /trace --full     附带更多思维链/参数细节
 */
export class TraceCommand implements Command {
  name() {
    return "trace";
  }
  aliases() {
    return ["digest"];
  }
  description() {
    return "排查会话:把当前/指定会话轨迹嚼碎成结构化摘要(--list 列会话, <id> 指定, --full 详细, --health 健康看板, --cache 缓存视图)";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { resolvePaths, listSessions, resolveSession, buildDigest, renderHuman, renderList } =
      await import("@sid-code/core/trace/digest.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const flags = new Set(tokens.filter((t) => t.startsWith("--")));
    const positional = tokens.filter((t) => !t.startsWith("--"));
    const full = flags.has("--full");
    // 命令面板渲染纯文本,固定无 ANSI 颜色码
    const renderOpts = { noColor: true, invocation: "/trace" };

    // T15.5：/trace --health 展示 Provider 健康度看板（跨会话聚合，独立于单会话轨迹）。
    // 支持 --period 1h|24h|7d（默认 24h）与 --provider NAME 过滤。
    if (flags.has("--health")) {
      const { aggregateProviderHealth, renderHealthText } =
        await import("@sid-code/core/telemetry/provider-health.ts");
      const periodTok = positional.find((t) => /^(1h|24h|7d)$/.test(t));
      const periodMs =
        periodTok === "1h" ? 3600_000 : periodTok === "7d" ? 86400_000 * 7 : 86400_000; // 默认 24h
      // --provider 后跟的值（positional 里排除周期 token 后的第一个）
      const provTok = positional.find((t) => t !== periodTok);
      const report = aggregateProviderHealth({ periodMs, provider: provTok });
      return { kind: "message", message: renderHealthText(report) };
    }

    // P2-4：跨会话缓存视图（命中率 / 省钱 / 中断归因 / 渠道可信度）。
    //
    // 此前 renderCacheSection 的唯一调用方是 scripts/trace-digest.ts —— 能力做完了
    // 却只能在仓库里跑脚本才看得到，产品内不可达。用户手上只有二进制，没有仓库。
    //
    // 必须放在下面 "no sessions" 早退**之前**：账本与 cache-breaks 是独立数据源
    //（~/.sid-code/usage-ledger.jsonl），trajectories 被 LRU 清掉后账本仍在，
    // 而那恰恰是最需要这个视图的时刻。与脚本侧的分支顺序刻意一致。
    if (flags.has("--cache")) {
      const { renderCacheSection } = await import("@sid-code/core/trace/cache-report.ts");
      // --days N 限定窗口（不传 = 全部历史）
      const daysIdx = tokens.indexOf("--days");
      const daysRaw = daysIdx >= 0 ? tokens[daysIdx + 1] : undefined;
      const days = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : undefined;
      // 命令面板固定纯文本（renderOpts.noColor 同源），避免 ANSI 码污染
      return {
        kind: "message",
        message: renderCacheSection({ noColor: true, sinceDays: days }),
      };
    }

    const paths = resolvePaths();
    const all = listSessions(paths);

    if (all.length === 0) {
      return {
        kind: "message",
        message: `未找到任何会话轨迹 (${paths.sessionsDir})。可能还没产生轨迹,或 SID_CODE_HOME 指向了别处。`,
      };
    }

    if (flags.has("--list")) {
      return { kind: "message", message: renderList(all, renderOpts) };
    }

    // 目标选择:显式参数优先;否则默认当前会话(进程内可靠拿到 ctx.sessionId,
    // 避免脚本 latest 的 mtime 猜测在并发时选错)。当前会话轨迹还没落盘时回退到 latest。
    let target = positional[0];
    let note = "";
    if (!target) {
      const hasCurrent = ctx.sessionId && all.some((s) => s.id === ctx.sessionId);
      if (hasCurrent) {
        target = ctx.sessionId;
      } else {
        target = "latest";
        note = ctx.sessionId
          ? `(当前会话 ${ctx.sessionId} 轨迹尚未落盘,改看最近一次历史会话;要指定用 /trace <id>)`
          : "";
      }
    }

    const { ref, warning } = resolveSession(target, all);
    if (!ref) {
      return {
        kind: "message",
        message: `未找到 session "${target}"。用 /trace --list 看可用会话。`,
      };
    }

    const digest = buildDigest(ref, full, paths);
    if (!digest) {
      return { kind: "message", message: `无法解析 ${ref.trajPath}(文件损坏?)` };
    }

    const parts: string[] = [];
    if (note) parts.push(note);
    if (warning) parts.push(`⚠ ${warning}`);
    parts.push(renderHuman(digest, renderOpts));
    return { kind: "message", message: parts.join("\n") };
  }
}

/** 注册所有内置命令 */
export async function registerBuiltins(registry: import("./registry.ts").Registry): Promise<void> {
  registry.register(new HelpCommand());
  registry.register(new ModelCommand());
  registry.register(new CostCommand());
  registry.register(new CacheCommand());
  registry.register(new TraceCommand());
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

  // 语言切换命令
  const { LanguageCommand } = await import("./language.ts");
  registry.register(new LanguageCommand());

  // 权限管理命令
  const { AllowCommand, DenyCommand, PermissionsCommand, AddDirCommand } =
    await import("./permissions.ts");
  registry.register(new AllowCommand());
  registry.register(new DenyCommand());
  registry.register(new PermissionsCommand());
  registry.register(new AddDirCommand());

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
