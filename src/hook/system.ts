/**
 * Hook 系统门面类
 * 对外统一 API，封装 registry/planner/runner/aggregator/event-handler
 */

import { HookRegistry } from "./registry.ts";
import { HookPlanner } from "./planner.ts";
import { HookRunner } from "./runner.ts";
import { HookAggregator } from "./aggregator.ts";
import { HookEventHandler } from "./event-handler.ts";
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

  constructor() {
    this.registry = new HookRegistry();
    this.planner = new HookPlanner(this.registry);
    this.runner = new HookRunner();
    this.aggregator = new HookAggregator();
    this.eventHandler = new HookEventHandler(
      this.planner,
      this.runner,
      this.aggregator,
    );
  }

  /** 从旧格式配置初始化（向后兼容） */
  initializeFromLegacy(legacyHooks: LegacyHooksConfig): void {
    this.registry.initializeFromLegacy(legacyHooks);
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
    if (!legacy.command) return null;
    return {
      type: "command",
      command: legacy.command,
      timeout: legacy.timeout,
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

  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolUseFailureEvent(toolName, toolInput, error, toolUseId);
  }

  async fireUserPromptSubmitEvent(prompt: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireUserPromptSubmitEvent(prompt);
  }

  async fireAfterAgentEvent(prompt: string, promptResponse: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireAfterAgentEvent(prompt, promptResponse);
  }

  async fireBeforeModelEvent(
    llmRequest: BeforeModelInput["llm_request"],
    options?: { harness_context?: import("./types.ts").HarnessHookContext },
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
}
