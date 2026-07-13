/**
 * CLI 完整入口（Stage 2）
 * 由 bootstrap.ts 动态导入，负责完整的参数解析、初始化和路由
 */

// ⚠️ 启动性能打点必须在所有其他 import 之前
import { profileCheckpoint } from "./utils/startup-profiler.ts";
profileCheckpoint("full_cli_entry");

// 强制启用终端颜色（必须在业务 import 之前）
if (!process.env.FORCE_COLOR && !process.env.NO_COLOR) {
  process.env.FORCE_COLOR = "3";
}

import { parseArgs } from "node:util";
import { loadConfig } from "./config/config.ts";
import type { Config } from "./config/config.ts";
import { initLogger, getLogger, LogLevel, getPerfTimer } from "./debug/index.ts";
import { printHelp } from "./help.ts";
import { runMigrations } from "./migrations/runner.ts";
import { getVersion } from "./version.ts";
import { isAbortError } from "./llm/errors.ts";

profileCheckpoint("full_cli_imports_loaded");

/** CLI 参数扩展类型 */
type CLIArgs = Partial<Config> & {
  prompt?: string;
  "list-sessions"?: boolean;
  "browse-sessions"?: boolean;
  "delete-session"?: string;
  "cleanup-sessions"?: boolean;
  "upload-traces"?: boolean;
  /** --json-schema 指向的文件路径，后续解析为 config.jsonSchema */
  jsonSchemaFile?: string;
  /** Bridge 远程控制：中继 WebSocket URL（ws:// 或 wss://） */
  bridgeUrl?: string;
  /** Bridge 远程控制：认证令牌 */
  bridgeToken?: string;
  /** --worktree [name]：启动时自动创建并进入 worktree（缺省值表示自动命名） */
  worktree?: string | boolean;
};

/** 解析命令行参数 */
function parseCLIArgs(): CLIArgs {
  let values: Record<string, any>;
  let positionals: string[];
  try {
    const result = parseArgs({
      options: {
        // LLM 配置
        provider: { type: "string" },
        model: { type: "string", short: "m" },
        "max-tokens": { type: "string" },

        // 权限配置
        "permission-mode": { type: "string" },
        "dangerously-skip-permissions": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        // 缺口 C1 §5.3：预授权工具白名单（守护进程无头 job 注入；逗号分隔）
        "allowed-tools": { type: "string" },
        "disallowed-tools": { type: "string" },

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
        verbose: { type: "boolean" },
        "json-schema": { type: "string" },

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

        // 插件
        "plugin-dir": { type: "string", multiple: true },

        // 轨迹采集
        trace: { type: "boolean" },
        "trace-upload-url": { type: "string" },
        "trace-upload-token": { type: "string" },
        "trace-user-id": { type: "string" },
        "trace-device-id": { type: "string" },
        "trace-upload-disabled": { type: "boolean" }, // 强制禁用上传（最高优先级，覆盖配置文件）
        "upload-traces": { type: "boolean" },

        // Bridge 远程控制（spec 16 §7）
        bridge: { type: "string" }, // 中继 WebSocket URL，提供即进入 Bridge 模式
        "bridge-token": { type: "string" },

        // UI 渲染（ADR-040）
        "alternate-buffer": { type: "boolean" }, // 启用全屏 alt-screen；缺省走主屏 Static 模式（原生文本选择）

        // Worktree 隔离（P1-2）：启动时直接进入 worktree
        worktree: { type: "string" }, // --worktree[=name]；不带值时自动命名
      },
      allowPositionals: true,
      allowNegative: true,
    });
    values = result.values;
    positionals = result.positionals;
  } catch (err: any) {
    const match = err.message?.match(/Unknown option '([^']+)'/);
    if (match) {
      console.error(`错误: 未知选项 '${match[1]}'，使用 --help 查看可用选项`);
    } else {
      console.error(`错误: ${err.message}\n使用 --help 查看可用选项`);
    }
    process.exit(1);
  }

  // 处理帮助和版本（兜底：bootstrap 未拦截时仍能处理）
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(getVersion());
    process.exit(0);
  }

  // 转换为 Config 格式
  const cliConfig: CLIArgs = {
    provider: values.provider,
    model: values.model,
    maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"]) : undefined,
    permissionMode: values["permission-mode"],
    skipPermissions: values["dangerously-skip-permissions"],
    yesMode: values.yes,
    // 缺口 C1 §5.3：逗号分隔 → string[]（守护进程无头 job 预授权白名单）
    allowedTools: values["allowed-tools"]
      ? String(values["allowed-tools"]).split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined,
    disallowedTools: values["disallowed-tools"]
      ? String(values["disallowed-tools"]).split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined,
    continue: values.continue,
    resume: values.resume,
    print: values.print,
    outputFormat: values["output-format"],
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"]) : undefined,
    verbose: values.verbose,
    jsonSchemaFile: values["json-schema"],
    systemPrompt: values["system-prompt"],
    appendSystemPrompt: values["append-system-prompt"],
    systemPromptFile: values["system-prompt-file"],
    debug: values.debug,
    debugLevel: values["debug-level"],
    debugLogFile: values["debug-log-file"],
    pluginDirs: values["plugin-dir"],
    "list-sessions": values["list-sessions"],
    "browse-sessions": values["browse-sessions"],
    "delete-session": values["delete-session"],
    "cleanup-sessions": values["cleanup-sessions"],
    "upload-traces": values["upload-traces"],
    bridgeUrl: values.bridge,
    bridgeToken: values["bridge-token"],
    // Worktree 启动 flag（P1-2）：--worktree=name 指定名称；--worktree= 或空串则自动命名
    worktree: values.worktree !== undefined ? (values.worktree || true) : undefined,
    // UI 渲染模式（ADR-040）：--alternate-buffer 显式开全屏；缺省 undefined → 主屏 Static
    alternateBuffer: values["alternate-buffer"] === true ? true : undefined,
    // 轨迹采集配置。
    // 采集默认启用（--no-trace 关闭）。上传配置完全走配置文件（settings.json trace.upload 段），
    // CLI flag 仅作为覆盖手段——不在代码中硬编码 URL/token。
    // "是否上传 / 是否本地保留 / 上传后是否删除" 是独立开关，由配置文件各字段控制：
    //   trace.upload.url / token      → 是否上传（有配置才上传）
    //   trace.upload.auto_upload      → 会话结束自动上传还是手动
    //   trace.upload.delete_after_upload → 上传成功后是否删本地（默认 false = 保留）
    // --trace-upload-disabled 可强制关闭上传（最高优先级，覆盖配置文件）。
    //
    // 关键：仅当用户通过 CLI flag 显式指定 trace 相关参数时才构造 trace 对象。
    // 否则不覆盖配置文件中的 trace 配置（避免浅合并把 settings.json 的完整 trace 吃掉）。
    trace: (values.trace === false || values["trace-upload-disabled"] || values["trace-upload-url"] || values["trace-upload-token"])
      ? {
          enabled: values.trace !== false,
          upload: values["trace-upload-disabled"]
            ? undefined // 强制禁用上传（最高优先级）
            : (values["trace-upload-url"] || values["trace-upload-token"])
              ? {
                  url: values["trace-upload-url"],
                  token: values["trace-upload-token"],
                  userId: values["trace-user-id"],
                  deviceId: values["trace-device-id"],
                  toolSource: "sid-code",
                  autoUpload: true,
                  deleteAfterUpload: false,
                  compress: true,
                  maxRetries: 5,
                  retryBaseMs: 2000,
                }
              : undefined,
        }
      : undefined, // 不覆盖——完全由配置文件（settings.json）决定
  };

  // 位置参数作为初始提示词
  if (positionals.length > 0) {
    cliConfig.prompt = positionals.join(" ");
  }

  return cliConfig;
}

