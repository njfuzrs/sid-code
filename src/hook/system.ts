/**
 * Hook 系统门面类
 * 对外统一 API，封装 registry/planner/runner/aggregator/event-handler
 */

import { HookRegistry } from "./registry.ts";
import { HookPlanner } from "./planner.ts";
import { HookRunner } from "./runner.ts";
import { HookAggregator } from "./aggregator.ts";
import { HookEventHandler } from "./event-handler.ts";
import type { HooksConfig as LegacyHooksConfig } from "../config/config.ts";
import type {
  HookConfig,
  HookEventName,
  NewHooksConfig,
  ConfigSource,
  AggregatedHookResult,
  HookRegistryEntry,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

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

  /** 启用/禁用指定 hook */
  setHookEnabled(hookName: string, enabled: boolean): void {
    this.registry.setHookEnabled(hookName, enabled);
  }

  /** 启用/禁用所有 hook */
  setAllEnabled(enabled: boolean): void {
    this.registry.setAllEnabled(enabled);
  }

  /** 获取所有 hook（用于管理命令） */
  getAllHooks(): HookRegistryEntry[] {
    return this.registry.getAllHooks();
  }

  // ============================================================
  // 便捷方法：直接触发事件（委托给 eventHandler）
  // ============================================================

  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePreToolUseEvent(toolName, toolInput);
  }

  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    isError?: boolean,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolUseEvent(toolName, toolInput, toolResponse, isError);
  }

  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolUseFailureEvent(toolName, toolInput, error);
  }

  async fireUserPromptSubmitEvent(prompt: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireUserPromptSubmitEvent(prompt);
  }

  async fireAfterAgentEvent(prompt: string, promptResponse: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireAfterAgentEvent(prompt, promptResponse);
  }

  async fireSessionStartEvent(source: "startup" | "resume" | "clear" = "startup"): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSessionStartEvent(source);
  }

  async fireSessionEndEvent(reason: "exit" | "clear" | "other" = "exit"): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSessionEndEvent(reason);
  }

  async firePreCompactEvent(trigger: "manual" | "auto" = "auto"): Promise<AggregatedHookResult> {
    return this.eventHandler.firePreCompactEvent(trigger);
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
}
