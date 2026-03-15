/**
 * CLI 入口
 * 使用 Node.js 内置 parseArgs 解析命令行参数，路由到不同模式
 */

// 强制启用终端颜色（必须在所有 import 之前，否则 chalk 检测不到 TTY）
if (!process.env.FORCE_COLOR && (process.stdout.isTTY || process.stderr.isTTY)) {
  process.env.FORCE_COLOR = "3";
}

import { parseArgs } from "node:util";
import { loadConfig } from "./config/config.ts";
import type { Config } from "./config/config.ts";
import { initLogger, LogLevel } from "./debug/logger.ts";

/** 解析命令行参数 */
function parseCLIArgs(): Partial<Config> & { prompt?: string } {
  const { values, positionals } = parseArgs({
    options: {
      // LLM 配置
      provider: { type: "string" },
      model: { type: "string", short: "m" },
      "max-tokens": { type: "string" },
      
      // 权限配置
      "permission-mode": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      
      // 会话配置
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      
      // 无头模式
      print: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      "max-turns": { type: "string" },
      
      // 系统提示词
      "system-prompt": { type: "string" },
      "append-system-prompt": { type: "string" },
      "system-prompt-file": { type: "string" },
      
      // UI
      "no-tui": { type: "boolean" },

      // 调试
      debug: { type: "boolean", short: "d" },
      "debug-level": { type: "string" },
      "debug-log-file": { type: "string" },

      // 帮助
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  // 处理帮助和版本
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log("sid-code v0.1.0 (TypeScript)");
    process.exit(0);
  }

  // 转换为 Config 格式
  const cliConfig: Partial<Config> & { prompt?: string } = {
    provider: values.provider,
    model: values.model,
    maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"]) : undefined,
    permissionMode: values["permission-mode"],
    skipPermissions: values["dangerously-skip-permissions"],
    yesMode: values.yes,
    continue: values.continue,
    resume: values.resume,
    print: values.print,
    outputFormat: values["output-format"],
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"]) : undefined,
    systemPrompt: values["system-prompt"],
    appendSystemPrompt: values["append-system-prompt"],
    systemPromptFile: values["system-prompt-file"],
    noTUI: values["no-tui"],
    debug: values.debug,
    debugLevel: values["debug-level"],
    debugLogFile: values["debug-log-file"],
  };

  // 位置参数作为初始提示词
  if (positionals.length > 0) {
    cliConfig.prompt = positionals.join(" ");
  }

  return cliConfig;
}

/** 打印帮助信息 */
function printHelp(): void {
  console.log(`
sid-code - AI 编程 CLI 工具

用法:
  sid-code [选项] [提示词]

LLM 配置:
  --provider <name>           LLM 提供商 (anthropic/openai/ollama)
  -m, --model <name>          模型名称
  --max-tokens <n>            响应最大 token 数

权限配置:
  --permission-mode <mode>    权限模式 (default/always-allow/deny-write)
  --dangerously-skip-permissions  跳过所有权限检查
  -y, --yes                   自动批准所有权限请求

会话配置:
  -c, --continue              继续最近一次会话
  -r, --resume <id>           恢复指定会话

无头模式:
  -p, --print                 无头模式（非交互式）
  --output-format <fmt>       输出格式 (text/json)
  --max-turns <n>             Agent 循环最大轮次

系统提示词:
  --system-prompt <text>      覆盖系统提示词
  --append-system-prompt <text>  追加到系统提示词
  --system-prompt-file <path>    从文件加载系统提示词

UI:
  --no-tui                    禁用 TUI，使用纯文本 REPL

调试:
  -d, --debug                 启用调试模式（日志输出到 ~/.sid-code/debug.log）
  --debug-level <level>       日志级别 (ERROR/WARN/INFO/DEBUG，默认 DEBUG)
  --debug-log-file <path>     自定义日志文件路径

其他:
  -h, --help                  显示帮助信息
  -v, --version               显示版本信息

环境变量:
  ANTHROPIC_API_KEY           Anthropic API 密钥
  OPENAI_API_KEY              OpenAI API 密钥
  LLM_PROVIDER                LLM 提供商
  LLM_MODEL                   模型名称
  LLM_BASE_URL                自定义 API 基础 URL

配置文件:
  ~/.sid-code/config.yaml     YAML 格式配置文件
`);
}

/** 主函数 */
async function main(): Promise<void> {
  try {
    const cliArgs = parseCLIArgs();
    const config = await loadConfig(cliArgs);

    // 初始化调试日志
    if (config.debug) {
      const levelMap: Record<string, LogLevel> = {
        ERROR: LogLevel.ERROR,
        WARN: LogLevel.WARN,
        INFO: LogLevel.INFO,
        DEBUG: LogLevel.DEBUG,
      };
      const level = levelMap[config.debugLevel?.toUpperCase() || "DEBUG"] ?? LogLevel.DEBUG;

      const logger = initLogger({
        enabled: true,
        level,
        logFile: config.debugLogFile,
        console: true,
      });

      logger.info("CLI", "调试模式已启用", {
        level: LogLevel[level],
        logFile: logger.getLogFilePath(),
      });
      logger.configLoaded("CLI", config);
    }

    // 验证 API Key
    if (config.provider === "anthropic" && !config.anthropicKey) {
      console.error("错误: 未设置 ANTHROPIC_API_KEY 环境变量");
      process.exit(1);
    }
    if (config.provider === "openai" && !config.openaiKey) {
      console.error("错误: 未设置 OPENAI_API_KEY 环境变量");
      process.exit(1);
    }

    // 创建 ProviderRegistry（Provider 工厂 + 缓存 + 子代理模型映射）
    const { ProviderRegistry } = await import("./llm/registry.ts");
    const providerRegistry = new ProviderRegistry(config, config.subAgentModels);
    let provider: import("./llm/provider.ts").Provider;
    try {
      provider = providerRegistry.getProvider();
    } catch (err: any) {
      console.error(`创建 Provider 失败: ${err.message}`);
      process.exit(1);
    }

    // 注册内置工具（共享 FileReadTracker 实例）
    const { Registry: ToolRegistry } = await import("./tool/registry.ts");
    const { FileReadTracker } = await import("./tool/file-read-tracker.ts");
    const toolRegistry = new ToolRegistry();
    const fileReadTracker = new FileReadTracker();

    const { ReadTool } = await import("./tool/read.ts");
    const { WriteTool } = await import("./tool/write.ts");
    const { EditTool } = await import("./tool/edit.ts");
    const { BashTool } = await import("./tool/bash.ts");
    const { GrepTool } = await import("./tool/grep.ts");
    const { GlobTool } = await import("./tool/glob.ts");

    toolRegistry.register(new ReadTool(fileReadTracker));
    toolRegistry.register(new WriteTool());
    toolRegistry.register(new EditTool(fileReadTracker));
    toolRegistry.register(new BashTool());
    toolRegistry.register(new GrepTool());
    toolRegistry.register(new GlobTool());

    // 注册子代理工具
    const { SubAgentTool } = await import("./agent/tool.ts");
    toolRegistry.register(new SubAgentTool(providerRegistry, toolRegistry));

    // 注册内置命令
    const { Registry: CommandRegistry } = await import("./command/registry.ts");
    const { registerBuiltins } = await import("./command/builtins.ts");
    const commandRegistry = new CommandRegistry();
    registerBuiltins(commandRegistry);

    // 加载自定义命令
    const { CustomCommandLoader } = await import("./command/custom.ts");
    const customCmds = await new CustomCommandLoader().loadAll();
    for (const cmd of customCmds) commandRegistry.register(cmd);

    // 加载 Skills（注册为工具，LLM 可自动调用）
    const { SkillLoader } = await import("./skill/loader.ts");
    const { SkillTool } = await import("./skill/tool.ts");
    const skills = await new SkillLoader().loadAll();
    for (const skill of skills) {
      if (!skill.disableModelInvocation) {
        toolRegistry.register(new SkillTool(skill, providerRegistry, toolRegistry));
      }
    }

    // 加载自定义 Agents（注册为工具）
    const { CustomAgentLoader, CustomAgentTool } = await import("./agent/custom.ts");
    const customAgents = await new CustomAgentLoader().loadAll();
    for (const def of customAgents) {
      toolRegistry.register(new CustomAgentTool(def, providerRegistry, toolRegistry));
    }

    // 创建权限检查器（加载五层权限规则）
    const { PermissionChecker } = await import("./permission/checker.ts");
    const { loadPermissionRules } = await import("./config/config.ts");
    const permissionRules = await loadPermissionRules();
    const permissionChecker = new PermissionChecker(config, permissionRules);

    // 创建 App
    const { App } = await import("./app.ts");
    const app = new App({ config, provider, providerRegistry, toolRegistry, commandRegistry, permissionChecker });

    // 会话恢复：--continue 或 --resume <id>
    if (config.continue || config.resume) {
      const { SessionStore } = await import("./session/store.ts");
      const store = new SessionStore();
      let session: import("./session/store.ts").SessionData | null = null;

      if (config.resume) {
        session = await store.load(config.resume);
        if (!session) {
          console.error(`错误: 未找到会话 ${config.resume}`);
          process.exit(1);
        }
      } else {
        session = await store.loadLatest();
        if (!session) {
          console.error("错误: 没有可恢复的历史会话");
          process.exit(1);
        }
      }

      console.log(`恢复会话: ${session.id} (${session.messages.length} 条消息)`);
      await app.restoreSession(session);
    }

    // 根据模式路由
    if (config.print) {
      // 无头模式
      if (!cliArgs.prompt) {
        console.error("错误: 无头模式需要提供提示词");
        process.exit(1);
      }
      await app.runHeadless(cliArgs.prompt);
    } else if (config.noTUI) {
      // 纯文本 REPL
      await app.runREPL(cliArgs.prompt);
    } else {
      // TUI 模式
      await app.runTUI(cliArgs.prompt);
    }
  } catch (err) {
    console.error("错误:", err);
    process.exit(1);
  }
}

// 运行主函数
main();
