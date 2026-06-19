/**
 * 子代理系统
 * 每个子代理有独立的短上下文，干完活只返回结果
 * 主代理当协调者，spawn 子代理执行子任务，汇总结果
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage } from "../llm/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { validateToolInput } from "../tool/input-validator.ts";
import type { LegacyTool } from "../tool/types.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { FileReadTracker } from "../tool/file-read-tracker.ts";
import { createStatefulTools, STATEFUL_TOOL_NAMES } from "../tool/stateful-tools.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector } from "./loop-detection.ts";
import { filterToolsForAgent } from "./tool-filter.ts";
import { runAgentLoop } from "./agentic-loop.ts";
import { describeToolActivity } from "./progress.ts";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  appendAgentOutput,
  updateAgentProgress,
  updateTask,
} from "../task/index.ts";
import type { AgentTaskResult, LocalAgentTaskState } from "../task/types.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  writeParentMsg,
} from "./sub-agent-protocol.ts";
import { drainAgentMessages } from "./message-queue.ts";
import { getAgentSystemPrompt, getAgentWhenToUse, type AgentDefinition } from "./agent-definition.ts";
import { platform, homedir } from "os";
import { cwd } from "process";

/** 子代理类型 */
export type SubAgentType = "explore" | "task" | "summarize" | "plan" | "verify";

/** 子代理任务定义 */
export interface SubAgentTask {
  type: string;
  description: string;
  prompt: string;
  /** 子代理可用的工具（默认继承主代理的工具） */
  tools?: ToolRegistry;
  /** 子代理最大轮次（默认 10） */
  maxTurns?: number;
  /** 子代理上下文窗口大小（默认 50000） */
  maxTokens?: number;
  /** 超时时间（毫秒，默认 120000） */
  timeout?: number;
  /** 外部预创建的 task ID（后台执行时由 runAsync 预先创建，内部使用） */
  _taskId?: string;
  /** 外部预创建的 AbortController（后台执行时使用） */
  _abortController?: AbortController;
  /** 后台异步执行标记（内部使用）。为 true 时工具过滤额外套用 Layer 4 异步白名单，
   *  把后台子代理可用工具收敛到安全子集（对标 claude-code ASYNC_AGENT_ALLOWED_TOOLS）。 */
  _isAsync?: boolean;
}

/** 子代理执行结果 */
export interface SubAgentResult {
  success: boolean;
  output: string;
  usage: Usage;
  turns: number;
  /** 工具调用次数（用于构造结构化 AgentTaskResult） */
  toolUseCount: number;
  /**
   * 子代理实际使用的模型名（P0-1：子代理可能用不同 subAgentModel，
   * 归集到主会话计费时需按此 model 分别计价，而非主模型）。
   */
  model?: string;
  /** 子代理实际使用的 provider 名（计费口径区分，缺省时由 model 推断） */
  provider?: string;
}

/** 子代理系统提示词（从 AgentDefinition 注册表获取，兼容内置 + 自定义类型） */
function getSystemPrompt(type: string): string {
  return getAgentSystemPrompt(type) ?? `你是一个 ${type} 代理。完成指定任务并返回结果。\n规则：\n- 专注于完成指定任务\n- 完成后简洁地报告完成状态和关键输出`;
}

/**
 * 增强子代理系统提示词（L4，对标 Claude Code enhanceSystemPromptWithEnvDetails）
 *
 * 注入语言铁律、环境信息到子代理的基础系统提示词中。
 * 从硬编码改为统一增强函数，语言规则从主代理配置继承。
 */
async function enhanceSubAgentPrompt(
  basePrompt: string,
  preferredLanguage?: "zh" | "en",
  workingDir?: string,
): Promise<string> {
  const notes: string[] = [];

  // 语言铁律（对标 Claude Code getLanguageSection）
  if (preferredLanguage === "zh" || preferredLanguage === undefined) {
    notes.push(
      "【最高优先级铁律】你的所有输出和思考必须使用中文。" +
        "代码和路径可保持原文，但解释和推理必须用中文。",
    );
  } else if (preferredLanguage === "en") {
    notes.push(
      "【最高优先级铁律】你的所有输出和思考必须使用英文。" +
        "代码和路径可保持原文，但解释和推理必须用英文。",
    );
  }

  // 环境信息
  const dir = workingDir ?? cwd();
  const home = homedir();
  const os = platform();
  const date = new Date().toISOString().split("T")[0];
  notes.push(`当前工作目录: ${dir}`);
  notes.push(`用户主目录: ${home}`);
  notes.push(`操作系统: ${os}`);
  notes.push(`当前日期: ${date}`);

  return `${basePrompt}\n\n---\n\n${notes.join("\n")}`;
}

