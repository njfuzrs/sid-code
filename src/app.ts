/**
 * 应用主循环
 * 实现 Agentic While-Loop：用户输入 → LLM 流式响应 → 工具调用 → 循环
 */

import type { Provider } from "./llm/provider.ts";
import type {
  ContentBlock,
  ToolUseBlock,
  StreamEvent,
  AccumulatedResponse,
} from "./llm/types.ts";
import type { Config } from "./config/config.ts";
import type { Checker } from "./permission/types.ts";
import type { ProviderRegistry } from "./llm/registry.ts";
import type { MCPManager } from "./mcp/manager.ts";
import type { PlanModeManager } from "./plan/state.ts";
import { Manager as ContextManager } from "./context/manager.ts";
import { Registry as ToolRegistry } from "./tool/registry.ts";
import { Registry as CommandRegistry } from "./command/registry.ts";
import { ModelFallback } from "./llm/fallback.ts";
import { ThinkingManager } from "./llm/thinking.ts";
import { SessionState } from "./session/state.ts";
import { QuotaManager } from "./llm/quota.ts";
import { TokenMeter } from "./telemetry/metrics/token-meter.ts";
import { BudgetTracker } from "./telemetry/metrics/budget-tracker.ts";
import type { BudgetRule } from "./telemetry/metrics/budget-tracker.ts";
import type { BudgetRuleConfig } from "./config/config.ts";
import { loadAllCLAUDEmd, watchCLAUDEmd, unwatchCLAUDEmd } from "./config/rules.ts";
import { cleanup as cleanupSettingsWatcher } from "./config/settings/change-detector.ts";
import { stopAppConfigWatcher } from "./config/app-config.ts";
import type { ProjectRules } from "./config/rules.ts";
import { clearPromptCache } from "./config/system-prompt.ts";
import { getLogger, getMemoryMonitor, getSessionMetrics } from "./debug/index.ts";
import { QueryEngine } from "./query/engine.ts";
import { HookSystem } from "./hook/system.ts";
import {
  SDKQueryEngine,
  type SDKQueryEngineDriver,
  StructuredIO,
  CommandQueue,
  runHeadless as sdkRunHeadless,
} from "./sdk/index.ts";
import { JitContextManager } from "./config/jit-context.ts";
import { isAbortError } from "./llm/errors.ts";
import * as CrashMarker from "./trace/crash-marker.ts";
import * as PidManager from "./trace/pid-manager.ts";
import { execSync } from "child_process";
import { readFile } from "fs/promises";
import { resolve, extname, join } from "path";
import { homedir } from "node:os";

/**
 * 展开用户输入中的 @path 引用为文件内容
 * 匹配 @path（不含空格，支持相对/绝对路径）
 * 文件不存在时保留原文，不报错
 */
async function expandAtReferences(input: string): Promise<string> {
  const AT_PATTERN = /@([\w./\-]+)/g;
  const matches = [...input.matchAll(AT_PATTERN)];
  if (matches.length === 0) return input;

  let result = input;
  for (const match of matches) {
    const filePath = match[1];
    try {
      const absPath = resolve(process.cwd(), filePath);
      const content = await readFile(absPath, "utf-8");
      const ext = extname(filePath).slice(1);
      const replacement = `以下是文件 \`${filePath}\` 的内容：\n\`\`\`${ext}\n${content}\n\`\`\``;
      result = result.replace(match[0], replacement);
    } catch {
      // 文件不存在时保留原文
    }
  }
  return result;
}


/** App 配置 */
export interface AppOptions {
  config: Config;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  toolRegistry?: ToolRegistry;
  commandRegistry?: CommandRegistry;
  permissionChecker?: Checker;
  initialPrompt?: string;
  mcpManager?: MCPManager;
  planManager?: PlanModeManager;
}

export class App {
  private config: Config;
  private provider: Provider;
  private providerRegistry?: ProviderRegistry;
  private mcpManager?: MCPManager;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  private permissionChecker: Checker | null;
  private fallback: ModelFallback;
  private thinkingMgr: ThinkingManager;
  private sessionState: SessionState;
  private quotaManager?: QuotaManager;
  private tokenMeter?: TokenMeter;
  private budgetTracker?: BudgetTracker;
  private abortController: AbortController | null = null;
  /** 紧急退出防重入：emergencySessionEnd 只执行一次 */
  private emergencyEnded = false;
  private queryEngine: QueryEngine;
  private hookSystem!: HookSystem;
  private jitContextMgr: JitContextManager;
  /** TelemetryHookProbe 引用（供 Harness 注册 enricher） */
  private telemetryProbe?: import("./telemetry/hook-probe.ts").TelemetryHookProbe;
  /** Plan Mode 管理器 */
  private planManager: PlanModeManager | null = null;
  /** TUI 模式下的权限确认回调（由 TUI 注入），返回 "yes" | "no" | "always" */
  private tuiConfirmCallback: ((toolName: string, toolInput: unknown, desc: string) => Promise<"yes" | "no" | "always">) | null = null;
  /** TUI 状态更新回调（由 TUI 注入，用于同步 permissionMode 等状态） */
  private tuiStateUpdater: ((patch: Record<string, unknown>) => void) | null = null;
  /** 幂等保护：init() 只执行一次 */
  private initPromise: Promise<void> | null = null;
  /** 是否正在处理一轮对话（Cron 调度器据此避免 REPL 忙时触发） */
  private busy = false;
  /** TUI 注入的提示词提交器（Cron 触发时把 prompt 注入主循环） */
  private promptInjector: ((text: string) => Promise<void>) | null = null;
  /** Cron 在 REPL 忙时触发的待处理提示词队列 */
  private scheduledPromptQueue: string[] = [];

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.providerRegistry = opts.providerRegistry;
    this.mcpManager = opts.mcpManager;
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.commandRegistry = opts.commandRegistry ?? new CommandRegistry();
    this.permissionChecker = opts.permissionChecker ?? null;
    this.planManager = opts.planManager ?? null;
    const sessionId = opts.config.sessionId || crypto.randomUUID().slice(0, 8);
    this.ctxMgr = new ContextManager({ maxTokens: 200000 });
    this.ctxMgr.setSessionId(sessionId);
    this.sessionState = new SessionState(sessionId);
    // 成本配额管理（合并 costLimit 和 quota 配置）
    const quotaConfig = opts.config.quota;
    const effectiveCostLimit = quotaConfig?.costLimit ?? opts.config.costLimit;
    if (effectiveCostLimit && effectiveCostLimit > 0) {
      this.quotaManager = new QuotaManager({
        costLimit: effectiveCostLimit,
        requestsPerMinute: quotaConfig?.requestsPerMinute,
        tokensPerMinute: quotaConfig?.tokensPerMinute,
      });
    }

    // Token 计量器（依赖 telemetry bus，延迟到 init() 中创建）
    // 先用 null bus 创建，init() 中 telemetry 启用后会重建
    this.tokenMeter = new TokenMeter(
      null,
      (model, usage) => this.sessionState.calculateCost(model, usage),
    );

