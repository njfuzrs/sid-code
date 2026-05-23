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
  type SubagentStartInput,
  type StopInput,
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
  private permissionMode: string = "";

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

  /** 设置当前权限模式 */
  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
  }

  // ============================================================
  // 事件触发方法
  // ============================================================

  /** PreToolUse 事件 */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...this.createBaseInput(HookEventName.PreToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };
    return this.executeHooks(HookEventName.PreToolUse, input, { toolName });
  }

  /** PostToolUse 事件 */
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
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      is_error: isError,
      tool_use_id: toolUseId,
      duration_ms: options?.duration_ms,
      edit_meta: options?.edit_meta,
      verify_triggered: options?.verify_triggered,
      harness_context: options?.harness_context,
    };
    return this.executeHooks(HookEventName.PostToolUse, input, { toolName });
  }

  /** PostToolUseFailure 事件 */
  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUseFailure),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { error },
      is_error: true,
      tool_use_id: toolUseId,
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
  async fireBeforeModelEvent(
    llmRequest: BeforeModelInput["llm_request"],
    options?: { harness_context?: import("./types.ts").HarnessHookContext },
  ): Promise<AggregatedHookResult> {
    const input: BeforeModelInput = {
      ...this.createBaseInput(HookEventName.BeforeModel),
      llm_request: llmRequest,
      harness_context: options?.harness_context,
    };
    return this.executeHooks(HookEventName.BeforeModel, input);
  }

  /** AfterModel 事件 */
  async fireAfterModelEvent(
    llmRequest: AfterModelInput["llm_request"],
    llmResponse: AfterModelInput["llm_response"],
    options?: { harness_context?: import("./types.ts").HarnessHookContext },
  ): Promise<AggregatedHookResult> {
    const input: AfterModelInput = {
      ...this.createBaseInput(HookEventName.AfterModel),
      llm_request: llmRequest,
      llm_response: llmResponse,
      harness_context: options?.harness_context,
    };
    return this.executeHooks(HookEventName.AfterModel, input);
  }

  /** SessionStart 事件 */
  async fireSessionStartEvent(
    source: SessionStartInput["source"] = "startup",
    options?: { model?: string; systemPromptHash?: string },
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
      model: options?.model,
      system_prompt_hash: options?.systemPromptHash,
    };
    return this.executeHooks(HookEventName.SessionStart, input, { trigger: source });
  }

  /** SessionEnd 事件 */
  async fireSessionEndEvent(
    reason: SessionEndInput["reason"] = "exit",
    stats?: SessionEndInput["stats"],
    options?: {
      harness_summary?: import("./types.ts").HarnessSessionSummary;
      error?: { message: string; name?: string; stack?: string };
    },
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
      stats,
      harness_summary: options?.harness_summary,
      error: options?.error,
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

  /** SubagentStart 事件 */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: string,
    parentSessionId?: string,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStartInput = {
      ...this.createBaseInput(HookEventName.SubagentStart),
      agent_id: agentId,
      agent_type: agentType,
      parent_session_id: parentSessionId,
    };
    return this.executeHooks(HookEventName.SubagentStart, input);
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

  /** Stop 事件：模型 end_turn 后执行检查 */
  async fireStopEvent(assistantResponse: string): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...this.createBaseInput(HookEventName.Stop),
      assistant_response: assistantResponse,
    };
    return this.executeHooks(HookEventName.Stop, input);
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
      permission_mode: this.permissionMode || undefined,
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
