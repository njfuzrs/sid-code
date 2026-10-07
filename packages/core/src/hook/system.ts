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
import { HookEventName, ConfigSource } from "./types.ts";
import { extractHookContext } from "./context-inject.ts";
import type { HooksConfig as LegacyHooksConfig } from "../config/config.ts";
import type { HookDiagnostic, NormalizeContext } from "./config-normalize.ts";
import type {
  HookConfig,
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
  /** clear / compact 后重发 SessionStart 得到的上下文，待下一条用户消息注入 */
  private pendingSessionContext: string[] = [];

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

  /** HC1：按来源分层初始化（user / project / local / managed 各自带 source，按事件追加） */
  initializeFromSources(
    layers: Array<{ hooks: unknown; source: ConfigSource; ctx?: NormalizeContext }>,
  ): HookDiagnostic[] {
    return this.registry.initializeFromSources(layers);
  }

  /** 归一化并注册一份 hooks 配置（skill / agent frontmatter 用） */
  addNormalizedHooks(
    raw: unknown,
    source: ConfigSource,
    ctx?: NormalizeContext,
    meta?: { skillName?: string; hookScope?: string },
  ): HookDiagnostic[] {
    return this.registry.addNormalized(raw, source, ctx, meta);
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

  /** 编程式注册 hook */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; if?: string; sequential?: boolean; source?: ConfigSource },
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
    options: { matcher?: string; skillName: string; once?: boolean; scope?: string },
  ): void {
    this.registry.registerSessionHook(config, eventName, options);
  }

  /**
   * 移除指定 Skill 注册的会话级 hook，返回移除数量。
   * 传 scope 时只删该次调用注册的那一批（P1-6：调用作用域卸载不能按名字删）。
   */
  removeSkillHooks(skillName: string, scope?: string): number {
    return this.registry.removeSkillHooks(skillName, scope);
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

  /**
   * 订阅 hook 开始 / 结束（statusMessage 的显示出口，对齐 CC「hook 运行时显示的自定义 spinner 消息」）。
   * core 不知道有没有 TUI：由 cli 层订阅并决定显示方式，headless 不订阅即零开销。
   * @returns 取消订阅
   */
  onHookLifecycle(listener: import("./runner.ts").HookLifecycleListener): () => void {
    return this.runner.addLifecycleListener(listener);
  }

  /** G6：注入 agent hook 的真子代理执行器（由 app 层携带工具注册表设置）。 */
  setAgentHookExecutor(executor: import("./runner.ts").AgentHookExecutor | undefined): void {
    this.runner.setAgentHookExecutor(executor);
  }

  /** 设置当前权限模式（app 层在初始化与每次切换处调用，HC11） */
  setPermissionMode(mode: string): void {
    this.eventHandler.setPermissionMode(mode);
  }

  /** 权限模式取值函数（stdin permission_mode，HC11）；优先于 setPermissionMode */
  setPermissionModeProvider(fn: (() => string | undefined) | undefined): void {
    this.eventHandler.setPermissionModeProvider(fn);
  }

  /** 会话对话记录路径取值函数（stdin transcript_path，HC11） */
  setTranscriptPathProvider(fn: ((sessionId: string) => string | undefined) | undefined): void {
    this.eventHandler.setTranscriptPathProvider(fn);
  }

  /** 设置会话启动时的项目根（CLAUDE_PROJECT_DIR，不随 cd 变，HC14） */
  setProjectDir(dir: string): void {
    this.runner.setProjectDir(dir);
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
  replacePluginHooks(
    pluginHooks:
      | LegacyHooksConfig
      | Array<{ hooks: unknown; pluginRoot?: string; pluginData?: string; name?: string }>,
  ): HookDiagnostic[] {
    // 1. 清除所有 source === Plugin 的已注册 hook
    this.registry.removeBySource(ConfigSource.Plugin);

    // 2. 注册新的插件 hooks——经唯一归一化层（HC3）。每个插件带自己的根目录：
    //    路径变量由 runner 导出为环境变量，不再往命令串里拼路径（原 loadPluginHooks 的字符串替换，H14 同型）。
    const layers = Array.isArray(pluginHooks) ? pluginHooks : [{ hooks: pluginHooks }];
    const diagnostics: HookDiagnostic[] = [];
    for (const layer of layers) {
      diagnostics.push(
        ...this.registry.addNormalized(layer.hooks, ConfigSource.Plugin, {
          pathPrefix: layer.name ? `plugin:${layer.name}.hooks` : "plugin.hooks",
          pluginRoot: layer.pluginRoot,
          pluginData: layer.pluginData,
        }),
      );
    }
    return diagnostics;
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
    return this.eventHandler.firePostToolUseEvent(
      toolName,
      toolInput,
      toolResponse,
      isError,
      toolUseId,
      options,
    );
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
      is_interrupt?: boolean;
      failure_kind?: import("./types.ts").ToolFailureKind;
      tool_output?: unknown;
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
    options?: {
      model?: string;
      systemPromptHash?: string;
      resumedFrom?: string;
      /** P0-1：一般不传，由 event-handler 填真实版本号；仅测试/回放需显式覆盖 */
      app_version?: string;
      /** clear / compact 的二次 SessionStart：只跑用户 hook，不送 runtime */
      userOnly?: boolean;
    },
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSessionStartEvent(source, options);
  }

  /**
   * HC12 / HC16：/clear 与压缩之后重发 SessionStart（source=clear / compact，对齐 CC），
   * 让「SessionStart 注入项目上下文」的 hook 在上下文被清空 / 压掉之后重新注入。
   *
   * 只跑用户 hook（userOnly）：collector / hook-probe 把 SessionStart 当开新轨迹。
   * 返回的上下文暂存在这里，由 QueryEngine 在下一条用户消息时取走（takePendingSessionContext）——
   * 放在 HookSystem 而不是让三条压缩路径各自去找 engine：压缩收尾模块不持有 engine，
   * 而 hookSystem 是三条路径（auto / manual / reactive·collapse）都已经传进来的唯一依赖。
   */
  async fireSessionRestartEvent(source: "clear" | "compact", model?: string): Promise<void> {
    // /clear 之后，clear 之前还没用掉的上下文属于已被清空的对话，丢弃
    if (source === "clear") this.pendingSessionContext = [];
    const result = await this.eventHandler.fireSessionStartEvent(source, { model, userOnly: true });
    const text = extractHookContext(result);
    if (text) this.pendingSessionContext.push(text);
  }

  /** 取走 clear / compact 后待注入的 SessionStart 上下文（取一次即清空） */
  takePendingSessionContext(): string | undefined {
    if (this.pendingSessionContext.length === 0) return undefined;
    const text = this.pendingSessionContext.join("\n");
    this.pendingSessionContext = [];
    return text;
  }

  async fireSessionEndEvent(
    reason: SessionEndInput["reason"] = "exit",
    stats?: SessionEndInput["stats"],
    options?: {
      harness_summary?: import("./types.ts").HarnessSessionSummary;
      error?: { message: string; name?: string; stack?: string };
      /** P0-1：一般不传，由 event-handler 填真实版本号；仅测试/回放需显式覆盖 */
      app_version?: string;
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
  async fireStopEvent(
    assistantResponse: string,
    stopHookActive: boolean = false,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireStopEvent(assistantResponse, stopHookActive);
  }

  /** StopFailure 事件 */
  async fireStopFailureEvent(
    error: string,
    errorType: import("./types.ts").StopFailureInput["error_type"],
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireStopFailureEvent(error, errorType);
  }

  /** PostCompact 事件 */
  async firePostCompactEvent(
    trigger: "manual" | "auto",
    messagesBefore: number,
    messagesAfter: number,
    tokensSaved: number,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostCompactEvent(
      trigger,
      messagesBefore,
      messagesAfter,
      tokensSaved,
    );
  }

  /** Setup 事件 */
  async fireSetupEvent(
    trigger: "first_run" | "dependency_change" | "manual",
    projectDir: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireSetupEvent(trigger, projectDir);
  }

  /** PermissionRequest 事件 */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionMode: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePermissionRequestEvent(toolName, toolInput, permissionMode);
  }

  /** PermissionDenied 事件 */
  async firePermissionDeniedEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    denialReason: string,
    denialSource: "user" | "rule" | "hook" | "auto",
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePermissionDeniedEvent(
      toolName,
      toolInput,
      denialReason,
      denialSource,
      toolUseId,
    );
  }

  /** ConfigChange 事件 */
  async fireConfigChangeEvent(
    changedKeys: string[],
    source: import("./types.ts").ConfigChangeInput["source"],
    filePath?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireConfigChangeEvent(changedKeys, source, filePath);
  }

  /** FileChanged 事件 */
  async fireFileChangedEvent(
    filePath: string,
    changeType: "created" | "modified" | "deleted",
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireFileChangedEvent(filePath, changeType);
  }

  /** CwdChanged 事件 */
  async fireCwdChangedEvent(oldCwd: string, newCwd: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireCwdChangedEvent(oldCwd, newCwd);
  }

  /** TaskCreated 事件 */
  async fireTaskCreatedEvent(
    taskId: string,
    taskDescription: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTaskCreatedEvent(taskId, taskDescription);
  }

  /** TaskCompleted 事件 */
  async fireTaskCompletedEvent(
    taskId: string,
    taskDescription: string,
    success: boolean,
    result?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTaskCompletedEvent(taskId, taskDescription, success, result);
  }

  /** G11：InstructionsLoaded 事件——指令（CLAUDE.md / rules）加载到上下文时 */
  async fireInstructionsLoadedEvent(
    sources: string[],
    totalChars?: number,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireInstructionsLoadedEvent(sources, totalChars);
  }

  /** G11：TeammateIdle 事件——团队代理空闲时（可 block） */
  async fireTeammateIdleEvent(
    teammateId: string,
    teammateName?: string,
    idleMs?: number,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireTeammateIdleEvent(teammateId, teammateName, idleMs);
  }

  /** G11：Elicitation 事件——hook 反向向用户提问（需配套 UI，先占位） */
  async fireElicitationEvent(
    message: string,
    requestedSchema?: Record<string, unknown>,
    serverName?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireElicitationEvent(message, requestedSchema, serverName);
  }

  /** G11：ElicitationResult 事件——Elicitation 的用户响应结果 */
  async fireElicitationResultEvent(
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
    serverName?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireElicitationResultEvent(action, content, serverName);
  }

  /** PostToolBatch 事件 */
  async firePostToolBatchEvent(
    toolCalls: Array<{ tool_name: string; tool_use_id: string; is_error: boolean }>,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.firePostToolBatchEvent(toolCalls);
  }

  /** PreModelSwitch 事件（拆成两个方法名：参考页按 fire<Event>Event 调用点判定是否接线） */
  async firePreModelSwitchEvent(
    fromModel: string,
    toModel: string,
    trigger: import("./types.ts").ModelSwitchInput["trigger"],
    reason?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireModelSwitchEvent("pre", fromModel, toModel, trigger, reason);
  }

  /** PostModelSwitch 事件（含降级链自动切换） */
  async firePostModelSwitchEvent(
    fromModel: string,
    toModel: string,
    trigger: import("./types.ts").ModelSwitchInput["trigger"],
    reason?: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireModelSwitchEvent("post", fromModel, toModel, trigger, reason);
  }

  /** UserPromptExpansion 事件 */
  async fireUserPromptExpansionEvent(
    commandName: string,
    originalPrompt: string,
    expandedPrompt: string,
  ): Promise<AggregatedHookResult> {
    return this.eventHandler.fireUserPromptExpansionEvent(
      commandName,
      originalPrompt,
      expandedPrompt,
    );
  }

  /** DirectoryAdded 事件 */
  async fireDirectoryAddedEvent(directory: string): Promise<AggregatedHookResult> {
    return this.eventHandler.fireDirectoryAddedEvent(directory);
  }
}