    // 预算追踪器（如果配置了 budgetRules）
    if (quotaConfig?.budgetRules?.length) {
      const rules: BudgetRule[] = quotaConfig.budgetRules.map((r: BudgetRuleConfig) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        limitUSD: r.limit_usd,
        scope: r.scope,
        thresholds: {
          warning: r.thresholds?.warning ?? 0.5,
          critical: r.thresholds?.critical ?? 0.8,
          exceeded: r.thresholds?.exceeded ?? 1.0,
        },
        action: r.action ?? "alert",
      }));
      this.budgetTracker = new BudgetTracker(rules, (alert) => {
        getLogger().warn("BUDGET", `${alert.ruleName}: ${alert.level} (${(alert.percentage * 100).toFixed(0)}%)`);
      });
    }
    // Extended Thinking 仅 Anthropic 支持
    this.thinkingMgr = new ThinkingManager(opts.config.provider === "anthropic");
    // 如果有 providerRegistry，从中获取 availability 服务
    const availability = opts.providerRegistry?.availability;

    // 配置 fallback：从 config.fallbackModel 查找 availableModels 中的条目，构建对应 provider
    let fallbackProvider: Provider | undefined;
    let fallbackModel: string | undefined;
    if (opts.config.fallbackModel && opts.providerRegistry) {
      const fbModelConfig = opts.config.availableModels.find(m => m.name === opts.config.fallbackModel);
      if (fbModelConfig && fbModelConfig.provider) {
        fallbackModel = fbModelConfig.name;
        fallbackProvider = opts.providerRegistry.getProviderFor(
          fbModelConfig.provider,
          fbModelConfig.apiKey || "",
          fbModelConfig.baseURL,
        );
      } else {
        getLogger().warn("FALLBACK", `fallback_model "${opts.config.fallbackModel}" 不在 available_models 中或缺少 provider，已忽略`);
      }
    }

    this.fallback = new ModelFallback({ availability, fallbackProvider, fallbackModel }, {
      onRetry: (attempt, error, delayMs) => {
        const log = getLogger();
        log.info("FALLBACK", `重试 ${attempt}，错误: ${error}，延迟 ${delayMs}ms`);
      },
      onFallback: (reason, model) => {
        const log = getLogger();
        log.warn("FALLBACK", `降级到 ${model}，原因: ${reason}`);
      },
    });

    // 初始化 JIT 上下文管理器
    this.jitContextMgr = new JitContextManager();

    // 初始化 Hook 系统
    this.hookSystem = new HookSystem();
    this.hookSystem.initializeFromLegacy(this.config.hooks);
    this.hookSystem.setSessionId(sessionId);
    this.hookSystem.setCwd(process.cwd());

    // 初始化 QueryEngine（两层架构：QueryEngine → queryLoop）
    this.queryEngine = new QueryEngine({
      config: this.config,
      provider: this.provider,
      ctxMgr: this.ctxMgr,
      toolRegistry: this.toolRegistry,
      sessionState: this.sessionState,
      fallback: this.fallback,
      thinkingMgr: this.thinkingMgr,
      hookSystem: this.hookSystem,
      quotaManager: this.quotaManager,
      tokenMeter: this.tokenMeter,
      budgetTracker: this.budgetTracker,
      executeTools: (content) => this.executeTools(content),
      processStream: (stream, onText) => this.processStream(stream, onText),
      autoCompact: () => this.autoCompact(),
      handleContextOverflow: (err, max) => this.handleContextOverflow(err, max),
      getAbortSignal: () => this.abortController?.signal,
      getPlanModeReminder: async () => {
        if (!this.planManager?.isPlanning()) return null;
        const { buildPlanModeReminder } = await import("./plan/prompt.ts");
        return buildPlanModeReminder(this.planManager.nextReminderIsFull());
      },
    });
  }

  /** 获取自定义命令摘要（供 /help 显示） */
  private getCustomCommandsSummary(): Array<{ name: string; description: string }> {
    const builtinNames = new Set([
      "help", "model", "cost", "compact", "clear", "config", "exit", "undo", "memory",
    ]);
    return this.commandRegistry.all()
      .filter(cmd => !builtinNames.has(cmd.name()))
      .map(cmd => ({ name: cmd.name(), description: cmd.description() }));
  }

  /** 处理上下文溢出错误，委托给 auto-compact 模块 */
  private handleContextOverflow(err: any, currentMaxTokens: number): number | null {
    const { handleContextOverflow: impl } = require("./query/auto-compact.ts");
    return impl(err, currentMaxTokens, this.ctxMgr, this.toolRegistry.size());
  }

  /** 自动压缩，委托给 auto-compact 模块 */
  private async autoCompact(): Promise<void> {
    const { autoCompact: impl } = await import("./query/auto-compact.ts");
    return impl({
      provider: this.provider,
      config: this.config,
      ctxMgr: this.ctxMgr,
      hookSystem: this.hookSystem,
      getAbortSignal: () => this.abortController?.signal,
    });
  }

  /** 初始化：加载系统提示词（幂等，多次调用只执行一次） */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  /** 实际初始化逻辑 */
  private async doInit(): Promise<void> {
    const log = getLogger();
    const initStartMs = Date.now();
    log.info("APP", "开始初始化...");

    // 启动内存监控
    getMemoryMonitor().start();

    // 设置 bash 工具配置（用于环境变量清理）
    const { setBashToolConfig } = await import("./tool/bash.ts");
    setBashToolConfig(this.config);

    // 加载插件 Hooks（原子注册到 HookSystem，失败不阻塞启动）
    try {
      const { loadPluginHooks } = await import("./plugin/index.ts");
      await loadPluginHooks(this.hookSystem);
    } catch (err: any) {
      log.warn("APP", `插件 Hooks 加载失败: ${err.message}`);
    }

    // 工作区信任检查（在加载项目级配置之前）
    if (!this.config.skipPermissions && !this.config.yesMode) {
      const { TrustManager } = await import("./permission/trust.ts");
      const trustMgr = new TrustManager(process.cwd());
      const dangerousItems = await trustMgr.scanDangerousConfigs();
      if (dangerousItems.length > 0 && !(await trustMgr.isTrusted())) {
        log.warn("APP", `检测到 ${dangerousItems.length} 项危险配置，需要用户信任确认`);
        // 在非交互模式下自动拒绝
        if (this.config.print || (this.config.maxTurns !== undefined && this.config.maxTurns > 0)) {
          log.warn("APP", "非交互模式下跳过信任检查，项目级危险配置不会被加载");
        } else {
          // 交互模式：自动信任（后续可替换为 TUI 对话框）
          // TODO: 实现 TUI TrustDialog 组件
          await trustMgr.trust();
          log.info("APP", "工作区已信任");
        }
      }
    }

    let systemPrompt = this.config.systemPrompt;

    // 评测隔离开关：SID_CODE_DISABLE_PROJECT_RULES=1 时跳过 CLAUDE.md 加载，
    // 避免项目 CLAUDE.md 里的目录结构（如 "AgentLoopRunner / src/agent/loop.ts"）
    // 直接作为 case 锚点泄露给 agent，造成 anchor_hit 虚高。
    // 仅供 evals/providers/* wrapper 使用，正常用户路径不应该设这个环境变量。
    const disableProjectRules = process.env.SID_CODE_DISABLE_PROJECT_RULES === "1";

    if (!systemPrompt) {
      if (disableProjectRules) {
        log.info("APP", "SID_CODE_DISABLE_PROJECT_RULES=1，跳过 CLAUDE.md 规则加载（评测隔离模式）");
      } else {
        // 加载并解析 CLAUDE.md 规则
        const projectRules = await loadAllCLAUDEmd(process.cwd());
        if (projectRules) {
          log.debug("APP", `加载 CLAUDE.md 规则 (${projectRules.rawContent.length} 字符)`);
          this.applyProjectRules(projectRules);
        }
      }

      // 构建系统提示词（委托给 init-helpers）
      const { buildInitialSystemPrompt } = await import("./query/init-helpers.ts");
      systemPrompt = await buildInitialSystemPrompt(this.config, this.toolRegistry.all());
    }

    // 多来源规则加载（settings.json 文件）
    if (this.permissionChecker && "initRules" in this.permissionChecker) {
      await (this.permissionChecker as any).initRules();
      log.info("APP", "多来源权限规则加载完成");
    }

    this.ctxMgr.setSystemPrompt(systemPrompt);
    log.info("APP", `初始化完成，系统提示词 ${systemPrompt.length} 字符，工具数 ${this.toolRegistry.size()}`);

    // 启动 CLAUDE.md 文件变化监听（变更时重新加载规则 + 重建系统提示词）
    watchCLAUDEmd(process.cwd(), async (changedPath) => {
      log.info("APP", `CLAUDE.md 已变更: ${changedPath}`);
      // 1. clearPromptCache 已在 watchCLAUDEmd 内部调用
      // 2. 重新加载并应用规则
      const newRules = await loadAllCLAUDEmd(process.cwd());
      if (newRules) {
        this.applyProjectRules(newRules);
        // 3. 重建系统提示词
        const { buildSystemPrompt } = await import("./config/system-prompt.ts");
        let memorySummary: string | undefined;
        try {
          const { MemoryStore } = await import("./memory/store.ts");
          const memStore = new MemoryStore(process.cwd());
          memorySummary = await memStore.generateSummary() || undefined;
        } catch { /* 忽略 */ }

        const newPrompt = buildSystemPrompt({
          tools: this.toolRegistry.all(),
          projectRules: newRules.rawContent,
          projectRulesPath: newRules.sourcePath,
          appendPrompt: this.config.appendSystemPrompt || undefined,
          workingDir: process.cwd(),
          permissionMode: this.config.permissionMode,
          gitStatus: true,
          memorySummary,
          maxTokens: 180000,
        });
        this.ctxMgr.setSystemPrompt(newPrompt);
        log.info("APP", `系统提示词已重建: ${newPrompt.length} 字符`);
      }
    });

    // 轨迹采集初始化（委托给 init-helpers）
    const { initTraceCollector, initTelemetrySystem } = await import("./query/init-helpers.ts");
    await initTraceCollector(this.config, this.hookSystem);

    // session_start hook（非阻塞）
    this.hookSystem.fireSessionStartEvent("startup", { model: this.config.model })
      .catch(err => log.error("HOOK", `session_start hook 失败: ${err.message}`));

    // 遥测系统初始化（委托给 init-helpers）
    const telemetryResult = await initTelemetrySystem(
      this.config, this.hookSystem, this.sessionState, this.tokenMeter,
    );
    if (telemetryResult.tokenMeter) {
      this.tokenMeter = telemetryResult.tokenMeter;
      this.queryEngine.updateTokenMeter(this.tokenMeter);
    }
    if (telemetryResult.telemetryProbe) {
      this.telemetryProbe = telemetryResult.telemetryProbe;
    }

    // 信号兜底：SIGINT / SIGTERM 时强制落地 SessionEnd（reason=abort），避免 trajectory 残留 unknown
    // 这是 25% session 卡在 exit_status=unknown 的另一个根因——promptfoo timeout 时 SIGTERM 杀进程
    this.registerSignalHandlers();

    // PID 文件：标记进程生命周期（启动时写入，正常退出时删除）
    try {
      PidManager.write(this.sessionState.sessionId);
    } catch { /* PID 写入失败不影响启动 */ }

    // 启动诊断：检查上一会话是否异常退出
    try {
      const crash = CrashMarker.readPrevious();
      if (crash) {
        log.warn("DIAG", [
          `上一会话异常退出:`,
          `  时间: ${crash.timestamp}`,
          `  会话: ${crash.session_id}`,
          `  错误: ${crash.error_name}: ${crash.error_message}`,
          `  最后 API 调用: #${crash.last_api_call_index}`,
          `  模型: ${crash.last_model}`,
          `  内存: ${crash.memory_mb.toFixed(1)} MB`,
          `  运行时间: ${crash.uptime_seconds.toFixed(1)}s`,
        ].join("\n"));
      }
    } catch { /* 诊断失败不影响启动 */ }

    // PID 孤儿诊断：扫描残留 PID 文件（进程已退出但 PID 文件未清理 → 异常退出）
    try {
      const orphanPids = PidManager.findOrphanPids();
      if (orphanPids.length > 0) {
        log.warn("DIAG", [
          `发现 ${orphanPids.length} 个孤儿进程残留（进程已退出但 PID 文件未清理）:`,
          ...orphanPids.map(p => `  PID ${p.pid} → session ${p.session_id}, 启动时间 ${p.start_time}`),
        ].join("\n"));
        // 后台清理孤儿 PID 文件
        for (const p of orphanPids) {
          try { PidManager.cleanup(p.session_id); } catch { /* ignore */ }
        }
      }
    } catch { /* 诊断失败不影响启动 */ }

    // 心跳残留诊断：检测有心跳无 crash.json 的会话 → 疑似 hang/僵尸
    try {
      const stale = PidManager.scanStaleHeartbeats();
      if (stale.length > 0) {
        log.warn("DIAG", [
          `发现 ${stale.length} 个疑似 hang/僵尸会话（有心跳无 crash.json，最后心跳 >30s）:`,
          ...stale.map(s => `  session ${s.session_id}, 最后心跳 ${s.last_heartbeat_ts}, 进程状态 ${s.is_process_alive ? "存活" : "已退出"}`),
        ].join("\n"));
      }
    } catch { /* 诊断失败不影响启动 */ }

    // 启动耗时事件（spec 17 §3.1 零依赖事件 API 埋点示例）
    try {
      const { logEvent } = await import("./analytics/index.ts");
      logEvent("startup_timing", { duration_ms: Date.now() - initStartMs });
    } catch { /* 遥测旁路，绝不影响启动 */ }
  }

  /** 注册信号处理：SIGINT/SIGTERM 时同步触发 SessionEnd，避免 trajectory 丢失 */
  private signalHandlersRegistered = false;
  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const log = getLogger();
    const onSignal = async (signal: "SIGINT" | "SIGTERM") => {
      log.warn("APP", `收到 ${signal}，触发 SessionEnd(reason=abort) 后退出`);
      // 触发 abort 让 LLM 流式请求/工具调用尽快停下
      try { this.abortController?.abort(); } catch { /* ignore */ }
      try {
        await this.hookSystem.fireSessionEndEvent(
          "abort",
          this.buildSessionEndStats(),
          { error: { message: `process received ${signal}`, name: signal } },
        );
      } catch (err: any) {
        process.stderr.write(`[signal] SessionEnd hook 失败: ${err?.message ?? err}\n`);
      }
      // 清理 crash marker（正常退出不残留）
      try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
      try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
      // 给 trajectory 写入一点时间，再强制退出
      setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 200);
    };

    // 用 once 防止 SIGTERM 风暴下重入；fire-and-forget 让 process.on 不卡死
    process.once("SIGINT", () => { void onSignal("SIGINT"); });
    process.once("SIGTERM", () => { void onSignal("SIGTERM"); });
  }

  /**
   * 应用 CLAUDE.md 中解析出的结构化规则到运行时配置
   * 只覆盖 CLAUDE.md 中明确指定的字段，不影响命令行参数和配置文件的设置
   */
  private applyProjectRules(rules: ProjectRules): void {
    const log = getLogger();

    // 工具白名单（合并，不覆盖命令行配置）
    if (rules.allowedTools?.length) {
      this.config.allowedTools = [
        ...this.config.allowedTools,
        ...rules.allowedTools,
      ];
      log.info("APP", `CLAUDE.md 工具白名单: ${rules.allowedTools.join(", ")}`);
    }

    // 工具黑名单（合并）
    if (rules.disallowedTools?.length) {
      this.config.disallowedTools = [
        ...this.config.disallowedTools,
        ...rules.disallowedTools,
      ];
      log.info("APP", `CLAUDE.md 工具黑名单: ${rules.disallowedTools.join(", ")}`);
    }

    // 权限模式（仅当命令行未指定时才覆盖）
    if (rules.permissionMode && this.config.permissionMode === "default") {
      this.config.permissionMode = rules.permissionMode;
      log.info("APP", `CLAUDE.md 权限模式: ${rules.permissionMode}`);
    }

    // 模型选择（仅当命令行未指定时才覆盖）
    if (rules.model && !process.argv.includes("--model")) {
      this.config.model = rules.model;
      log.info("APP", `CLAUDE.md 模型: ${rules.model}`);
    }

    // systemPromptAddition → appendSystemPrompt（仅当 CLI 未指定 --append-system-prompt 时）
    if (rules.systemPromptAddition && !this.config.appendSystemPrompt) {
      this.config.appendSystemPrompt = rules.systemPromptAddition;
      log.info("APP", `CLAUDE.md 系统提示词追加: ${rules.systemPromptAddition.length} 字符`);
    }

    // instructions → 拼接到 rawContent 前面（作为高优先级指令）
    if (rules.instructions) {
      rules.rawContent = `# Instructions\n${rules.instructions}\n\n---\n\n${rules.rawContent}`;
      log.info("APP", `CLAUDE.md 指令已注入 rawContent 前部: ${rules.instructions.length} 字符`);
    }

    // memory → 异步写入 MemoryStore（不阻塞初始化）
    if (rules.memory && Object.keys(rules.memory).length > 0) {
      this.applyProjectMemory(rules.memory);
    }
  }

  /**
   * 将 CLAUDE.md 中的 memory 键值对写入 MemoryStore
   * 异步执行，不阻塞主流程
   */
  private async applyProjectMemory(memory: Record<string, string>): Promise<void> {
    const log = getLogger();
    try {
      const { MemoryStore } = await import("./memory/store.ts");
      const memStore = new MemoryStore(process.cwd());
      await memStore.load();
      for (const [key, value] of Object.entries(memory)) {
        await memStore.set(key, value, "project");
        log.info("APP", `CLAUDE.md 记忆写入: ${key} = ${value.slice(0, 50)}${value.length > 50 ? "..." : ""}`);
      }
    } catch (err: any) {
      log.warn("APP", `CLAUDE.md 记忆写入失败: ${err.message}`);
    }
  }

  /**
   * 恢复会话：从 SessionData 恢复消息历史
   * 如果消息太多，注入摘要而非完整历史
   */
  async restoreSession(sessionData: import("./session/store.ts").SessionData): Promise<void> {
    const log = getLogger();
    const { SessionStore } = await import("./session/store.ts");

    log.info("APP", `恢复会话: ${sessionData.id}, 消息数 ${sessionData.messages.length}`);

    // 如果消息数量不多，直接恢复
    const SUMMARY_THRESHOLD = 20;
    if (sessionData.messages.length <= SUMMARY_THRESHOLD) {
      this.ctxMgr.setMessages(sessionData.messages);
      log.info("APP", `直接恢复 ${sessionData.messages.length} 条消息`);
      return;
    }

    // 消息太多，尝试加载摘要
    const store = new SessionStore();
    const summary = await store.loadSummary(sessionData.id);

    if (summary) {
      // 有摘要，注入摘要 + 最近消息
      const recentMessages = sessionData.messages.slice(-10);
      const resumeMsg = SessionStore.buildResumeMessage(summary.summary);
      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: resumeMsg }],
      });
      this.ctxMgr.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      });
      for (const msg of recentMessages) {
        this.ctxMgr.addMessage(msg);
      }
      log.info("APP", `恢复会话：摘要 + 最近 ${recentMessages.length} 条消息`);
    } else {
      // 无摘要，简单截断
      const recentMessages = sessionData.messages.slice(-15);
      this.ctxMgr.setMessages(recentMessages);
      log.warn("APP", `无摘要，仅恢复最近 ${recentMessages.length} 条消息`);
    }
  }

  /** 处理流式响应，委托给 stream-processor */
  async processStream(
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ): Promise<AccumulatedResponse> {
    const { processStream: processStreamImpl } = await import("./query/stream-processor.ts");
    return processStreamImpl(stream, onText, {
      getAbortController: () => this.abortController,
    });
  }

  /** 设置 TUI 模式下的权限确认回调 */
  setTUIConfirmCallback(cb: (toolName: string, toolInput: unknown, desc: string) => Promise<"yes" | "no" | "always">): void {
    this.tuiConfirmCallback = cb;
  }

  /** 请求用户确认（TUI 回调 或 headless 自动决策） */
  private async requestUserConfirmation(
    description: string,
    req?: import("./permission/types.ts").PermissionRequest,
    toolName?: string,
    toolInput?: unknown,
  ): Promise<boolean> {
    // TUI 模式：使用注入的回调
    if (this.tuiConfirmCallback) {
      const answer = await this.tuiConfirmCallback(toolName || "", toolInput, description);
      if (answer === "always") {
        if (req && this.permissionChecker?.rememberDecision) {
          this.permissionChecker.rememberDecision(req, true);
        }
        return true;
      }
      return answer === "yes";
    }

    // headless 模式：根据权限模式自动决策
    return this.config.permissionMode === "always-allow";
  }

  /** 执行工具调用，委托给 tool-executor */
  async executeTools(content: ContentBlock[]): Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }> {
    const { executeTools: executeToolsImpl } = await import("./query/tool-executor.ts");
    return executeToolsImpl(content, {
      config: this.config,
      toolRegistry: this.toolRegistry,
      sessionState: this.sessionState,
      hookSystem: this.hookSystem,
      permissionChecker: this.permissionChecker,
      getAbortSignal: () => this.abortController?.signal,
      requestUserConfirmation: (desc, permReq, toolName, toolInput) =>
        this.requestUserConfirmation(desc, permReq, toolName, toolInput),
      handlePlanModeTransitions: (toolBlocks, resultMap) =>
        this.handlePlanModeTransitions(toolBlocks, resultMap),
      getPlanModeReminder: async () => {
        if (!this.planManager?.isPlanning()) return null;
        const { buildPlanModeReminder } = await import("./plan/prompt.ts");
        // 节流：每 N 轮发完整提醒，中间轮次发简短提醒，省 token
        return buildPlanModeReminder(this.planManager.nextReminderIsFull());
      },
      discoverJitContext: (toolBlocks) => this.discoverJitContext(toolBlocks),
    });
  }

  /**
   * Plan Mode 状态转换处理
   * 在工具执行完成后，检查是否有 enter/exit_plan_mode 调用，执行相应的状态转换
   * 使用 resultMap（按原始索引存储）避免数组错位
   *
   * ADR-019：返回 followup 让 loop 在 toolResults 之后再 enqueue。
   * 不能在本函数内 ctxMgr.addMessage(plan-approved 文本) —— 会插在 user(tool_result) 之前，
   * 触发 OpenAI 400 "tool_calls must be followed by tool messages"。
   */
  private async handlePlanModeTransitions(
    toolBlocks: Array<{ block: ToolUseBlock; idx: number }>,
    resultMap: Map<number, ContentBlock>,
  ): Promise<{ followup?: ContentBlock[] }> {
    if (!this.planManager) return {};
    const log = getLogger();
    const followup: ContentBlock[] = [];

    for (const { block, idx } of toolBlocks) {
      const result = resultMap.get(idx);

      // 工具执行失败 + 处于 planning 状态 → 触发 Recovery Hook
      if (result && result.type === "tool_result" && result.is_error && this.planManager.isPlanning()) {
        const { getSharedRecoveryHook } = await import("./plan/recovery.ts");
        const hook = getSharedRecoveryHook();
        const ctx = {
          toolName: block.name,
          errorMessage: typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content ?? ""),
          failedArgs: block.input,
          currentPlanFilePath: this.planManager.getPlanFilePath() || "",
          planStepIndex: null,
        };
        const triggerType = block.name === "read" || block.name === "edit"
          ? "file_not_found"
          : "tool_failure";
        if (hook.shouldTrigger(triggerType, ctx)) {
          hook.recordTrigger(triggerType, ctx.currentPlanFilePath);
          const hint = hook.buildRecoveryHint(triggerType, ctx);
          followup.push({ type: "text", text: hint });
          log.info("PLAN", `Recovery Hook 触发: trigger=${triggerType} tool=${block.name}`);
        }
        continue;
      }

      // 跳过执行失败的工具（上面已处理 plan mode 中的失败，这里跳过非 plan mode 的失败）
      if (result && result.type === "tool_result" && result.is_error) continue;

      if (block.name === "enter_plan_mode" && this.planManager.isPlanning()) {
        await this.activatePlanMode();
      }

      if (block.name === "exit_plan_mode" && this.planManager.isAwaitingApproval()) {
        const approvalFollowup = await this.handlePlanApproval();
        if (approvalFollowup) followup.push(...approvalFollowup);
      }

      // plan 文件 write/edit 成功 → 记录 update 计数（plan_recovery capability 用）
      // W12.D2 / ADR-017：让 grader 能拿到真"plan 更新次数"，而不是粗估 tools_called 数量
      if (
        (block.name === "write" || block.name === "edit") &&
        result &&
        result.type === "tool_result" &&
        !result.is_error
      ) {
        const input = block.input as { file_path?: string } | undefined;
        const fp = input?.file_path;
        if (fp && this.planManager.isPlanFile(fp)) {
          this.planManager.recordPlanFileWrite(Date.now());
          log.info("PLAN", `plan 文件 ${block.name} 成功 → update_count=${this.planManager.getPlanFileUpdateCount()}`);
        }
      }
    }

    return followup.length > 0 ? { followup } : {};
  }

  /** 激活 Plan Mode：切换权限模式（不重建 system prompt，对标 Claude Code） */
  private async activatePlanMode(): Promise<void> {
    const log = getLogger();
    log.info("PLAN", "激活 Plan Mode");

    // 保存原始权限模式（退出时恢复）
    if (!this._originalPermissionMode) {
      this._originalPermissionMode = this.config.permissionMode;
    }
    this.config.permissionMode = "plan";

    // 同步 TUI 状态
    this.tuiStateUpdater?.({ permissionMode: "plan", isPlanMode: true });

    // ✅ 不重建 system prompt——plan mode 约束通过 system-reminder 注入
    // 对标 Claude Code：system prompt 不变 + 工具集不变 = Prompt Caching 不中断
  }

  /** 退出 Plan Mode：恢复权限模式（不重建 system prompt，对标 Claude Code） */
  private async deactivatePlanMode(): Promise<void> {
    const log = getLogger();
    log.info("PLAN", "退出 Plan Mode");

    // 恢复原始权限模式
    const restored = this._originalPermissionMode || "default";
    this.config.permissionMode = restored;
    this._originalPermissionMode = null;

    // 同步 TUI 状态
    this.tuiStateUpdater?.({ permissionMode: restored, isPlanMode: false });

    // ✅ 不需要重建 system prompt——plan mode 信息只在 system-reminder 中
  }

  /**
   * 处理 Plan Mode 审批流程
   *
   * ADR-019：返回 followup（plan-approved / plan-rejected 反馈），由调用方 loop 在
   * tool_results 之后再 enqueue。不再在本函数内直接 ctxMgr.addMessage——会让 user(text)
   * 排在 user(tool_result) 之前，违反 OpenAI tool_calls 协议。
   */
  private async handlePlanApproval(): Promise<ContentBlock[] | null> {
    if (!this.planManager) return null;
    const log = getLogger();

    // 审批结果由 TUI 层或 REPL 层处理
    // 这里通过 tuiPlanApprovalCallback 获取用户决策
    if (this.tuiPlanApprovalCallback) {
      const planPath = this.planManager.getPlanFilePath();
      const decision = await this.tuiPlanApprovalCallback(planPath || "");

      if (decision === "approve") {
        this.planManager.approve();
        await this.deactivatePlanMode();
        log.info("PLAN", "用户批准计划，退出 Plan Mode");
        // 注入批准反馈，让 LLM 知道可以开始执行
        // W12.D2 / ADR-017：批准消息嵌入失败更新执行守则
        // 因为 deactivatePlanMode 后系统提示词的 plan prompt（含阶段 5）会被移除，
        // 批准消息是 LLM 进入执行阶段唯一保留的"plan 上下文锚点"
        const { buildPlanApprovedMessage } = await import("./plan/prompt.ts");
        return [{
          type: "text",
          text: buildPlanApprovedMessage(planPath || ""),
        }];
      } else {
        const canContinue = this.planManager.reject();
        if (canContinue) {
          const count = this.planManager.getRejectionCount();
          log.info("PLAN", `用户拒绝计划 (${count}/5)，继续修改`);
          // 注入拒绝反馈，让 LLM 知道需要修改计划
          return [{
            type: "text",
            text: `用户拒绝了你的计划（第 ${count} 次）。请根据用户反馈修改计划文件，然后再次调用 exit_plan_mode 提交审批。`,
          }];
        } else {
          await this.deactivatePlanMode();
          log.info("PLAN", "拒绝次数超限，强制退出 Plan Mode");
          return null;
        }
      }
    } else {
      // 非 TUI 模式（headless）：自动批准
      // W12.D3 修正：headless 也注入执行守则（否则 plan_recovery capability eval 永远拿不到指令）
      const planPath = this.planManager.getPlanFilePath();
      this.planManager.approve();
      await this.deactivatePlanMode();
      log.info("PLAN", "非交互模式，自动批准计划");
      const { buildPlanApprovedMessage } = await import("./plan/prompt.ts");
      return [{
        type: "text",
        text: buildPlanApprovedMessage(planPath || ""),
      }];
    }
  }

  /** 原始权限模式（Plan Mode 退出时恢复） */
  private _originalPermissionMode: string | null = null;

  /** TUI 模式下的 Plan Mode 审批回调，返回 "approve" | "reject" */
  private tuiPlanApprovalCallback: ((planFilePath: string) => Promise<"approve" | "reject">) | null = null;

  /** 设置 Plan Mode 审批回调（由 TUI 注入） */
  setPlanApprovalCallback(cb: (planFilePath: string) => Promise<"approve" | "reject">): void {
    this.tuiPlanApprovalCallback = cb;
  }

  /** 获取 Plan Mode 管理器（供 TUI/命令使用） */
  getPlanManager(): PlanModeManager | null {
    return this.planManager;
  }

  /** 当前是否正在处理一轮对话（Cron 调度器据此判断 REPL 是否空闲） */
  isBusy(): boolean {
    return this.busy;
  }

  /** TUI 注入提示词提交器（Cron 触发时把 prompt 注入主循环） */
  setPromptInjector(injector: (text: string) => Promise<void>): void {
    this.promptInjector = injector;
    // 注入器就绪后，立即冲刷忙时积压的调度提示词
    void this.flushScheduledPrompts();
  }

  /**
   * Cron 触发：把调度的 prompt 注入主循环。
   * REPL 忙时（busy 或无注入器）先入队，待空闲再冲刷，避免污染当前轮上下文。
   */
  async enqueueScheduledPrompt(prompt: string): Promise<void> {
    if (this.busy || !this.promptInjector) {
      this.scheduledPromptQueue.push(prompt);
      return;
    }
    await this.promptInjector(prompt);
  }

  /** 冲刷忙时积压的调度提示词（空闲时调用） */
  private async flushScheduledPrompts(): Promise<void> {
    if (this.busy || !this.promptInjector) return;
    const pending = this.scheduledPromptQueue.splice(0);
    for (const p of pending) {
      await this.promptInjector(p);
    }
  }

  /** JIT 上下文发现：根据工具访问的路径发现新的 CLAUDE.md */
  private async discoverJitContext(toolBlocks: ToolUseBlock[]): Promise<void> {
    // 配置开关（默认开启）
    if (this.config.jitContext === false) return;

    const log = getLogger();
    const projectRoot = process.cwd();

    // 收集工具访问的路径
    const accessedPaths: string[] = [];
    for (const block of toolBlocks) {
      // 只处理文件操作工具
      if (!["read", "write", "edit", "grep", "glob"].includes(block.name)) {
        continue;
      }

      const input = block.input as any;
      if (input?.file_path) {
        accessedPaths.push(input.file_path);
      } else if (input?.path) {
        accessedPaths.push(input.path);
      } else if (input?.pattern && block.name === "glob") {
        // glob 工具访问的是当前目录
        accessedPaths.push(input.path || projectRoot);
      }
    }

    if (accessedPaths.length === 0) return;

    // 对每个路径尝试发现上下文
    for (const path of accessedPaths) {
      try {
        const newContext = await this.jitContextMgr.discoverContext(path, projectRoot);
        if (newContext) {
          // 将新上下文追加到系统提示词
          const currentPrompt = this.ctxMgr.getSystemPrompt();
          this.ctxMgr.setSystemPrompt(currentPrompt + "\n\n" + newContext);
          log.info("JIT", `已加载 JIT 上下文 (${newContext.length} 字符)`);
        }
      } catch (err) {
        log.warn("JIT", `JIT 上下文发现失败: ${path}`, err);
      }
    }
  }

  /** 构建 SessionEnd 统计数据 */
  private buildSessionEndStats() {
    const totalUsage = this.sessionState.getTotalUsage();
    const totalRequests = Object.values(this.sessionState.modelUsage).reduce((sum, s) => sum + s.requests, 0);
    return {
      model: this.config.model,
      total_tokens_sent: totalUsage.inputTokens,
      total_tokens_received: totalUsage.outputTokens,
      total_cache_read_tokens: totalUsage.cacheReadInputTokens ?? 0,
      total_cache_creation_tokens: totalUsage.cacheCreationInputTokens ?? 0,
      total_cost_usd: this.sessionState.totalCostUSD,
      total_api_calls: totalRequests,
      duration_ms: this.sessionState.getElapsedMs(),
    };
  }

  /**
   * 紧急 SessionEnd：uncaughtException / V8 OOM 等无法正常退出的场景。
   *
   * 约束：
   * - 同步优先：先同步写 crash.json，再尝试异步 fireSessionEndEvent（200ms 超时）
   * - 防重入：emergencyEnded flag 确保只执行一次
   * - 幂等：正常 SessionEnd 已触发则跳过（crash.json 已清理）
   */
  emergencySessionEnd(err: Error): void {
    if (this.emergencyEnded) return;
    this.emergencyEnded = true;

    // 1. abort 当前请求
    try { this.abortController?.abort(); } catch { /* ignore */ }

    // 2. 同步写 crash.json 到磁盘（OOM 前的最后一搏）
    try {
      CrashMarker.write({
        session_id: this.sessionState.sessionId,
        timestamp: new Date().toISOString(),
        error_message: err.message,
        error_name: err.name,
        stack: err.stack?.split("\n").slice(0, 10).join("\n"),
        last_api_call_index: -1, // emergency 上下文中无法安全获取
        last_model: this.config.model ?? "unknown",
        memory_mb: process.memoryUsage().rss / 1024 / 1024,
        uptime_seconds: process.uptime(),
      });
    } catch { /* 文件系统可能已不可用 */ }

    // 3. fire-and-forget: 尝试触发 SessionEnd（有 200ms 超时）
    try {
      const promise = this.hookSystem.fireSessionEndEvent(
        "error",
        this.buildSessionEndStats(),
        { error: { message: err.message, name: err.name, stack: err.stack } },
      );
      // 200ms 超时，不阻塞 exit
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 200));
      void Promise.race([promise, timeout]);
    } catch { /* SessionEnd hook 自身报错也不能阻塞退出 */ }
  }

  /** 无头模式：消费 QueryEngine async generator，不依赖任何 renderer */
  async runHeadless(input: string): Promise<string> {
    await this.init();

    // stream-json 模式：走 SDK 编程接口（NDJSON 双向流式）
    if (this.config.outputFormat === "stream-json") {
      await this.runHeadlessSDK(input);
      return "";
    }

    let streamBuffer = "";
    this.queryEngine.setStreamTextCallback((text) => { streamBuffer += text; });

    this.abortController = new AbortController();
    let runError: Error | null = null;
    let aborted = false;
    try {
      for await (const event of this.queryEngine.submitMessage(input)) {
        // 无头模式只关心 done 和 system 消息
        if (event.kind === "done") break;
        if (event.kind === "system" && event.level === "warning") {
          streamBuffer += `\n⚠️ ${event.text}\n`;
        }
      }
    } catch (err: any) {
      runError = err instanceof Error ? err : new Error(String(err));
      aborted = (err && (err.name === "AbortError" || /abort/i.test(err.message ?? ""))) === true;
      // stderr 输出错误，但不抛出——必须让 SessionEnd hook 落地后再退出
      process.stderr.write(`\n[runHeadless] 异常: ${runError.message}\n${runError.stack ?? ""}\n`);
    } finally {
      this.abortController = null;
      this.queryEngine.setStreamTextCallback(null);
    }

    // session_end hook 必须触发——无论正常结束还是异常，否则 trajectory 永远是 unknown
    // reason 三态：abort（用户取消）/ error（运行时异常）/ exit（正常）
    const endReason: "exit" | "error" | "abort" = aborted
      ? "abort"
      : runError
      ? "error"
      : "exit";
    try {
      await this.hookSystem.fireSessionEndEvent(
        endReason,
        this.buildSessionEndStats(),
        runError ? { error: { message: runError.message, name: runError.name, stack: runError.stack } } : undefined,
      );
    } catch (hookErr: any) {
      // SessionEnd hook 自身报错也不能阻塞退出，否则 trajectory 反而丢失
      process.stderr.write(`[runHeadless] SessionEnd hook 失败: ${hookErr?.message ?? hookErr}\n`);
    }
    // 清理 crash marker（正常退出不残留）
    try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
    try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }

    // 输出结果（即使出错也输出已收到的内容，便于诊断）
    if (this.config.outputFormat === "json") {
      const messages = this.ctxMgr.getMessages();
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const traceOutputDir = this.config.trace?.outputDir
        ?? join(homedir(), ".sid-code", "trajectories");
      const result: Record<string, unknown> = {
        session_id: this.sessionState.sessionId,
        trajectory_path: join(traceOutputDir, "sessions", this.sessionState.sessionId, "session.traj"),
        role: "assistant",
        content: lastAssistant?.content || [],
        usage: this.sessionState.getTotalUsage(),
      };
      if (runError) {
        result.error = { message: runError.message, name: runError.name, aborted };
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(streamBuffer);
      if (runError) {
        process.stderr.write(`\n[error] ${runError.message}\n`);
      }
    }

    // 清理
    unwatchCLAUDEmd();
    cleanupSettingsWatcher();
    stopAppConfigWatcher();
    this.mcpManager?.closeAll();

    // 停止内存监控
    getMemoryMonitor().stop();
    getLogger().close();

    // 会话摘要输出到 stderr（避免污染 JSON stdout）
    const summary = getSessionMetrics().getSummary();
    process.stderr.write('\n' + '─'.repeat(60) + '\n');
    process.stderr.write('会话摘要\n');
    process.stderr.write('─'.repeat(60) + '\n');
    process.stderr.write(summary + '\n');
    process.stderr.write('─'.repeat(60) + '\n\n');

    // headless 模式强制退出：init() 启动的 watcher/interval/telemetry 不会自行排空事件循环
    // 出错时 exit code 非 0，方便 wrapper 区分；trajectory 已在上面正确落盘
    // 优雅关闭：刷新遥测/事件缓冲区（500ms 硬超时）后再强制退出（spec 17 §3.4）
    const { runShutdownSequence } = await import("./utils/graceful-shutdown.ts");
    await runShutdownSequence();
    process.exit(runError ? 1 : 0);
  }

  /**
   * Bridge 远程控制模式：通过 WebSocket 中继接受远程客户端的消息，
   * 把 QueryEngine 的事件流转发回远程，并把工具权限确认转交远程决策。
   *
   * 与 runHeadless / runTUI 平级的第三种运行形态（spec 16 §7）。
   * 进程常驻，直到收到 SIGINT/SIGTERM 才退出。
   */
  async runBridge(options: { url: string; authToken?: string; permissionTimeoutMs?: number }): Promise<void> {
    await this.init();

    const { BridgeRunner } = await import("./bridge/bridge-runner.ts");
    const log = getLogger();

    const runner = new BridgeRunner(
      {
        submitMessage: (input: string) => this.queryEngine.submitMessage(input),
        setStreamTextCallback: (cb) => this.queryEngine.setStreamTextCallback(cb),
        abort: () => this.abortController?.abort(),
        setPermissionDelegate: (delegate) => {
          // 仅当 checker 支持 Bridge 代理时注入（PermissionChecker 实现了该方法）
          const checker = this.permissionChecker as { setBridgePermissionDelegate?: (d: typeof delegate) => void } | null;
          checker?.setBridgePermissionDelegate?.(delegate);
        },
      },
      options,
    );

    this.abortController = new AbortController();

    try {
      await runner.start();
      log.info("BRIDGE", `Bridge 模式已就绪: ${options.url}`);
      process.stderr.write(`\nBridge 远程控制已启动: ${options.url}\n按 Ctrl+C 退出\n\n`);

      // 常驻：等待退出信号
      await new Promise<void>((resolve) => {
        const shutdown = () => resolve();
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    } finally {
      await runner.stop().catch(() => {});
      this.abortController = null;
      this.mcpManager?.closeAll();
      const { runShutdownSequence } = await import("./utils/graceful-shutdown.ts");
      await runShutdownSequence();
    }
  }

  /**
   * 构建 SDKQueryEngineDriver：把现有 QueryEngine 适配为 SDK 引擎驱动。
   *
   * 关键：不重建 queryLoop，而是包装 this.queryEngine 的事件流（依赖反转，
   * spec §2.1 #4）。SDK 用户因此获得与交互式用户一致的 Agent 内核。
   */
  private buildSDKDriver(): SDKQueryEngineDriver {
    return {
      submitMessage: (input: string) => this.queryEngine.submitMessage(input),
      getUsage: () => this.sessionState.getTotalUsage(),
      getCostUsd: () => this.sessionState.totalCostUSD,
      getMessages: () => this.ctxMgr.getMessages(),
      listTools: () =>
        this.toolRegistry.all().map((t) => ({
          name: t.name(),
          description: t.description(),
        })),
      getApiDurationMs: () => this.sessionState.getElapsedMs(),
      setStreamTextCallback: (cb: ((text: string) => void) | null) =>
        this.queryEngine.setStreamTextCallback(cb),
    };
  }

  /**
   * SDK stream-json 无头模式：NDJSON 双向流式通信
   *
   * 通过 stdin/stdout 与外部调用者（Python SDK / IDE / CI）通信：
   * - 初始 prompt 入队执行
   * - stdin 后续 user 消息触发多轮对话
   * - 每条 SDKMessage 以 NDJSON 写出 stdout
   *
   * session_end hook 与优雅关闭复用与文本/JSON 模式一致的收尾逻辑。
   */
  private async runHeadlessSDK(input: string): Promise<void> {
    this.abortController = new AbortController();

    const structuredIO = new StructuredIO(process.stdin, process.stdout);
    const commandQueue = new CommandQueue();
    const driver = this.buildSDKDriver();

    const engine = new SDKQueryEngine(
      {
        cwd: process.cwd(),
        sessionId: this.sessionState.sessionId,
        model: this.config.model,
        maxTurns: this.config.maxTurns || undefined,
        systemPrompt: this.config.systemPrompt || undefined,
        jsonSchema: this.config.jsonSchema,
      },
      driver,
    );

    let runError: Error | null = null;
    let aborted = false;
    try {
      await sdkRunHeadless(engine, {
        outputFormat: "stream-json",
        verbose: this.config.verbose,
        initialPrompt: input,
        structuredIO,
        commandQueue,
      });
    } catch (err: any) {
      runError = err instanceof Error ? err : new Error(String(err));
      aborted =
        runError.name === "AbortError" || /abort/i.test(runError.message ?? "");
      structuredIO.rejectAllPending("session ended");
      process.stderr.write(`\n[runHeadlessSDK] 异常: ${runError.message}\n`);
    } finally {
      this.abortController = null;
    }

    // session_end hook（与文本/JSON 模式一致：abort/error/exit 三态）
    const endReason: "exit" | "error" | "abort" = aborted
      ? "abort"
      : runError
      ? "error"
      : "exit";
    try {
      await this.hookSystem.fireSessionEndEvent(
        endReason,
        this.buildSessionEndStats(),
        runError
          ? { error: { message: runError.message, name: runError.name, stack: runError.stack } }
          : undefined,
      );
    } catch (hookErr: any) {
      process.stderr.write(
        `[runHeadlessSDK] SessionEnd hook 失败: ${hookErr?.message ?? hookErr}\n`,
      );
    }
    // 清理 crash marker（正常退出不残留）
    try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
    try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }

    // 清理 + 优雅关闭（与 runHeadless 收尾一致）
    unwatchCLAUDEmd();
    this.mcpManager?.closeAll();
    getMemoryMonitor().stop();
    getLogger().close();

    const { runShutdownSequence } = await import("./utils/graceful-shutdown.ts");
    await runShutdownSequence();
    process.exit(runError ? 1 : 0);
  }

  /** TUI 模式 */
  async runTUI(initialPrompt?: string): Promise<void> {
    const log = getLogger();
    // TUI 模式下切换为仅文件输出，避免干扰 Ink 渲染
    log.setFileOnly(true);
    log.info("TUI", "进入 TUI 模式");

    await this.init();

    const React = await import("react");
    const { createFullScreen } = await import("./ui/fullscreen.ts");
    const { TUIApp } = await import("./ui/App.tsx");

    const { StateBridge, getConversationClearedPatch } = await import("./ui/state-bridge.ts");

    // 流式文本累积器（状态驱动）
    let streamingFullText = "";

    // 事件驱动状态桥接（替代 50ms 轮询）
    const bridge = new StateBridge({
      messages: [],
      displayItems: [],
      historyItems: [],
      isLoading: false,
      toolName: null,
      toolInput: null,
      isToolExecuting: false,
      model: this.config.model,
      provider: this.config.provider,
      usage: { ...this.sessionState.getTotalUsage() },
      costUSD: 0,
      costLimit: this.config.costLimit ?? 0,
      contextPercent: 0,
      permissionMode: this.config.permissionMode || "default",
      isPlanMode: false,
      gitBranch: (() => { try { return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return ""; } })(),
      statusMessage: "",
      permissionRequest: null,
      shellConfirmRequest: null,
      planApprovalRequest: null,
      debug: !!this.config.debug,
      lastToolResult: null,
      streamingText: "",
      isStreaming: false,
      streamingLine: "",
      isQuitting: false,
      copyModeEnabled: false,
      commands: this.commandRegistry.all().map(cmd => ({
        name: cmd.name(),
        aliases: cmd.aliases(),
        description: cmd.description(),
      })),
      cwd: process.cwd(),
      activeDialog: null,
      availableModels: this.config.availableModels.map(m => ({
        name: m.name,
        provider: m.provider || this.config.provider,
        description: m.baseURL ? `${m.provider || this.config.provider} (${m.baseURL})` : undefined,
      })),
      todos: [],
    });

    const updateState = (patch: Partial<import("./ui/App.tsx").TUIState>) => {
      const keys = Object.keys(patch);
      log.debug("TUI:STATE", `updateState: ${keys.join(", ")}`, {
        messagesLen: patch.messages !== undefined ? patch.messages.length : undefined,
        isLoading: patch.isLoading,
        toolName: patch.toolName,
        isToolExecuting: patch.isToolExecuting,
      });
      bridge.update(patch);
    };

    // 注入 TUI 状态更新器（供 activatePlanMode/deactivatePlanMode 同步 permissionMode）
    this.tuiStateUpdater = (patch) => updateState(patch as any);

    // 通知队列：管理 statusMessage 的叠加与去重，解决多条通知互相覆盖的问题
    // - sticky 通知（max_turns/loop_detected/hook_blocked 等）不设超时，持久保留
    // - transient 通知（compact/tombstone/error）通过 removeStatusMessage 按 id 移除
    const activeStatusMessages = new Map<string, string>();
    let statusMsgSerial = 0; // 递增序号，确保同 id 的 transient 通知不会互相干扰

    function addStatusMessage(id: string, text: string): void {
      activeStatusMessages.set(id, text);
      const joined = [...activeStatusMessages.values()].join(" | ");
      updateState({ statusMessage: joined });
    }

    function addTransientStatusMessage(baseId: string, text: string, delayMs: number): void {
      const id = `${baseId}:${++statusMsgSerial}`;
      addStatusMessage(id, text);
      setTimeout(() => removeStatusMessage(id), delayMs);
    }

    function removeStatusMessage(id: string): void {
      activeStatusMessages.delete(id);
      const joined = [...activeStatusMessages.values()].join(" | ") || "";
      updateState({ statusMessage: joined });
    }

    // HistoryItem 同步：追踪上次同步的 ctxMgr 消息数
    const { messagesToDisplayItems } = await import("./ui/App.tsx");
    const { messagesToHistoryItems } = await import("./ui/history-adapter.ts");
    let lastSyncedCount = 0;
    let historyIdCounter = 0;

    /** 为 HistoryItemWithoutId[] 分配 id，返回 HistoryItem[] */
    const assignIds = (items: import("./ui/types.ts").HistoryItemWithoutId[]): import("./ui/types.ts").HistoryItem[] => {
      return items.map(item => {
        historyIdCounter += 1;
        return { ...item, id: historyIdCounter } as import("./ui/types.ts").HistoryItem;
      });
    };

    /** 从 ctxMgr 增量同步新消息到 historyItems */
    const syncDisplay = (extraPatch?: Partial<import("./ui/App.tsx").TUIState>) => {
      const allMsgs = this.ctxMgr.getMessages();
      const newCount = allMsgs.length - lastSyncedCount;
      if (newCount <= 0 && !extraPatch) return;

      // 旧 DisplayItem 兼容（增量）
      const prevDisplayItems = bridge.current.displayItems;
      const newDisplayItems = newCount > 0 ? messagesToDisplayItems(allMsgs.slice(lastSyncedCount)) : [];
      const displayItems = [...prevDisplayItems, ...newDisplayItems];

      // 新 HistoryItem：始终从完整消息列表重建
      // 这样 tool_use 和 tool_result 能正确合并，description/input 不会丢失
      historyIdCounter = 0;
      const historyItems = assignIds(messagesToHistoryItems(allMsgs));

      lastSyncedCount = allMsgs.length;
      updateState({ messages: allMsgs, displayItems, historyItems, ...extraPatch });
    };

    /** 重建（/compact 后消息被压缩，需要完整重建） */
    const rebuildDisplay = (extraPatch?: Partial<import("./ui/App.tsx").TUIState>) => {
      const allMsgs = this.ctxMgr.getMessages();
      lastSyncedCount = allMsgs.length;
      historyIdCounter = 0;
      // 保留事件处理中追加的系统消息（如 loop_detected/max_turns/hook_blocked），
      // 这些消息不在 ctxMgr 中，messagesToDisplayItems 无法生成
      const systemItems = bridge.current.displayItems.filter(d => d.kind === "system");
      const displayItems = [...messagesToDisplayItems(allMsgs), ...systemItems];
      const historyItems = assignIds(messagesToHistoryItems(allMsgs));
      updateState({ messages: allMsgs, displayItems, historyItems, ...extraPatch });
    };

    /** 追加命令消息（输入+输出分离，不进 ctxMgr） */
    const appendCommandOutput = (input: string, output: string | null) => {
      const displayItem = { kind: "command" as const, input, output };
      const prevDisplayItems = bridge.current.displayItems;
      const displayItems = [...prevDisplayItems, displayItem];

      historyIdCounter += 1;
      const historyItem: import("./ui/types.ts").HistoryItem = {
        id: historyIdCounter,
        type: "command",
        input,
        output,
      };
      const prevHistoryItems = bridge.current.historyItems;
      const historyItems = [...prevHistoryItems, historyItem];

      updateState({ displayItems, historyItems });
    };

    // 设置 TUI 权限确认回调
    this.setTUIConfirmCallback(async (toolName, toolInput, desc) => {
      return new Promise<"yes" | "no" | "always">((resolve) => {
        log.info("TUI:PERM", `显示权限对话框: ${toolName} - ${desc}`);
        const wrappedResolve = (answer: "yes" | "no" | "always") => {
          log.info("TUI:PERM", `权限对话框响应: ${answer}`);
          updateState({ permissionRequest: null });
          resolve(answer);
        };
        updateState({
          permissionRequest: { toolName, toolInput, description: desc, resolve: wrappedResolve },
        });
      });
    });

    // 设置 TUI Plan Mode 审批回调
    this.setPlanApprovalCallback(async (planFilePath) => {
      return new Promise<"approve" | "reject">((resolve) => {
        log.info("TUI:PLAN", `显示 Plan 审批对话框: ${planFilePath}`);
        // 读取计划文件内容
        let planContent = "";
        try {
          const { readFileSync } = require("fs");
          planContent = readFileSync(planFilePath, "utf-8");
        } catch (err: any) {
          planContent = `(无法读取计划文件: ${err.message})`;
        }

        // 把计划内容注入到消息滚动区域（用户可滚动查看完整计划）
        historyIdCounter += 1;
        const planHistoryItem: import("./ui/types.ts").HistoryItem = {
          id: historyIdCounter,
          type: "plan_review",
          planContent,
          planFilePath,
        };
        const prevHistoryItems = bridge.current.historyItems;
        updateState({ historyItems: [...prevHistoryItems, planHistoryItem] });

        const wrappedResolve = (decision: "approve" | "reject") => {
          log.info("TUI:PLAN", `Plan 审批响应: ${decision}`);
          updateState({ planApprovalRequest: null });
          resolve(decision);
        };
        updateState({
          planApprovalRequest: { planFilePath, planContent, resolve: wrappedResolve },
        });
      });
    });

    // TUI 版本的 agentLoop（消费 QueryEngine async generator）
    const tuiAgentLoop = async (userInput: string) => {
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 单次 session 最长 30 分钟
      const sessionTimer = setTimeout(() => {
        log.warn("TUI", "Session 超时，触发 abort");
        this.abortController?.abort();
      }, SESSION_TIMEOUT_MS);

      this.busy = true;
      updateState({
        isLoading: true,
      });

      let streamSynced = false;
      let completedNormally = false;

      // 设置流式文本回调（桥接 processStream 内部的 onText）
      this.queryEngine.setStreamTextCallback((text: string) => {
        if (!streamSynced) {
          streamSynced = true;
          syncDisplay();
          streamingFullText = "";
        }
        streamingFullText += text;
        updateState({ streamingText: streamingFullText, isStreaming: true });
      });

      try {
        for await (const event of this.queryEngine.submitMessage(userInput)) {
          switch (event.kind) {
            case "user_message_added":
              syncDisplay();
              break;
            case "hook_blocked": {
              completedNormally = true;
              const hookBlockedText = `⛔ Hook 阻止执行: ${event.reason}`;
              addStatusMessage("hook_blocked", hookBlockedText);
              updateState({ isLoading: false });
              const hookBlockedDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: hookBlockedText }];
              updateState({ displayItems: hookBlockedDisplay });
              break;
            }
            case "tool_start":
              // 工具开始前，结束当前流式输出
              streamingFullText = "";
              streamSynced = false;
              syncDisplay({ toolName: event.toolName, toolInput: event.toolInput ?? null, isToolExecuting: true, streamingText: "", isStreaming: false, streamingLine: "" });
              break;
            case "tool_end":
              syncDisplay({
                toolName: null,
                toolInput: null,
                isToolExecuting: false,
                lastToolResult: event.result ? { toolName: event.toolName, isError: !!event.result.isError, elapsedMs: event.result.elapsedMs ?? 0 } : null,
              });
              // TodoWrite 工具执行后同步 todo 列表到 TUI
              if (event.toolName === "todo_write") {
                const todoTool = this.toolRegistry.get("todo_write") as import("./tool/todo-write.ts").TodoWriteTool | undefined;
                if (todoTool) {
                  updateState({ todos: todoTool.getTodos() });
                }
              }
              break;
            case "compact":
              rebuildDisplay();
              addTransientStatusMessage("compact", "上下文已自动压缩", 3000);
              break;
            case "context_warning":
              addStatusMessage("context_warning", `⚠ 上下文剩余 ${event.remaining.toFixed(0)}%，即将自动压缩`);
              break;
            case "max_turns": {
              const maxTurnsText = `达到最大轮次限制: ${event.maxTurns}`;
              addStatusMessage("max_turns", maxTurnsText);
              const maxTurnsDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: maxTurnsText }];
              updateState({ displayItems: maxTurnsDisplay });
              break;
            }
            case "loop_detected": {
              const loopDetectedText = `⚠️ 检测到循环模式: ${event.detail}`;
              addStatusMessage("loop_detected", loopDetectedText);
              const loopDetectedDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: loopDetectedText }];
              updateState({ displayItems: loopDetectedDisplay });
              break;
            }
            case "loop_recovery": {
              const loopRecoveryText = `🔄 循环恢复尝试 ${event.attempt}/${event.maxAttempts}`;
              addStatusMessage("loop_recovery", loopRecoveryText);
              const loopRecoveryDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: loopRecoveryText }];
              updateState({ displayItems: loopRecoveryDisplay });
              break;
            }
            case "system":
              if (event.level === "warning") {
                addStatusMessage("system", `⚠️ ${event.text}`);
              }
              break;
            case "tombstone":
              // 模型降级：清理流式文本残留，重建显示
              streamingFullText = "";
              streamSynced = false;
              rebuildDisplay();
              addTransientStatusMessage("tombstone", "模型降级，正在使用备用模型重试...", 3000);
              break;
            case "done": {
              completedNormally = true;
              const ctxUsed = this.ctxMgr.estimateTokens(this.toolRegistry.size());
              const ctxPct = Math.round((ctxUsed / 200000) * 100);
              streamingFullText = "";
              streamSynced = false;
              syncDisplay({
                isLoading: false,
                usage: { ...this.sessionState.getTotalUsage() },
                costUSD: this.sessionState.totalCostUSD,
                contextPercent: ctxPct,
                streamingText: "",
                isStreaming: false,
                streamingLine: "",
              });
              break;
            }
          }
        }
      } finally {
        // 清理 session 超时定时器
        clearTimeout(sessionTimer);

        // 兜底：确保异常路径也能正确清理
        streamingFullText = "";
        this.queryEngine.setStreamTextCallback(null);

        // 检查是否正常完成（通过 done 事件标记）
        if (!completedNormally) {
          const warningDisplay = [...bridge.current.displayItems,
            { kind: "system" as const, text: "⚠️ 任务异常中断，部分操作可能未完成" }];
          updateState({ isLoading: false, isStreaming: false,
            displayItems: warningDisplay,
            statusMessage: "任务异常中断" });
        }
      }

      syncDisplay({
        isLoading: false,
        usage: { ...this.sessionState.getTotalUsage() },
        costUSD: this.sessionState.totalCostUSD,
        contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / 200000) * 100),
      });

      // 本轮结束 → 标记空闲并冲刷 Cron 忙时积压的提示词
      this.busy = false;
      void this.flushScheduledPrompts();
    };

    // 注册提示词注入器：Cron 触发时，把调度 prompt 当作一次用户输入跑完整循环
    this.setPromptInjector(async (text: string) => {
      this.abortController = new AbortController();
      await tuiAgentLoop(text);
    });

    // 回调
    const callbacks: import("./ui/App.tsx").TUICallbacks = {
      onUserInput: async (text) => {
        log.debug("TUI:CB", `onUserInput 被调用: "${text.slice(0, 100)}"`);
        try {
          this.abortController = new AbortController();
          // @ 文件注入：展开用户输入中的 @path 引用
          const expanded = await expandAtReferences(text);
          await tuiAgentLoop(expanded);
        } catch (err: any) {
          const aborted = isAbortError(err);
          if (aborted) {
            log.info("TUI:CB", "当前响应已被用户中断");
          } else {
            log.error("TUI:CB", `onUserInput 异常`, { error: err.message, stack: err.stack });
          }

          const message = aborted ? "已取消当前响应" : `错误: ${err.message ?? String(err)}`;
          updateState({
            isLoading: false,
            isStreaming: false,
            streamingText: "",
            streamingLine: "",
            toolName: null,
            toolInput: null,
            isToolExecuting: false,
            usage: { ...this.sessionState.getTotalUsage() },
            costUSD: this.sessionState.totalCostUSD,
            contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / 200000) * 100),
          });
          addTransientStatusMessage("error", message, aborted ? 1500 : 5000);
        } finally {
          this.abortController = null;
        }
      },
      onSlashCommand: async (cmd, args) => {
        log.info("TUI:CMD", `斜杠命令: /${cmd} ${args}`);

        const commandInput = `/${cmd}${args ? " " + args : ""}`;

        // 构建命令上下文
        const cmdCtx: import("./command/types.ts").AppContext = {
          ctxMgr: this.ctxMgr,
          registry: this.toolRegistry,
          config: this.config,
          sessionId: "",
          provider: this.provider,
          setModel: (m) => {
            log.info("TUI:CMD", `切换模型: ${this.config.model} → ${m}`);
            this.config.model = m;
            const { resolveCurrentModelConfig } = require("./config/config.ts");
            resolveCurrentModelConfig(this.config);
            if (this.providerRegistry) {
              this.providerRegistry.clearCache();
              this.provider = this.providerRegistry.getProvider();
              this.queryEngine.updateProvider(this.provider);
            }
            updateState({ model: m });
          },
          exitRequested: false,
          sessionState: this.sessionState,
          mcpManager: this.mcpManager,
          sendToLLM: async (text) => {
            await callbacks.onUserInput(text);
          },
          customCommands: this.getCustomCommandsSummary(),
          confirmShellCommands: async (commands) => {
            return new Promise<boolean>((resolve) => {
              updateState({
                shellConfirmRequest: { commands, resolve },
              });
            });
          },
          hookSystem: this.hookSystem,
          commandRegistry: this.commandRegistry,
        };

        const command = this.commandRegistry.get(cmd);
        if (!command) {
          log.warn("TUI:CMD", `未知命令: /${cmd}`);
          appendCommandOutput(commandInput, `未知命令: /${cmd}，输入 /help 查看可用命令`);
          return;
        }

        // 记录命令使用频率（驱动补全排序的指数衰减统计）
        try {
          const { recordUsage } = await import("./command/usage-tracking.ts");
          recordUsage(command.name());
        } catch {
          // 使用追踪失败不影响命令执行
        }

        let result: import("./command/types.ts").CommandResult;
        try {
          log.debug("TUI:CMD", `执行命令: /${cmd}`);
          result = await command.execute(args, cmdCtx);
          updateState({ model: this.config.model, provider: this.config.provider });
        } catch (err: any) {
          log.error("TUI:CMD", `命令执行失败: /${cmd}`, { error: err.message, stack: err.stack });
          appendCommandOutput(commandInput, `命令执行失败: ${err.message}`);
          return;
        }

        // 处理结构化结果
        switch (result.kind) {
          case "clear":
            log.info("TUI:CMD", "清空消息历史，重置上下文");
            this.ctxMgr.clear();
            clearPromptCache();
            this.quotaManager?.resetAlertLevel();
            this.fallback.reset();
            lastSyncedCount = 0;
            historyIdCounter = 0;
            activeStatusMessages.clear();
            updateState(getConversationClearedPatch());
            break;

          case "quit":
            appendCommandOutput(commandInput, result.message ?? "再见！");
            // D3-4：/quit 退出前必须 fireSessionEndEvent，否则跳过 line 1665 的 SessionEnd，
            // 导致 messages.json / trajectory 不落盘（违反纪律不变量第 1 条「transcript 必落盘」）。
            void (async () => {
              try {
                await this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats());
              } catch (err: any) {
                process.stderr.write(`[quit] SessionEnd hook 失败: ${err?.message ?? err}\n`);
              }
              // 清理 crash marker（正常退出不残留）
              try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
              try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
              setTimeout(() => process.exit(0), 100);
            })();
            break;

          case "submit_prompt":
            if (result.prompt) {
              appendCommandOutput(commandInput, null);
              await callbacks.onUserInput(result.prompt);
            }
            break;

          case "error":
            appendCommandOutput(commandInput, `错误: ${result.message ?? ""}`);
            break;

          case "dialog":
            // 打开交互式对话框（不输出命令文本）
            if (result.dialog) {
              log.info("TUI:CMD", `打开对话框: ${result.dialog}`);
              updateState({ activeDialog: result.dialog });
            }
            break;

          case "message":
          default:
            appendCommandOutput(commandInput, result.message ?? null);
            break;
        }
      },
      onInterrupt: () => {
        if (!this.abortController || this.abortController.signal.aborted) {
          return;
        }

        log.info("TUI:CB", "收到中断请求，取消当前响应");
        updateState({ statusMessage: "正在取消当前响应..." });
        this.abortController.abort();
      },
    };

    // 渲染 TUI（ADR-040：默认主屏 Static 原生选择，--alternate-buffer 走全屏虚拟滚动）
    const alternateBuffer = this.config.alternateBuffer === true;
    log.info("TUI", `开始渲染 TUI 组件（${alternateBuffer ? "Alternate Buffer 全屏" : "主屏 Static"} 模式）`);

    const app = createFullScreen(
      React.createElement(TUIApp, {
        initialState: bridge.current,
        callbacks,
        bridge,
        alternateBuffer,
      }),
      { alternateBuffer },
    );
    await app.start();

    // 滚动由 ScrollProvider + KeypressContext 在 React 层面处理，不再需要外部接线

    // 处理初始提示词
    if (initialPrompt) {
      log.info("TUI", `处理初始提示词: ${initialPrompt.slice(0, 100)}`);
      await callbacks.onUserInput(initialPrompt);
    }

    await app.waitUntilExit();
    await this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats());
    // 清理 crash marker（正常退出不残留）
    try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
    try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
    unwatchCLAUDEmd();
    cleanupSettingsWatcher();
    stopAppConfigWatcher();
    this.mcpManager?.closeAll();

    // 停止内存监控并输出会话摘要
    getMemoryMonitor().stop();
    getLogger().close();

    // 输出会话摘要到控制台
    const summary = getSessionMetrics().getSummary();
    console.log('\n' + '─'.repeat(60));
    console.log('会话摘要');
    console.log('─'.repeat(60));
    console.log(summary);
    console.log('─'.repeat(60) + '\n');

    log.info("TUI", "TUI 退出");

    // 优雅关闭：刷新遥测/事件缓冲区（500ms 硬超时）+ failsafe（5s 强制退出）（spec 17 §3.4）
    // 正常退出（/exit 或 Ctrl+D）不触发 SIGINT/SIGTERM，必须显式刷新，否则缓冲数据丢失
    const { runShutdownSequence } = await import("./utils/graceful-shutdown.ts");
    await runShutdownSequence();
  }
}
