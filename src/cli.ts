/**
 * CLI 入口
 * 使用 Node.js 内置 parseArgs 解析命令行参数，路由到不同模式
 */

// 强制启用终端颜色（必须在所有 import 之前）
// sid-code 是 TUI 应用，始终需要颜色支持（加粗/斜体/代码高亮等）。
// chalk / cli-highlight 在模块加载时读取此变量创建 theme，
// 如果不设置，Ink 接管 stdout 后 chalk 检测不到 TTY 会禁用所有样式。
// 尊重用户显式设置的 NO_COLOR / FORCE_COLOR。
if (!process.env.FORCE_COLOR && !process.env.NO_COLOR) {
  process.env.FORCE_COLOR = "3";
}

import { parseArgs } from "node:util";
import { loadConfig } from "./config/config.ts";
import type { Config } from "./config/config.ts";
import { initLogger, getLogger, LogLevel, getPerfTimer } from "./debug/index.ts";

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
      "list-sessions": { type: "boolean" },
      "browse-sessions": { type: "boolean" },
      "delete-session": { type: "string" },
      "cleanup-sessions": { type: "boolean" },
      
      // 无头模式
      print: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      "max-turns": { type: "string" },
      
      // 系统提示词
      "system-prompt": { type: "string" },
      "append-system-prompt": { type: "string" },
      "system-prompt-file": { type: "string" },
      
      // 调试
      debug: { type: "boolean", short: "d" },
      "debug-level": { type: "string" },
      "debug-log-file": { type: "string" },

      // 帮助
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },

      // 轨迹采集
      trace: { type: "boolean" },
      "trace-upload-url": { type: "string" },
      "trace-upload-token": { type: "string" },
      "trace-user-id": { type: "string" },
      "trace-device-id": { type: "string" },
      "upload-traces": { type: "boolean" },
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
  const cliConfig: Partial<Config> & {
    prompt?: string;
    "list-sessions"?: boolean;
    "browse-sessions"?: boolean;
    "delete-session"?: string;
    "cleanup-sessions"?: boolean;
    "upload-traces"?: boolean;
  } = {
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
    debug: values.debug,
    debugLevel: values["debug-level"],
    debugLogFile: values["debug-log-file"],
    "list-sessions": values["list-sessions"],
    "browse-sessions": values["browse-sessions"],
    "delete-session": values["delete-session"],
    "cleanup-sessions": values["cleanup-sessions"],
    "upload-traces": values["upload-traces"],
    // 轨迹采集配置
    ...(values.trace ? {
      trace: {
        enabled: true,
        ...(values["trace-upload-url"] && values["trace-upload-token"] ? {
          upload: {
            url: values["trace-upload-url"],
            token: values["trace-upload-token"],
            userId: values["trace-user-id"],
            deviceId: values["trace-device-id"],
          },
        } : {}),
      },
    } : {}),
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
  -r, --resume <id>           恢复指定会话（ID 或索引）
  --list-sessions             列出所有会话（文本模式）
  --browse-sessions           打开 TUI 会话浏览器
  --delete-session <id>       删除指定会话
  --cleanup-sessions          手动触发会话清理

无头模式:
  -p, --print                 无头模式（非交互式）
  --output-format <fmt>       输出格式 (text/json)
  --max-turns <n>             Agent 循环最大轮次

系统提示词:
  --system-prompt <text>      覆盖系统提示词
  --append-system-prompt <text>  追加到系统提示词
  --system-prompt-file <path>    从文件加载系统提示词

调试:
  -d, --debug                 启用调试模式（日志输出到 ~/.sid-code/debug.log）
  --debug-level <level>       日志级别 (ERROR/WARN/INFO/DEBUG，默认 DEBUG)
  --debug-log-file <path>     自定义日志文件路径

轨迹采集:
  --trace                     启用轨迹采集（本地保存到 ~/.sid-code/trajectories/）
  --trace-upload-url <url>    轨迹上传平台地址（如 http://xxx/traj）
  --trace-upload-token <tok>  上传认证 token（X-Upload-Token）
  --trace-user-id <id>        用户标识（多用户场景）
  --trace-device-id <id>      设备标识
  --upload-traces             手动触发重试队列补传（处理之前失败的上传）

UI:
  --alternate-buffer          启用 alternate buffer 模式（全屏 TUI，默认禁用以支持原生文本选择）

其他:
  -h, --help                  显示帮助信息
  -v, --version               显示版本信息

环境变量:
  ANTHROPIC_API_KEY           Anthropic API 密钥
  OPENAI_API_KEY              OpenAI API 密钥
  LLM_PROVIDER                LLM 提供商
  LLM_MODEL                   模型名称
  LLM_BASE_URL                自定义 API 基础 URL
  SID_CODE_TRACE              设为 1 或 true 启用轨迹采集
  SID_CODE_TRACE_OUTPUT_DIR   自定义轨迹输出目录
  SID_CODE_TRACE_UPLOAD_URL   轨迹上传平台地址
  SID_CODE_TRACE_UPLOAD_TOKEN 上传认证 token
  SID_CODE_TRACE_USER_ID      用户标识
  SID_CODE_TRACE_DEVICE_ID    设备标识

配置文件:
  ~/.sid-code/config.yaml     YAML 格式配置文件
`);
}

/** 处理列出会话命令 */
async function handleListSessions(): Promise<void> {
  const { SessionSelector } = await import("./session/utils.ts");
  const { homedir } = await import("os");
  const { join } = await import("path");

  const home = process.env.HOME || homedir();
  const sessionDir = join(home, ".sid-code", "sessions");
  const selector = new SessionSelector(sessionDir);

  try {
    const sessions = await selector.listSessions();

    if (sessions.length === 0) {
      console.log("未找到任何会话");
      return;
    }

    console.log(`共 ${sessions.length} 个会话:\n`);
    console.log("索引 | 消息数 | 时间 | 名称");
    console.log("-----|--------|------|------");

    for (const session of sessions) {
      const { formatRelativeTime } = await import("./session/utils.ts");
      const time = formatRelativeTime(session.lastUpdated, "short");
      const name = session.displayName.slice(0, 50);
      console.log(`#${session.index.toString().padStart(3)} | ${session.messageCount.toString().padStart(6)} | ${time.padEnd(4)} | ${name}`);
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

/** 处理浏览会话命令 */
async function handleBrowseSessions(config: Config): Promise<void> {
  const React = await import("react");
  const { render } = await import("ink");
  const { SessionBrowser } = await import("./session/browser.tsx");
  const { SessionStore } = await import("./session/store.ts");
  const { homedir } = await import("os");
  const { join } = await import("path");
  const { unlinkSync, existsSync } = await import("fs");

  const store = new SessionStore();
  const home = process.env.HOME || homedir();
  const sessionDir = join(home, ".sid-code", "sessions");

  let selectedSession: any = null;

  const { waitUntilExit } = render(
    React.createElement(SessionBrowser, {
      config,
      currentSessionId: config.sessionId,
      onResumeSession: (session: any) => {
        selectedSession = session;
      },
      onDeleteSession: async (session: any) => {
        const sessionPath = join(sessionDir, session.fileName);
        if (existsSync(sessionPath)) {
          unlinkSync(sessionPath);
        }
      },
      onExit: () => {
        process.exit(0);
      },
    })
  );

  await waitUntilExit();

  if (selectedSession) {
    console.log(`已选择会话: ${selectedSession.id}`);
    console.log(`使用 --resume ${selectedSession.id} 恢复此会话`);
  }
}

/** 处理删除会话命令 */
async function handleDeleteSession(sessionId: string): Promise<void> {
  const { SessionSelector } = await import("./session/utils.ts");
  const { homedir } = await import("os");
  const { join } = await import("path");
  const { unlinkSync, existsSync } = await import("fs");

  const home = process.env.HOME || homedir();
  const sessionDir = join(home, ".sid-code", "sessions");
  const selector = new SessionSelector(sessionDir);

  try {
    const session = await selector.findSession(sessionId);
    const sessionPath = join(sessionDir, session.fileName);

    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
      console.log(`已删除会话: ${session.id} (${session.displayName})`);
    } else {
      console.error(`错误: 会话文件不存在: ${session.fileName}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

/** 处理清理会话命令 */
async function handleCleanupSessions(config: Config): Promise<void> {
  const { cleanupExpiredSessions, getRetentionSettings } = await import("./session/cleanup.ts");

  try {
    const retentionSettings = getRetentionSettings(config);
    console.log("开始清理过期会话...");
    console.log(`配置: maxAge=${retentionSettings.maxAge}, maxCount=${retentionSettings.maxCount}`);

    const result = await cleanupExpiredSessions(config, retentionSettings, config.sessionId);

    console.log(`\n清理完成:`);
    console.log(`  扫描: ${result.scanned} 个`);
    console.log(`  删除: ${result.deleted} 个`);
    console.log(`  跳过: ${result.skipped} 个`);
    console.log(`  失败: ${result.failed} 个`);

    if (result.deletedIds.length > 0) {
      console.log(`\n已删除会话 ID:`);
      for (const id of result.deletedIds) {
        console.log(`  - ${id}`);
      }
    }

    if (result.failedIds.length > 0) {
      console.log(`\n删除失败的会话 ID:`);
      for (const id of result.failedIds) {
        console.log(`  - ${id}`);
      }
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

/** 处理手动触发重试队列补传 */
async function handleUploadTraces(config: Config): Promise<void> {
  const traceUpload = config.trace?.upload;
  if (!traceUpload?.url || !traceUpload?.token) {
    console.error("错误: 未配置上传地址或 token，请在配置文件或通过 --trace-upload-url / --trace-upload-token 参数指定");
    process.exit(1);
  }

  const { UploadManager } = await import("./trace/uploader.ts");
  const { homedir } = await import("os");
  const { join } = await import("path");

  const outputDir = config.trace?.outputDir ?? join(homedir(), ".sid-code", "trajectories");
  const mgr = new UploadManager({
    baseUrl: traceUpload.url,
    token: traceUpload.token,
    toolSource: traceUpload.toolSource,
    userId: traceUpload.userId,
    deviceId: traceUpload.deviceId,
    maxRetries: traceUpload.maxRetries,
    retryBaseMs: traceUpload.retryBaseMs,
    compress: traceUpload.compress,
    outputDir,
  });

  console.log("正在处理待上传队列...");
  try {
    await mgr.processRetryQueue();
    console.log("处理完成");
  } catch (err: any) {
    console.error(`处理失败: ${err.message}`);
    process.exit(1);
  }
}

/** 主函数 */
async function main(): Promise<void> {
  const startupTimer = getPerfTimer().start('startup');

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

      // TUI 模式下日志只写文件，不输出到控制台（避免启动时一闪而过的调试信息）
      const isTUI = !config.print;
      const logger = initLogger({
        enabled: true,
        level,
        logFile: config.debugLogFile,
        console: !isTUI,
        fileOnly: isTUI,
        mutedCategories: ["UI:MD", "TUI:STATE", "TUI:RESIZE", "STREAM_WRITER"],
      });

      logger.info("CLI", "调试模式已启用", {
        level: LogLevel[level],
        logFile: logger.getLogFilePath(),
      });
      logger.configLoaded("CLI", config);
    }

    // 处理会话管理命令（不需要 API Key）
    if (cliArgs["list-sessions"]) {
      await handleListSessions();
      return;
    }
    if (cliArgs["browse-sessions"]) {
      await handleBrowseSessions(config);
      return;
    }
    if (cliArgs["delete-session"]) {
      await handleDeleteSession(cliArgs["delete-session"]);
      return;
    }
    if (cliArgs["cleanup-sessions"]) {
      await handleCleanupSessions(config);
      return;
    }

    // 手动触发重试队列（补传之前失败的上传）
    if (cliArgs["upload-traces"]) {
      await handleUploadTraces(config);
      return;
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

    // 记录 Provider 信息
    if (config.debug) {
      const { getLogger } = await import("./debug/logger.ts");
      getLogger().info("CONFIG", `Provider: ${config.provider} model=${config.model} baseURL=${config.baseURL || "(默认)"}`);
    }

    // 注册内置工具（共享 FileReadTracker 实例）
    const { Registry: ToolRegistry } = await import("./tool/registry.ts");
    const { FileReadTracker } = await import("./tool/file-read-tracker.ts");
    const { MemoryStore } = await import("./memory/store.ts");
    const toolRegistry = new ToolRegistry();
    const fileReadTracker = new FileReadTracker();
    const memoryStore = new MemoryStore(process.cwd());

    const { ReadTool } = await import("./tool/read.ts");
    const { WriteTool } = await import("./tool/write.ts");
    const { EditTool } = await import("./tool/edit.ts");
    const { BashTool } = await import("./tool/bash.ts");
    const { GrepTool } = await import("./tool/grep.ts");
    const { GlobTool } = await import("./tool/glob.ts");
    const { LsTool } = await import("./tool/ls.ts");
    const { WebFetchTool } = await import("./tool/web-fetch.ts");
    const { ReadManyTool } = await import("./tool/read-many.ts");
    const { MemoryTool } = await import("./tool/memory.ts");

    toolRegistry.register(new ReadTool(fileReadTracker));
    toolRegistry.register(new WriteTool());
    toolRegistry.register(new EditTool(fileReadTracker));
    toolRegistry.register(new BashTool());
    toolRegistry.register(new GrepTool());
    toolRegistry.register(new GlobTool());
    toolRegistry.register(new LsTool());
    toolRegistry.register(new WebFetchTool());
    toolRegistry.register(new ReadManyTool(fileReadTracker));
    toolRegistry.register(new MemoryTool(memoryStore));

    // 注册子代理工具
    const { SubAgentTool } = await import("./agent/tool.ts");
    toolRegistry.register(new SubAgentTool(providerRegistry, toolRegistry));

    // 注册内置命令
    const { Registry: CommandRegistry } = await import("./command/registry.ts");
    const { registerBuiltins } = await import("./command/builtins.ts");
    const commandRegistry = new CommandRegistry();
    await registerBuiltins(commandRegistry);

    // 加载自定义命令（带信任检查）
    const { CustomCommandLoader } = await import("./command/custom.ts");
    const { TrustManager } = await import("./extension/trust.ts");
    const trustManager = new TrustManager();
    const scanOptions = {
      trustManager,
      trustProjectExtensions: config.trustProjectExtensions,
      onUntrusted: async (files: any[]) => {
        // 非交互模式下跳过未信任的扩展
        if (config.print) return [];
        const log = getLogger();
        log.warn("TRUST", `发现 ${files.length} 个未信任的项目级扩展，已自动信任`);
        // 首次使用自动信任（后续内容变更会重新检查）
        return files;
      },
    };
    const customCmds = await new CustomCommandLoader().loadAll(undefined, scanOptions);
    for (const { cmd, source } of customCmds) commandRegistry.register(cmd, source);

    // 加载 Skills（通过 SkillManager 统一管理）
    const { SkillManager } = await import("./skill/manager.ts");
    const { SkillTool } = await import("./skill/tool.ts");
    const skillManager = new SkillManager();
    await skillManager.discover(process.cwd(), scanOptions);

    // 应用禁用列表
    if (config.disabledSkills && config.disabledSkills.length > 0) {
      skillManager.setDisabledSkills(config.disabledSkills);
    }

    // 注册为工具
    const skills = skillManager.getSkills();
    for (const skill of skills) {
      if (!skill.disableModelInvocation) {
        toolRegistry.register(new SkillTool(skill, providerRegistry, toolRegistry));
      }
    }

    // 加载自定义 Agents（注册为工具）
    const { CustomAgentLoader, CustomAgentTool } = await import("./agent/custom.ts");
    const customAgents = await new CustomAgentLoader().loadAll(undefined, scanOptions);
    for (const def of customAgents) {
      toolRegistry.register(new CustomAgentTool(def, providerRegistry, toolRegistry));
    }

    // 初始化 MCP 服务器（后台连接，不阻塞启动）
    let mcpManager: import("./mcp/manager.ts").MCPManager | undefined;
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const { MCPManager } = await import("./mcp/manager.ts");
      mcpManager = new MCPManager();

      // 工具变更回调：刷新工具注册表
      mcpManager.onToolsRefresh = (serverName, tools) => {
        const prefix = `mcp__${serverName}__`;
        toolRegistry.removeByPrefix(prefix);
        for (const tool of tools) toolRegistry.register(tool);
      };

      // 后台连接，不 await
      mcpManager.connectAll(config.mcpServers).then((mcpTools) => {
        for (const tool of mcpTools) toolRegistry.register(tool);
        if (mcpTools.length > 0) {
          getLogger().info("MCP", `已连接，注册 ${mcpTools.length} 个工具`);
        }
      }).catch((err: any) => {
        getLogger().error("MCP", `初始化失败: ${err.message}`);
      });
    }

    // 记录注册的工具
    if (config.debug) {
      const { getLogger } = await import("./debug/logger.ts");
      const toolNames = toolRegistry.all().map(t => t.name()).join(", ");
      getLogger().info("CONFIG", `注册工具: ${toolNames} (共${toolRegistry.size()}个)`);
    }

    // 创建权限检查器（加载五层权限规则）
    const { PermissionChecker } = await import("./permission/checker.ts");
    const { loadPermissionRules } = await import("./config/config.ts");
    const permissionRules = await loadPermissionRules();
    const permissionChecker = new PermissionChecker(config, permissionRules);

    // 记录权限规则
    if (config.debug && permissionRules) {
      const { getLogger } = await import("./debug/logger.ts");
      const allowCount = permissionRules.allow?.length ?? 0;
      const denyCount = permissionRules.deny?.length ?? 0;
      const askCount = permissionRules.ask?.length ?? 0;
      getLogger().info("CONFIG", `权限规则: ${allowCount}条 allow, ${denyCount}条 deny, ${askCount}条 ask`);
    }

    // 创建 App
    const { App } = await import("./app.ts");
    const app = new App({ config, provider, providerRegistry, toolRegistry, commandRegistry, permissionChecker, mcpManager });

    // 启动时自动清理过期会话（后台静默执行）
    if (!config.print) {
      const { cleanupExpiredSessions, getRetentionSettings } = await import("./session/cleanup.ts");
      const retentionSettings = getRetentionSettings(config);
      if (retentionSettings.enabled) {
        cleanupExpiredSessions(config, retentionSettings, config.sessionId)
          .then((result) => {
            if (result.deleted > 0 && config.debug) {
              getLogger().info("CLEANUP", `自动清理: 删除 ${result.deleted} 个过期会话`);
            }
          })
          .catch((err: any) => {
            if (config.debug) {
              getLogger().error("CLEANUP", `自动清理失败: ${err.message}`);
            }
          });
      }
    }

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
      startupTimer.end();
      await app.runHeadless(cliArgs.prompt);
    } else {
      // TUI 模式
      const startupDuration = startupTimer.end();
      if (config.debug) {
        getLogger().info("CLI", `启动完成，耗时 ${startupDuration.toFixed(0)}ms`);
      }
      await app.runTUI(cliArgs.prompt);
    }
  } catch (err) {
    console.error("错误:", err);
    process.exit(1);
  }
}

// 运行主函数
main();
