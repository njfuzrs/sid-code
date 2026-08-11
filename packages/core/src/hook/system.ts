/**
 * Hook 系统门面类
 * 对外统一 API，封装 registry/planner/runner/aggregator/event-handler
 */

import { HookRegistry } from "./registry.ts";
import { HookPlanner } from "./planner.ts";
import { HookRunner } from "./runner.ts";
import { HookAggregator } from "./aggregator.ts";
import { HookEventHandler } from "./event-handler.ts";
import { AsyncHookRegistry, type RewakeNotification } from "./async-registry.ts";
import { EnterprisePolicyGate, type EnterprisePolicy } from "./enterprise-policy.ts";
import { HookEventName, ConfigSource, LEGACY_EVENT_MAP } from "./types.ts";
import type { HooksConfig as LegacyHooksConfig, HookConfig as LegacyHookConfig } from "../config/config.ts";
import type {
  HookConfig,
  NewHooksConfig,
  AggregatedHookResult,
  SessionStartInput,
  SessionEndInput,
  BeforeModelInput,
  AfterModelInput,
} from "./types.ts";
import type { HookRegistryEntry } from "./registry.ts";

export class HookSystem {
  private readonly registry: HookRegistry;
  private readonly planner: HookPlanner;
  private readonly runner: HookRunner;
  private readonly aggregator: HookAggregator;
  private readonly eventHandler: HookEventHandler;
  /** G7：异步 hook 注册表（后台执行 + asyncRewake 回灌） */
  private readonly asyncRegistry: AsyncHookRegistry;

  constructor() {
    this.registry = new HookRegistry();
    this.planner = new HookPlanner(this.registry);
    this.runner = new HookRunner();
    this.aggregator = new HookAggregator();
    this.asyncRegistry = new AsyncHookRegistry();
    this.runner.setAsyncRegistry(this.asyncRegistry);
    this.eventHandler = new HookEventHandler(
      this.planner,
      this.runner,
      this.aggregator,
      "",
      process.cwd(),
      // once hook 回标需要 registry（执行成功后标记已执行，使其不再进入后续计划）
      this.registry,
    );
  }

  /**
   * G7：排空异步 hook 的 rewake 通知（供主循环每轮开始时调用）。
   * 返回 asyncRewake=true 且后台进程 exit 2 的 hook 的 stderr，作为 system-reminder 注入下一轮。
   */
  drainRewakeNotifications(): RewakeNotification[] {
    return this.asyncRegistry.drainRewakeNotifications();
  }

  /** G7：是否有待回灌的异步 rewake 通知（主循环快速检查用）。 */
  hasRewakeNotifications(): boolean {
    return this.asyncRegistry.hasRewakeNotifications();
  }

  /** G7：清理已完成的异步 hook 条目（会话结束或定期调用）。 */
  cleanupAsyncHooks(): void {
    this.asyncRegistry.cleanup();
  }

  /** 从旧格式配置初始化（向后兼容） */
  initializeFromLegacy(legacyHooks: LegacyHooksConfig): void {
    this.registry.initializeFromLegacy(legacyHooks);
  }

  /**
   * G13：应用企业策略（managed-settings）——构造 EnterprisePolicyGate 注入 registry。
   * disableAllHooks / allowManagedHooksOnly 等策略会在 getHooksForEvent 时过滤 hook。
   * 传 undefined 或空策略等价于解除门控。
   */
  applyEnterprisePolicy(policy: EnterprisePolicy | undefined): void {
    if (!policy) {
      this.registry.setPolicyGate(undefined);
      return;
    }
    const gate = new EnterprisePolicyGate(policy);
    this.registry.setPolicyGate(gate);
  }

  /** 从新格式配置初始化 */
  initializeFromNew(newHooks: NewHooksConfig, source: ConfigSource = "user" as ConfigSource): void {
    this.registry.initializeFromNew(newHooks, source);
  }