/** 处理浏览会话命令 */
async function handleBrowseSessions(config: Config): Promise<void> {
  const React = await import("react");
  const { default: render } = await import("./ink/root.js");
  const { SessionBrowser } = await import("./session/browser.tsx");
  const { SessionStore } = await import("./session/store.ts");
  const { sidPaths } = await import("./config/paths.ts");
  const { join } = await import("path");
  const { unlinkSync, existsSync } = await import("fs");

  const store = new SessionStore();
  const sessionDir = sidPaths.sessions();

  let selectedSession: any = null;

  const { waitUntilExit } = await render(
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
  const { sidPaths } = await import("./config/paths.ts");

  const outputDir = config.trace?.outputDir ?? sidPaths.trajectories();
  const mgr = new UploadManager({
    baseUrl: traceUpload.url,
    token: traceUpload.token,
    toolSource: traceUpload.toolSource,
    userId: traceUpload.userId,
    deviceId: traceUpload.deviceId,
    maxRetries: traceUpload.maxRetries,
    retryBaseMs: traceUpload.retryBaseMs,
    compress: traceUpload.compress,
    deleteAfterUpload: traceUpload.deleteAfterUpload ?? false,
    outputDir,
    // §6.4：手动补传队列时也据 events.jsonl 校正历史会话 cost=0
    availableModels: config.availableModels,
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

// ─── 全局 App 弱引用（供 uncaughtException 等异常兜底使用）───

/** 全局 App 弱引用，供 emergencySessionEnd 在 uncaughtException 时调用 */
let lastAppRef: WeakRef<import("./app.ts").App> | null = null;

/** 注册当前 App 实例（由 main() 在 App 创建后调用） */
export function setLastApp(app: import("./app.ts").App): void {
  lastAppRef = new WeakRef(app);
}

/** 全局异常兜底处理器 */
function registerGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason: unknown, _promise: Promise<unknown>) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    try {
      const { getLogger } = require("./debug/logger.ts");
      getLogger().error("GLOBAL", `unhandledRejection: ${msg}`, { stack });
    } catch { /* logger 可能未初始化 */ }

    // A5：abort 类拒绝 = 用户按 ESC / 超时主动中断，是可观测事件而非故障。
    // 对标 claude-code：abort 的 unhandledRejection 仅记录，不触发 emergencySessionEnd
    // （避免把会话错误标记为 error 并吃掉真正的 SessionEnd），更不退出进程。
    // 配合 anthropic.ts 已把 signal 下传 SDK（A1），abort 几乎不会再产生孤儿 Promise；
    // 此处为双保险——即使偶发，进程也保持存活。
    if (isAbortError(reason)) {
      return;
    }

    process.stderr.write(`[sid-code] unhandledRejection: ${msg}\n`);
    if (stack) process.stderr.write(`${stack}\n`);
    // 非 abort 的未处理拒绝：保留原有兜底（紧急 SessionEnd + 退出）
    const err = reason instanceof Error ? reason : new Error(String(reason));
    try { lastAppRef?.deref()?.emergencySessionEnd(err); } catch { /* ignore */ }
    process.exit(1);
  });

  process.on("uncaughtException", (err: Error) => {
    try {
      const { getLogger } = require("./debug/logger.ts");
      getLogger().error("GLOBAL", `uncaughtException: ${err.message}`, { stack: err.stack });
    } catch { /* logger 可能未初始化 */ }

    // 与 unhandledRejection 对称：abort 类异常 = 用户/超时主动中断，不是真故障。
    // 多数 abort 走 unhandledRejection，但 setTimeout 回调内的 abort throw、
    // 无监听器的 EventEmitter error 等场景会以 uncaughtException 形式出现，
    // 携带裸 reason 字符串（如 "user-cancel"）。此前缺 isAbortError 短路 →
    // 这些路径仍会 process.exit(1) 崩溃。这里补齐，保持两个全局处理器一致。
    if (isAbortError(err)) {
      return;
    }

    process.stderr.write(`[sid-code] uncaughtException: ${err.message}\n`);
    if (err.stack) process.stderr.write(`${err.stack}\n`);
    // 紧急 SessionEnd（在 exit 前做最后一搏）
    try { lastAppRef?.deref()?.emergencySessionEnd(err); } catch { /* ignore */ }
    // 强制退出（对标 claude-code forceExit）：
    // 终端已死时 process.exit() 可能抛 EIO，此时回退到 SIGKILL
    try {
      process.exit(1);
    } catch {
      // 生产环境：dead terminal → EIO → 回退 SIGKILL
      process.kill(process.pid, "SIGKILL");
    }
  });
}

