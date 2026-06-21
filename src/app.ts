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
import { TokenEstimator } from "./llm/token-estimator.ts";
import { ThinkingManager } from "./llm/thinking.ts";
import { SessionState } from "./session/state.ts";
import { SessionStore } from "./session/store.ts";
import {
  stashPendingInput,
  markForRestore,
  clearPendingInput,
  canRestoreCanceledInput,
} from "./ui/pending-input.ts";
import { QuotaManager } from "./llm/quota.ts";
import { TokenMeter } from "./telemetry/metrics/token-meter.ts";
import { appendUsageLedger } from "./telemetry/usage-ledger.ts";
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
import { resetCacheDetection, clearCacheBreaks } from "./api/cache-detection.ts";
import { resetCircuitBreaker } from "./query/auto-compact.ts";
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
import { sidPaths } from "./config/paths.ts";
import { deriveTaskTitle } from "./ui/utils/task-title.ts";

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
  /** 统一命令注册表（新体系）。TUI 命令获取/执行优先走此注册表 */
  unifiedRegistry?: import("./command/unified-registry.ts").UnifiedCommandRegistry;
  permissionChecker?: Checker;
  initialPrompt?: string;
  mcpManager?: MCPManager;
  planManager?: PlanModeManager;
}

/**
 * CM3/CM4：从重试错误文本推断重试种类，决定 TUI 提示语气与是否给升级建议。
 * - 限流(429 / rate limit / quota)→ rate_limit（CM4 附升级建议）
 * - 过载(529 / overloaded / 503)→ overloaded
 * - 其余 → retry（通用网络/超时/5xx）
 */
export function classifyRetryKind(
  error: string,
): "retry" | "rate_limit" | "overloaded" {
  const e = (error || "").toLowerCase();
  if (/429|rate.?limit|quota|too many requests/.test(e)) return "rate_limit";
  if (/529|overload|503|capacity/.test(e)) return "overloaded";
  return "retry";
}

export class App {
  private config: Config;
  private provider: Provider;
  private providerRegistry?: ProviderRegistry;
  private mcpManager?: MCPManager;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  /** 统一命令注册表（新体系）。非空时 TUI 命令获取/执行走此注册表 */
  private unifiedRegistry?: import("./command/unified-registry.ts").UnifiedCommandRegistry;
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
  /** 模块 C1：用量账本防重入——每会话只落一行 */
  private ledgerWritten = false;
  /** B1/B2/B3：会话持久化写入端（JSONL 增量写入） */
  private sessionStore: SessionStore | null = null;
  /** B6：被 resume 恢复的会话 id（非 null 表示当前是 resume 会话，doInit 应续写原 jsonl 而非新建） */
  private resumedSessionId: string | null = null;
  private queryEngine: QueryEngine;
  private hookSystem!: HookSystem;
  private jitContextMgr: JitContextManager;
  /** TelemetryHookProbe 引用（供 Harness 注册 enricher） */
  private telemetryProbe?: import("./telemetry/hook-probe.ts").TelemetryHookProbe;
  /** Plan Mode 管理器 */
  private planManager: PlanModeManager | null = null;
  /** TUI 模式下的权限确认回调（由 TUI 注入），返回 "yes" | "no" | "always" */
  private tuiConfirmCallback: ((toolName: string, toolInput: unknown, desc: string, shadowedRules?: import("./ui/App.tsx").ShadowedRuleInfo[]) => Promise<"yes" | "no" | "always">) | null = null;
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
  /**
   * Session Memory 句柄（Step 0）：在压缩前持续维护结构化会话笔记，
   * autoCompact 优先用它做摘要。doInit 中接线；未启用时为 null，autoCompact 回退 LLM 摘要。
   */
  private sessionMemory: import("./session-memory/session-memory.ts").SessionMemoryHandle | null = null;
  /** 后台记忆提取句柄（每轮 end_turn 后 fire-and-forget 提取记忆，会话关闭前 drain）。 */
  private extractMemories: import("./memory/extract/extractor.ts").ExtractMemoriesHandle | null = null;
  /**
   * 推理强度运行时态（/effort 切换端）。undefined = auto（跟随模型默认）。
   * 与 config.permissionMode 同级——运行时可变，queryLoop 每轮经注入的 getter 取最新值。
   * 初值在构造函数解析：env > config.effortLevel(settings) > undefined。
   */
  private runtimeEffort: import("./llm/effort.ts").EffortSetting;
  /**
   * 思考开关运行时态（/think 切换端）。undefined = auto（跟随模型/provider 默认）。
   * 初值：env > config.thinkingEnabled(settings) > undefined。
   */
  private runtimeThinking: import("./llm/effort.ts").ThinkingSetting;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.providerRegistry = opts.providerRegistry;
    this.mcpManager = opts.mcpManager;
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.commandRegistry = opts.commandRegistry ?? new CommandRegistry();
    this.unifiedRegistry = opts.unifiedRegistry;
    this.permissionChecker = opts.permissionChecker ?? null;
    this.planManager = opts.planManager ?? null;
    const sessionId = opts.config.sessionId || crypto.randomUUID().slice(0, 8);
    // 上下文窗口按模型实际大小初始化（deepseek-v4 为 1M，Claude 200K，gpt-4o 128K）。
    // 硬编码 200000 会让 deepseek 的 contextPercent 高估 5 倍、过早触发自动压缩。
    const ctxWindow = new TokenEstimator().getContextLimit(opts.config.model, opts.config.availableModels);
    this.ctxMgr = new ContextManager({ maxTokens: ctxWindow });
    this.ctxMgr.setSessionId(sessionId);
    this.sessionState = new SessionState(sessionId);
    // 注入用户配置的模型列表（含定价/provider），供计费和 provider 推断优先使用
    this.sessionState.setAvailableModels(opts.config.availableModels);
    getSessionMetrics().setSessionId(sessionId);
    getSessionMetrics().setAvailableModels(opts.config.availableModels);
    // B1：会话持久化写入端（构造很轻，仅建目录）。startSession/resumeSession 延迟到 doInit 调用，
    // 以便 B6 能根据 resumedSessionId 决定"新建 jsonl"还是"续写旧 jsonl"。
    this.sessionStore = new SessionStore();
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
    // Extended Thinking / 推理强度控制：Anthropic 走 thinking.budgetTokens，
    // DeepSeek 走 reasoning_effort（high/max）。两者都需要 ThinkingManager 启用，
    // 否则 parseThinkingHint/getThinkingConfig 恒返回 undefined → think hard/ultrathink 失效。
    // 其它兼容端点（ollama 等）不认这些字段，保持关闭。
    const thinkingProvider =
      opts.config.provider === "anthropic" ||
      /deepseek/i.test(opts.config.model || opts.config.provider || "");
    this.thinkingMgr = new ThinkingManager(thinkingProvider);