  /** 编程式注册 hook */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    this.registry.registerHook(config, eventName, options);
  }

  /**
   * 注册 Skill 声明的会话级 hook（Task 7）
   * Skill 被调用时注册，会话结束或 Skill 卸载时通过 removeSkillHooks 清理。
   */
  registerSessionHook(
    config: HookConfig,
    eventName: HookEventName,
    options: { matcher?: string; skillName: string; once?: boolean },
  ): void {
    this.registry.registerSessionHook(config, eventName, options);
  }

  /** 移除指定 Skill 注册的所有会话级 hook，返回移除数量 */
  removeSkillHooks(skillName: string): number {
    return this.registry.removeSkillHooks(skillName);
  }

  /** 获取事件处理器（用于触发事件） */
  getEventHandler(): HookEventHandler {
    return this.eventHandler;
  }

  /** 设置会话 ID */
  setSessionId(id: string): void {
    this.eventHandler.setSessionId(id);
  }

  /** 设置工作目录 */
  setCwd(cwd: string): void {
    this.eventHandler.setCwd(cwd);
  }

  /** G6：注入 agent hook 的真子代理执行器（由 app 层携带工具注册表设置）。 */
  setAgentHookExecutor(executor: import("./runner.ts").AgentHookExecutor | undefined): void {
    this.runner.setAgentHookExecutor(executor);
  }

  /** 设置当前权限模式 */
  setPermissionMode(mode: string): void {
    this.eventHandler.setPermissionMode(mode);
  }

  /** 启用/禁用指定 hook */
  setHookEnabled(hookName: string, enabled: boolean): void {
    this.registry.setHookEnabled(hookName, enabled);
  }

  /** 启用/禁用所有 hook */
  setAllEnabled(enabled: boolean): void {
    this.registry.setAllEnabled(enabled);
  }

  /**
   * 批量应用禁用列表（settings.json disabledHooks 启动恢复用）。
   * 先全启用再按名禁用,保证与配置一致（幂等）；对插件 hook 也生效,故 loadPluginHooks 后需再调一次。
   */
  applyDisabledHooks(disabledNames: string[] | undefined): void {
    if (!disabledNames || disabledNames.length === 0) return;
    for (const name of disabledNames) {
      this.registry.setHookEnabled(name, false);
    }
  }

  /** 获取 hook 的显示名（name > command > url），供管理命令与持久化按名匹配复用。 */
  getHookName(entry: HookRegistryEntry): string {
    return this.registry.getHookName(entry);
  }

  /** 获取所有 hook（用于管理命令） */
  getAllHooks(): HookRegistryEntry[] {
    return this.registry.getAllHooks();
  }

  /**
   * 获取某事件当前**仍可执行**的 hook（已过滤禁用项、已执行的 once hook、企业策略拦截项）。
   * 与 getAllHooks 的区别：后者返回全部注册条目（含已失效的 once），供 /hooks 面板展示；
   * 本方法反映「下次触发会真正跑哪些」，供诊断与测试断言使用。
   */
  getHooksForEvent(eventName: HookEventName): HookRegistryEntry[] {
    return this.registry.getHooksForEvent(eventName);
  }

  /**
   * 原子替换插件 hooks（不影响 user/project/runtime 来源的 hooks）
   *
   * 关键设计（对标 Claude Code gh-29767 教训）：先清除所有 source=plugin 的旧 hook，
   * 再注册新的插件 hooks，整个过程在同一同步调用内完成——旧 hooks 一直有效直到新 hooks 就位。
   *
   * @param pluginHooks 按事件名分组的插件 hook 列表（config 层 HooksConfig 格式）
   */
  replacePluginHooks(pluginHooks: LegacyHooksConfig): void {
    // 1. 清除所有 source === Plugin 的已注册 hook
    this.registry.removeBySource(ConfigSource.Plugin);

    // 2. 注册新的插件 hooks
    for (const [eventKey, hooks] of Object.entries(pluginHooks)) {
      if (!Array.isArray(hooks)) continue;
      const eventName = this.resolveEventName(eventKey);
      if (!eventName) continue;

      for (const legacyHook of hooks) {
        const config = this.convertPluginHook(legacyHook);
        if (!config) continue;
        try {
          this.registry.registerHook(config, eventName, {
            matcher: legacyHook.matcher,
            if: legacyHook.if,
            source: ConfigSource.Plugin,
          });
        } catch {
          // 单个 hook 配置无效不影响其他 hook（错误已由 registry 内部记录）
        }
      }
    }
  }

  /** 将 config 层 HookConfig 转为 hook 注册表的 HookConfig（command / url 两类） */
  private convertPluginHook(legacy: LegacyHookConfig): HookConfig | null {
    const type = legacy.type || "command";
    if (type === "url") {
      if (!legacy.url) return null;
      return {
        type: "url",
        url: legacy.url,
        method: legacy.method,
        headers: legacy.headers,
        timeout: legacy.timeout,
      };
    }
    // G5：prompt / agent 类型（与 registry.convertLegacyHook 保持一致）
    if (type === "prompt") {
      if (!legacy.prompt) return null;
      return { type: "prompt", name: legacy.name, prompt: legacy.prompt, model: legacy.model, timeout: legacy.timeout };
    }
    if (type === "agent") {
      if (!legacy.prompt) return null;
      return { type: "agent", name: legacy.name, prompt: legacy.prompt, model: legacy.model, tools: legacy.tools, timeout: legacy.timeout };
    }
    if (!legacy.command) return null;
    return {
      type: "command",
      name: legacy.name,
      command: legacy.command,
      timeout: legacy.timeout,
      async: legacy.async,           // G7：后台异步执行
      asyncRewake: legacy.asyncRewake, // G7：exit 2 回灌唤醒
    };
  }

  /** 解析事件名（支持 snake_case 和 PascalCase），委托给 registry 同款逻辑 */
  private resolveEventName(name: string): HookEventName | null {
    const values = Object.values(HookEventName) as string[];
    if (values.includes(name)) return name as HookEventName;
    const legacy = (LEGACY_EVENT_MAP as Record<string, HookEventName>)[name];
    return legacy ?? null;
  }

  // ============================================================
  // 便捷方法：直接触发事件（委托给 eventHandler）
  // ============================================================

  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePreToolUseEvent(toolName, toolInput, toolUseId);
  }

  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    isError?: boolean,
    toolUseId?: string,
    options?: {
      duration_ms?: number;
      edit_meta?: import("./types.ts").HarnessEditMeta;
      verify_triggered?: boolean;
      harness_context?: import("./types.ts").HarnessHookContext;
    },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolUseEvent(toolName, toolInput, toolResponse, isError, toolUseId, options);
  }

  /** options.duration_ms：让失败工具的 execute_tool span 也带真实耗时（见 event-handler 同名方法） */
  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    toolUseId?: string,
    options?: {
      duration_ms?: number;
      harness_context?: import("./types.ts").HarnessHookContext;
    },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolUseFailureEvent(
      toolName,
      toolInput,
      error,
      toolUseId,
      options,
    );
  }

  async fireUserPromptSubmitEvent(prompt: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireUserPromptSubmitEvent(prompt);
  }

  async fireAfterAgentEvent(prompt: string, promptResponse: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireAfterAgentEvent(prompt, promptResponse);
  }

  async fireBeforeModelEvent(
    llmRequest: BeforeModelInput["llm_request"],
    options?: {
      harness_context?: import("./types.ts").HarnessHookContext;
      stream_snapshot_ref?: BeforeModelInput["stream_snapshot_ref"];
    },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireBeforeModelEvent(llmRequest, options);
  }

  async fireAfterModelEvent(
    llmRequest: AfterModelInput["llm_request"],
    llmResponse: AfterModelInput["llm_response"],
    options?: { harness_context?: import("./types.ts").HarnessHookContext },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireAfterModelEvent(llmRequest, llmResponse, options);
  }

  async fireSessionStartEvent(
    source: SessionStartInput["source"] = "startup",
    options?: { model?: string; systemPromptHash?: string; resumedFrom?: string },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSessionStartEvent(source, options);
  }

  async fireSessionEndEvent(
    reason: SessionEndInput["reason"] = "exit",
    stats?: SessionEndInput["stats"],
    options?: {
      harness_summary?: import("./types.ts").HarnessSessionSummary;
      error?: { message: string; name?: string; stack?: string };
    },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSessionEndEvent(reason, stats, options);
  }

  async firePreCompactEvent(trigger: "manual" | "auto" = "auto"): Promise<AggregatedHookResult> {
    return this.eventHandler.firePreCompactEvent(trigger);
  }

  async fireSubagentStartEvent(
    agentId: string,
    agentType: string,
    parentSessionId?: string,
    extra?: { model?: string; provider?: string; description?: string },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSubagentStartEvent(agentId, agentType, parentSessionId, extra);
  }

  async fireSubagentStopEvent(details?: Record<string, unknown>): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSubagentStopEvent(details);
  }

  async fireNotificationEvent(
    notificationType: string,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireNotificationEvent(notificationType, message, details);
  }

  /** Stop 事件：模型 end_turn 后执行检查 */
  async fireStopEvent(assistantResponse: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireStopEvent(assistantResponse);
  }

  /** StopFailure 事件 */
  async fireStopFailureEvent(error: string, errorType: "api_error" | "rate_limit" | "context_overflow" | "abort" | "unknown"): Promise<AggregatedHookResult> {
    return this.eventHandler.fireStopFailureEvent(error, errorType);
  }

  /** PostCompact 事件 */
  async firePostCompactEvent(trigger: "manual" | "auto", messagesBefore: number, messagesAfter: number, tokensSaved: number): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostCompactEvent(trigger, messagesBefore, messagesAfter, tokensSaved);
  }

  /** Setup 事件 */
  async fireSetupEvent(trigger: "first_run" | "dependency_change" | "manual", projectDir: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSetupEvent(trigger, projectDir);
  }

  /** PermissionRequest 事件 */
  async firePermissionRequestEvent(toolName: string, toolInput: Record<string, unknown>, permissionMode: string): Promise<AggregatedHookResult> {
    return this.eventHandler.firePermissionRequestEvent(toolName, toolInput, permissionMode);
  }

  /** PermissionDenied 事件 */
  async firePermissionDeniedEvent(toolName: string, toolInput: Record<string, unknown>, denialReason: string, denialSource: "user" | "rule" | "hook" | "auto"): Promise<AggregatedHookResult> {
    return this.eventHandler.firePermissionDeniedEvent(toolName, toolInput, denialReason, denialSource);
  }

  /** ConfigChange 事件 */
  async fireConfigChangeEvent(changedKeys: string[], source: "file" | "command" | "env"): Promise<AggregatedHookResult> {
    return this.eventHandler.fireConfigChangeEvent(changedKeys, source);
  }

  /** FileChanged 事件 */
  async fireFileChangedEvent(filePath: string, changeType: "created" | "modified" | "deleted"): Promise<AggregatedHookResult> {
    return this.eventHandler.fireFileChangedEvent(filePath, changeType);
  }

  /** CwdChanged 事件 */
  async fireCwdChangedEvent(oldCwd: string, newCwd: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireCwdChangedEvent(oldCwd, newCwd);
  }

  /** TaskCreated 事件 */
  async fireTaskCreatedEvent(taskId: string, taskDescription: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTaskCreatedEvent(taskId, taskDescription);
  }

  /** TaskCompleted 事件 */
  async fireTaskCompletedEvent(taskId: string, taskDescription: string, success: boolean, result?: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTaskCompletedEvent(taskId, taskDescription, success, result);
  }

  /** G11：InstructionsLoaded 事件——指令（CLAUDE.md / rules）加载到上下文时 */
  async fireInstructionsLoadedEvent(sources: string[], totalChars?: number): Promise<AggregatedHookResult> {
    return this.eventHandler.fireInstructionsLoadedEvent(sources, totalChars);
  }

  /** G11：TeammateIdle 事件——团队代理空闲时（可 block） */
  async fireTeammateIdleEvent(teammateId: string, teammateName?: string, idleMs?: number): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTeammateIdleEvent(teammateId, teammateName, idleMs);
  }

  /** G11：Elicitation 事件——hook 反向向用户提问（需配套 UI，先占位） */
  async fireElicitationEvent(message: string, requestedSchema?: Record<string, unknown>): Promise<AggregatedHookResult> {
    return this.eventHandler.fireElicitationEvent(message, requestedSchema);
  }

  /** G11：ElicitationResult 事件——Elicitation 的用户响应结果 */
  async fireElicitationResultEvent(
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireElicitationResultEvent(action, content);
  }
}
