/**
 * Hook 事件总线
 * 统一触发入口、构建 baseInput、日志记录、协调 planner→runner→aggregator 流程
 */

import { HookPlanner, type HookEventContext } from "./planner.ts";
import { HookRunner } from "./runner.ts";
import { HookAggregator } from "./aggregator.ts";
import type { HookRegistry } from "./registry.ts";
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
  type PostCompactInput,
  type NotificationInput,
  type SubagentStartInput,
  type StopInput,
  type StopFailureInput,
  type SetupInput,
  type PermissionRequestInput,
  type PermissionDeniedInput,
  type ConfigChangeInput,
  type FileChangedInput,
  type CwdChangedInput,
  type TaskCreatedInput,
  type TaskCompletedInput,
  type InstructionsLoadedInput,
  type TeammateIdleInput,
  type ElicitationInput,
  type ElicitationResultInput,
  type AggregatedHookResult,
  type HookExecutionPlan,
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
  /**
   * registry 引用，仅用于 once hook 回标（executeHooks 里按 plan.entries 下标标记已执行）。
   * 可选：老调用点不传时 once 语义退化为「不失效」，与历史行为一致，不会报错。
   */
  private readonly registry?: HookRegistry;

  constructor(
    planner: HookPlanner,
    runner: HookRunner,
    aggregator: HookAggregator,
    sessionId: string = "",
    cwd: string = process.cwd(),
    registry?: HookRegistry,
  ) {
    this.planner = planner;
    this.runner = runner;
    this.aggregator = aggregator;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.registry = registry;
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
    return this.executeHooks(HookEventName.PreToolUse, input, { toolName, toolInput });
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
    return this.executeHooks(HookEventName.PostToolUse, input, { toolName, toolInput });
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
    return this.executeHooks(HookEventName.PostToolUseFailure, input, { toolName, toolInput });
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
    options?: {
      harness_context?: import("./types.ts").HarnessHookContext;
      stream_snapshot_ref?: BeforeModelInput["stream_snapshot_ref"];
    },
  ): Promise<AggregatedHookResult> {
    const input: BeforeModelInput = {
      ...this.createBaseInput(HookEventName.BeforeModel),
      llm_request: llmRequest,
      harness_context: options?.harness_context,
      stream_snapshot_ref: options?.stream_snapshot_ref,
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
    options?: { model?: string; systemPromptHash?: string; resumedFrom?: string },
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
      model: options?.model,
      system_prompt_hash: options?.systemPromptHash,
      resumed_from: options?.resumedFrom,
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
    extra?: { model?: string; provider?: string; description?: string },
  ): Promise<AggregatedHookResult> {
    const input: SubagentStartInput = {
      ...this.createBaseInput(HookEventName.SubagentStart),
      agent_id: agentId,
      agent_type: agentType,
      parent_session_id: parentSessionId,
      ...(extra?.description ? { description: extra.description } : {}),
      ...(extra?.model ? { model: extra.model } : {}),
      ...(extra?.provider ? { provider: extra.provider } : {}),
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

  /** StopFailure 事件：API 错误导致的非正常结束 */
  async fireStopFailureEvent(error: string, errorType: StopFailureInput["error_type"]): Promise<AggregatedHookResult> {
    const input: StopFailureInput = {
      ...this.createBaseInput(HookEventName.StopFailure),
      error,
      error_type: errorType,
    };
    return this.executeHooks(HookEventName.StopFailure, input);
  }

  /** PostCompact 事件：上下文压缩后 */
  async firePostCompactEvent(
    trigger: "manual" | "auto",
    messagesBefore: number,
    messagesAfter: number,
    tokensSaved: number,
  ): Promise<AggregatedHookResult> {
    const input: PostCompactInput = {
      ...this.createBaseInput(HookEventName.PostCompact),
      trigger,
      messages_before: messagesBefore,
      messages_after: messagesAfter,
      tokens_saved: tokensSaved,
    };
    return this.executeHooks(HookEventName.PostCompact, input);
  }

  /** Setup 事件：仓库初始化 */
  async fireSetupEvent(trigger: SetupInput["trigger"], projectDir: string): Promise<AggregatedHookResult> {
    const input: SetupInput = {
      ...this.createBaseInput(HookEventName.Setup),
      trigger,
      project_dir: projectDir,
    };
    return this.executeHooks(HookEventName.Setup, input);
  }

  /** PermissionRequest 事件 */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionMode: string,
  ): Promise<AggregatedHookResult> {
    const input: PermissionRequestInput = {
      ...this.createBaseInput(HookEventName.PermissionRequest),
      tool_name: toolName,
      tool_input: toolInput,
      permission_mode: permissionMode,
    };
    return this.executeHooks(HookEventName.PermissionRequest, input);
  }

  /** PermissionDenied 事件 */
  async firePermissionDeniedEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    denialReason: string,
    denialSource: PermissionDeniedInput["denial_source"],
  ): Promise<AggregatedHookResult> {
    const input: PermissionDeniedInput = {
      ...this.createBaseInput(HookEventName.PermissionDenied),
      tool_name: toolName,
      tool_input: toolInput,
      denial_reason: denialReason,
      denial_source: denialSource,
    };
    return this.executeHooks(HookEventName.PermissionDenied, input);
  }

  /** ConfigChange 事件 */
  async fireConfigChangeEvent(changedKeys: string[], source: ConfigChangeInput["source"]): Promise<AggregatedHookResult> {
    const input: ConfigChangeInput = {
      ...this.createBaseInput(HookEventName.ConfigChange),
      changed_keys: changedKeys,
      source,
    };
    return this.executeHooks(HookEventName.ConfigChange, input);
  }

  /** FileChanged 事件 */
  async fireFileChangedEvent(filePath: string, changeType: FileChangedInput["change_type"]): Promise<AggregatedHookResult> {
    const input: FileChangedInput = {
      ...this.createBaseInput(HookEventName.FileChanged),
      file_path: filePath,
      change_type: changeType,
    };
    return this.executeHooks(HookEventName.FileChanged, input);
  }

  /** CwdChanged 事件 */
  async fireCwdChangedEvent(oldCwd: string, newCwd: string): Promise<AggregatedHookResult> {
    const input: CwdChangedInput = {
      ...this.createBaseInput(HookEventName.CwdChanged),
      old_cwd: oldCwd,
      new_cwd: newCwd,
    };
    return this.executeHooks(HookEventName.CwdChanged, input);
  }

  /** TaskCreated 事件 */
  async fireTaskCreatedEvent(taskId: string, taskDescription: string): Promise<AggregatedHookResult> {
    const input: TaskCreatedInput = {
      ...this.createBaseInput(HookEventName.TaskCreated),
      task_id: taskId,
      task_description: taskDescription,
    };
    return this.executeHooks(HookEventName.TaskCreated, input);
  }

  /** TaskCompleted 事件 */
  async fireTaskCompletedEvent(taskId: string, taskDescription: string, success: boolean, result?: string): Promise<AggregatedHookResult> {
    const input: TaskCompletedInput = {
      ...this.createBaseInput(HookEventName.TaskCompleted),
      task_id: taskId,
      task_description: taskDescription,
      success,
      result,
    };
    return this.executeHooks(HookEventName.TaskCompleted, input);
  }

  /** G11：InstructionsLoaded 事件——指令（CLAUDE.md / rules）加载到上下文时 */
  async fireInstructionsLoadedEvent(sources: string[], totalChars?: number): Promise<AggregatedHookResult> {
    const input: InstructionsLoadedInput = {
      ...this.createBaseInput(HookEventName.InstructionsLoaded),
      sources,
      total_chars: totalChars,
    };
    return this.executeHooks(HookEventName.InstructionsLoaded, input);
  }

  /** G11：TeammateIdle 事件——团队代理空闲时（可 block） */
  async fireTeammateIdleEvent(teammateId: string, teammateName?: string, idleMs?: number): Promise<AggregatedHookResult> {
    const input: TeammateIdleInput = {
      ...this.createBaseInput(HookEventName.TeammateIdle),
      teammate_id: teammateId,
      teammate_name: teammateName,
      idle_ms: idleMs,
    };
    return this.executeHooks(HookEventName.TeammateIdle, input);
  }

  /** G11：Elicitation 事件——hook 反向向用户提问（需配套 UI，先占位） */
  async fireElicitationEvent(message: string, requestedSchema?: Record<string, unknown>): Promise<AggregatedHookResult> {
    const input: ElicitationInput = {
      ...this.createBaseInput(HookEventName.Elicitation),
      message,
      requestedSchema,
    };
    return this.executeHooks(HookEventName.Elicitation, input);
  }

  /** G11：ElicitationResult 事件——Elicitation 的用户响应结果 */
  async fireElicitationResultEvent(
    action: ElicitationResultInput["action"],
    content?: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    const input: ElicitationResultInput = {
      ...this.createBaseInput(HookEventName.ElicitationResult),
      action,
      content,
    };
    return this.executeHooks(HookEventName.ElicitationResult, input);
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

      // ★ 快速路径：全部是 runtime hook → 直接执行，跳过 aggregator 开销
      const userHooks = plan.hookConfigs.filter(h => h.type !== "runtime");
      if (userHooks.length === 0) {
        for (let i = 0; i < plan.hookConfigs.length; i++) {
          const config = plan.hookConfigs[i];
          if (config.type === "runtime") {
            await config.action(input);
            // runtime hook 无 success 概念，执行即视为成功 → 回标 once
            this.markOnceExecuted(plan, i);
          }
        }
        return emptyResult();
      }

      // 2. 执行 hook（根据计划决定串行/并行）
      const results = plan.sequential
        ? await this.runner.executeHooksSequential(plan.hookConfigs, eventName, input)
        : await this.runner.executeHooksParallel(plan.hookConfigs, eventName, input);

      // 2.5 once hook 回标：执行成功的一次性 hook 标记为已执行，后续计划不再纳入。
      // 对齐 CC registerSkillHooks 的 onHookSuccess → removeSessionHook（只在成功后移除，
      // 失败的 once hook 保留以便下次重试）。runner 按入参顺序返回结果，故下标可对齐。
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.success) this.markOnceExecuted(plan, i);
      }

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

  /**
   * 把计划中第 index 个 hook 对应的 registry 条目标记为「once 已执行」。
   * 非 once 条目在 registry.markOnceExecuted 内部直接短路，此处无需判断。
   */
  private markOnceExecuted(plan: HookExecutionPlan, index: number): void {
    const entry = plan.entries?.[index];
    if (!entry || !entry.once || !this.registry) return;
    this.registry.markOnceExecuted(entry);
    getLogger().debug(
      "HOOK",
      `一次性 hook 已执行，后续不再触发: ${entry.eventName}${entry.skillName ? ` (skill:${entry.skillName})` : ""}`,
    );
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