/** 自定义子代理任务（Skills/Agents 用） */
export interface CustomSubAgentTask {
  systemPrompt: string;
  userPrompt: string;
  allowedTools: string[];
  maxTurns?: number;
  maxTokens?: number;
  timeout?: number;
}

export class SubAgent {
  private provider: Provider;
  private model: string;
  private toolRegistry: ToolRegistry;
  private hookSystem?: HookSystem;
  /** ProviderRegistry 引用（fromRegistry 创建时设置） */
  private registry?: ProviderRegistry;
  /** 模型覆盖（自定义 Agent/Skill 指定模型时使用） */
  private modelOverride?: string;
  /** 输出语言偏好（L4，从主代理配置继承） */
  private language?: "zh" | "en";

  /** Spawn 模式配置（子进程启动所需的 Provider 信息） */
  private spawnConfig?: { providerName: string; apiKey: string; baseURL?: string };

  constructor(provider: Provider, model: string, toolRegistry: ToolRegistry, hookSystem?: HookSystem) {
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.hookSystem = hookSystem;
  }

  /** 从 ProviderRegistry 创建（子代理类型决定 model/provider） */
  static fromRegistry(
    registry: ProviderRegistry,
    toolRegistry: ToolRegistry,
    hookSystem?: HookSystem,
    modelOverride?: string,
  ): SubAgent {
    // 用主 provider/model 初始化（executeInner 中会动态替换）
    const provider = registry.getProvider();
    const model = modelOverride || registry.getCurrentModel();
    const agent = new SubAgent(provider, model, toolRegistry, hookSystem);
    agent.registry = registry;
    agent.modelOverride = modelOverride;
    agent.language = registry.getLanguage();
    // 保存 spawn 配置（用于子进程启动，兼容未实现 getSpawnConfig 的 registry）
    try { agent.spawnConfig = registry.getSpawnConfig?.(); } catch { /* registry 未实现 getSpawnConfig，spawn 模式自动回退 */ }
    return agent;
  }

  /** 解析子代理 ContextManager 的窗口大小（tokens）。
   *  优先级：task.maxTokens 显式值 > 主模型 contextWindow（经 registry 派生）> 历史兜底 50000。
   *  保成功：子代理过去被写死 50000，1M 窗口模型的主代理下，子代理探索大型代码库会过早压缩；
   *  现默认跟随主模型窗口，让子代理拥有与主代理同等的上下文容量。
   *  非法/拿不到时回退 50000，绝不更紧。 */
  private resolveSubAgentWindow(task: { maxTokens?: number }): number {
    if (typeof task.maxTokens === "number" && task.maxTokens > 0) return task.maxTokens;
    try {
      const window = this.registry?.getContextWindow();
      if (typeof window === "number" && window > 0) return window;
    } catch { /* registry 未实现 getContextWindow 或派生失败，回退兜底 */ }
    return 50_000;
  }