/** 主函数（由 bootstrap.ts 调用） */
export async function main(): Promise<void> {
  registerGlobalErrorHandlers();
  const startupTimer = getPerfTimer().start('startup');

  try {
    const cliArgs = parseCLIArgs();

    // 执行数据迁移（幂等，失败不阻塞）
    profileCheckpoint("migrations_start");
    runMigrations();
    profileCheckpoint("migrations_end");

    profileCheckpoint("config_load_start");
    const config = await loadConfig(cliArgs);
    profileCheckpoint("config_load_end");

    // Coordinator 模式：检查环境变量 SID_CODE_COORDINATOR_MODE=1
    // 设为 coordinator 后主循环角色切换为"编排者"，注入编排工作流提示词
    const { checkCoordinatorEnv } = await import("./coordinator/mode.ts");
    checkCoordinatorEnv();

    // 启动期管家：生成配置目录 .gitignore + 按水位线节流的过期清理（幂等、不阻塞）
    try {
      const { runStartupHousekeeping } = await import("./config/startup-housekeeping.ts");
      runStartupHousekeeping();
    } catch (err) {
      getLogger().debug("CONFIG", `启动管家任务跳过: ${err}`);
    }

    // Settings 系统：Phase 1 安全环境变量（信任边界之前，仅可信来源 + 安全白名单）
    // 旧 safe-env.ts 从未被调用——此处首次接入两阶段环境变量应用。
    try {
      const { applySafeConfigEnvironmentVariables } = await import(
        "./config/settings/managed-env.ts"
      );
      applySafeConfigEnvironmentVariables();
    } catch (err) {
      getLogger().warn("ENV", `Phase 1 环境变量应用跳过: ${err}`);
    }

    // AppConfig：加载内部应用状态 + 递增启动计数（write-through，后台 watchFile）
    try {
      const { getAppConfig, incrementStartupCount } = await import(
        "./config/app-config.ts"
      );
      getAppConfig();
      incrementStartupCount();
    } catch (err) {
      getLogger().warn("CONFIG", `AppConfig 初始化跳过: ${err}`);
    }

    // 注册会话级插件目录（--plugin-dir），必须在任何插件加载前设置
    if (config.pluginDirs && config.pluginDirs.length > 0) {
      const { setInlinePluginDirs } = await import("./plugin/index.ts");
      setInlinePluginDirs(config.pluginDirs);
    }

    // 初始化调试日志
    if (config.debug) {
      const levelMap: Record<string, LogLevel> = {
        ERROR: LogLevel.ERROR,
        WARN: LogLevel.WARN,
        INFO: LogLevel.INFO,
        DEBUG: LogLevel.DEBUG,
      };
      const level = levelMap[config.debugLevel?.toUpperCase() || "DEBUG"] ?? LogLevel.DEBUG;

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
    } else if (config.audit !== false) {
      // 零配置审计日志：不开 --debug 也常驻留痕。
      // 只落 WARN/ERROR 关键事件（空参数退化、循环、压缩、孤儿修复、上传失败等），
      // 不输出控制台、不写 DEBUG/INFO 噪音，出问题必有现场。只写本地、不外传。
      // logger 自带 10MB 大小轮转 + 仅留 1 备份，磁盘安全。
      initLogger({
        enabled: true,
        level: LogLevel.WARN,
        logFile: config.auditLogFile ?? "~/.sid-code/audit.log",
        console: false,
        fileOnly: true,
        append: true,
      });
    }

    // logger 就绪后，统一输出配置校验诊断（loadConfig 阶段暂存的）。
    // warnings 走 debug（--debug 才显示明细，不刷首屏）；非致命 errors 走 warn（真信号该可见）。
    // 致命错误已在 loadConfig 内提前抛出，不会走到这里。
    if (config._validationDiagnostics) {
      const diag = config._validationDiagnostics;
      const logger = getLogger();
      if (diag.warnings.length > 0) {
        logger.debug("CONFIG", `配置有 ${diag.warnings.length} 条提示:`);
        for (const w of diag.warnings) {
          logger.debug("CONFIG", `  ⚠ ${w.path}: ${w.message}`);
        }
      }
      if (diag.errors.length > 0) {
        logger.warn("CONFIG", `配置验证发现 ${diag.errors.length} 个非致命错误:`);
        for (const e of diag.errors) {
          logger.warn("CONFIG", `  ✗ ${e.path}: ${e.message}`);
        }
      }
    }

    // headless(--print) 模式：诊断默认可见（不依赖 --debug），有问题才输出、无问题零输出；
    // 固定走 stderr，不碰 stdout（--output-format json/stream-json 靠 stdout 输出结构化数据）。
    // 门控在 config.print 上，天然排除 TUI —— Ink 接管终端前的裸 console 输出会在正式渲染
    // 上方留下游离行（同一原因，恢复会话提示此前已从 console.log 改为 logger）。
    if (config.print && config._validationDiagnostics) {
      const diag = config._validationDiagnostics;
      const total = diag.warnings.length + diag.errors.length;
      if (total > 0) {
        console.error(`配置检查发现 ${total} 项提示（不影响本次启动，可能导致部分功能未按预期工作）:`);
        for (const e of diag.errors) {
          console.error(`  ✗ [错误] ${e.path}: ${e.message}`);
        }
        for (const w of diag.warnings) {
          console.error(`  ⚠ [提示] ${w.path}: ${w.message}`);
        }
        const logPath = config.debug ? config.debugLogFile : (config.auditLogFile ?? "~/.sid-code/audit.log");
        console.error(`详情见 ${logPath}`);
      }
    }

    // 处理会话管理命令（不需要 API Key）
    if (cliArgs["list-sessions"]) {
      const { handleListSessions } = await import("./session/commands.ts");
      await handleListSessions();
      return;
    }
    if (cliArgs["browse-sessions"]) {
      await handleBrowseSessions(config);
      return;
    }
    if (cliArgs["delete-session"]) {
      const { handleDeleteSession } = await import("./session/commands.ts");
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

    // 验证 API Key。
    // - headless（print）模式：缺 key 无法交互，按原样报错退出（文案指向配置位置）。
    // - TUI 模式：缺 key 不退出，标记 _needsOnboarding，进界面后由 OnboardingDialog 引导。
    //   （config.ts loadConfig 已处理"完全空配置"分支；此处覆盖"provider 有值但缺 key"。）
    const missingKey =
      (config.provider === "anthropic" && !config.anthropicKey) ||
      (config.provider === "openai" && !config.openaiKey);
    if (missingKey) {
      if (config.print) {
        const keyName = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        console.error(
          `错误: 未配置 ${keyName}。\n` +
          `请在 ~/.sid-code/settings.json 配置 availableModels[].api_key，或设置环境变量 ${keyName}。`,
        );
        process.exit(1);
      }
      config._needsOnboarding = true;
    }

    // Settings 系统：Phase 2 全量环境变量（信任边界之后）+ 启动文件变更监听。
    // 当前无独立信任对话框 UI，以"通过 API Key 校验、确定在此项目运行"为信任边界。
    if (!config.print) {
      try {
        const { applyAllConfigEnvironmentVariables } = await import(
          "./config/settings/managed-env.ts"
        );
        applyAllConfigEnvironmentVariables();

        const { initializeChangeDetector } = await import(
          "./config/settings/change-detector.ts"
        );
        const { getSettingsFilePaths } = await import(
          "./config/settings/constants.ts"
        );
        initializeChangeDetector(getSettingsFilePaths());
      } catch (err) {
        getLogger().warn("SETTINGS", `Phase 2 / 变更监听初始化跳过: ${err}`);
      }
    }

    profileCheckpoint("init_start");

    // 创建 ProviderRegistry（Provider 工厂 + 缓存 + 子代理模型映射）
    const { ProviderRegistry } = await import("./llm/registry.ts");
    // _needsOnboarding 时 provider 可能为空，给兜底名使 registry 可构造占位 Provider
    // （registry 仅对未知 provider 名 throw；空 model/key 构造 OpenAIProvider 无碍）。
    // 该 Provider 永不实际发起 LLM 调用（TUI 弹 OnboardingDialog 收集配置前不进查询循环）。
    if (config._needsOnboarding && !config.provider) {
      config.provider = "openai";
    }
    const providerRegistry = new ProviderRegistry(config, config.subAgentModels);
    let provider: import("./llm/provider.ts").Provider;
    try {
      provider = providerRegistry.getProvider();
    } catch (err: any) {
      if (config._needsOnboarding) {
        // 兜底：构造失败也不退出，创建一个最简 OpenAI Provider 占位
        const { OpenAIProvider } = await import("./llm/openai.ts");
        provider = new OpenAIProvider("", config.model || "placeholder");
      } else {
        console.error(`创建 Provider 失败: ${err.message}`);
        process.exit(1);
      }
    }

    // 记录 Provider 信息
    if (config.debug) {
      const { getLogger } = await import("./debug/logger.ts");
      getLogger().info("CONFIG", `Provider: ${config.provider} model=${config.model} baseURL=${config.baseURL || "(默认)"}`);
    }

    // 注册内置工具（共享 FileReadTracker 实例）
    profileCheckpoint("tool_reg_start");
    const { Registry: ToolRegistry } = await import("./tool/registry.ts");
    const { FileReadTracker } = await import("./tool/file-read-tracker.ts");
    const { MemoryStore } = await import("./memory/store.ts");
    const toolRegistry = new ToolRegistry();
    // P0-2：延迟加载豁免名单（高频工具强制首轮可见，省每会话 tool_search 往返）。
    // 在注册任何工具前设置即可——isToolDeferred 每次调用时实时读该名单。
    toolRegistry.setKeepLoaded(config.toolSearchKeepLoaded);
    const fileReadTracker = new FileReadTracker();
    const memoryStore = new MemoryStore(process.cwd());

    const { BashTool } = await import("./tool/bash.ts");
    const { GrepTool } = await import("./tool/grep.ts");
    const { GlobTool } = await import("./tool/glob.ts");
    const { LsTool } = await import("./tool/ls.ts");
    const { WebFetchTool } = await import("./tool/web-fetch.ts");
    const { MemoryTool } = await import("./tool/memory.ts");
    const { createStatefulTools } = await import("./tool/stateful-tools.ts");

    // 有状态工具（read/edit/read_many/write）经工厂用同一 tracker 构造，
    // 与子代理隔离路径（sub-agent.ts）共用工厂，避免构造逻辑漂移。
    // write 已并入工厂（与 edit 共享 tracker 做先读后写 + 写后回写），不再单独注册。
    for (const t of createStatefulTools(fileReadTracker)) toolRegistry.register(t);
    toolRegistry.register(new BashTool());
    toolRegistry.register(new GrepTool());
    // G21：glob/ls 需接权限 deny 规则做列举过滤，但 permissionChecker 此刻尚未创建，
    // 先留引用，待 checker 就绪后 setPathHiddenFilter 后置注入（见下方权限检查器创建处）。
    const globTool = new GlobTool();
    const lsTool = new LsTool();
    toolRegistry.register(globTool);
    toolRegistry.register(lsTool);
    toolRegistry.register(new WebFetchTool());
    toolRegistry.register(new MemoryTool(memoryStore));

    // 注册 LSP 代码智能查询工具（goToDefinition/findReferences/hover/documentSymbol 等 9 操作）。
    // isEnabled 自动检测：LSP 初始化成功/进行中才进上下文，无配置时不暴露给模型（零配置体验）。
    const { LSPTool } = await import("./tool/lsp.ts");
    toolRegistry.register(new LSPTool());

    // 注册 web_search 工具（始终可用，DuckDuckGo 兜底）
    const { createSearchBackend } = await import("./tool/search-backends/factory.ts");
    const { WebSearchTool } = await import("./tool/web-search.ts");
    const searchBackend = createSearchBackend(config.search);
    toolRegistry.register(new WebSearchTool(searchBackend));

    // 创建 Plan Mode 管理器 + 注册 Plan Mode 工具
    const { PlanModeManager } = await import("./plan/state.ts");
    const { EnterPlanModeTool } = await import("./tool/enter-plan-mode.ts");
    const { ExitPlanModeTool } = await import("./tool/exit-plan-mode.ts");
    const planManager = new PlanModeManager();
    toolRegistry.register(new EnterPlanModeTool(planManager));
    toolRegistry.register(new ExitPlanModeTool(planManager));

    // 注册 TodoWrite 工具（执行阶段进度追踪，防 Plan Mode 套娃）
    const { TodoWriteTool } = await import("./tool/todo-write.ts");
    toolRegistry.register(new TodoWriteTool());

    // 注册结构化提问工具（对标 cc AskUserQuestion）：模型遇关键岔路口时向用户抛
    // 选择题、收集决策。shouldDefer，由 tool_search 按需调出；TUI 模式弹交互对话框，
    // headless 模式自动降级为"无法提问"提示（见 ask-user-question-bridge.ts）。
    const { AskUserQuestionTool } = await import("./tool/ask-user-question.ts");
    toolRegistry.register(new AskUserQuestionTool());

    // G11：注册 NotebookEdit 工具（cell 级 .ipynb 编辑，与 Read 的 notebook 支持配套）。
    // shouldDefer，由 tool_search 按需调出——多数会话不涉及 notebook。
    const { NotebookEditTool } = await import("./tool/notebook-edit.ts");
    toolRegistry.register(new NotebookEditTool());

    // G19：注册 think 工具——全仓首个用新泛型 buildTool() 定义、经 toLegacyTool() bridge
    // 适配到产线 registry 的工具，验证新接口 → bridge → registry 链路真实可用。
    const { createThinkTool } = await import("./tool/think.ts");
    toolRegistry.register(createThinkTool());

    // 注册假设登记表工具（环节③：把"怀疑自己的假设"从模型自律外化为 harness 机制）。
    // register 工具持有 ledger，challenge 工具复用同一实例；turnProvider 暂用占位（轮次仅用于
    // 证据追溯，非关键路径）。queryLoop 经 deps.getHypothesisLedger 读取做矛盾中断 + 交付门禁。
    const { HypothesisRegisterTool, HypothesisChallengeTool } = await import("./tool/hypothesis.ts");
    const hypothesisRegisterTool = new HypothesisRegisterTool();
    toolRegistry.register(hypothesisRegisterTool);
    toolRegistry.register(new HypothesisChallengeTool(hypothesisRegisterTool.getLedger()));

    // 注册子代理工具
    const { SubAgentTool } = await import("./agent/tool.ts");
    toolRegistry.register(new SubAgentTool(providerRegistry, toolRegistry));

    // 注册工具搜索工具（延迟加载机制的调出入口，alwaysLoad 强制首轮可见）
    const { ToolSearchTool } = await import("./tool/tool-search.ts");
    const toolSearchTool = new ToolSearchTool(toolRegistry);
    toolRegistry.register(toolSearchTool);

    // 注册后台任务工具（task 系统已就位，此处补齐工具入口）
    const { TaskOutputTool } = await import("./tool/task-output.ts");
    const { TaskStopTool } = await import("./tool/task-stop.ts");
    const { TaskListTool } = await import("./tool/task-list.ts");
    const { TaskGetTool } = await import("./tool/task-get.ts");
    const { SendMessageTool } = await import("./tool/send-message.ts");
    toolRegistry.register(new TaskOutputTool());
    toolRegistry.register(new TaskStopTool());
    toolRegistry.register(new TaskListTool());
    toolRegistry.register(new TaskGetTool());
    toolRegistry.register(new SendMessageTool(providerRegistry, toolRegistry));

    // 注册 Worktree 隔离工具（D27: 仅在 git 仓库或配置了 WorktreeCreate/Remove hook 时注册）
    {
      const { findGitRoot } = await import("./worktree/manager.ts");
      const { hasWorktreeCreateHook, hasWorktreeRemoveHook } = await import("./worktree/hooks.ts");
      const gitRoot = findGitRoot(process.cwd());
      if (gitRoot || hasWorktreeCreateHook() || hasWorktreeRemoveHook()) {
        const { EnterWorktreeTool } = await import("./tool/enter-worktree.ts");
        const { ExitWorktreeTool } = await import("./tool/exit-worktree.ts");
        toolRegistry.register(new EnterWorktreeTool());
        toolRegistry.register(new ExitWorktreeTool());
      }
    }

    // 注册 Cron 调度工具
    const { CronCreateTool } = await import("./tool/cron-create.ts");
    const { CronDeleteTool } = await import("./tool/cron-delete.ts");
    const { CronListTool } = await import("./tool/cron-list.ts");
    const { ScheduleWakeupTool } = await import("./tool/schedule-wakeup.ts");
    toolRegistry.register(new CronCreateTool());
    toolRegistry.register(new CronDeleteTool());
    toolRegistry.register(new CronListTool());
    toolRegistry.register(new ScheduleWakeupTool());

    // 注册 Swarm 多代理协作工具
    const { TeamCreateTool } = await import("./tool/team-create.ts");
    toolRegistry.register(new TeamCreateTool(providerRegistry, toolRegistry));

    // 注册 Dynamic Workflows 编排工具(延迟工具,由 tool_search 在多 agent 编排场景按需调出)
    const { WorkflowTool } = await import("./tool/workflow.ts");
    toolRegistry.register(new WorkflowTool(providerRegistry, toolRegistry));

    // 注册内置命令
    const { Registry: CommandRegistry } = await import("./command/registry.ts");
    const { registerBuiltins } = await import("./command/builtins.ts");
    const commandRegistry = new CommandRegistry();
    await registerBuiltins(commandRegistry);

    // 注：Bundled Skills（/commit /review 等）不再桥接进旧 Registry。
    // 它们由新命令体系（UnifiedCommandRegistry → loadSkillCommands → loadBundledSkills）
    // 原生加载，App 的 TUI 命令获取/执行走新体系。旧 Registry 仅作回退路径。

    // 加载自定义命令（带信任检查）
    const { CustomCommandLoader } = await import("./command/custom.ts");
    const { TrustManager } = await import("./extension/trust.ts");
    const trustManager = new TrustManager();
    const scanOptions = {
      trustManager,
      trustProjectExtensions: config.trustProjectExtensions,
      onUntrusted: async (files: any[]) => {
        if (config.print) return [];
        const log = getLogger();
        log.warn("TRUST", `发现 ${files.length} 个未信任的项目级扩展，已自动信任`);
        return files;
      },
    };
    const customCmds = await new CustomCommandLoader().loadAll(undefined, scanOptions);
    for (const { cmd, source } of customCmds) commandRegistry.register(cmd, source);

    // 加载 Skills（通过 SkillManager 统一管理）
    const { SkillManager } = await import("./skill/manager.ts");
    const { SkillTool } = await import("./skill/tool.ts");
    const { SkillCommand } = await import("./command/skill-command.ts");
    const skillManager = new SkillManager();
    await skillManager.discover(process.cwd(), scanOptions);

    if (config.disabledSkills && config.disabledSkills.length > 0) {
      skillManager.setDisabledSkills(config.disabledSkills);
    }

    const skills = skillManager.getSkills();
    for (const skill of skills) {
      // 模型调用路径：注册为工具（除非显式禁止模型调用）
      if (!skill.disableModelInvocation) {
        toolRegistry.register(new SkillTool(skill, providerRegistry, toolRegistry));
      }
      // 用户调用路径：注册为斜杠命令 /skill-name（除非显式禁止用户调用）
      // 此前缺失此步骤,导致 /bug-fix 等 skill 命令报"未知命令"。
      if (skill.userInvocable !== false) {
        commandRegistry.register(new SkillCommand(skill), "user");
      }
    }

    // Bundled Skill 模型调用路径（Gap 1）：把 fork 模式且未禁止模型调用的
    // Bundled Skill 注册为工具，使 LLM 可自动调用（与磁盘 Skill 的 SkillTool 对等）。
    // inline 模式语义是注入主对话、不返回结果，不适合做工具，仅保留斜杠命令。
    // 带强副作用的 skill（commit-push-pr / pr-workflow / pr-comments）已在各自定义里
    // 设 disableModelInvocation:true，仅 review(只读) 暴露给模型。
    try {
      const { loadBundledSkills } = await import("./skill/bundled/index.ts");
      const { BundledSkillTool } = await import("./skill/bundled/tool.ts");
      for (const cmd of loadBundledSkills()) {
        if (cmd.type !== "prompt") continue;
        if (cmd.context !== "fork") continue; // inline 不可包装
        if (cmd.disableModelInvocation) continue;
        toolRegistry.register(
          new BundledSkillTool(cmd, providerRegistry, toolRegistry),
        );
      }
    } catch (err: any) {
      getLogger().debug(
        "SKILL",
        `Bundled Skill 工具注册失败: ${err?.message ?? String(err)}`,
      );
    }

    // 加载自定义 Agents（注册为工具 + 注册进统一聚合 registry）
    const { CustomAgentLoader, CustomAgentTool } = await import("./agent/custom.ts");
    const { registerDynamicAgents } = await import("./agent/agent-definition.ts");
    const customAgents = await new CustomAgentLoader().loadAll(undefined, scanOptions);
    // 注册进聚合 registry：让 sub_agent 的 type 枚举能发现自定义 agent
    if (customAgents.length > 0) {
      registerDynamicAgents(
        customAgents.map((def) => ({
          agentType: def.name,
          description: def.description,
          whenToUse: def.description,
          systemPrompt: def.prompt,
          tools: def.tools.length > 0 ? def.tools : undefined,
          source: "userSettings" as const,
          filePath: def.filePath,
        })),
      );
    }
    for (const def of customAgents) {
      toolRegistry.register(new CustomAgentTool(def, providerRegistry, toolRegistry));
    }

    // 加载插件组件（命令 / Agent；Hooks 和 MCP 在下方各自的初始化点接入）
    let pluginMcpServers: Record<string, import("./config/config.ts").MCPServerConfig> = {};
    try {
      const {
        mergePluginCommands,
        loadPluginAgents,
        collectPluginMcpServers,
      } = await import("./plugin/index.ts");

      // 插件命令（带 pluginName: 前缀，与内置/自定义命令隔离）
      const pluginCmdCount = await mergePluginCommands(commandRegistry);

      // 插件 Agent（注册为工具 + 注册进聚合 registry，overwrite=false：优先级低于用户自定义）
      const pluginAgents = await loadPluginAgents();
      if (pluginAgents.length > 0) {
        registerDynamicAgents(
          pluginAgents.map((def) => ({
            agentType: def.name,
            description: def.description,
            whenToUse: def.description,
            systemPrompt: def.prompt,
            tools: def.tools.length > 0 ? def.tools : undefined,
            source: "plugin" as const,
            filePath: def.filePath,
          })),
          false,
        );
      }
      for (const def of pluginAgents) {
        toolRegistry.register(new CustomAgentTool(def, providerRegistry, toolRegistry));
      }

      // 收集插件 MCP 服务器（合并到 config.mcpServers，下方统一连接）
      pluginMcpServers = await collectPluginMcpServers();

      if (pluginCmdCount > 0 || pluginAgents.length > 0 || Object.keys(pluginMcpServers).length > 0) {
        getLogger().info("PLUGIN", `插件组件: ${pluginCmdCount} 命令, ${pluginAgents.length} Agent, ${Object.keys(pluginMcpServers).length} MCP 服务器`);
      }
    } catch (err: any) {
      getLogger().error("PLUGIN", `插件组件加载失败: ${err.message}`);
    }

    profileCheckpoint("tool_reg_end");

    // 初始化 MCP 服务器（后台连接，不阻塞启动）—— 合并用户配置 + 插件 MCP
    const allMcpServers = { ...config.mcpServers, ...pluginMcpServers };
    let mcpManager: import("./mcp/manager.ts").MCPManager | undefined;

    // IDE 自动连接需要 mcpManager（IDE 作为动态 MCP server 接入），
    // 因此即使没有配置 MCP 服务器，只要 IDE 自动连接生效也创建 manager
    const { shouldAutoConnect } = await import("./ide/integration.ts");
    const ideAutoConnect = shouldAutoConnect();

    if (Object.keys(allMcpServers).length > 0 || ideAutoConnect) {
      const { MCPManager } = await import("./mcp/manager.ts");
      mcpManager = new MCPManager();

      // 回填 tool_search 的 MCP pending 检测：搜索无果时若有 server 仍在连接中，
      // 提示模型稍后重试（避免启动初期 MCP 异步连接未完成时误判工具不存在）。
      const { MCPConnectionStatus } = await import("./mcp/types.ts");
      const mgr = mcpManager;
      toolSearchTool.setPendingMcpServers(() =>
        mgr
          .getStatus()
          .filter(
            (s) =>
              s.status === MCPConnectionStatus.CONNECTING ||
              s.status === MCPConnectionStatus.RECONNECTING,
          )
          .map((s) => s.name),
      );

      mcpManager.onToolsRefresh = (serverName, tools) => {
        const prefix = `mcp__${serverName}__`;
        toolRegistry.removeByPrefix(prefix);
        for (const tool of tools) toolRegistry.register(tool);
        // 动态刷新（IDE/重连）换了工具集，清 paramText 缓存避免陈旧参数文本。
        toolRegistry.invalidateParamTextCache();
      };

      // G3 接线：注入 Elicitation 处理器（服务器请求额外信息时用终端交互处理）。
      // App 就绪后可用 UI 版覆盖（见 App）；此处提供 CLI 版兜底，避免默认 cancel 一切。
      {
        const { cliElicitationHandler } = await import("./mcp/elicitation.ts");
        mcpManager.elicitationHandler = cliElicitationHandler;
      }

      if (Object.keys(allMcpServers).length > 0) {
        mcpManager.connectAll(allMcpServers).then((mcpTools) => {
          for (const tool of mcpTools) toolRegistry.register(tool);
          if (mcpTools.length > 0) {
            // 新工具进池后清 paramText 缓存：延迟工具集变化（含 schema 可能更新），
            // 避免 tool_search 命中陈旧参数文本（借鉴 CC ToolSearchTool 的缓存失效）。
            toolRegistry.invalidateParamTextCache();
            getLogger().info("MCP", `已连接，注册 ${mcpTools.length} 个工具`);
          }
        }).catch((err: any) => {
          getLogger().error("MCP", `初始化失败: ${err.message}`);
        });
      }
    }

    // IDE 自动发现与连接（后台进行，不阻塞启动）
    // 复用 mcpManager 的 onToolsRefresh 同步工具，IDE 作为动态 MCP server 接入
    if (mcpManager && ideAutoConnect) {
      const { getIDEIntegration } = await import("./ide/integration.ts");
      const ideIntegration = getIDEIntegration(mcpManager, process.cwd(), {
        discoveryTimeout: config.ide?.discoveryTimeout,
      });
      void ideIntegration?.startAutoConnect().catch((err: any) => {
        getLogger().debug("IDE", `自动连接失败: ${err.message}`);
      });
    }

    // LSP 代码智能系统懒初始化（后台进行，不阻塞启动）
    // 无 LSP 配置或语言服务器不可用时自动降级为无操作
    try {
      const { initializeLSP } = await import("./lsp/manager.ts");
      initializeLSP(process.cwd());
    } catch (err: any) {
      getLogger().debug("LSP", `LSP 初始化跳过: ${err.message}`);
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
    permissionChecker.setPlanManager(planManager);

    // G21：把权限 deny 规则接入 glob/ls 列举过滤——被 deny 的敏感文件（.env / secrets/**）
    // 不再出现在列举结果里（对标 claude-code），而非仅在后续 Read 时才被拦。
    // isPathHidden 仅做静态 deny 规则匹配（无 LLM/交互/副作用），高频调用无成本；
    // 无 deny 规则时恒 false（零开销、行为不变）。绑定实例方法保留 this。
    {
      const hidden = (absPath: string) => permissionChecker.isPathHidden(absPath);
      globTool.setPathHiddenFilter(hidden);
      lsTool.setPathHiddenFilter(hidden);
    }

    // 注入 LLM 命令风险分类器（P0-3 迭代 II，第二道防线；默认关闭，enableLLMClassifier 开启）
    {
      const { BashClassifier } = await import("./permission/bash-classifier.ts");
      const classifier = new BashClassifier({
        enabled: config.enableLLMClassifier === true,
        model: config.classifierModel,
      });
      if (config.enableLLMClassifier === true) {
        // 复用主 provider；模型默认跟主循环模型
        classifier.setProvider(providerRegistry.getProvider(), config.classifierModel || config.model);
      }
      permissionChecker.setBashClassifier(classifier);
    }

    // G2 修复：注入泛化工具安全分类器（auto 权限模式核心）。
    // 此前 tool-classifier.ts + checker auto 分支写好了但生产从未调 setToolClassifier，
    // 导致 classifier 恒 null → auto 分支整段短路、行为等价 default（死档），
    // 且 Shift+Tab 循环主动跳过 auto 档。这里补上接线，让 auto 模式对用户可达。
    //
    // 分类器仅在 permissionMode === "auto" 时被 checker 调用（checker.ts:652），
    // 非 auto 模式下不产生任何 API 成本，故默认 enabled=true 恒设 provider 无副作用。
    // 复用主 provider + 主循环模型（与 BashClassifier 一致的注入路径）。
    {
      const { ToolClassifier } = await import("./permission/tool-classifier.ts");
      const toolClassifier = new ToolClassifier({
        enabled: true,
        model: config.classifierModel,
      });
      toolClassifier.setProvider(providerRegistry.getProvider(), config.classifierModel || config.model);
      permissionChecker.setToolClassifier(toolClassifier);
    }

    if (config.debug && permissionRules) {
      const { getLogger } = await import("./debug/logger.ts");
      const allowCount = permissionRules.allow?.length ?? 0;
      const denyCount = permissionRules.deny?.length ?? 0;
      const askCount = permissionRules.ask?.length ?? 0;
      getLogger().info("CONFIG", `权限规则: ${allowCount}条 allow, ${denyCount}条 deny, ${askCount}条 ask`);
    }

    // 沙箱初始化（macOS Seatbelt，默认关闭）
    if (config.enableSandbox) {
      const { SandboxManager, defaultSandboxConfig } = await import("./permission/sandbox.ts");
      const sandboxConfig = { ...defaultSandboxConfig(), enabled: true };
      const sandboxManager = new SandboxManager(sandboxConfig, process.cwd());
      permissionChecker.setSandboxManager(sandboxManager);
      // 注入到 bash 工具（遍历工具注册表找 BashTool）
      for (const tool of toolRegistry.all()) {
        const maybeBash = tool as { setSandboxManager?: (m: typeof sandboxManager) => void };
        if (typeof maybeBash.setSandboxManager === "function") {
          maybeBash.setSandboxManager(sandboxManager);
        }
      }
      getLogger().info("CONFIG", "macOS Seatbelt 沙箱已启用");
    }

    profileCheckpoint("init_end");

    // 创建统一命令注册表（新体系）：承载 custom/skill(含 bundled)/builtin/plugin 四来源。
    // App 的 TUI 命令获取/执行走此注册表；旧 commandRegistry 仍传入作回退 + /help 摘要数据源。
    const { UnifiedCommandRegistry } = await import("./command/unified-registry.ts");
    const unifiedRegistry = new UnifiedCommandRegistry({
      scanOptions,
      disabledSkills: config.disabledSkills,
    });
    // 预加载插件命令快照（custom/skill/builtin 由 getCommands 按 cwd 懒加载并缓存）
    try {
      await unifiedRegistry.loadPlugins();
    } catch (err: any) {
      getLogger().warn("CLI", `预加载插件命令失败: ${err?.message}`);
    }

    // 创建 App
    const { App } = await import("./app.ts");
    const app = new App({ config, provider, providerRegistry, toolRegistry, commandRegistry, unifiedRegistry, permissionChecker, mcpManager, planManager, fileReadTracker });
    // 注册全局 App 弱引用（供 uncaughtException 等异常兜底使用）
    setLastApp(app);

    // 注册并发会话（Spec 18 §4）+ 启动 Cron 调度器（Spec 18 §5）
    {
      const { registerSession, unregisterSession } = await import("./session/concurrent.ts");
      const sessionEntry = {
        sessionId: config.sessionId,
        pid: process.pid,
        kind: (config.print ? "headless" : "interactive") as "headless" | "interactive",
        cwd: process.cwd(),
        startedAt: Date.now(),
        model: config.model,
      };
      registerSession(sessionEntry);

      // Cron 调度器：onFire 把 prompt 注入 App 主循环；isLoading 避免 REPL 忙时触发
      const { getScheduler } = await import("./cron/scheduler.ts");
      const scheduler = getScheduler({
        onFire: (prompt: string) => {
          void app.enqueueScheduledPrompt?.(prompt);
        },
        isLoading: () => app.isBusy?.() ?? false,
        sessionId: config.sessionId,
        workspaceDir: process.cwd(),
      });
      scheduler.start();

      // 退出时注销会话 + 停止调度器
      const cleanup = () => {
        try { unregisterSession(config.sessionId); } catch { /* 忽略 */ }
        try { scheduler.stop(); } catch { /* 忽略 */ }
      };
      // ASYNC-2 修复：只挂 exit 兜底，不再注册同步 process.exit 的信号 handler。
      // 原先 cli.ts 在此处注册 SIGINT/SIGTERM → cleanup() + 同步 process.exit，
      // 会抢先于 app.ts:registerSignalHandlers 的异步 SessionEnd 落盘（fireSessionEndEvent
      // + finalizeSessionStore 需要 await），导致 Ctrl+C 时 trajectory 只剩 metadata、消息丢失。
      // 现统一由 app.ts 的 onSignal 异步落盘后再 process.exit；其 process.exit 会触发本 'exit'
      // 事件，cleanup（注销并发会话 + 停止调度器，均为同步操作）仍会被执行，幂等无副作用。
      process.once("exit", cleanup);
    }

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

    // 启动时恢复并清理 Worktree（P0-1 / P1-9 / D16），以及 --worktree 启动 flag（P1-2）
    if (!config.print) {
      try {
        const { findGitRoot, restoreWorktreeSession, setCurrentWorktreeSession } =
          await import("./worktree/index.ts");
        const gitRoot = findGitRoot(process.cwd());
        if (gitRoot) {
          let activeWtPath: string | undefined;

          // P1-2：--worktree [name] 启动即创建并进入（优先于 resume）
          if (cliArgs.worktree !== undefined) {
            try {
              const { WorktreeManager } = await import("./worktree/manager.ts");
              const { enterWorktreeCwd } = await import("./worktree/canonical.ts");
              const { saveWorktreeState } = await import("./worktree/persistence.ts");
              const { logWorktreeEvent } = await import("./worktree/analytics.ts");
              const { generateWordSlug } = await import("./plan/slug.ts");
              const { join } = await import("path");
              const worktreesDir = join(gitRoot, ".sid-code", "worktrees");
              const name =
                typeof cliArgs.worktree === "string" && cliArgs.worktree
                  ? cliArgs.worktree
                  : generateWordSlug(worktreesDir);
              const manager = new WorktreeManager(gitRoot);
              const wtSession = await manager.create(name);
              await enterWorktreeCwd(wtSession.worktreePath);
              setCurrentWorktreeSession(wtSession);
              saveWorktreeState(wtSession);
              activeWtPath = wtSession.worktreePath;
              logWorktreeEvent("worktree_created", {
                slug: wtSession.worktreeName,
                hookBased: !!wtSession.hookBased,
                durationMs: wtSession.creationDurationMs,
                viaFlag: true,
              });
              getLogger().info("WORKTREE", `--worktree 启动进入: ${wtSession.worktreePath}`);
            } catch (err: any) {
              getLogger().error("WORKTREE", `--worktree 创建失败: ${err.message}`);
              console.error(`错误: --worktree 创建失败: ${err.message}`);
              process.exit(1);
            }
          } else {
            // P0-1：恢复上次会话的 worktree（进程重启/crash 后）
            const { session, cleared } = restoreWorktreeSession(gitRoot);
            if (session) {
              const { enterWorktreeCwd } = await import("./worktree/canonical.ts");
              const { logWorktreeEvent } = await import("./worktree/analytics.ts");
              try {
                await enterWorktreeCwd(session.worktreePath);
                setCurrentWorktreeSession(session);
                activeWtPath = session.worktreePath;
                logWorktreeEvent("worktree_resume", { slug: session.worktreeName, success: true });
                getLogger().info("WORKTREE", `已恢复 worktree 会话: ${session.worktreeName}`);
              } catch (err: any) {
                getLogger().warn("WORKTREE", `恢复 worktree cwd 失败: ${err.message}`);
              }
            } else if (cleared && config.debug) {
              getLogger().info("WORKTREE", "持久化的 worktree 已失效，已清除状态");
            }
          }

          // D16：后台清理过期临时 worktree（跳过当前活跃 session）
          const { cleanupStaleWorktrees } = await import("./worktree/cleanup.ts");
          cleanupStaleWorktrees(gitRoot, 30, activeWtPath)
            .then((n) => {
              if (n > 0 && config.debug) {
                getLogger().info("WORKTREE", `自动清理: 删除 ${n} 个过期临时 Worktree`);
              }
            })
            .catch(() => {/* 忽略 */});
        }
      } catch (err: any) {
        getLogger().warn("WORKTREE", `worktree 启动处理失败（不阻断）: ${err.message}`);
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

      // 不再 console.log：TUI 渲染前的裸输出会留在 banner 上方的终端 scrollback 里，
      // 用户看到一行游离的「恢复会话: …」。恢复进度只写日志，TUI 首屏会自然呈现历史消息。
      getLogger().info("CLI", `恢复会话: ${session.id} (${session.messages.length} 条消息)`);
      await app.restoreSession(session);
    }

    // 根据模式路由
    if (cliArgs.bridgeUrl) {
      // Bridge 远程控制模式（spec 16 §7）：常驻进程，接受远程客户端连接
      startupTimer.end();
      await app.runBridge({
        url: cliArgs.bridgeUrl,
        authToken: cliArgs.bridgeToken,
      });
    } else if (config.print) {
      if (!cliArgs.prompt) {
        console.error("错误: 无头模式需要提供提示词");
        process.exit(1);
      }
      // 解析 --json-schema 文件 → config.jsonSchema（结构化输出约束）
      if (cliArgs.jsonSchemaFile) {
        try {
          const { readFileSync } = await import("node:fs");
          config.jsonSchema = JSON.parse(readFileSync(cliArgs.jsonSchemaFile, "utf-8"));
        } catch (err) {
          console.error(
            `错误: 无法读取/解析 --json-schema 文件 "${cliArgs.jsonSchemaFile}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          process.exit(1);
        }
      }
      startupTimer.end();
      await app.runHeadless(cliArgs.prompt);
    } else {
      profileCheckpoint("render_start");
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
