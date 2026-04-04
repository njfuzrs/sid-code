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
import type { ProjectRules } from "./config/rules.ts";
import { clearPromptCache } from "./config/system-prompt.ts";
import { getLogger, getMemoryMonitor, getSessionMetrics } from "./debug/index.ts";
import { QueryEngine } from "./query/engine.ts";
import { HookSystem } from "./hook/system.ts";
import { JitContextManager } from "./config/jit-context.ts";
import { isAbortError } from "./llm/errors.ts";
import { execSync } from "child_process";
import { readFile } from "fs/promises";
import { resolve, extname } from "path";

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
    this.fallback = new ModelFallback({ availability }, {
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

  /** 初始化：加载系统提示词 */
  async init(): Promise<void> {
    const log = getLogger();
    log.info("APP", "开始初始化...");

    // 启动内存监控
    getMemoryMonitor().start();

    // 设置 bash 工具配置（用于环境变量清理）
    const { setBashToolConfig } = await import("./tool/bash.ts");
    setBashToolConfig(this.config);

    let systemPrompt = this.config.systemPrompt;

    if (!systemPrompt) {
      // 加载并解析 CLAUDE.md 规则
      const projectRules = await loadAllCLAUDEmd(process.cwd());
      if (projectRules) {
        log.debug("APP", `加载 CLAUDE.md 规则 (${projectRules.rawContent.length} 字符)`);
        this.applyProjectRules(projectRules);
      }

      // 构建系统提示词（委托给 init-helpers）
      const { buildInitialSystemPrompt } = await import("./query/init-helpers.ts");
      systemPrompt = await buildInitialSystemPrompt(this.config, this.toolRegistry.all());
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
  async executeTools(content: ContentBlock[]): Promise<ContentBlock[]> {
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
        return buildPlanModeReminder();
      },
      discoverJitContext: (toolBlocks) => this.discoverJitContext(toolBlocks),
    });
  }

  /**
   * Plan Mode 状态转换处理
   * 在工具执行完成后，检查是否有 enter/exit_plan_mode 调用，执行相应的状态转换
   * 使用 resultMap（按原始索引存储）避免数组错位
   */
  private async handlePlanModeTransitions(
    toolBlocks: Array<{ block: ToolUseBlock; idx: number }>,
    resultMap: Map<number, ContentBlock>,
  ): Promise<void> {
    if (!this.planManager) return;
    const log = getLogger();

    for (const { block, idx } of toolBlocks) {
      const result = resultMap.get(idx);
      // 跳过执行失败的工具
      if (result && result.type === "tool_result" && result.is_error) continue;

      if (block.name === "enter_plan_mode" && this.planManager.isPlanning()) {
        await this.activatePlanMode();
      }

      if (block.name === "exit_plan_mode" && this.planManager.isAwaitingApproval()) {
        await this.handlePlanApproval();
      }
    }
  }

  /** 激活 Plan Mode：切换权限模式 + 注入 Plan Mode 系统提示词 */
  private async activatePlanMode(): Promise<void> {
    const log = getLogger();
    log.info("PLAN", "激活 Plan Mode");

    // 保存原始权限模式（退出时恢复）
    if (!this._originalPermissionMode) {
      this._originalPermissionMode = this.config.permissionMode;
    }
    this.config.permissionMode = "plan";

    // 同步 TUI 状态
    this.tuiStateUpdater?.({ permissionMode: "plan" });

    // 重建系统提示词（注入 Plan Mode 提示词）
    await this.rebuildSystemPromptForPlanMode();
  }

  /** 退出 Plan Mode：恢复权限模式 + 重建系统提示词 */
  private async deactivatePlanMode(): Promise<void> {
    const log = getLogger();
    log.info("PLAN", "退出 Plan Mode");

    // 恢复原始权限模式
    const restored = this._originalPermissionMode || "default";
    this.config.permissionMode = restored;
    this._originalPermissionMode = null;

    // 同步 TUI 状态
    this.tuiStateUpdater?.({ permissionMode: restored });

    // 重建系统提示词（移除 Plan Mode 提示词）
    await this.rebuildSystemPrompt();
  }

  /** 处理 Plan Mode 审批流程 */
  private async handlePlanApproval(): Promise<void> {
    if (!this.planManager) return;
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
        this.ctxMgr.addMessage({
          role: "user",
          content: [{ type: "text", text: "用户已批准你的计划。你现在可以开始按计划编写代码了。" }],
        });
      } else {
        const canContinue = this.planManager.reject();
        if (canContinue) {
          const count = this.planManager.getRejectionCount();
          log.info("PLAN", `用户拒绝计划 (${count}/5)，继续修改`);
          // 注入拒绝反馈，让 LLM 知道需要修改计划
          this.ctxMgr.addMessage({
            role: "user",
            content: [{ type: "text", text: `用户拒绝了你的计划（第 ${count} 次）。请根据用户反馈修改计划文件，然后再次调用 exit_plan_mode 提交审批。` }],
          });
        } else {
          await this.deactivatePlanMode();
          log.info("PLAN", "拒绝次数超限，强制退出 Plan Mode");
        }
      }
    } else {
      // 非 TUI 模式（headless）：自动批准
      this.planManager.approve();
      await this.deactivatePlanMode();
      log.info("PLAN", "非交互模式，自动批准计划");
    }
  }

  /** 重建系统提示词（Plan Mode 专用，注入 Plan Mode 提示词片段） */
  private async rebuildSystemPromptForPlanMode(): Promise<void> {
    const { buildPlanModePrompt } = await import("./plan/prompt.ts");
    const { existsSync } = await import("fs");

    const planPath = this.planManager?.getPlanFilePath() || "";
    const planExists = planPath ? existsSync(planPath) : false;
    const planModePrompt = buildPlanModePrompt(planPath, planExists);

    // 在现有系统提示词末尾追加 Plan Mode 提示词
    const currentPrompt = this.ctxMgr.getSystemPrompt();
    this.ctxMgr.setSystemPrompt(currentPrompt + "\n\n" + planModePrompt);
    clearPromptCache();
  }

  /** 重建系统提示词（恢复正常模式） */
  private async rebuildSystemPrompt(): Promise<void> {
    const projectRules = await loadAllCLAUDEmd(process.cwd());
    let memorySummary: string | undefined;
    try {
      const { MemoryStore } = await import("./memory/store.ts");
      const memStore = new MemoryStore(process.cwd());
      memorySummary = await memStore.generateSummary() || undefined;
    } catch { /* 忽略 */ }

    const { buildSystemPrompt } = await import("./config/system-prompt.ts");
    const newPrompt = buildSystemPrompt({
      tools: this.toolRegistry.all(),
      projectRules: projectRules?.rawContent || undefined,
      projectRulesPath: projectRules?.sourcePath,
      appendPrompt: this.config.appendSystemPrompt || undefined,
      workingDir: process.cwd(),
      permissionMode: this.config.permissionMode,
      gitStatus: true,
      memorySummary,
      maxTokens: 180000,
    });
    this.ctxMgr.setSystemPrompt(newPrompt);
    clearPromptCache();
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

  /** 无头模式：消费 QueryEngine async generator，不依赖任何 renderer */
  async runHeadless(input: string): Promise<string> {
    await this.init();

    let streamBuffer = "";
    this.queryEngine.setStreamTextCallback((text) => { streamBuffer += text; });

    this.abortController = new AbortController();
    try {
      for await (const event of this.queryEngine.submitMessage(input)) {
        // 无头模式只关心 done 和 system 消息
        if (event.kind === "done") break;
        if (event.kind === "system" && event.level === "warning") {
          streamBuffer += `\n⚠️ ${event.text}\n`;
        }
      }
    } finally {
      this.abortController = null;
      this.queryEngine.setStreamTextCallback(null);
    }

    // 输出结果
    if (this.config.outputFormat === "json") {
      const messages = this.ctxMgr.getMessages();
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const result = {
        role: "assistant",
        content: lastAssistant?.content || [],
        usage: this.sessionState.getTotalUsage(),
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(streamBuffer);
    }

    // session_end hook + 清理
    await this.hookSystem.fireSessionEndEvent("exit", this.buildSessionEndStats());
    unwatchCLAUDEmd();
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

    return "";
  }

  /** TUI 模式 */
  async runTUI(initialPrompt?: string): Promise<void> {
    const log = getLogger();
    // TUI 模式下切换为仅文件输出，避免干扰 Ink 渲染
    log.setFileOnly(true);
    log.info("TUI", "进入 TUI 模式（alternate screen）");

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
        description: m.baseUrl ? `${m.provider || this.config.provider} (${m.baseUrl})` : undefined,
      })),
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

    const scheduleStatusMessageClear = (message: string, delayMs = 1500) => {
      setTimeout(() => {
        if (bridge.current.statusMessage === message) {
          updateState({ statusMessage: "" });
        }
      }, delayMs);
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
    };

    /** 重建（/compact 后消息被压缩，需要完整重建） */
    const rebuildDisplay = (extraPatch?: Partial<import("./ui/App.tsx").TUIState>) => {
      const allMsgs = this.ctxMgr.getMessages();
      lastSyncedCount = allMsgs.length;
      historyIdCounter = 0;
      const displayItems = messagesToDisplayItems(allMsgs);
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
      updateState({
        isLoading: true,
      });

      let streamSynced = false;

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
              break;
            case "compact":
              rebuildDisplay({ statusMessage: "上下文已自动压缩" });
              setTimeout(() => updateState({ statusMessage: "" }), 3000);
              break;
            case "context_warning":
              updateState({ statusMessage: `⚠ 上下文剩余 ${event.remaining.toFixed(0)}%，即将自动压缩` });
              break;
            case "max_turns":
              updateState({ statusMessage: `达到最大轮次限制: ${event.maxTurns}` });
              break;
            case "system":
              if (event.level === "warning") {
                updateState({ statusMessage: `⚠️ ${event.text}` });
              }
              break;
            case "done": {
              const ctxUsed = this.ctxMgr.estimateTokens(this.toolRegistry.size());
              const ctxPct = Math.round((ctxUsed / 200000) * 100);
              streamingFullText = "";
              streamSynced = false;
              syncDisplay({
                usage: { ...this.sessionState.getTotalUsage() },
                costUSD: this.sessionState.totalCostUSD,
                contextPercent: ctxPct,
                statusMessage: "",
                streamingText: "",
                isStreaming: false,
                streamingLine: "",
              });
              break;
            }
          }
        }
      } finally {
        // 兜底：确保异常路径也能正确清理
        streamingFullText = "";
        this.queryEngine.setStreamTextCallback(null);
      }

      syncDisplay({
        isLoading: false,
        usage: { ...this.sessionState.getTotalUsage() },
        costUSD: this.sessionState.totalCostUSD,
        contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / 200000) * 100),
      });
    };

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
            statusMessage: message,
          });

          if (aborted) {
            scheduleStatusMessageClear(message);
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
          setModel: (m) => {
            log.info("TUI:CMD", `切换模型: ${this.config.model} → ${m}`);
            this.config.model = m;
            const { resolveModelMaxOutputTokens } = require("./config/config.ts");
            const modelMaxOutput = resolveModelMaxOutputTokens(this.config);
            if (modelMaxOutput) {
              this.config.maxTokens = modelMaxOutput;
              log.info("TUI:CMD", `maxTokens 已更新: ${modelMaxOutput}`);
            }
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
        };

        const command = this.commandRegistry.get(cmd);
        if (!command) {
          log.warn("TUI:CMD", `未知命令: /${cmd}`);
          appendCommandOutput(commandInput, `未知命令: /${cmd}，输入 /help 查看可用命令`);
          return;
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
            updateState(getConversationClearedPatch());
            break;

          case "quit":
            appendCommandOutput(commandInput, result.message ?? "再见！");
            setTimeout(() => process.exit(0), 100);
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

    // 渲染 TUI
    log.info("TUI", "开始渲染 TUI 组件（Alternate Buffer 模式）");

    const app = createFullScreen(
      React.createElement(TUIApp, {
        initialState: bridge.current,
        callbacks,
        bridge,
      }),
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
    unwatchCLAUDEmd();
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
  }
}