  /** 执行子代理任务 */
  async execute(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    // 创建或获取 task 状态（后台执行时由 runAsync 预先创建）
    let taskId: string;
    let abortController: AbortController;
    if (task._taskId && task._abortController) {
      taskId = task._taskId;
      abortController = task._abortController;
    } else {
      const created = createAgentTask({
        agentType: task.type,
        prompt: task.prompt,
        description: task.description,
      });
      taskId = created.taskState.id;
      abortController = created.abortController;
    }

    let result: SubAgentResult;
    try {
      // SubagentStart hook
      this.hookSystem?.fireSubagentStartEvent(
        `subagent-${task.type}-${Date.now()}`,
        task.type,
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式（独立进程，避免 V8 OOM）
      if (this.shouldUseSpawn()) {
        try {
          result = await this.executeSpawned(task, signal, taskId);
          log.info("SUBAGENT", `[${task.type}] spawn 模式完成`);
        } catch (err: any) {
          log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
          result = await this.executeInner(task, signal, taskId);
        }
      } else {
        result = await this.executeInner(task, signal, taskId);
      }

      // 成功：标记任务完成并发送通知（结构化结果）
      if (result.success) {
        const agentResult: AgentTaskResult = {
          output: result.output,
          totalToolUseCount: result.toolUseCount,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          usage: result.usage,
        };
        await completeAgentTask(taskId, agentResult);
      } else {
        await failAgentTask(taskId, result.output);
      }
    } catch (err: any) {
      // 顶层异常兜底
      log.error("SUBAGENT", `[${task.type}] 顶层异常`, { error: err.message });
      await failAgentTask(taskId, err.message).catch(() => {});
      result = {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
    } finally {
      // subagent_stop hook（非阻塞）
      this.hookSystem?.fireSubagentStopEvent({
        toolName: `subagent:${task.type}`,
      }).catch(err => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  /** 执行自定义子代理任务（Skills/Agents 用） */
  async executeCustom(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    let result: SubAgentResult;
    try {
      // SubagentStart hook
      this.hookSystem?.fireSubagentStartEvent(
        `subagent-custom-${Date.now()}`,
        "custom",
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式
      if (this.shouldUseSpawn()) {
        try {
          result = await this.executeSpawnedCustom(task, signal);
          log.info("SUBAGENT", `[custom] spawn 模式完成`);
        } catch (err: any) {
          log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
          result = await this.executeCustomInner(task, signal);
        }
      } else {
        result = await this.executeCustomInner(task, signal);
      }
    } finally {
      // subagent_stop hook（非阻塞）
      this.hookSystem?.fireSubagentStopEvent({
        toolName: "subagent:custom",
      }).catch(err => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  // ============================================================
  // Spawn 模式（Wave 2：进程隔离）
  // ============================================================

  /** 判断是否使用 spawn 模式（可通过环境变量 SIDCODE_NO_SPAWN=1 禁用） */
  private shouldUseSpawn(): boolean {
    if (process.env.SIDCODE_NO_SPAWN === "1") return false;
    if (!this.spawnConfig) return false;
    // 需要 Bun.spawn 可用（Bun 运行时）
    return typeof Bun !== "undefined" && typeof Bun.spawn === "function";
  }

  /** 从工具注册表获取工具定义列表（用于 spawn init 消息） */
  private getToolDefs(task: SubAgentTask): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const sourceRegistry = task.tools ?? this.toolRegistry;
    const allTools = sourceRegistry.all();
    const filteredTools = filterToolsForAgent(allTools, {
      isBuiltIn: true,
      builtInType: task.type,
      isAsync: task._isAsync,
    });
    return filteredTools.map(t => ({
      name: t.name(),
      description: t.description(),
      inputSchema: t.inputSchema(),
    }));
  }

  /** 获取自定义子代理的工具定义 */
  private getCustomToolDefs(allowedTools: string[]): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const filtered = this.toolRegistry.filter(allowedTools);
    return filtered.all().map(t => ({
      name: t.name(),
      description: t.description(),
      inputSchema: t.inputSchema(),
    }));
  }

  /** Spawn 子代理（标准类型） */
  private async executeSpawned(task: SubAgentTask, signal?: AbortSignal, taskId?: string): Promise<SubAgentResult> {
    const basePrompt = getSystemPrompt(task.type);
    const systemPrompt = await enhanceSubAgentPrompt(basePrompt, this.language, process.cwd());
    const toolDefs = this.getToolDefs(task);

    // 计费口径对齐：spawn 模式按子代理类型解析模型 + 对应 provider 配置，
    // 与进程内 executeInner 的 getModelForSubAgent/getProviderForSubAgent 口径一致。
    // 缺省（registry 未实现）回退主模型 + 主 spawn 配置。
    const sc = this.registry?.getSpawnConfigForSubAgent?.(task.type);
    const model = sc?.model ?? this.model;
    const providerName = sc?.providerName ?? this.spawnConfig!.providerName;
    const apiKey = sc?.apiKey ?? this.spawnConfig!.apiKey;
    const baseURL = sc?.baseURL ?? this.spawnConfig?.baseURL;

    const initMsg: ParentInitMessage = {
      type: "init",
      session_id: `subagent-${task.type}-${Date.now()}`,
      task_type: task.type,
      system_prompt: systemPrompt,
      user_prompt: task.prompt,
      allowed_tools: toolDefs.map(t => t.name),
      tool_defs: toolDefs,
      model,
      max_turns: task.maxTurns ?? 10,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 120_000,
      workdir: process.cwd(),
      provider_name: providerName,
      api_key: apiKey,
      base_url: baseURL,
    };

    return this.executeSpawnedInternal(initMsg, task.tools ?? this.toolRegistry, signal, taskId);
  }

  /** Spawn 自定义子代理 */
  private async executeSpawnedCustom(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const enhancedSystemPrompt = await enhanceSubAgentPrompt(task.systemPrompt, this.language, process.cwd());
    const tools = task.allowedTools.length > 0
      ? this.toolRegistry.filter(task.allowedTools)
      : new ToolRegistry();
    const toolDefs = this.getCustomToolDefs(task.allowedTools);

    // 计费口径对齐 executeCustomInner：modelOverride 优先，否则按 "task" 类型解析。
    const sc = this.registry?.getSpawnConfigForSubAgent?.("task");
    const model = this.modelOverride ?? sc?.model ?? this.model;
    const providerName = sc?.providerName ?? this.spawnConfig!.providerName;
    const apiKey = sc?.apiKey ?? this.spawnConfig!.apiKey;
    const baseURL = sc?.baseURL ?? this.spawnConfig?.baseURL;

    const initMsg: ParentInitMessage = {
      type: "init",
      session_id: `subagent-custom-${Date.now()}`,
      task_type: "task", // 自定义代理按 task 类型
      system_prompt: enhancedSystemPrompt,
      user_prompt: task.userPrompt,
      allowed_tools: task.allowedTools,
      tool_defs: toolDefs,
      model,
      max_turns: task.maxTurns ?? 10,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 120_000,
      workdir: process.cwd(),
      provider_name: providerName,
      api_key: apiKey,
      base_url: baseURL,
    };

    return this.executeSpawnedInternal(initMsg, tools, signal);
  }

  /** 核心 spawn 逻辑：启动子进程、通信、超时控制 */
  private async executeSpawnedInternal(
    initMsg: ParentInitMessage,
    tools: ToolRegistry,
    signal?: AbortSignal,
    taskId?: string,
  ): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    const timeout = initMsg.timeout;

    // 构建启动参数
    const spawnArgs = ["run", "src/entrypoints/headless.ts"];
    // 容器环境设堆限制
    const maxOldSpace = process.env.SIDCODE_MAX_OLD_SPACE_SIZE;
    if (maxOldSpace) {
      spawnArgs.unshift(`--max-old-space-size=${maxOldSpace}`);
    }

    log.info("SUBAGENT", `spawn 子进程: bun ${spawnArgs.join(" ")}`);

    // Spawn 子进程
    const subprocess = Bun.spawn(["bun", ...spawnArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: process.cwd(),
      env: { ...process.env },
    });

    // 发送 init 消息
    writeParentMsg(subprocess.stdin, initMsg);

    // 超时控制
    const timeoutId = setTimeout(() => {
      log.warn("SUBAGENT", `spawn 子进程超时 (${Math.round(timeout / 1000)}秒)，kill`);
      if (!subprocess.killed) subprocess.kill();
    }, timeout);

    // 父进程 abort → kill 子进程
    const onAbort = () => {
      log.info("SUBAGENT", "父进程 abort，kill 子进程");
      if (!subprocess.killed) subprocess.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // 读取子进程 stdout 消息循环
      const stdoutReader = subprocess.stdout.getReader();
      const decoder = new TextDecoder();
      let stdoutBuffer = "";
      let result: SubAgentResult | null = null;

      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        stdoutBuffer += decoder.decode(value, { stream: true });
        // 按行分割
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || ""; // 保留不完整的最后一行

        for (const line of lines) {
          if (!line.trim()) continue;

          let msg: ChildMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            log.warn("SUBAGENT", `子进程 stdout 非 JSON: ${line.slice(0, 100)}`);
            continue;
          }

          switch (msg.type) {
            case "ready":
              break;

            case "tool_use": {
              // 父进程执行工具并返回结果
              const toolResult = await this.executeToolForChild(
                msg.name,
                msg.input,
                tools,
                signal,
              );
              writeParentMsg(subprocess.stdin, {
                type: "tool_result",
                tool_use_id: msg.id,
                content: toolResult.content,
                is_error: toolResult.is_error,
              });
              break;
            }

            case "progress":
              // 实时进度回写：spawn 子进程每轮上报真实 token / 工具次数 / 活动文案，
              // 写进任务注册表 → 触发 onTaskChanged → TUI 面板刷新。
              if (taskId && (msg.tokenCount != null || msg.toolUseCount != null)) {
                updateAgentProgress(taskId, {
                  toolUseCount: msg.toolUseCount ?? 0,
                  tokenCount: msg.tokenCount ?? 0,
                  lastActivity: msg.lastActivity
                    ? { toolName: "", input: {}, activityDescription: msg.lastActivity }
                    : undefined,
                  recentActivities: [],
                });
              }
              break;

            case "result":
              result = {
                success: msg.success,
                output: msg.output,
                usage: msg.usage,
                turns: msg.turns,
                toolUseCount: msg.toolUseCount ?? 0,
                // P0-1：spawn 子进程的 result 消息可能不带 model/provider，
                // 父进程用 initMsg 已知值兜底（子进程必用 initMsg.model + provider_name）
                model: msg.model ?? initMsg.model,
                provider: msg.provider ?? initMsg.provider_name,
              };
              break;

            case "crash":
              throw new Error(
                `子代理崩溃: ${msg.error}${msg.stack ? `\n${msg.stack}` : ""}`,
              );
          }
        }

        if (result) break;
      }

      // 等待子进程退出
      await subprocess.exited;

      if (!result) {
        const exitCode = subprocess.exitCode;
        return {
          success: false,
          output: `子代理意外退出 (exit code: ${exitCode})`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          toolUseCount: 0,
        };
      }

      log.info("SUBAGENT", `spawn 完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      return result;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      // 确保子进程被终止
      if (!subprocess.killed) {
        subprocess.kill();
      }
    }
  }

  /** 为子进程执行工具（与 executeSingleTool 类似，但输入来自 ChildToolUseMessage） */
  private async executeToolForChild(
    name: string,
    input: Record<string, unknown>,
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<{ content: string; is_error: boolean }> {
    const tool = tools.get(name);

    if (!tool) {
      return { content: `工具 "${name}" 未找到`, is_error: true };
    }

    try {
      // zod 运行时校验：用注入 _agentId 之前的原始 input 校验
      const validation = validateToolInput(tool, input);
      if (!validation.ok) {
        return { content: validation.message, is_error: true };
      }
      // 注入 _agentId 标记，防止子代理调用 enter_plan_mode 形成套娃
      const result = await tool.execute({ ...(validation.data as Record<string, unknown>), _agentId: "sub-agent" }, signal);
      const truncated = ContextManager.truncateToolOutput(result.output);
      return { content: truncated, is_error: result.isError ?? false };
    } catch (err: any) {
      return { content: `工具执行异常: ${err.message}`, is_error: true };
    }
  }

  /** 内部执行逻辑（含超时控制）
   *  M5: 使用共享 runAgentLoop() 替代自维护 while 循环，对标 claude-code runAgent() */
  private async executeInner(task: SubAgentTask, signal?: AbortSignal, taskId?: string): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    log.info("SUBAGENT", `启动子代理 [${task.type}]: ${task.description}`);

    // 超时控制（默认 120 秒）
    const timeout = task.timeout ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      // 独立的上下文
      const ctxMgr = new ContextManager({
        maxTokens: this.resolveSubAgentWindow(task),
      });

      const basePrompt = getSystemPrompt(task.type);
      const systemPrompt = await enhanceSubAgentPrompt(basePrompt, this.language, process.cwd());
      ctxMgr.setSystemPrompt(systemPrompt);

      // 添加任务提示
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.prompt }],
      });

      const sourceRegistry = task.tools ?? this.toolRegistry;
      const allTools = sourceRegistry.all();
      const filteredTools = filterToolsForAgent(allTools, {
        isBuiltIn: true,
        builtInType: task.type,
        isAsync: task._isAsync,
      });
      const tools = this.buildIsolatedToolRegistry(filteredTools);
      const maxTurns = task.maxTurns ?? 10;
      const loopDetector = new LoopDetector();

      const toolNames = filteredTools.map(t => t.name());
      log.info("SUBAGENT", `[${task.type}] 可用工具: ${toolNames.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      // 动态获取 provider/model（registry 模式下按子代理类型选择）
      const activeProvider = this.registry
        ? this.registry.getProviderForSubAgent(task.type)
        : this.provider;
      const activeModel = this.registry
        ? this.registry.getModelForSubAgent(task.type)
        : this.model;

      // M5: 使用共享 runAgentLoop() 运行独立 Agent Loop
      let lastTextOutput = "";
      let toolUseCount = 0;
      let tokenCount = 0;

      const loopResult = await runAgentLoop({
        provider: activeProvider,
        model: activeModel,
        ctxMgr,
        tools,
        maxTurns,
        signal: mergedSignal,
        loopDetector,
        onBeforeTurn: (turn) => {
          // 消费 SendMessage 注入的消息（从第 2 轮开始检查）
          if (taskId && turn > 1) {
            const injected = drainAgentMessages(taskId);
            for (const msg of injected) {
              log.info("SUBAGENT", `[${task.type}] 收到主代理消息: ${msg.slice(0, 100)}`);
              ctxMgr.addMessage({
                role: "user",
                content: [{ type: "text", text: `[主代理消息] ${msg}` }],
              });
            }
          }
        },
        onTurnEnd: (info) => {
          lastTextOutput = info.textOutput || lastTextOutput;
          // 真实进度直接取 runAgentLoop 累计值（token 来自 totalUsage，非伪造估算）
          toolUseCount = info.toolUseCount;
          tokenCount = info.tokenCount;

          // 实时写输出到磁盘（支持 task_output 增量读取）
          if (taskId && info.textOutput) {
            appendAgentOutput(taskId, `[轮次 ${info.turn}] ${info.textOutput}\n`);
          }

          // 更新任务进度（供 pollTasks / TUI 实时读取）。每轮都更新——
          // 即便本轮无工具调用，token 与耗时也在推进，面板需要随之刷新。
          if (taskId) {
            const lastToolEntry = info.tools.length > 0 ? info.tools[info.tools.length - 1] : undefined;
            updateAgentProgress(taskId, {
              toolUseCount,
              tokenCount,
              lastActivity: lastToolEntry ? {
                toolName: lastToolEntry.name,
                input: lastToolEntry.input,
                activityDescription: describeToolActivity(lastToolEntry.name, lastToolEntry.input),
              } : undefined,
              recentActivities: [],
            });

            // M5 opt-in: 周期性进度摘要（每 5 轮生成一次）
            if (process.env.SIDCODE_AGENT_PROGRESS_SUMMARY === "1" && info.turn % 5 === 0) {
              const toolNames = info.tools.map(t => t.name).join(", ");
              const textPreview = info.textOutput.slice(0, 100);
              const summary = `[轮次 ${info.turn}] 工具: ${toolNames || "(无)"} | 输出预览: ${textPreview || "(无文本)"}`;
              updateTask<LocalAgentTaskState>(taskId, (t) => ({
                ...t,
                progressSummary: summary,
              }));
            }
          }
        },
      });

      // 更新 final 状态（runAgentLoop 结束后 lastTextOutput 已从 onTurnEnd 累积）
      const totalUsage = loopResult.totalUsage;

      // 提取最终结果：从所有 assistant 消息中回溯查找最后一条有文本内容的
      const finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      log.info("SUBAGENT", `[${task.type}] 结果: ${finalOutput.slice(0, 200)}`);
      log.info("SUBAGENT", `[${task.type}] 完成，共 ${loopResult.turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      if (loopResult.success) {
        return {
          success: true,
          output: finalOutput,
          usage: totalUsage,
          turns: loopResult.turns,
          toolUseCount,
          model: activeModel,
          provider: activeProvider.name(),
        };
      } else {
        return {
          success: false,
          output: loopResult.errorMessage || "子代理执行未成功",
          usage: totalUsage,
          turns: loopResult.turns,
          toolUseCount,
          model: activeModel,
          provider: activeProvider.name(),
        };
      }
    } catch (err: any) {
      // 超时中断时返回友好提示
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[${task.type}] 超时 (${timeout}ms)`);
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          toolUseCount: 0,
        };
      }
      // 其他异常也不穿透，转为失败结果
      log.error("SUBAGENT", `[${task.type}] 执行异常`, { error: err.message });
      return {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 自定义子代理内部执行逻辑（M5: 使用共享 runAgentLoop） */
  private async executeCustomInner(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    log.info("SUBAGENT", `启动自定义子代理`);

    const timeout = task.timeout ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const ctxMgr = new ContextManager({
        maxTokens: this.resolveSubAgentWindow(task),
      });

      const systemPrompt = await enhanceSubAgentPrompt(task.systemPrompt, this.language, process.cwd());
      ctxMgr.setSystemPrompt(systemPrompt);
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.userPrompt }],
      });

      const tools = task.allowedTools.length > 0
        ? this.buildIsolatedToolRegistry(this.toolRegistry.filter(task.allowedTools).all())
        : new ToolRegistry();
      const maxTurns = task.maxTurns ?? 10;
      const loopDetector = new LoopDetector();

      log.info("SUBAGENT", `[custom] 可用工具: ${task.allowedTools.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      // 动态获取 provider/model（registry 模式下使用 modelOverride 或主模型）
      const activeProvider = this.registry
        ? (this.modelOverride
          ? this.registry.getProviderForSubAgent("task")  // 自定义 agent 按 task 类型查找
          : this.registry.getProvider())
        : this.provider;
      const activeModel = this.modelOverride || (this.registry
        ? this.registry.getCurrentModel()
        : this.model);

      // M5: 使用共享 runAgentLoop() 运行独立 Agent Loop
      let lastTextOutput = "";
      let toolUseCount = 0;

      const loopResult = await runAgentLoop({
        provider: activeProvider,
        model: activeModel,
        ctxMgr,
        tools,
        maxTurns,
        signal: mergedSignal,
        loopDetector,
        onTurnEnd: (info) => {
          lastTextOutput = info.textOutput || lastTextOutput;
          toolUseCount += info.tools.length;
        },
      });

      const totalUsage = loopResult.totalUsage;

      // 提取最终结果：从所有 assistant 消息中回溯查找最后一条有文本内容的
      const finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      log.info("SUBAGENT", `[custom] 完成，共 ${loopResult.turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      if (loopResult.success) {
        return {
          success: true,
          output: finalOutput,
          usage: totalUsage,
          turns: loopResult.turns,
          toolUseCount,
          model: activeModel,
          provider: activeProvider.name(),
        };
      } else {
        return {
          success: false,
          output: loopResult.errorMessage || "子代理执行未成功",
          usage: totalUsage,
          turns: loopResult.turns,
          toolUseCount,
          model: activeModel,
          provider: activeProvider.name(),
        };
      }
    } catch (err: any) {
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[custom] 超时 (${timeout}ms)`);
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          toolUseCount: 0,
        };
      }
      // 其他异常也不穿透，转为失败结果
      log.error("SUBAGENT", `[custom] 执行异常`, { error: err.message });
      return {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 为进程内子代理组装隔离的工具注册表（缺口 1 修复）。
   *
   * 关键：read/edit/read_many 持有 FileReadTracker 引用，是「先读后写」校验的状态载体。
   * 进程内子代理若直接复用主代理的工具实例，会共享同一 tracker——子代理读文件后
   * 主代理 tracker 也被 markAsRead，造成缓存污染、绕过先读后写护栏、mtime 串扰
   * （详见 docs/bugfixes/todo/子代理委托机制 §3.1）。
   *
   * 这里为子代理建**独立 tracker**，用工厂重建这三个有状态工具；其余无状态工具
   * （grep/glob/ls/bash/web_* 等）复用传入实例，避免重复构造开销。
   *
   * 对标 claude-code：普通子代理 readFileState 全新空初始化（我们无 fork 模式，
   * 故无需克隆父级，比 cc 更简单）。spawn 路径靠进程隔离天然解决，不经过此方法。
   */
  private buildIsolatedToolRegistry(filteredTools: LegacyTool[]): ToolRegistry {
    const subTracker = new FileReadTracker();
    const rebuilt = new Map<string, LegacyTool>();
    for (const t of createStatefulTools(subTracker)) rebuilt.set(t.name(), t);

    const tools = new ToolRegistry();
    for (const t of filteredTools) {
      // 有状态工具用子代理独立 tracker 重建；无状态工具直接复用（安全）
      const replacement = STATEFUL_TOOL_NAMES.has(t.name()) ? rebuilt.get(t.name()) : undefined;
      tools.register(replacement ?? t);
    }
    return tools;
  }

  /** 从所有 assistant 消息中回溯提取最终文本输出
   *  参考 claude-code finalizeAgentTool 回退逻辑：
   *  优先取最后一条有 text content 的 assistant 消息，
   *  如果最后一条 assistant 是纯 tool_use block（无文本），向前查找最近的有文本的，
   *  只有在完全没有文本时才回退到 lastTextOutput */
  private extractFinalText(messages: Array<{ role: string; content: ContentBlock[] }>, fallback: string): string {
    // 倒序遍历所有消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      const texts = (msg.content as ContentBlock[])
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("\n")
        .trim();
      if (texts) return texts;
    }
    return fallback;
  }
}
