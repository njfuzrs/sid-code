import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /help 命令 */
export class HelpCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();

    // 如果指定了命令名，显示该命令的详细帮助
    if (trimmed) {
      return this.showCommandHelp(trimmed, ctx);
    }

    // 无参数 → 打开交互式帮助面板
    return { type: "dialog", dialog: "help" };
  }

  private showCommandHelp(cmdName: string, ctx: CommandContext): LocalCommandResult {
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
  /trace --prune-index 5000  裁剪会话索引,只保留最近 N 行(手动,索引不自动清理)
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
      return { type: "text", value: helpText };
    }

    return {
      type: "text",
      value: `未找到命令 "${cmdName}" 的帮助信息\n使用 /help 查看所有可用命令`,
    };
  }
}
