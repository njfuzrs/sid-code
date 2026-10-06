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
  type HookConfig,
  resolveHookTimeoutMs,
  sessionEndBudgetMs,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";
import { getIdentity } from "../identity/index.ts";
import { finalizeGuardrailSession } from "../analytics/events.ts";

/**
 * P0-1：本进程的 sid-code 版本号（裸 x.y.z），供 SessionStart/End 两端携带。
 *
 * 在事件层填而不是只在 collector 里兜底：外部 hook 脚本也是这两个事件的消费方，
 * 它们同样需要知道"这条事件出自哪个版本"。只在 collector 填的话，
 * hook 侧永远看不到版本，等于把维度锁死在内部一个消费者里。
 *
 * env 覆盖与 `analytics/metadata.ts` / `trace/collector.ts` 保持同一口径
 * （灰度/回放时手动打标）。
 */
function appVersion(): string {
  return process.env.SID_CODE_VERSION ?? getRawVersion();
}

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
   * HC11：权限模式 / 对话记录路径的取值函数（app 层注入）。用 getter 不用 setter：
   * 权限模式在 app 里至少 4 处被改写（plan 进出、Shift+Tab、CLAUDE.md 规则），
   * setter 漏接一处就是 stdin 里一个过期值——原先 setPermissionMode 生产零调用，字段恒缺失。
   */
  private permissionModeProvider?: () => string | undefined;
  private transcriptPathProvider?: (sessionId: string) => string | undefined;
  /** HC11：本轮 prompt_id，每次 UserPromptSubmit 换新 */
  private promptId?: string;
  /**
   * registry 引用，仅用于 once hook 回标（executeHooks 里按 plan.entries 下标标记已执行）。
   * 可选：老调用点不传时 once 语义退化为「不失效」，与历史行为一致，不会报错。
   */
  private readonly registry?: HookRegistry;
  /**
   * 已派发过 SessionEnd 的会话 ID（防重入，2026-10-06）。
   *
   * 一个会话只该有一个终态。实测会话 20261005-234012-b45f9ea6：关终端 → SIGHUP 处理器派发
   * SessionEnd(abort)；22ms 后卸载 TUI 往已死的终端写 → EIO → uncaughtException →
   * emergencySessionEnd 再派发 SessionEnd(error)。events.jsonl 里两条 SessionEnd，
   * 后一条把 `.traj` 的 exit_status 从 abort 覆盖成 error——用户关窗口被记成了运行时崩溃。
   * 第一条才是因，后面的都是退出过程的连带后果，故**先到者为准**。
   * 按 sessionId 记而不是一个布尔：/clear 换新会话（setSessionId）后新会话仍须能正常收尾。
   */
  private readonly sessionEndFired = new Set<string>();

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

  setPermissionModeProvider(fn: (() => string | undefined) | undefined): void {
    this.permissionModeProvider = fn;
  }

  /** 会话对话记录路径按当前 sessionId 算（/clear 换会话后跟着变） */
  setTranscriptPathProvider(fn: ((sessionId: string) => string | undefined) | undefined): void {
    this.transcriptPathProvider = fn;
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

  /**
   * PostToolUseFailure 事件
   *
   * `options.duration_ms`：与 firePostToolUseEvent 同字段同语义。缺它会让**失败工具的
   * `execute_tool` span 不带真实耗时**——span 本身在 PostToolUse* 里创建即结束
   * （durationMs ≈ 0），真实耗时只能靠 `sidcode.tool.duration_ms` 属性承载。
   * 于是"成功工具有耗时、失败工具没耗时"，而慢工具超时失败恰恰是最需要看耗时的场景
   * （区分"秒失败"与"卡 30s 才失败"）。options 形态与成功路径保持一致，
   * 便于后续补 harness_context 等字段时不用再改签名。
   */
  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    toolUseId?: string,
    options?: {
      duration_ms?: number;
      harness_context?: import("./types.ts").HarnessHookContext;
      is_interrupt?: boolean;
    },
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUseFailure),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { error },
      is_error: true,
      // HC12：CC 的顶层字段（tool_response.error 保留，存量 sid 脚本照常）
      error,
      is_interrupt: options?.is_interrupt ?? false,
      tool_use_id: toolUseId,
      duration_ms: options?.duration_ms,
      harness_context: options?.harness_context,
    };
    return this.executeHooks(HookEventName.PostToolUseFailure, input, { toolName, toolInput });
  }

  /** UserPromptSubmit 事件 */
  async fireUserPromptSubmitEvent(prompt: string): Promise<AggregatedHookResult> {
    // 新一轮：换 prompt_id，本轮之后的所有事件共用它
    this.promptId = crypto.randomUUID();
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
    options?: {
      model?: string;
      systemPromptHash?: string;
      resumedFrom?: string;
      /** P0-1：一般不传，由本函数填真值；仅测试与回放需要显式覆盖 */
      app_version?: string;
    },
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
      model: options?.model,
      system_prompt_hash: options?.systemPromptHash,
      resumed_from: options?.resumedFrom,
      // P0-1：飞轮维度。四方向第 3 级都是 release-over-release 曲线，版本是唯一分组键。
      app_version: options?.app_version ?? appVersion(),
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
      /** P0-1：一般不传，由本函数填真值；仅测试与回放需要显式覆盖 */
      app_version?: string;
    },
  ): Promise<AggregatedHookResult> {
    if (this.sessionEndFired.has(this.sessionId)) {
      getLogger().warn(
        "HOOK",
        `SessionEnd 已派发过，忽略重复派发（reason=${reason}）——会话终态以首次为准`,
      );
      return emptyResult();
    }
    this.sessionEndFired.add(this.sessionId);
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
      stats,
      harness_summary: options?.harness_summary,
      error: options?.error,
      // P0-1：两端都记。版本在一个进程内恒定，两端都写是为了让**只有 SessionEnd 存活**
      // 的会话也能归因 —— 实测 SessionStart 55 : SessionEnd 25，两侧都有缺失。
      app_version: options?.app_version ?? appVersion(),
    };
    // M4：护栏误报回填挂在这里，不挂 graceful-shutdown（Ctrl+C 不走那条，R5）。
    try {
      finalizeGuardrailSession(reason);
    } catch {
      /* 遥测旁路 */
    }
    return this.executeHooks(HookEventName.SessionEnd, input, { trigger: reason });
  }

  /** PreCompact 事件 */
  async firePreCompactEvent(
    trigger: PreCompactInput["trigger"] = "auto",
  ): Promise<AggregatedHookResult> {
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
  async fireStopEvent(
    assistantResponse: string,
    stopHookActive: boolean = false,
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...this.createBaseInput(HookEventName.Stop),
      assistant_response: assistantResponse,
      last_assistant_message: assistantResponse,
      stop_hook_active: stopHookActive,
    };
    return this.executeHooks(HookEventName.Stop, input);
  }

  /** StopFailure 事件：API 错误导致的非正常结束 */
  async fireStopFailureEvent(
    error: string,
    errorType: StopFailureInput["error_type"],
  ): Promise<AggregatedHookResult> {
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
  async fireSetupEvent(
    trigger: SetupInput["trigger"],
    projectDir: string,
  ): Promise<AggregatedHookResult> {
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
    // H21 同源：PermissionRequest 有 tool_input，`if` / 工具名 matcher 在它上面本该可用（types.ts 的
    // HookDefinition.if 文档列了它），但原先不传 context，配了 if 的 PermissionRequest hook 永不命中。
    return this.executeHooks(HookEventName.PermissionRequest, input, { toolName, toolInput });
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
  async fireConfigChangeEvent(
    changedKeys: string[],
    source: ConfigChangeInput["source"],
  ): Promise<AggregatedHookResult> {
    const input: ConfigChangeInput = {
      ...this.createBaseInput(HookEventName.ConfigChange),
      changed_keys: changedKeys,
      source,
    };
    return this.executeHooks(HookEventName.ConfigChange, input);
  }

  /** FileChanged 事件 */
  async fireFileChangedEvent(
    filePath: string,
    changeType: FileChangedInput["change_type"],
  ): Promise<AggregatedHookResult> {
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
  async fireTaskCreatedEvent(
    taskId: string,
    taskDescription: string,
  ): Promise<AggregatedHookResult> {
    const input: TaskCreatedInput = {
      ...this.createBaseInput(HookEventName.TaskCreated),
      task_id: taskId,
      task_description: taskDescription,
    };
    return this.executeHooks(HookEventName.TaskCreated, input);
  }

  /** TaskCompleted 事件 */
  async fireTaskCompletedEvent(
    taskId: string,
    taskDescription: string,
    success: boolean,
    result?: string,
  ): Promise<AggregatedHookResult> {
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
  async fireInstructionsLoadedEvent(
    sources: string[],
    totalChars?: number,
  ): Promise<AggregatedHookResult> {
    const input: InstructionsLoadedInput = {
      ...this.createBaseInput(HookEventName.InstructionsLoaded),
      sources,
      total_chars: totalChars,
    };
    return this.executeHooks(HookEventName.InstructionsLoaded, input);
  }

  /** G11：TeammateIdle 事件——团队代理空闲时（可 block） */
  async fireTeammateIdleEvent(
    teammateId: string,
    teammateName?: string,
    idleMs?: number,
  ): Promise<AggregatedHookResult> {
    const input: TeammateIdleInput = {
      ...this.createBaseInput(HookEventName.TeammateIdle),
      teammate_id: teammateId,
      teammate_name: teammateName,
      idle_ms: idleMs,
    };
    return this.executeHooks(HookEventName.TeammateIdle, input);
  }

  /** G11：Elicitation 事件——hook 反向向用户提问（需配套 UI，先占位） */
  async fireElicitationEvent(
    message: string,
    requestedSchema?: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
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

      // H6/H7：曾有一条「全部是 runtime hook 就直接 await action(input)」的快速路径，号称跳过 aggregator 开销。
      // 它实际跳过的是 runner.executeRuntimeHook 的整条管线：返回值（含 deny）被丢、timeout 不读、
      // AbortSignal 不传、异常不隔离、耗时不记——而结论还取决于同事件上有没有别的非 runtime hook。
      // 省下的只是一次对象构造，所以删掉，runtime hook 与其他类型走同一条路。别加回来。

      // 2. 执行 hook（根据计划决定串行/并行）
      // HC20：SessionEnd 所有用户 hook 共享一个预算（缺省 1.5s，显式 timeout 可提高，上限 60s），
      // 与 CC 一致——退出路径上不能让一个慢 hook 把关窗口卡住。runtime（轨迹 / 遥测落盘）不受此限。
      const configs =
        eventName === HookEventName.SessionEnd
          ? applySessionEndBudget(plan.hookConfigs)
          : plan.hookConfigs;
      const results = plan.sequential
        ? await this.runner.executeHooksSequential(configs, eventName, input)
        : await this.runner.executeHooksParallel(configs, eventName, input);

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
    const ident = getIdentity();
    const mode = this.permissionModeProvider?.() ?? this.permissionMode;
    return {
      session_id: this.sessionId,
      cwd: this.cwd,
      hook_event_name: eventName,
      timestamp: new Date().toISOString(),
      permission_mode: toCcPermissionMode(mode),
      sid_permission_mode: mode || undefined,
      transcript_path: this.sessionId ? this.transcriptPathProvider?.(this.sessionId) : undefined,
      prompt_id: this.promptId,
      device_id: ident.deviceId,
      user_id: ident.userId,
      org_id: ident.orgId,
      team_id: ident.teamId,
    };
  }

  /** 日志记录 */
  private logExecution(
    eventName: HookEventName,
    results: Array<{ success: boolean; duration: number; error?: Error }>,
    aggregated: AggregatedHookResult,
  ): void {
    const log = getLogger();
    const failed = results.filter((r) => !r.success);
    const successCount = results.length - failed.length;

    if (failed.length > 0) {
      log.warn(
        "HOOK",
        `[${eventName}] ${successCount} 成功, ${failed.length} 失败, 耗时 ${aggregated.totalDuration}ms`,
      );
      for (const err of aggregated.errors) {
        log.debug("HOOK", `  失败详情: ${err.message}`);
      }
    } else if (results.length > 0) {
      log.debug(
        "HOOK",
        `[${eventName}] ${successCount} 个 hook 执行成功, 耗时 ${aggregated.totalDuration}ms`,
      );
    }
  }
}

/**
 * sid 权限模式 → CC permission_mode 取值（HC11）。
 * always-allow / dangerously-skip-permissions → bypassPermissions；manual / deny-write → default；
 * 其余同名原样。未设置时返回 undefined（字段被 JSON 丢掉，与之前一致）。
 */
export function toCcPermissionMode(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  switch (mode) {
    case "always-allow":
    case "dangerously-skip-permissions":
      return "bypassPermissions";
    case "manual":
    case "deny-write":
      return "default";
    default:
      return mode;
  }
}

/** SessionEnd 共享预算：把每条用户 hook 的超时压到预算内（runtime 不动） */
export function applySessionEndBudget(configs: HookConfig[]): HookConfig[] {
  const budgetMs = sessionEndBudgetMs(configs);
  return configs.map((c) => {
    if (c.type === "runtime") return c;
    const own = resolveHookTimeoutMs(c, HookEventName.SessionEnd);
    return own <= budgetMs ? c : ({ ...c, timeout: budgetMs / 1000 } as HookConfig);
  });
}