    // Effort/Thinking 旋钮运行时态初值解析：env > settings(config) > undefined(auto)。
    // env 覆盖优先级最高且会被 queryLoop 每轮重新读取，这里仅解析 runtime 基线。
    {
      const { getEffortEnvOverride, getThinkingEnvOverride } = require("./llm/effort.ts");
      const effortEnv = getEffortEnvOverride();
      // env 已设（含强制 auto=undefined）则以 env 为基线；未设(null)才用 settings。
      this.runtimeEffort = effortEnv !== null ? effortEnv : opts.config.effortLevel;
      const thinkingEnv = getThinkingEnvOverride();
      this.runtimeThinking =
        thinkingEnv !== null
          ? thinkingEnv
            ? "on"
            : "off"
          : opts.config.thinkingEnabled === undefined
            ? undefined
            : opts.config.thinkingEnabled
              ? "on"
              : "off";
    }
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
        // CM3/CM4：把重试/限流状态推到 TUI，驱动实时倒计时与升级建议。
        const kind = classifyRetryKind(error);
        this.tuiStateUpdater?.({
          retryStatus: {
            kind,
            attempt,
            delayMs,
            retryAtMs: Date.now() + delayMs,
            model: this.config.model,
            error,
          },
        });
      },
      onFallback: (reason, model) => {
        const log = getLogger();
        log.warn("FALLBACK", `降级到 ${model}，原因: ${reason}`);
        // CM3：降级也作为一种重试状态展示（attempt 不适用，置 0）。
        this.tuiStateUpdater?.({
          retryStatus: {
            kind: "fallback",
            attempt: 0,
            delayMs: 0,
            retryAtMs: Date.now(),
            model: this.config.model,
            fallbackModel: model,
            error: reason,
          },
        });
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
      sessionStore: this.sessionStore ?? undefined,
      executeTools: (content) => this.executeTools(content),
      processStream: (stream, onText, onThinking) => this.processStream(stream, onText, onThinking),
      autoCompact: () => this.autoCompact(),
      handleContextOverflow: (err, max) => this.handleContextOverflow(err, max),
      getAbortSignal: () => this.abortController?.signal,
      // L1 单轮硬超时触发时主动 abort 上游 fetch（尽力而为的资源释放，配合 loop.ts 的 Promise.race）。
      abortCurrentRequest: (reason) => {
        try { this.abortController?.abort(reason ?? "turn-timeout"); } catch { /* ignore */ }
      },
      getPlanModeReminder: async () => {
        if (!this.planManager?.isPlanning()) return null;
        const { buildPlanModeReminder } = await import("./plan/prompt.ts");
        return buildPlanModeReminder(this.planManager.nextReminderIsFull());
      },
      // 缺口 C：把运行时可变的 permission mode 暴露给 queryLoop，每轮取最新值。
      // config.permissionMode 会被 enter_plan_mode / CLAUDE.md 规则 / 斜杠命令运行时改写，
      // 而 mode 指南只进有缓存的 system prompt——靠这里走每轮 reminder 通道补上时机缺失。
      getCurrentPermissionMode: () => this.config.permissionMode,
      // Effort/Thinking 旋钮：把运行时态暴露给 queryLoop，每轮取最新值经 effort.ts 映射到线格式。
      // 照搬 getCurrentPermissionMode 的「每轮取 getter」模式，保证 /effort、/think 切换当轮生效。
      getEffortSetting: () => this.runtimeEffort,
      getThinkingSetting: () => this.runtimeThinking,
      getTodoState: () => {
        // P0-2 / P0-3：把 TodoWriteTool 的内存状态暴露给 queryLoop，
        // 用于每轮回注完整清单（根因 1）+ end_turn 完成度硬校验（根因 1、2）。
        const todoTool = this.toolRegistry.get("todo_write") as
          | import("./tool/todo-write.ts").TodoWriteTool
          | undefined;
        if (!todoTool) return null;
        const todos = todoTool.getTodos();
        if (todos.length === 0) return null;
        return { todos, writeVersion: todoTool.getWriteVersion() };
      },
      getHypothesisLedger: () => {
        // 环节③：把假设登记表暴露给 queryLoop，用于矛盾中断（机制2）+ 交付门禁（机制3）。
        // 登记表实例由 hypothesis_register 工具持有（与 TodoWriteTool 同构）。
        const regTool = this.toolRegistry.get("hypothesis_register") as
          | import("./tool/hypothesis.ts").HypothesisRegisterTool
          | undefined;
        return regTool?.getLedger() ?? null;
      },
    });

    // P0-1：把子代理 usage 归集 sink 注入到 SubAgentTool / CustomAgentTool。
    // 子代理执行完毕后按其实际使用的 model/provider 回写主会话 SessionState，
    // 否则子代理烧的 token/费用完全不计入总费用、costLimit 守卫对子代理失效。
    this.wireSubAgentUsageSink();

    // Fork 模式接线：给 SubAgentTool 注入主对话上下文提供者，
    // 让 fork=true 的子代理能继承主对话最近消息（prompt cache 友好）。
    this.wireSubAgentMainContext();

    // 根因修复：把 HookSystem 回填到 spawn-agent 类工具。这些工具在 cli.ts 注册时
    // HookSystem 尚未创建（构造时 hookSystem=undefined），导致子代理/workflow 的
    // 工具级 hook 与 Subagent span 在生产中从未触发。HookSystem 创建后经 setter 接通。
    this.wireToolHookSystem();

    // EST-4：注入工具定义的真实 schema token 数，替代 ContextManager 内 toolCount×80 粗估，
    // 避免 schema 大/工具多时低估上下文占用、compact 触发过晚。
    this.refreshToolSchemaTokens();
  }

  /** 重算并注入工具定义的真实 token 数（EST-4）。工具池变化（含 MCP 连接）后可重复调用。 */
  refreshToolSchemaTokens(): void {
    try {
      const defs = this.toolRegistry.definitions();
      const tokens = new TokenEstimator().estimateTools(defs);
      this.ctxMgr.setToolSchemaTokens(tokens);
    } catch {
      // 估算失败不致命：ContextManager 回退到 toolCount×80 粗估
    }
  }

  /** 注入子代理 usage 归集 sink（P0-1）。遍历工具注册表，给所有带 setUsageSink 的工具接线。 */
  private wireSubAgentUsageSink(): void {
    const sink = (result: import("./agent/sub-agent.ts").SubAgentResult): void => {
      const usage = result.usage;
      if (!usage) return;
      // 子代理可能用不同 subAgentModel，按其实际 model 分别计费；缺省回退主模型。
      const model = result.model || this.config.model;
      const provider = result.provider || SessionState.inferProvider(model, this.config.availableModels);
      // 子代理无独立 API 耗时归集口径，durationMs 计 0（费用/ token 才是归集重点）。
      this.sessionState.updateUsage(model, usage, 0, provider);
    };
    for (const tool of this.toolRegistry.all()) {
      const maybe = tool as { setUsageSink?: (s: typeof sink) => void };
      if (typeof maybe.setUsageSink === "function") {
        maybe.setUsageSink(sink);
      }
    }
  }

  /**
   * 注入主对话上下文提供者到 SubAgentTool（fork 模式）。
   * 提供者返回主对话当前消息历史，buildForkMessages 截取尾部构建 fork 子代理初始上下文。
   */
  private wireSubAgentMainContext(): void {
    const provider = (): { role: string; content: import("./llm/types.ts").ContentBlock[] }[] =>
      this.ctxMgr.getMessages() as { role: string; content: import("./llm/types.ts").ContentBlock[] }[];
    for (const tool of this.toolRegistry.all()) {
      const maybe = tool as { setMainContextProvider?: (p: typeof provider) => void };
      if (typeof maybe.setMainContextProvider === "function") {
        maybe.setMainContextProvider(provider);
      }
    }
  }

  /** 注入 HookSystem 到 spawn-agent 类工具（根因修复）。遍历工具注册表，给所有带
   *  setHookSystem 的工具（SubAgentTool / WorkflowTool）回填 hookSystem，使其内部 spawn 的
   *  子代理能触发 Subagent 生命周期 hook 与工具级 execute_tool span。 */
  private wireToolHookSystem(): void {
    for (const tool of this.toolRegistry.all()) {
      const maybe = tool as { setHookSystem?: (h: HookSystem) => void };
      if (typeof maybe.setHookSystem === "function") {
        maybe.setHookSystem(this.hookSystem);
      }
    }
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

  /** 解析当前模型的 effort 能力描述符（/effort、/think 状态读取 + setter 共用）。 */
  private resolveEffortCap(): import("./llm/effort.ts").EffortCapability {
    const { resolveEffortCapability } = require("./llm/effort.ts");
    const mc = this.config.availableModels?.find(m => m.name === this.config.model);
    return resolveEffortCapability({
      model: this.config.model,
      provider: this.config.provider,
      baseURL: mc?.baseURL ?? this.config.baseURL,
      modelConfig: mc ? { supportsThinking: mc.supportsThinking } : undefined,
    });
  }

  /** 读取 effort 运行时态 + 展示档位（/effort 无参展示用）。 */
  private getEffortState() {
    const eff = require("./llm/effort.ts");
    const cap = this.resolveEffortCap();
    const envOverride = eff.getEffortEnvOverride();
    return {
      runtime: this.runtimeEffort,
      applied: eff.getDisplayedEffort(cap, this.runtimeEffort, envOverride),
      isAuto: eff.isEffortAuto(this.runtimeEffort, envOverride),
      capability: cap,
    };
  }

  /** 读取 thinking 运行时态 + 实际开关（/think 无参展示用）。 */
  private getThinkingState() {
    const eff = require("./llm/effort.ts");
    const cap = this.resolveEffortCap();
    return {
      runtime: this.runtimeThinking,
      applied: eff.resolveThinking(cap, this.runtimeThinking, eff.getThinkingEnvOverride()),
      capability: cap,
    };
  }

  /**
   * 设置 effort 运行时态（/effort 用）。
   * - 更新 runtimeEffort（queryLoop 下一轮即生效）；
   * - persist=true 时写 settings.json effortLevel（跨会话）；
   * - 推送展示态到状态栏（TUIState，对标 model 列经 updateState 流到 ConfigContext）。
   */
  private setEffortRuntime(level: import("./llm/effort.ts").EffortSetting, persist?: boolean): void {
    this.runtimeEffort = level;
    if (persist) this.persistKnob("effortLevel", level);
    this.pushKnobDisplay();
  }

  /** 设置 thinking 运行时态（/think 用）。语义同 setEffortRuntime。 */
  private setThinkingRuntime(setting: import("./llm/effort.ts").ThinkingSetting, persist?: boolean): void {
    this.runtimeThinking = setting;
    if (persist) {
      // settings.json thinkingEnabled 是 boolean：on→true / off→false / auto→删除字段（回退默认）。
      this.persistKnob("thinkingEnabled", setting === undefined ? undefined : setting === "on");
    }
    this.pushKnobDisplay();
  }

  /** 写单个旋钮字段到用户 settings.json（value=undefined 表示删除该字段，回退 auto）。 */
  private persistKnob(key: "effortLevel" | "thinkingEnabled", value: unknown): void {
    try {
      const { getSettingsForSource, writeSettingsFile } = require("./config/settings/index.ts");
      const { settings } = getSettingsForSource("userSettings");
      const current: Record<string, unknown> = { ...(settings ?? {}) };
      if (value === undefined) delete current[key];
      else current[key] = value;
      writeSettingsFile("userSettings", current);
    } catch (e) {
      getLogger().warn("KNOB", `持久化 ${key} 失败（不阻断）: ${(e as Error)?.message}`);
    }
  }

  /**
   * 把 effort/thinking 展示态推到状态栏。
   * 经 tuiStateUpdater 写 TUIState（effortDisplay/thinkingDisplay），由 App.tsx 派生到
   * ConfigContext → Footer。无 TUI（无头模式）时 tuiStateUpdater 为 null，安全跳过。
   */
  private pushKnobDisplay(): void {
    if (!this.tuiStateUpdater) return;
    const eff = require("./llm/effort.ts");
    const cap = this.resolveEffortCap();
    const effortEnv = eff.getEffortEnvOverride();
    this.tuiStateUpdater({
      effortDisplay: cap.supportsEffort
        ? {
            level: eff.getDisplayedEffort(cap, this.runtimeEffort, effortEnv),
            isAuto: eff.isEffortAuto(this.runtimeEffort, effortEnv),
          }
        : null,
      thinkingDisplay: cap.supportsThinkingToggle
        ? {
            on: eff.resolveThinking(cap, this.runtimeThinking, eff.getThinkingEnvOverride()),
            isAuto: this.runtimeThinking === undefined && eff.getThinkingEnvOverride() === null,
          }
        : null,
    });
  }

  /**
   * /clear 时重置 TodoWrite 工具的内部清单状态。
   * UI 层 todos 由 getConversationClearedPatch 清空，但工具内部 currentTodos 是
   * 模块级私有状态、不随 ctxMgr.clear() 重置——不清会导致 /clear 后 TodoPanel 残留旧清单"幽灵"。
   */
  private resetTodoTool(): void {
    const todoTool = this.toolRegistry.get("todo_write") as
      | import("./tool/todo-write.ts").TodoWriteTool
      | undefined;
    todoTool?.reset?.();
  }

  /** /clear 时重置假设登记表（环节③） */
  private resetHypothesisLedger(): void {
    const regTool = this.toolRegistry.get("hypothesis_register") as
      | import("./tool/hypothesis.ts").HypothesisRegisterTool
      | undefined;
    regTool?.getLedger()?.reset();
  }

  /**
   * /clear 时清理 registry 中的非运行态任务条目。
   * getConversationClearedPatch 只把 UI 快照 tasks 置空，但全局 task registry 的 Map
   * 不随之清——下次 notifyTaskChanged 会把已完成/失败的旧任务条目重新同步回面板（复活）。
   * 仅清终止态、保留 running，避免误杀用户正在跑的后台 agent。
   */
  private clearInactiveBackgroundTasks(): void {
    try {
      const { clearInactiveTasks } = require("./task/index.ts");
      clearInactiveTasks();
    } catch { /* task 模块未加载或清理失败不影响 /clear 主流程 */ }
  }

  /**
   * 加载命令列表（补全/帮助显示用）。
   * 新体系优先：从 UnifiedCommandRegistry.getCommands 取（含 bundled skills、plugin 命令）；
   * 无新注册表时回退旧 Registry.all()。
   */
  private async loadCommandList(): Promise<Array<{ name: string; aliases: string[]; description: string }>> {
    if (this.unifiedRegistry) {
      try {
        const cmds = await this.unifiedRegistry.getCommands(process.cwd());
        return cmds
          // 隐藏命令不进补全列表
          .filter((c) => !c.isHidden)
          // 仅用户可调用的进补全（userInvocable 默认 true）
          .filter((c) => c.userInvocable !== false)
          .map((c) => ({
            name: c.name,
            aliases: c.aliases ?? [],
            description: c.description,
          }));
      } catch (err: any) {
        getLogger().warn("APP", `统一注册表加载命令列表失败，回退旧 Registry: ${err?.message}`);
      }
    }
    return this.commandRegistry.all().map((cmd) => ({
      name: cmd.name(),
      aliases: cmd.aliases(),
      description: cmd.description(),
    }));
  }

  /**
   * 处理新体系 CommandExecutor 的执行结果（CommandExecutionResult）。
   *
   * 覆盖全部分支：message/submit_prompt/dialog/clear/quit/compact/confirm/error/passthrough/skip。
   * 与旧体系 result.kind 分支语义对齐，新增 compact/passthrough/skip/confirm 处理。
   */
  private async handleCommandExecutionResult(
    result: import("./command/types.ts").CommandExecutionResult,
    deps: {
      cmd: string;
      commandInput: string;
      callbacks: { onUserInput: (text: string) => Promise<void> };
      updateState: (patch: Partial<import("./ui/App.tsx").TUIState>) => void;
      appendCommandOutput: (input: string, output: string | null, isError?: boolean) => void;
      getConversationClearedPatch: () => Partial<import("./ui/App.tsx").TUIState>;
      clearPromptCache: () => void;
      resetSyncState: () => void;
    },
  ): Promise<void> {
    const log = getLogger();
    const { commandInput, callbacks, updateState, appendCommandOutput, getConversationClearedPatch, clearPromptCache, resetSyncState } = deps;

    switch (result.type) {
      case "clear":
        log.info("TUI:CMD", "清空消息历史，重置上下文");
        this.ctxMgr.clear();
        this.sessionState.resetCounters();
        clearPromptCache();
        this.quotaManager?.resetAlertLevel();
        this.fallback.reset();
        this.resetTodoTool();
        this.resetHypothesisLedger();
        this.clearInactiveBackgroundTasks();
        // 缓存检测状态重置：旧基线对新会话无效，不清会产生虚假中断检测
        resetCacheDetection();
        clearCacheBreaks();
        // 压缩熔断器重置：旧会话的失败记录不应阻止新会话的合理压缩
        resetCircuitBreaker();
        resetSyncState();
        updateState(getConversationClearedPatch());
        break;

      case "quit":
        appendCommandOutput(commandInput, result.message ?? "再见！");
        // D3-4：/quit 退出前必须 fireSessionEndEvent，保证 transcript 落盘（纪律不变量第 1 条）。
        void (async () => {
          try {
            // hook 卡死时不阻塞退出（对齐 signal 路径 1.2s 上限）：SessionEnd 可能跑用户命令长时间无响应。
            await Promise.race([
              this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats()),
              new Promise((resolve) => setTimeout(resolve, 1200)),
            ]);
          } catch (err: any) {
            process.stderr.write(`[quit] SessionEnd hook 失败: ${err?.message ?? err}\n`);
          }
          this.finalizeSessionStore();
          try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
          try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
          setTimeout(() => process.exit(0), 100);
        })();
        break;

      case "submit_prompt":
        if (result.value) {
          appendCommandOutput(commandInput, null);
          await callbacks.onUserInput(result.value);
        }
        break;

      case "passthrough":
        // 不像命令的输入：当作普通文本发给模型
        appendCommandOutput(commandInput, null);
        await callbacks.onUserInput(result.value);
        break;

      case "compact":
        // 压缩摘要：作为消息显示（compact 命令内部已操作 ctxMgr，这里仅回显摘要）
        appendCommandOutput(commandInput, result.summary ?? null);
        break;

      case "dialog":
        if (result.dialog) {
          log.info("TUI:CMD", `打开对话框: ${result.dialog}`);
          updateState({ activeDialog: result.dialog });
        }
        break;

      case "confirm": {
        // 确认型结果：暂以文本提示用户（新体系 confirm 的 UI 接线后续可增强）。
        // 当前 bundled skills 不产生 confirm，此分支为完整性兜底。
        appendCommandOutput(commandInput, result.message ?? "需要确认");
        break;
      }

      case "error":
        appendCommandOutput(commandInput, `错误: ${result.message ?? ""}`, true);
        break;

      case "skip":
        // 静默完成：不输出
        break;

      case "message":
      default:
        appendCommandOutput(commandInput, result.value ?? null);
        break;
    }
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
      sessionMemory: this.sessionMemory ?? undefined,
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

      // 缺口 D：在构建系统提示词之前先加载多来源权限规则（settings.json），
      // 这样 describeDenyRules() 能拿到完整 deny 规则，前置告知模型。
      // （原顺序是 initRules 在 buildInitialSystemPrompt 之后，会漏掉文件来源的 deny 规则）
      if (this.permissionChecker && "initRules" in this.permissionChecker) {
        await (this.permissionChecker as any).initRules();
        log.info("APP", "多来源权限规则加载完成");
      }

      // 缺口 D：收集 deny 规则摘要（无 checker 或 describeDenyRules 时为 undefined）
      let denyRulesSummary: string | undefined;
      if (this.permissionChecker && typeof (this.permissionChecker as any).describeDenyRules === "function") {
        denyRulesSummary = (this.permissionChecker as any).describeDenyRules() || undefined;
      }

      // 构建系统提示词（委托给 init-helpers）
      const { buildInitialSystemPrompt } = await import("./query/init-helpers.ts");
      systemPrompt = await buildInitialSystemPrompt(this.config, this.toolRegistry.all(), denyRulesSummary);
    } else {
      // 预置 systemPrompt 分支：跳过附件构建，但多来源权限规则仍需加载（原 initRules 在此之外，
      // 重排后这里补上，避免预置 prompt 时规则不生效的回归）。
      if (this.permissionChecker && "initRules" in this.permissionChecker) {
        await (this.permissionChecker as any).initRules();
        log.info("APP", "多来源权限规则加载完成");
      }
    }

    this.ctxMgr.setSystemPrompt(systemPrompt);
    log.info("APP", `初始化完成，系统提示词 ${systemPrompt.length} 字符，工具数 ${this.toolRegistry.size()}`);

    // B1/B6：接入会话持久化写入端。
    // - 纯新会话：startSession（写 session_start，新建 jsonl）。
    // - resume 会话（restoreSession 已设 resumedSessionId）：resumeSession（续写旧 jsonl，不写 session_start），
    //   避免恢复进来的历史不回写、多次 resume 历史碎片化。
    // 持久化失败绝不能阻断启动。
    try {
      if (this.resumedSessionId) {
        this.sessionStore?.resumeSession(
          this.resumedSessionId,
          this.config.model,
          this.config.provider,
          process.cwd(),
          this.sessionState.sessionId,
        );
        log.info("APP", `会话持久化续写已启动（resume）: ${this.resumedSessionId}（trace=${this.sessionState.sessionId}）`);
      } else {
        this.sessionStore?.startSession(
          this.sessionState.sessionId,
          this.config.model,
          this.config.provider,
          process.cwd(),
        );
        log.info("APP", `会话持久化已启动: ${this.sessionState.sessionId}`);
      }
    } catch (e) {
      log.warn("APP", `会话持久化启动失败（不阻断）: ${(e as Error)?.message}`);
    }

    // Layer 2：把会话转录文件路径注入 ctxMgr，供压缩摘要提示模型查阅压缩前细节。
    // SessionStore 启动后 currentFile 才指向 jsonl，此处读取一次注入即可（resume 同样适用）。
    try {
      const transcriptPath = this.sessionStore?.getCurrentFile() ?? undefined;
      this.ctxMgr.setTranscriptPath(transcriptPath);
    } catch { /* 注入失败不影响启动，转录路径提示自动省略 */ }

    // Step 0：接线 Session Memory 子系统（压缩前持续维护结构化会话笔记）。
    // 三处接线之一（① init）——构造 handle 并持有：
    //   - getMainContext 提供 ForkedAgentContext（共享主对话历史前缀，cache 友好）
    //   - canUseTool 把提取代理权限收窄到只能编辑 .session_memory.md 单文件
    // 另两处接线在 query loop 每轮收尾（② updateSessionMemory ③ recordToolCall），见 query/loop.ts。
    // 失败不阻断启动：sessionMemory 保持 null，autoCompact 回退 LLM 摘要。
    try {
      const { initSessionMemory } = await import("./session-memory/session-memory.ts");
      const { createSessionMemoryPermissions } = await import("./memory/extract/permissions.ts");
      const { getSessionMemoryPath } = await import("./memory/paths.ts");
      const { createStatefulTools } = await import("./tool/stateful-tools.ts");
      const { FileReadTracker } = await import("./tool/file-read-tracker.ts");
      const sessionMemoryFile = getSessionMemoryPath(process.cwd());
      this.sessionMemory = initSessionMemory({
        getMainContext: () => ({
          systemPrompt: this.ctxMgr.getSystemPrompt(),
          messages: this.ctxMgr.getMessages(),
          provider: this.provider,
          toolRegistry: this.toolRegistry,
          model: this.config.model,
          // FileReadTracker 隔离（缺口 A）：每次提取用独立 tracker 重建有状态工具，
          // 不共享主代理 tracker——避免 forked agent 读 .session_memory.md 污染主代理
          // 缓存新鲜度、绕过「先读后写」护栏。对标 cc cloneFileStateCache。
          statefulTools: createStatefulTools(new FileReadTracker()),
        }),
        canUseTool: createSessionMemoryPermissions(sessionMemoryFile),
        cwd: process.cwd(),
      });
      // 把 handle 暴露给 queryLoop（经 QueryEngine），用于每轮收尾触发提取 + 记录工具调用。
      this.queryEngine.setSessionMemory(this.sessionMemory);
      log.info("APP", `Session Memory 子系统已接线: ${sessionMemoryFile}`);
    } catch (e) {
      this.sessionMemory = null;
      log.warn("APP", `Session Memory 接线失败（不阻断，autoCompact 回退 LLM 摘要）: ${(e as Error)?.message}`);
    }

    // 接线后台记忆提取子系统：每轮 end_turn 后 fire-and-forget 跑 forked agent，
    // 从对话中提取值得长期记住的信息写入 MEMORY.md（互斥：主代理本轮已写记忆则跳过）。
    //   - getMainContext 提供 ForkedAgentContext（共享主对话历史前缀，cache 友好）
    //   - statefulTools 注入独立 FileReadTracker（缺口 A 隔离，不污染主代理缓存）
    //   - canUseTool 把提取代理权限收窄到只读 + 仅能写 memoryDir
    //   - appendSystemMessage 把"已保存 N 条记忆"回注主上下文，提示模型
    // 失败不阻断启动：extractMemories 保持 null，主循环 extractMemories?.() 自动跳过。
    try {
      const { initExtractMemories } = await import("./memory/extract/extractor.ts");
      const { createExtractPermissions } = await import("./memory/extract/permissions.ts");
      const { ensureAutoMemPath } = await import("./memory/paths.ts");
      const { createStatefulTools } = await import("./tool/stateful-tools.ts");
      const { FileReadTracker } = await import("./tool/file-read-tracker.ts");
      const memoryDir = ensureAutoMemPath(process.cwd());
      this.extractMemories = initExtractMemories({
        getMainContext: () => ({
          systemPrompt: this.ctxMgr.getSystemPrompt(),
          messages: this.ctxMgr.getMessages(),
          provider: this.provider,
          toolRegistry: this.toolRegistry,
          model: this.config.model,
          // FileReadTracker 隔离（缺口 A）：提取代理读文件用独立 tracker，
          // 不污染主代理「先读后写」护栏。
          statefulTools: createStatefulTools(new FileReadTracker()),
        }),
        memoryDir,
        canUseTool: createExtractPermissions(memoryDir),
        // 提取保存记忆后，把摘要回注主上下文（作为 system-reminder），让模型知晓已记忆。
        appendSystemMessage: (msg) => {
          try { this.ctxMgr.addMessage(msg as import("./llm/types.ts").Message); } catch { /* 回注失败不阻断 */ }
        },
      });
      this.queryEngine.setExtractMemories(this.extractMemories);
      // 会话关闭前 drain 进行中的提取，避免 fire-and-forget 的写入被强制退出截断。
      try {
        const { registerCleanup } = await import("./utils/graceful-shutdown.ts");
        registerCleanup(() => this.extractMemories?.drainPending(5_000) ?? Promise.resolve());
      } catch { /* drain 注册失败不阻断启动 */ }
      log.info("APP", `后台记忆提取子系统已接线: ${memoryDir}`);
    } catch (e) {
      this.extractMemories = null;
      log.warn("APP", `后台记忆提取接线失败（不阻断）: ${(e as Error)?.message}`);
    }

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
        const { collectSkillListingEntries } = await import("./skill/tool.ts");
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
          preferredLanguage: this.config.language,
          model: this.config.model,
          availableModels: this.config.availableModels,
          // 缺口 E：CLAUDE.md 重建路径同样收集 skill 摘要，避免重建后丢失 skill 列表
          skillEntries: collectSkillListingEntries(this.toolRegistry.all()),
          // 缺口 D：CLAUDE.md 可能改写 deny 规则，重建时刷新约束摘要
          denyRulesSummary:
            this.permissionChecker && typeof (this.permissionChecker as any).describeDenyRules === "function"
              ? (this.permissionChecker as any).describeDenyRules() || undefined
              : undefined,
          // 不再写死 maxTokens：交由 buildSystemPrompt 按模型 contextWindow 的 90% 动态推导
        });
        this.ctxMgr.setSystemPrompt(newPrompt);
        log.info("APP", `系统提示词已重建: ${newPrompt.length} 字符`);
      }
    });

    // 轨迹采集初始化（委托给 init-helpers）
    const { initTraceCollector, initTelemetrySystem } = await import("./query/init-helpers.ts");
    await initTraceCollector(this.config, this.hookSystem);

    // session_start hook（非阻塞）。
    // Bug3 桥接：resume 时上报 source="resume" + resumedFrom=旧会话 id，
    // 使 trajectory 元数据能反查到 SessionStore 的 sessions/{旧id}.jsonl。
    this.hookSystem.fireSessionStartEvent(
      this.resumedSessionId ? "resume" : "startup",
      { model: this.config.model, resumedFrom: this.resumedSessionId ?? undefined },
    )
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
      // 兜底退出:无论落盘是否 hang,最多 1.5s 后强制退出。
      // 提前注册(在 await 之前),避免 fireSessionEndEvent 永久挂起时此兜底永远不执行(ASYNC-7)。
      const forceExitTimer = setTimeout(
        () => process.exit(signal === "SIGINT" ? 130 : 143),
        1500,
      );
      // 触发 abort 让 LLM 流式请求/工具调用尽快停下
      try { this.abortController?.abort(); } catch { /* ignore */ }
      try {
        // 给落盘整体一个 1.2s 上限,SessionEnd hook 卡死时不至于拖死整个退出流程(ASYNC-7)
        await Promise.race([
          this.hookSystem.fireSessionEndEvent(
            "abort",
            this.buildSessionEndStats(),
            { error: { message: `process received ${signal}`, name: signal } },
          ),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      } catch (err: any) {
        process.stderr.write(`[signal] SessionEnd hook 失败: ${err?.message ?? err}\n`);
      }
      // B3：信号退出也结束会话持久化（幂等）
      this.finalizeSessionStore();
      // 清理 crash marker（正常退出不残留）
      try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
      try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
      // 落盘已完成(或超时),清掉兜底并立即退出
      clearTimeout(forceExitTimer);
      process.exit(signal === "SIGINT" ? 130 : 143);
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
    // 安全尾部切片：保证切片起点不落在游离 tool_result 上（Session 0427d1bd 400 根因）。
    // slice(-N) 固定数量截断会切断 tool_use/tool_result 配对，留下游离 tool_result → 400。
    const { safeSliceTail } = await import("./agent/message-invariants.ts");

    log.info("APP", `恢复会话: ${sessionData.id}, 消息数 ${sessionData.messages.length}`);

    // B6：标记当前为 resume 会话。doInit 据此调 resumeSession（续写原 jsonl）而非 startSession（新建）。
    // 注意：不修改 sessionState.sessionId（trajectory/PID/crash marker 仍用本进程的新 id，避免跨进程冲突），
    // 仅让 SessionStore 的 currentFile 指向被恢复会话的旧 jsonl 续写，使历史不碎片化。
    this.resumedSessionId = sessionData.id;

    // 缺口 B：读取被恢复会话的落盘进度（~/.sid-code/progress/<被恢复会话 id>.md）。
    // 注意用 sessionData.id（被恢复会话），不是本进程新 id——progress 文件按被恢复会话落盘。
    // 跨会话续做时，这是抗压缩、抗清理的外部进度记忆，恢复时一并回注。失败不阻断。
    let progressNote: string | undefined;
    try {
      const { loadProgressMarkdown } = await import("./query/work-log.ts");
      progressNote = loadProgressMarkdown(sessionData.id) ?? undefined;
    } catch { /* 进度回注是增强，失败不阻断恢复 */ }

    /**
     * 缺口 B：在历史之后追加一条续接标记 user 消息，让模型知道"这是续接、别重新打招呼/重复询问"。
     * 必须在历史末尾干净（无游离 tool_use）时才安全追加——safeSliceTail 已保证切片边界干净。
     * 作为独立 user 消息插在历史之后，出现在注意力最强的末尾位置。
     */
    const appendResumeMarker = () => {
      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: SessionStore.buildResumeMarker(progressNote) }],
      });
    };

    // 如果消息数量不多，直接恢复
    const SUMMARY_THRESHOLD = 20;
    if (sessionData.messages.length <= SUMMARY_THRESHOLD) {
      // 缺口 B 路径 1（最常见的短会话续接）：此前只 setMessages、不注入任何续接提示。
      // 整体恢复完整历史后追加续接标记。若历史末尾恰是未应答的 tool_use，追加 user marker
      // 会形成孤儿 tool_use——由发送前的 backfillOrphanToolResults 补占位 tool_result
      // （它会把占位并入紧邻的下一条 user 消息，即本 marker），协议保持合法。
      this.ctxMgr.setMessages(sessionData.messages);
      appendResumeMarker();
      log.info("APP", `直接恢复 ${sessionData.messages.length} 条消息 + 续接标记`);
      return;
    }

    // 消息太多，尝试加载摘要
    const store = new SessionStore();
    const summary = await store.loadSummary(sessionData.id);

    if (summary) {
      // 路径 2（有摘要）：已有续接提示（buildResumeMessage 含摘要），保持现状即可。
      const recentMessages = safeSliceTail(sessionData.messages, 10);
      const resumeMsg = SessionStore.buildResumeMessage(summary.summary);
      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: resumeMsg }],
      });
      this.ctxMgr.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      });
      // 此路径用 addMessage 逐条添加（非 setMessages 整体替换）：必须先 safeSliceTail 切干净，
      // 否则若首条是游离 tool_result，接在上面 assistant(ack) 之后无前置 tool_calls → 400。
      for (const msg of recentMessages) {
        this.ctxMgr.addMessage(msg);
      }
      log.info("APP", `恢复会话：摘要 + 最近 ${recentMessages.length} 条消息`);
    } else {
      // 缺口 B 路径 3（无摘要长会话）：此前只 setMessages、不注入任何续接提示。
      // 安全截断后整体替换，再追加续接标记（说明早期消息已因恢复截断）。
      const recentMessages = safeSliceTail(sessionData.messages, 15);
      this.ctxMgr.setMessages(recentMessages);
      appendResumeMarker();
      log.warn("APP", `无摘要，仅恢复最近 ${recentMessages.length} 条消息 + 续接标记`);
    }
  }

  /** 处理流式响应，委托给 stream-processor */
  async processStream(
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
    onThinking?: (text: string) => void,
  ): Promise<AccumulatedResponse> {
    const { processStream: processStreamImpl } = await import("./query/stream-processor.ts");
    return processStreamImpl(stream, onText, onThinking, {
      getAbortController: () => this.abortController,
    });
  }

  /** 设置 TUI 模式下的权限确认回调 */
  setTUIConfirmCallback(cb: (toolName: string, toolInput: unknown, desc: string, shadowedRules?: import("./ui/App.tsx").ShadowedRuleInfo[]) => Promise<"yes" | "no" | "always">): void {
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
      // 计算与该工具相关的不可达规则（对标 cc Unreachable Rules），失败不阻断
      const shadowedRules = this.collectShadowedRulesForUI(toolName);
      const answer = await this.tuiConfirmCallback(toolName || "", toolInput, description, shadowedRules);
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

  /**
   * 收集指定工具的阴影规则并投影为 UI 展示结构。
   * 阴影提示是增强信息，任何异常都返回 undefined，绝不阻断权限确认流程。
   */
  private collectShadowedRulesForUI(
    toolName?: string,
  ): import("./ui/App.tsx").ShadowedRuleInfo[] | undefined {
    if (!toolName || !this.permissionChecker?.getShadowedRulesForTool) return undefined;
    try {
      const shadows = this.permissionChecker.getShadowedRulesForTool(toolName);
      if (!shadows.length) return undefined;
      return shadows.map((s) => ({
        rule: s.shadowed.rawRule,
        bySource: s.shadowedBy.source,
        byBehavior: s.shadowedBy.behavior,
        severity: s.severity,
      }));
    } catch {
      return undefined;
    }
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

      // 工具执行失败 + (planning 探索阶段 或 执行阶段) → 触发 Recovery Hook
      //
      // 缺陷修复：旧条件只判 isPlanning()，而 recovery 的设计意图恰恰是"执行阶段
      // （approve 后）工具失败时提醒先更新 plan 再继续"。但 approve() 后状态已回 inactive、
      // isPlanning() 为 false，导致 recovery 在它真正该工作的执行阶段永不触发。
      // 现在追加 isExecuting()：approve 后进入执行阶段标志，按计划执行期间失败也能触发。
      const inPlanContext = this.planManager.isPlanning() || this.planManager.isExecuting();
      if (result && result.type === "tool_result" && result.is_error && inPlanContext) {
        const { getSharedRecoveryHook } = await import("./plan/recovery.ts");
        const hook = getSharedRecoveryHook();
        const planFilePath = this.planManager.getPlanFilePath() || "";
        // 执行阶段 plan 文件路径仍保留（approve/deactivate 不清空，仅 forceExit/下次 enter 清）。
        // 防御：路径为空时跳过（hook 的 isValidContext 也会拒，这里提前 continue 省一次 import）。
        if (!planFilePath) continue;
        const ctx = {
          toolName: block.name,
          errorMessage: typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content ?? ""),
          failedArgs: block.input,
          currentPlanFilePath: planFilePath,
          planStepIndex: null,
        };
        const triggerType = block.name === "read" || block.name === "edit"
          ? "file_not_found"
          : "tool_failure";
        if (hook.shouldTrigger(triggerType, ctx)) {
          hook.recordTrigger(triggerType, ctx.currentPlanFilePath);
          const hint = hook.buildRecoveryHint(triggerType, ctx);
          followup.push({ type: "text", text: hint });
          const phase = this.planManager.isExecuting() ? "执行阶段" : "探索阶段";
          log.info("PLAN", `Recovery Hook 触发(${phase}): trigger=${triggerType} tool=${block.name}`);
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
          text: buildPlanApprovedMessage(planPath || "", this.countPlanSteps(planPath)),
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
        text: buildPlanApprovedMessage(planPath || "", this.countPlanSteps(planPath)),
      }];
    }
  }

  /**
   * P1-1（全集锚点）：解析计划文件得到顶层步骤数，供 buildPlanApprovedMessage 生成
   * "todo 必须覆盖全部 N 步"的硬约束。解析失败/无文件返回 0（退化为通用约束）。
   */
  private countPlanSteps(planPath: string | null): number {
    if (!planPath || !this.planManager) return 0;
    try {
      const { existsSync, readFileSync } = require("fs");
      if (!existsSync(planPath)) return 0;
      const md = readFileSync(planPath, "utf-8");
      return this.planManager.parsePlanFromMarkdown(md).length;
    } catch {
      return 0;
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
      total_cumulative_prompt_tokens: this.sessionState.getCumulativePromptTokens(),
      total_cache_read_tokens: totalUsage.cacheReadInputTokens ?? 0,
      total_cache_creation_tokens: totalUsage.cacheCreationInputTokens ?? 0,
      total_cost_usd: this.sessionState.totalCostUSD,
      total_api_calls: totalRequests,
      duration_ms: this.sessionState.getElapsedMs(),
    };
  }

  /**
   * B3：结束会话持久化（唯一的 endSession 调用封装）。
   *
   * - 在所有退出路径调用（正常退出 / /quit / SIGINT|SIGTERM / runHeadless / emergencySessionEnd）。
   * - endSession 自身幂等（store.ts：currentFile 为 null 时直接 return），重复调用安全 no-op，
   *   故无需在 App 层再加防重入标志。
   * - 修正 bug⑥：消息数用 ctxMgr.getMessages().length（SessionState 无 getMessageCount）。
   * - 持久化失败绝不能阻断退出流程。
   */
  private finalizeSessionStore(): void {
    try {
      this.sessionStore?.endSession(
        this.sessionState.totalCostUSD,
        this.ctxMgr.getMessages().length,
      );
    } catch { /* 文件系统可能已不可用 */ }
    // 模块 C1：会话末落一行用量账本（幂等，best-effort，绝不阻断退出）
    this.appendSessionToLedger();
  }

  /**
   * 模块 C1：SessionEnd 时落一行用量账本汇总（~/.sid-code/usage-ledger.jsonl）。
   *
   * - 幂等：ledgerWritten flag 确保每会话只落一行（finalizeSessionStore 在多退出路径调用）。
   * - 跳过空会话：无任何 API 调用（promptTotal=0）不落行，避免噪声。
   * - 经 SessionState.getNormalizedCacheUsage() 单一事实源派生三段，口径与 Footer/摘要一致。
   * - 只存聚合数字，绝不含消息内容——隐私安全。
   */
  private appendSessionToLedger(): void {
    if (this.ledgerWritten) return;
    try {
      const n = this.sessionState.getNormalizedCacheUsage();
      if (n.promptTotal <= 0) return; // 空会话不落行
      this.ledgerWritten = true;
      const models = Object.entries(this.sessionState.modelUsage);
      // 主模型 = 请求数最多者（多模型会话取主导模型标注；token 仍为全会话汇总）
      const primary = models.sort(([, a], [, b]) => b.requests - a.requests)[0];
      const model = primary?.[0] ?? this.config.model ?? "unknown";
      const provider = primary?.[1]?.provider ?? this.config.provider ?? "unknown";
      appendUsageLedger({
        ts: Math.floor(Date.now() / 1000),
        sessionId: this.sessionState.sessionId,
        model,
        provider,
        promptTotal: n.promptTotal,
        cacheHit: n.cacheHitTokens,
        cacheWrite: n.cacheWriteTokens,
        uncachedInput: n.uncachedInputTokens,
        output: n.outputTokens,
        costUSD: this.sessionState.totalCostUSD,
        savingsUSD: this.sessionState.getTotalCacheSavings(),
        durationMs: this.sessionState.getElapsedMs(),
      });
    } catch { /* 账本写入失败绝不阻断退出 */ }
  }

  /**
   * A4：判断"被取消的本轮输入"是否应自动回填到输入框。
   *
   * 对标 claude-code `messagesAfterAreOnlySynthetic`（REPL.tsx:3015）：
   * 仅当用户在"收到任何实质响应之前"中断,才回退会话并恢复输入框——
   * 若 LLM 已经吐出真实内容,保留对话、不回填。
   *
   * sid-code 适配:取末尾最后一条 user 消息,检查其后是否**没有任何含非空 text 的 assistant 消息**。
   * - 其后只有 tool_use/tool_result（工具已跑但还没产出 assistant 总结）→ 仍视为"无实质响应",可回填。
   * - 其后有非空 assistant text → 有实质响应,不回填。
   *
   * @returns true 表示可回填(且调用方应回退该 user 轮次)
   */
  private shouldRestoreCanceledInput(): boolean {
    return canRestoreCanceledInput(this.ctxMgr.getMessages() as any);
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

    // B3：崩溃兜底也结束会话持久化（best-effort，幂等）
    this.finalizeSessionStore();

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
    // 新用户回合开始：清执行阶段标志。approve 永远发生在 run 中途（exit_plan_mode 工具执行时），
    // 故 submitMessage 开始时上一轮执行阶段必已收尾，此处清理不会误清刚 approve 的标志。
    this.planManager?.endExecution();
    try {
      for await (const event of this.queryEngine.submitMessage(input)) {
        // 无头模式只关心 done、system 消息和 fatal_error
        if (event.kind === "done") break;
        if (event.kind === "system" && event.level === "warning") {
          streamBuffer += `\n⚠️ ${event.text}\n`;
        }
        // §3.2：queryLoop 异常现封装为 fatal_error 事件（不再穿透 for-await）。
        // 无头模式需显式转成 runError，使 SessionEnd reason=error、错误落盘可见。
        if (event.kind === "fatal_error") {
          runError = new Error(event.message);
          if (event.stack) runError.stack = event.stack;
          process.stderr.write(`\n[runHeadless] 致命错误: ${event.message}\n${event.stack ?? ""}\n`);
          break;
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
    // B3：无头模式退出也结束会话持久化（幂等）
    this.finalizeSessionStore();
    // 清理 crash marker（正常退出不残留）
    try { CrashMarker.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }
    try { PidManager.cleanup(this.sessionState.sessionId); } catch { /* ignore */ }

    // 输出结果（即使出错也输出已收到的内容，便于诊断）
    if (this.config.outputFormat === "json") {
      const messages = this.ctxMgr.getMessages();
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const traceOutputDir = this.config.trace?.outputDir
        ?? sidPaths.trajectories();
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
    // B3：stream-json 无头模式退出也结束会话持久化（幂等）
    this.finalizeSessionStore();
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

    // 命令列表（补全/帮助用）：新体系异步加载（含 bundled skills、plugin 命令），
    // 在构造 initialState 前 await 一次填入；运行时刷新（/reload-plugins）走 refreshCommandList。
    const initialCommands = await this.loadCommandList();

    // 流式文本累积器（状态驱动）
    let streamingFullText = "";
    // v2：流式思考累积器（独立于 streamingText，对标 Claude Code）
    let streamingThinkingFull = "";
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
      stockInputTokens: this.sessionState.getStockPromptTokens(),
      costUSD: this.sessionState.totalCostUSD,
      costLimit: this.config.costLimit ?? 0,
      contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / this.ctxMgr.getMaxTokens()) * 100),
      permissionMode: this.config.permissionMode || "default",
      isPlanMode: false,
      gitBranch: (() => { try { return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return ""; } })(),
      // effort/thinking 展示态初值置 null，doInit 末尾 pushKnobDisplay() 会按当前模型能力填充。
      effortDisplay: null,
      thinkingDisplay: null,
      statusMessage: "",
      permissionRequest: null,
      shellConfirmRequest: null,
      planApprovalRequest: null,
      askUserQuestionRequest: null,
      debug: !!this.config.debug,
      lastToolResult: null,
      streamingText: "",
      streamingThinking: "",
      isStreaming: false,
      streamingLine: "",
      isQuitting: false,
      copyModeEnabled: false,
      commands: initialCommands,
      cwd: process.cwd(),
      activeDialog: null,
      availableModels: this.config.availableModels.map(m => ({
        name: m.name,
        provider: m.provider || this.config.provider,
        description: m.baseURL ? `${m.provider || this.config.provider} (${m.baseURL})` : undefined,
      })),
      todos: [],
      tasks: [],
      retryStatus: null,
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

    // ── 会话任务名（终端标题用）──
    // 首条用户消息时：① 本地启发式即时设标题（零延迟,多窗口立刻可区分）;
    // ② 后台用小请求生成更凝练的标题覆盖（fire-and-forget,失败静默回退启发式）。
    // 对标 cc：先启发式占位,Haiku 解析后升级。仅设一次,后续轮次不再改。
    let sessionTitleSet = false;

    const SESSION_TITLE_PROMPT =
      "为下面这段编程会话的首条指令起一个 3-7 个词的简短任务名,用于终端标签区分。" +
      "只输出任务名本身,不要引号、不要标点结尾、不要解释。例:修复登录按钮、添加 OAuth 认证。";

    /** 后台用非流式小请求生成更好的任务名,成功则覆盖标题。不阻塞主流程,任何失败都静默。 */
    const upgradeSessionTitle = (firstMessage: string): void => {
      // provider 不支持非流式 → 跳过,保留启发式标题。
      if (typeof this.provider.sendMessageNonStreaming !== "function") return;
      const trimmed = firstMessage.trim();
      if (!trimmed) return;

      void (async () => {
        try {
          const resp = await this.provider.sendMessageNonStreaming!(
            {
              model: this.config.model,
              system: SESSION_TITLE_PROMPT,
              messages: [{ role: "user", content: [{ type: "text", text: trimmed.slice(0, 1000) }] }],
              maxTokens: 32,
            },
            // 15s 超时,且不与主对话的 abortController 关联——后台任务独立。
            AbortSignal.timeout(15_000),
          );
          const raw = resp.content
            .filter((b): b is import("./llm/types.ts").TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          // 复用启发式做清洗/截断(去换行、按显示宽度裁剪),保证标题栏不溢出。
          const title = deriveTaskTitle(raw);
          if (title) updateState({ sessionTitle: title });
        } catch {
          // 超时 / 网络 / 模型不可用 → 静默,启发式标题已经在用,无需回退。
        }
      })();
    };

    /** 首条用户消息触发任务名生成（启发式即时 + 后台升级）。 */
    const maybeSetSessionTitle = (text: string): void => {
      if (sessionTitleSet) return;
      const heuristic = deriveTaskTitle(text);
      if (!heuristic) return; // 纯命令/空输入不设,保留 cwd 末段。
      sessionTitleSet = true;
      updateState({ sessionTitle: heuristic });
      upgradeSessionTitle(text);
    };

    // 注入 TUI 状态更新器（供 activatePlanMode/deactivatePlanMode 同步 permissionMode）
    this.tuiStateUpdater = (patch) => updateState(patch as any);
    // 初次推送 effort/thinking 展示态到状态栏（让会话启动即显示当前旋钮档位）。
    this.pushKnobDisplay();

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

    // P1-3：把限流状态接到状态栏。rate-limit 模块从 API 响应头实时提取真实配额
    // （anthropic.ts:158 updateRateLimitStatus），此前写了从不显示 → 真正限流时用户处于盲区。
    // 每轮结束时读取最新状态：warning/exceeded 用 sticky 状态消息显示，回到 ok 则清除。
    const syncRateLimitStatus = async (): Promise<void> => {
      try {
        const { getCurrentRateLimitStatus, formatRateLimitWarning, resetRateLimitStatus } = await import("./api/rate-limit.ts");
        let status = getCurrentRateLimitStatus();
        // 陈旧警告自清：配额重置时间（resetsAt）已过 → 旧的 warning/exceeded 已失效
        // （服务端配额窗口已滚动），强制重置回 ok，避免限流提示一直 sticky 误导用户。
        // 这是 resetRateLimitStatus 的唯一合理调用场景：不能无脑在每次成功后重置
        // （否则会掩盖真实的"接近配额"警告），只在窗口确实过期时清。
        if (status.status !== "ok" && status.resetsAt && Date.now() > status.resetsAt) {
          resetRateLimitStatus();
          status = getCurrentRateLimitStatus();
        }
        const warning = formatRateLimitWarning(status);
        if (warning) {
          // 用专属前缀字形与 transient 重试提示区分；sticky（不超时），配额回落到 ok 才清。
          addStatusMessage("rate_limit", `⚠️ ${warning}`);
        } else {
          removeStatusMessage("rate_limit");
        }
      } catch {
        /* 限流状态读取失败不影响主流程 */
      }
    };

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
      // 每次同步时刷新后台任务面板
      bridge.updateTasks();
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
      // 每次重建时刷新后台任务面板
      bridge.updateTasks();
    };
    const appendCommandOutput = (input: string, output: string | null, isError = false) => {
      const displayItem = { kind: "command" as const, input, output };
      const prevDisplayItems = bridge.current.displayItems;
      const displayItems = [...prevDisplayItems, displayItem];

      historyIdCounter += 1;
      const historyItem: import("./ui/types.ts").HistoryItem = {
        id: historyIdCounter,
        type: "command",
        input,
        output,
        isError,
      };
      const prevHistoryItems = bridge.current.historyItems;
      const historyItems = [...prevHistoryItems, historyItem];

      updateState({ displayItems, historyItems });
    };

    // 设置 TUI 权限确认回调
    this.setTUIConfirmCallback(async (toolName, toolInput, desc, shadowedRules) => {
      return new Promise<"yes" | "no" | "always">((resolve) => {
        log.info("TUI:PERM", `显示权限对话框: ${toolName} - ${desc}`);
        const wrappedResolve = (answer: "yes" | "no" | "always") => {
          log.info("TUI:PERM", `权限对话框响应: ${answer}`);
          updateState({ permissionRequest: null });
          resolve(answer);
        };
        updateState({
          permissionRequest: { toolName, toolInput, description: desc, resolve: wrappedResolve, shadowedRules },
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

    // 设置 TUI AskUserQuestion 提问回调（结构化选择题，对标 cc AskUserQuestion）
    {
      const { setAskUserQuestionHandler } = await import("./tool/ask-user-question-bridge.ts");
      setAskUserQuestionHandler(async (req, signal) => {
        return new Promise((resolve) => {
          log.info("TUI:ASK", `显示提问对话框: ${req.questions.length} 题`);
          let settled = false;
          const wrappedResolve = (
            result:
              | { decision: "answered"; answers: Record<string, string> }
              | { decision: "cancelled" },
          ) => {
            if (settled) return;
            settled = true;
            log.info("TUI:ASK", `提问对话框响应: ${result.decision}`);
            updateState({ askUserQuestionRequest: null });
            if (result.decision === "answered") {
              resolve({ status: "answered", answers: result.answers });
            } else {
              resolve({ status: "cancelled" });
            }
          };
          // abort（用户 ESC 中断整轮 / 超时）时清理对话框并按取消处理，避免悬挂
          if (signal) {
            if (signal.aborted) {
              wrappedResolve({ decision: "cancelled" });
              return;
            }
            signal.addEventListener(
              "abort",
              () => wrappedResolve({ decision: "cancelled" }),
              { once: true },
            );
          }
          updateState({
            askUserQuestionRequest: { questions: req.questions, resolve: wrappedResolve },
          });
        });
      });
    }

    // TUI 版本的 agentLoop（消费 QueryEngine async generator）
    const tuiAgentLoop = async (userInput: string) => {
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 单次 session 最长 30 分钟
      const sessionTimer = setTimeout(() => {
        log.warn("TUI", "Session 超时，触发 abort");
        // A6：超时中断 reason='timeout'，与用户主动取消区分——超时不触发输入框回填。
        this.abortController?.abort("timeout");
      }, SESSION_TIMEOUT_MS);

      this.busy = true;
      updateState({
        isLoading: true,
        // 记下本轮起点 outputTokens：spinner 显示「本轮新增」= 当前累计 − 此起点,
        // 与 Footer 的「会话总账」区分开,避免两行显示同一个数。
        turnStartOutputTokens: this.sessionState.getTotalUsage().outputTokens,
      });

      let streamSynced = false;
      let completedNormally = false;

      // 设置流式文本回调（桥接 processStream 内部的 onText）
      this.queryEngine.setStreamTextCallback((text: string) => {
        // 重试进度消息（stream-processor 的 system_api_error → onText(`[重试中] …`)）走状态栏，
        // 不能累加进 assistant 气泡——否则 "[重试中] 正在重试 (2/4)…" 会残留在正文里
        // 与模型真实输出同屏混显（段内无剥离逻辑）。分流到 transient 状态消息，文本成功流式时清除。
        if (text.startsWith("[重试中] ")) {
          addStatusMessage("system:transient", `⟳ ${text.slice("[重试中] ".length)}`);
          return;
        }
        if (!streamSynced) {
          streamSynced = true;
          syncDisplay();
          streamingFullText = "";
          // CM3：文本开始流式输出 = 请求已成功，清除任何残留的重试/限流提示。
          if (bridge.current.retryStatus) {
            updateState({ retryStatus: null });
          }
          // 清除 transient system 警告（空参数重试成功 / 超时重试成功等）。
          // 使用独立 key "system:transient"，不会误清预算/配额等 sticky 警告。
          removeStatusMessage("system:transient");
        }
        streamingFullText += text;
        updateState({ streamingText: streamingFullText, isStreaming: true });
      });

      // v2：设置流式思考回调（桥接 processStream 内部的 onThinking，对标 Claude Code）
      this.queryEngine.setStreamThinkingCallback((thinking: string) => {
        streamingThinkingFull += thinking;
        // 关键修复：思考也是「模型正在产出」，必须置 isStreaming=true。
        // 否则推理模型（扩展思考 / DeepSeek-R1 等）在思考阶段持续吐 token 时，
        // deriveStreamingState 会因 isStreaming=false 误判为 Connecting，
        // 界面显示「连接中…」并触发慢提示——而模型其实在正常输出（盲区误报）。
        // 同时 MainContent 的思考渲染条件是 isStreaming && streamingThinking，
        // 不置位思考内容也不会显示，界面看着就是一片空白。
        // 首个思考 token 到达 = 请求已成功，清除残留的重试/限流提示（与文本回调对齐）。
        if (bridge.current.retryStatus) {
          updateState({ retryStatus: null });
          removeStatusMessage("system:transient");
        }
        updateState({ streamingThinking: streamingThinkingFull, isStreaming: true });
      });

      try {
        // 新用户回合开始：清执行阶段标志（同 runHeadless，详见该处注释）。
        this.planManager?.endExecution();
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
              streamingThinkingFull = "";
              streamSynced = false;
              syncDisplay({ toolName: event.toolName, toolInput: event.toolInput ?? null, isToolExecuting: true, streamingText: "", streamingThinking: "", isStreaming: false, streamingLine: "" });
              break;
            case "tool_end":
              syncDisplay({
                toolName: null,
                toolInput: null,
                isToolExecuting: false,
                lastToolResult: event.result ? { toolName: event.toolName, isError: !!event.result.isError, elapsedMs: event.result.elapsedMs ?? 0 } : null,
                // 工具结束即刷新统计三件套，不必等下一轮 done（否则工具跑完后 Footer 仍显示上一轮旧值）
                usage: { ...this.sessionState.getTotalUsage() },
                stockInputTokens: this.sessionState.getStockPromptTokens(),
                costUSD: this.sessionState.totalCostUSD,
                contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / this.ctxMgr.getMaxTokens()) * 100),
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
                // 空参数/超时重试类是 transient，流式恢复后自动清除，避免一直挂在底部。
                // 预算/配额/上下文等 sticky 警告继续用 "system" key，不会被误清。
                if (event.text.includes("重试")) {
                  addStatusMessage("system:transient", `⚠️ ${event.text}`);
                } else {
                  addStatusMessage("system", `⚠️ ${event.text}`);
                }
              }
              break;
            case "tombstone":
              // 模型降级：清理流式文本残留，重建显示
              streamingFullText = "";
              streamingThinkingFull = "";
              streamSynced = false;
              rebuildDisplay({ streamingThinking: "" });
              addTransientStatusMessage("tombstone", "模型降级，正在使用备用模型重试...", 3000);
              break;
            case "fatal_error": {
              // §3.2 + §3.3（fdb47f30）：queryLoop 异常现封装为此事件（不再穿透 for-await）。
              // 把具体错误原因**持久化**写入 displayItems（永久留存，对标 cc 错误展示），
              // 而非仅 status bar 瞬态 5 秒——用户回神时仍能看到失败原因，便于排查/重试。
              completedNormally = true; // 已显式展示错误，避免 finally 再叠加模糊的"任务异常中断"
              streamingFullText = "";
              streamingThinkingFull = "";
              streamSynced = false;
              log.error("TUI", `queryLoop 致命错误: ${event.message}`, { stack: event.stack });
              const fatalText = `❌ 任务失败：${event.message}\n可重新输入指令重试，或检查上面的工具输出定位原因。`;
              const fatalDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: fatalText }];
              updateState({
                isLoading: false,
                isStreaming: false,
                streamingText: "",
                streamingThinking: "",
                streamingLine: "",
                toolName: null,
                toolInput: null,
                isToolExecuting: false,
                displayItems: fatalDisplay,
                statusMessage: "任务失败",
              });
              break;
            }
            case "done": {
              completedNormally = true;
              const ctxUsed = this.ctxMgr.estimateTokens(this.toolRegistry.size());
              const ctxPct = Math.round((ctxUsed / this.ctxMgr.getMaxTokens()) * 100);
              streamingFullText = "";
              streamingThinkingFull = "";
              streamSynced = false;
              syncDisplay({
                isLoading: false,
                usage: { ...this.sessionState.getTotalUsage() },
                stockInputTokens: this.sessionState.getStockPromptTokens(),
                costUSD: this.sessionState.totalCostUSD,
                contextPercent: ctxPct,
                streamingText: "",
                streamingThinking: "",
                isStreaming: false,
                streamingLine: "",
              });
              break;
            }
          }
        }
      } catch (err: any) {
        // A3：区分 abort 与真异常。用户按 ESC 触发的 abort 是"主动结束"而非故障，
        // 标记 completedNormally=true 避免 finally 误报"⚠️ 任务异常中断"。
        // 不重新 throw——交给 onUserInput 的 catch 显示"已取消当前响应"，让 TUI 继续等待下一轮输入。
        if (isAbortError(err)) {
          completedNormally = true;
          log.info("TUI", "用户中断当前响应");
        } else {
          log.error("TUI", `agent loop 异常: ${err?.message}`, { stack: err?.stack });
          throw err;
        }
      } finally {
        // 清理 session 超时定时器
        clearTimeout(sessionTimer);

        // 兜底：确保异常路径也能正确清理
        streamingFullText = "";
        streamingThinkingFull = "";
        this.queryEngine.setStreamTextCallback(null);
        this.queryEngine.setStreamThinkingCallback(null);

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
        stockInputTokens: this.sessionState.getStockPromptTokens(),
        costUSD: this.sessionState.totalCostUSD,
        contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / this.ctxMgr.getMaxTokens()) * 100),
        // CM3：本轮结束，清除残留的重试/限流提示。
        retryStatus: null,
      });
      // 本轮结束兜底清除重试进度消息：重试后若直接进 tool（不走文本/思考流式的清除路径），
      // sticky 的 "system:transient" 重试提示会残留到下一轮、与新状态串台。done 路径统一清一次。
      removeStatusMessage("system:transient");

      // 本轮结束 → 标记空闲并冲刷 Cron 忙时积压的提示词
      this.busy = false;
      // P1-3：刷新限流状态到状态栏（warning/exceeded 显示，ok 清除）。
      void syncRateLimitStatus();
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
        // 首条用户消息 → 设置会话任务名（终端标题）。启发式即时 + 后台升级。
        maybeSetSessionTitle(text);
        // A4：暂存本轮原始输入,供"中断后自动回填"使用（仅暂存,是否回填由 ESC 取消时决定）。
        stashPendingInput(text, false);
        try {
          this.abortController = new AbortController();
          // @ 文件注入：展开用户输入中的 @path 引用
          const expanded = await expandAtReferences(text);
          await tuiAgentLoop(expanded);
          // 正常完成 → 丢弃暂存,不回填
          clearPendingInput();
        } catch (err: any) {
          const aborted = isAbortError(err);
          let restoredInput = false;
          if (aborted) {
            log.info("TUI:CB", "当前响应已被用户中断");
            // A4：仅"用户主动 ESC 取消"（reason==='user-cancel'，A6）且尚无实质响应时,
            // 回退该 user 轮次并标记输入框回填。超时/其他 reason 不回填。
            const reason = this.abortController?.signal?.reason;
            if (reason === "user-cancel" && this.shouldRestoreCanceledInput()) {
              this.ctxMgr.rewindTurns(1); // 回退本轮 user 输入及其后残留消息
              markForRestore();
              restoredInput = true;
              log.info("TUI:CB", "已回退被取消的输入轮次,输入框将自动恢复原文");
            } else {
              clearPendingInput();
            }
          } else {
            log.error("TUI:CB", `onUserInput 异常`, { error: err.message, stack: err.stack });
            clearPendingInput();
          }

          const message = aborted ? "已取消当前响应" : `错误: ${err.message ?? String(err)}`;
          updateState({
            isLoading: false,
            isStreaming: false,
            streamingText: "",
            // P0-2：ESC 取消是用户最高频路径，此前漏清 streamingThinking →
            // 推理模型思考流式中按 ESC，思考残留动态区，下一轮与新思考同屏混显（范式一+二）。
            streamingThinking: "",
            streamingLine: "",
            toolName: null,
            toolInput: null,
            isToolExecuting: false,
            usage: { ...this.sessionState.getTotalUsage() },
            stockInputTokens: this.sessionState.getStockPromptTokens(),
            costUSD: this.sessionState.totalCostUSD,
            contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / this.ctxMgr.getMaxTokens()) * 100),
          });
          addTransientStatusMessage("error", message, aborted ? 1500 : 5000);

          // §3.3（fdb47f30）：非中断的真异常，除瞬态 status（5s 后消失）外，
          // 还把具体错误**持久化**写入 displayItems（永久留存，对标 cc 错误展示）。
          // 这是 engine fatal_error 封装之外的兜底路径（如 submitMessage 之外抛出的异常），
          // 确保任何真异常用户回神时都能看到原因，而不是只剩一句转瞬即逝的提示。
          if (!aborted) {
            const errDisplayText = `❌ 任务失败：${err?.message ?? String(err)}\n可重新输入指令重试，或检查上面的输出定位原因。`;
            const errDisplay = [...bridge.current.displayItems, { kind: "system" as const, text: errDisplayText }];
            updateState({ displayItems: errDisplay });
          }

          // 中断给出路：用户主动中断后，留一条持久 hint 引导「下一步该做什么」，
          // 不靠瞬态状态消息（会自动消失，用户回神时已无痕迹）。对标 cc 的
          // "Request interrupted · Tell Claude what to do differently"。
          if (aborted) {
            historyIdCounter += 1;
            const guideText = restoredInput
              ? "已中断，并恢复了你刚才的输入 — 可修改后重新发送，或按 esc 清空。"
              : "已中断 — 直接输入新的指令，或告诉我该怎么调整。";
            const interruptHint: import("./ui/types.ts").HistoryItem = {
              id: historyIdCounter,
              type: "hint",
              text: guideText,
            };
            const prevHistoryItems = bridge.current.historyItems;
            updateState({ historyItems: [...prevHistoryItems, interruptHint] });
          }
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
          // providerRegistry 必传：fork 模式的 bundled skill（/review、/commit-push-pr 等 6 个）
          // 依赖它创建子代理；缺失会让 executor 静默退回 inline，导致 fork 隔离/allowedTools/maxTurns 失效。
          providerRegistry: this.providerRegistry,
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
            // 同步上下文窗口：新模型窗口可能与旧模型不同（如 200k↔1M）。
            // 不更新会让 compact 决策与 Footer 上下文百分比沿用旧窗口作分母而失真。
            try {
              const newWindow = new TokenEstimator().getContextLimit(m, this.config.availableModels);
              this.ctxMgr.setMaxTokens(newWindow);
            } catch { /* 窗口解析失败不影响切换，沿用旧窗口 */ }
            updateState({ model: m });
            // 模型变了，effort/thinking 能力可能随之变（如换到不支持 max 的模型），重推展示态。
            this.pushKnobDisplay();
          },
          setEffort: (level, persist) => this.setEffortRuntime(level, persist),
          setThinking: (setting, persist) => this.setThinkingRuntime(setting, persist),
          getEffortState: () => this.getEffortState(),
          getThinkingState: () => this.getThinkingState(),
          exitRequested: false,
          sessionState: this.sessionState,
          mcpManager: this.mcpManager,
          sendToLLM: async (text) => {
            await callbacks.onUserInput(text);
          },
          customCommands: this.getCustomCommandsSummary(),
          confirmShellCommands: async (commands) => {
            return new Promise<boolean>((resolve) => {
              // 与 permissionRequest / planApprovalRequest 对齐：resolve 前先清 state，
              // 否则 DialogManager 按键只调 resolve、确认框永远残留在屏幕上（范式一）。
              const wrappedResolve = (ok: boolean) => {
                updateState({ shellConfirmRequest: null });
                resolve(ok);
              };
              updateState({
                shellConfirmRequest: { commands, resolve: wrappedResolve },
              });
            });
          },
          hookSystem: this.hookSystem,
          commandRegistry: this.commandRegistry,
          unifiedRegistry: this.unifiedRegistry,
        };

        // 记录命令使用频率（驱动补全排序的指数衰减统计）
        try {
          const { recordUsage } = await import("./command/usage-tracking.ts");
          recordUsage(cmd);
        } catch {
          // 使用追踪失败不影响命令执行
        }

        // 新体系执行路径：CommandExecutor 分发 UnifiedCommand
        if (this.unifiedRegistry) {
          const { CommandExecutor } = await import("./command/executor.ts");
          const { toCommandContext } = await import("./command/adapter.ts");

          let execResult: import("./command/types.ts").CommandExecutionResult;
          try {
            const cmdCtxNew = toCommandContext(cmdCtx);
            const commands = await this.unifiedRegistry.getCommands(process.cwd());
            // setToolJSX 回调：本项目当前无真 local-jsx 命令（dialog 走 activeDialog state），
            // 但保留接线以备未来 JSX 命令；渲染交给 activeDialog 机制，这里仅兜底关闭。
            const executor = new CommandExecutor(cmdCtxNew, {
              setToolJSX: () => { /* 预留：当前 dialog 走 activeDialog state，无需 JSX 挂载 */ },
            });
            log.debug("TUI:CMD", `执行命令(新体系): /${cmd}`);
            execResult = await executor.executeSlashCommand(commandInput, commands);
            updateState({ model: this.config.model, provider: this.config.provider });
          } catch (err: any) {
            log.error("TUI:CMD", `命令执行失败: /${cmd}`, { error: err.message, stack: err.stack });
            appendCommandOutput(commandInput, `命令执行失败: ${err.message}`, true);
            return;
          }

          await this.handleCommandExecutionResult(execResult, {
            cmd,
            commandInput,
            callbacks,
            updateState,
            appendCommandOutput,
            getConversationClearedPatch,
            clearPromptCache,
            resetSyncState: () => {
              lastSyncedCount = 0;
              historyIdCounter = 0;
              activeStatusMessages.clear();
            },
          });
          return;
        }

        // 旧体系回退路径（无 unifiedRegistry 时，如部分测试场景）
        const command = this.commandRegistry.get(cmd);
        if (!command) {
          log.warn("TUI:CMD", `未知命令: /${cmd}`);
          appendCommandOutput(commandInput, `未知命令: /${cmd}，输入 /help 查看可用命令`, true);
          return;
        }

        let result: import("./command/types.ts").CommandResult;
        try {
          log.debug("TUI:CMD", `执行命令: /${cmd}`);
          result = await command.execute(args, cmdCtx);
          updateState({ model: this.config.model, provider: this.config.provider });
        } catch (err: any) {
          log.error("TUI:CMD", `命令执行失败: /${cmd}`, { error: err.message, stack: err.stack });
          appendCommandOutput(commandInput, `命令执行失败: ${err.message}`, true);
          return;
        }

        // 处理结构化结果
        switch (result.kind) {
          case "clear":
            log.info("TUI:CMD", "清空消息历史，重置上下文");
            this.ctxMgr.clear();
            this.sessionState.resetCounters();
            clearPromptCache();
            this.quotaManager?.resetAlertLevel();
            this.fallback.reset();
            this.resetTodoTool();
            this.resetHypothesisLedger();
            this.clearInactiveBackgroundTasks();
            // 缓存检测状态重置：旧基线对新会话无效，不清会产生虚假中断检测
            resetCacheDetection();
            clearCacheBreaks();
            // 压缩熔断器重置：旧会话的失败记录不应阻止新会话的合理压缩
            resetCircuitBreaker();
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
                // hook 卡死时不阻塞退出（对齐 signal 路径 1.2s 上限）：SessionEnd 可能跑用户命令长时间无响应。
                await Promise.race([
                  this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats()),
                  new Promise((resolve) => setTimeout(resolve, 1200)),
                ]);
              } catch (err: any) {
                process.stderr.write(`[quit] SessionEnd hook 失败: ${err?.message ?? err}\n`);
              }
              // B3：/quit 退出也结束会话持久化（幂等）
              this.finalizeSessionStore();
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
            appendCommandOutput(commandInput, `错误: ${result.message ?? ""}`, true);
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
        // A6：带 reason 区分中断场景。对标 claude-code 的 signal.reason === 'user-cancel'：
        // 仅"用户主动 ESC 取消"这一场景才触发 A4 的输入框自动回填；超时/信号等不回填。
        this.abortController.abort("user-cancel");
      },
    };

    // 恢复会话首屏渲染：restoreSession 仅把历史灌入 ctxMgr（LLM 上下文），
    // 而 syncDisplay/rebuildDisplay 只在事件回调中触发，故 resume 后历史不会出现在视图里。
    // 在 createFullScreen 前先 rebuildDisplay 一次，把已恢复的消息写进 bridge.current，
    // 这样 initialState: bridge.current 就能带上历史首屏渲染。
    if (this.ctxMgr.getMessages().length > 0) {
      log.info("TUI", `恢复会话首屏渲染: ${this.ctxMgr.getMessages().length} 条消息`);
      rebuildDisplay();
    }

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

    // 兜底退出：正常退出路径(Ctrl+C / /quit / Ctrl+D)此前无 failsafe，也无显式 process.exit——
    // 完全依赖事件循环自然 drain。任一清理 await(SessionEnd hook / MCP closeAll / 遥测 flush)
    // hang 住，或有 handle 未释放(MCP 子进程管道 / watcher / 遥测 socket)，进程就会卡在 shell
    // 不退出(用户已看到会话摘要却回不到提示符)。这正是"Ctrl+C 有时退出卡住"的根因。
    // 对齐 signal 路径的 forceExitTimer：提前注册(在所有 await 之前),最多 5s 强制退出。
    const forceExitTimer = setTimeout(() => {
      try { log.warn("TUI", "退出清理超时(5s)，强制退出"); } catch { /* ignore */ }
      process.exit(0);
    }, 5000);
    forceExitTimer.unref();

    // SessionEnd hook 卡死时不拖死退出(对齐 signal 路径的 Promise.race 1.2s 上限):
    // hook 可能跑用户自定义命令而长时间无响应,不能让它永久阻塞退出。
    try {
      await Promise.race([
        this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats()),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch { /* SessionEnd 落盘失败不阻塞退出 */ }
    // B3：正常退出——唯一的"主路径" endSession。写 session_end 并把 currentFile 置 null，
    // 后续若 emergency 再调一次会安全 no-op（幂等）。
    this.finalizeSessionStore();
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

    // 显式退出：清理已完成,主动 process.exit(0) 而非依赖事件循环自然 drain。
    // 残留 handle(MCP 管道 / 遥测 socket / 未 unref 的 timer)会让进程永久挂起在 shell——
    // 这是本路径此前缺失的最后一环。clearTimeout 让 failsafe 不再需要(已正常退出)。
    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}
