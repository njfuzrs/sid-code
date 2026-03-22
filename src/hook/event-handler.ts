/**
 * Hook 事件总线
 * 统一触发入口、构建 baseInput、日志记录、协调 planner→runner→aggregator 流程
 */

import { HookPlanner, type HookEventContext } from "./planner.ts";
import { HookRunner } from "./runner.ts";
import { HookAggregator } from "./aggregator.ts";
import {
  HookEventName,
  type HookInput,
  type PreToolUseInput,
  type PostToolUseInput,
  type UserPromptSubmitInput,
  type AfterAgentInput,
  type BeforeModelInput,
  type AfterModelInput,
  type SessionStartInput,
  type SessionEndInput,
  type PreCompactInput,
  type NotificationInput,
  type AggregatedHookResult,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 空结果（无 hook 匹配时返回） */
function emptyResult(): AggregatedHookResult {
  return { success: true, allOutputs: [], errors: [], totalDuration: 0 };
}

export class HookEventHandler {
  private readonly planner: HookPlanner;
  private readonly runner: HookRunner;
  private readonly aggregator: HookAggregator;
  private sessionId: string;
  private cwd: string;

  constructor(
    planner: HookPlanner,
    runner: HookRunner,
    aggregator: HookAggregator,
    sessionId: string = "",
    cwd: string = process.cwd(),
  ) {
    this.planner = planner;
    this.runner = runner;
    this.aggregator = aggregator;
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  /** 更新会话 ID */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** 更新工作目录 */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  // ============================================================
  // 事件触发方法
  // ============================================================

  /** PreToolUse 事件 */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...this.createBaseInput(HookEventName.PreToolUse),
      tool_name: toolName,
      tool_input: toolInput,
    };
    return this.executeHooks(HookEventName.PreToolUse, input, { toolName });
  }

  /** PostToolUse 事件 */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    isError?: boolean,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      is_error: isError,
    };
    return this.executeHooks(HookEventName.PostToolUse, input, { toolName });
  }

  /** PostToolUseFailure 事件 */
  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUseFailure),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { error },
      is_error: true,
    };
    return this.executeHooks(HookEventName.PostToolUseFailure, input, { toolName });
  }

  /** UserPromptSubmit 事件 */
  async fireUserPromptSubmitEvent(prompt: string): Promise<AggregatedHookResult> {
    const input: UserPromptSubmitInput = {
      ...this.createBaseInput(HookEventName.UserPromptSubmit),
      prompt,
    };
    return this.executeHooks(HookEventName.UserPromptSubmit, input);
  }

  /** AfterAgent 事件 */
  async fireAfterAgentEvent(prompt: string, promptResponse: string): Promise<AggregatedHookResult> {
    const input: AfterAgentInput = {
      ...this.createBaseInput(HookEventName.AfterAgent),
      prompt,
      prompt_response: promptResponse,
    };
    return this.executeHooks(HookEventName.AfterAgent, input);
  }

  /** BeforeModel 事件 */
  async fireBeforeModelEvent(llmRequest: BeforeModelInput["llm_request"]): Promise<AggregatedHookResult> {
    const input: BeforeModelInput = {
      ...this.createBaseInput(HookEventName.BeforeModel),
      llm_request: llmRequest,
    };
    return this.executeHooks(HookEventName.BeforeModel, input);
  }

  /** AfterModel 事件 */
  async fireAfterModelEvent(
    llmRequest: AfterModelInput["llm_request"],
    llmResponse: AfterModelInput["llm_response"],
  ): Promise<AggregatedHookResult> {
    const input: AfterModelInput = {
      ...this.createBaseInput(HookEventName.AfterModel),
      llm_request: llmRequest,
      llm_response: llmResponse,
    };
    return this.executeHooks(HookEventName.AfterModel, input);
  }

  /** SessionStart 事件 */
  async fireSessionStartEvent(source: SessionStartInput["source"] = "startup"): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
    };
    return this.executeHooks(HookEventName.SessionStart, input, { trigger: source });
  }

  /** SessionEnd 事件 */
  async fireSessionEndEvent(reason: SessionEndInput["reason"] = "exit"): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
    };
    return this.executeHooks(HookEventName.SessionEnd, input, { trigger: reason });
  }

  /** PreCompact 事件 */
  async firePreCompactEvent(trigger: PreCompactInput["trigger"] = "auto"): Promise<AggregatedHookResult> {
    const input: PreCompactInput = {
      ...this.createBaseInput(HookEventName.PreCompact),
      trigger,
    };
    return this.executeHooks(HookEventName.PreCompact, input, { trigger });
  }

  /** SubagentStop 事件 */
  async fireSubagentStopEvent(details?: Record<string, unknown>): Promise<AggregatedHookResult> {
    const input: HookInput = {
      ...this.createBaseInput(HookEventName.SubagentStop),
      ...(details || {}),
    } as HookInput;
    return this.executeHooks(HookEventName.SubagentStop, input);
  }

  /** Notification 事件 */
  async fireNotificationEvent(
    notificationType: string,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...this.createBaseInput(HookEventName.Notification),
      notification_type: notificationType,
      message,
      details,
    };
    return this.executeHooks(HookEventName.Notification, input);
  }

  // ============================================================
  // 核心执行流程
  // ============================================================

  /** 执行 hook：planner → runner → aggregator */
  private async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
  ): Promise<AggregatedHookResult> {
    const log = getLogger();

    try {
      // 1. 创建执行计划
      const plan = this.planner.createExecutionPlan(eventName, context);
      if (!plan || plan.hookConfigs.length === 0) {
        return emptyResult();
      }

      // 2. 执行 hook（根据计划决定串行/并行）
      const results = plan.sequential
        ? await this.runner.executeHooksSequential(plan.hookConfigs, eventName, input)
        : await this.runner.executeHooksParallel(plan.hookConfigs, eventName, input);

      // 3. 聚合结果
      const aggregated = this.aggregator.aggregateResults(results, eventName);

      // 4. 日志
      this.logExecution(eventName, results, aggregated);

      return aggregated;
    } catch (error) {
      log.error("HOOK", `事件处理异常 [${eventName}]: ${error}`);
      return {
        success: false,
        allOutputs: [],
        errors: [error instanceof Error ? error : new Error(String(error))],
        totalDuration: 0,
      };
    }
  }

  /** 构建基础输入 */
  private createBaseInput(eventName: HookEventName): HookInput {
    return {
      session_id: this.sessionId,
      cwd: this.cwd,
      hook_event_name: eventName,
      timestamp: new Date().toISOString(),
    };
  }

  /** 日志记录 */
  private logExecution(
    eventName: HookEventName,
    results: Array<{ success: boolean; duration: number; error?: Error }>,
    aggregated: AggregatedHookResult,
  ): void {
    const log = getLogger();
    const failed = results.filter(r => !r.success);
    const successCount = results.length - failed.length;

    if (failed.length > 0) {
      log.warn("HOOK", `[${eventName}] ${successCount} 成功, ${failed.length} 失败, 耗时 ${aggregated.totalDuration}ms`);
      for (const err of aggregated.errors) {
        log.debug("HOOK", `  失败详情: ${err.message}`);
      }
    } else if (results.length > 0) {
      log.debug("HOOK", `[${eventName}] ${successCount} 个 hook 执行成功, 耗时 ${aggregated.totalDuration}ms`);
    }
  }
}
