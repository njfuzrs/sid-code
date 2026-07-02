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
import {
  StructuredOutputTool,
  structuredOutputPromptSuffix,
} from "../tool/structured-output-tool.ts";
import {
  validateAgainstSchema,
  formatSchemaErrors,
} from "../workflow/json-schema-validator.ts";
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
import { getAgentSystemPrompt, resolveAgent, BUILTIN_AGENTS } from "./agent-definition.ts";
import { platform, homedir } from "os";
import { cwd } from "process";
import { dirname, join, sep } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { withAgentCwd } from "../bootstrap/cwd-context.ts";

/** sid-code 源码根目录（src/）的绝对路径，用于 spawn 子进程时定位 headless.ts。
 *  编译二进制中 import.meta.url 指向 /$bunfs/root/...（虚拟路径），此时 headless.ts
 *  不存在于磁盘——shouldUseSpawn 检测到后自动回退进程内模式。 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS_ENTRY = join(__dirname, "..", "entrypoints", "headless.ts");
/** headless 入口是否存在于磁盘（编译二进制中为 false） */
const HEADLESS_AVAILABLE = existsSync(HEADLESS_ENTRY);

/**
 * 子代理类型（已废弃硬编码枚举，改为开放字符串）。
 *
 * 原先 SubAgentType 是硬编码联合类型，新增 Agent（如 general-purpose、自定义/插件 Agent）
 * 必须改源码。现在改为 string，实际可用类型由 getActiveAgentTypes() 运行时派生，
 * 与 sub_agent 工具的 z.string() schema 对齐。
 *
 * 此处保留类型别名（值为 string）供 swarm/team 等历史引用方平滑过渡，
 * 新代码直接用 string。
 */
export type SubAgentType = string;

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
  /** M2(Dynamic Workflows): 结构化输出 JSON Schema。存在时给子代理挂 StructuredOutput 工具，
   *  强制其按 schema 返回；执行结果旁路 extractFinalText，直接用工具捕获的 JSON。 */
  schema?: Record<string, unknown>;
  /** M4(Dynamic Workflows): 显式指定子代理模型，优先于按类型查找的默认模型。 */
  model?: string;
  /** M4(Dynamic Workflows): 子代理工作目录（worktree 真并行用）。设置时整个执行包在
   *  withAgentCwd 上下文里，文件类工具经 getCwd() 自动以此为基准，并发隔离无需 chdir。 */
  cwd?: string;
  /** M4(Dynamic Workflows): 推理强度。workflow agent({effort}) 透传而来。
   *  low|medium|high → provider reasoningEffort "high"；xhigh|max → "max"
   *  （provider 层仅接受 high|max，对齐 SendParams.reasoningEffort 契约）。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Fork 模式：从主对话继承的初始消息序列（由 buildForkMessages 构建）。
   *  存在时子代理不从空上下文起步，而是接续这段父对话历史（prompt cache 友好），
   *  适合"接着主对话往下深钻某个分支"的子任务。对标 cc forkSubagent。 */
  forkMessages?: { role: string; content: ContentBlock[] }[];
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

  // 结论输出约束（防止 max_turns 退出时 result 是 thinking 碎片）
  // 对标 CC：Anthropic 模型 thinking 有独立 block type 自然被过滤，
  // 但第三方模型（DeepSeek 等）reasoning 混在 text block 中无法靠 type 过滤，
  // 必须在 prompt 层面预防性约束。
  notes.push(
    "【关键约束】你的最后一条消息必须是结构化总结/结论，不能是规划或思考过程。" +
      "如果你感觉快要达到轮次限制，请立即停止探索并输出目前已有的结论。" +
      "格式要求：以「## 结论」或「## 发现」开头，用表格/列表组织发现内容。",
  );

  // 环境信息
  const dir = workingDir ?? cwd();
  const home = homedir();
  const os = platform();
  const date = new Date().toISOString().split("T")[0];
  notes.push(`当前工作目录: ${dir}`);
  notes.push(`用户主目录: ${home}`);
  notes.push(`操作系统: ${os}`);
  notes.push(`当前日期: ${date}`);

  // D13：若工作目录落在隔离 worktree 内，明确告知子代理，避免它输出主仓路径或误判仓库状态。
  if (dir.includes(`${sep}.sid-code${sep}worktrees${sep}`)) {
    notes.push(
      "【隔离环境提示】你当前运行在一个隔离的 Git Worktree 中（独立工作区，与主仓共享对象库）。" +
        "你的文件改动只影响此工作区，不会污染主仓。请使用上面的「当前工作目录」作为项目根，" +
        "不要假设自己在主仓库目录下，也不要引用主仓的绝对路径。",
    );
  }

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
    // 稳定 agentId：贯穿 start → stop，让遥测能把一个子代理的 start/stop 配对成同一 span。
    const agentId = `subagent-${task.type}-${taskId}`;
    const startedAt = Date.now();
    try {
      // SubagentStart hook（带预期 model/provider，供遥测按 model 分类）
      const expectedModel = task.model
        ?? (this.registry ? this.registry.getModelForSubAgent(task.type) : this.model);
      this.hookSystem?.fireSubagentStartEvent(
        agentId,
        task.type,
        undefined,
        { model: expectedModel },
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式（独立进程，避免 V8 OOM）
      // M4: task.cwd 存在时强制进程内模式——ALS cwd 上下文无法跨进程传递,
      //     必须在本进程内用 withAgentCwd 包裹才能让文件类工具以 worktree 为基准。
      const runInner = () =>
        task.cwd
          ? withAgentCwd(task.cwd, () => this.executeInner(task, signal, taskId))
          : this.executeInner(task, signal, taskId);

      if (this.shouldUseSpawn() && !task.cwd) {
        try {
          result = await this.executeSpawned(task, signal, taskId);
          log.info("SUBAGENT", `[${task.type}] spawn 模式完成`);
        } catch (err: any) {
          log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
          result = await this.executeInner(task, signal, taskId);
        }
      } else {
        result = await runInner();
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
      // subagent_stop hook（非阻塞）。带子代理实际 model/provider/usage/turns，
      // 供 TelemetryHookProbe 创建 invoke_agent 子 span 并按 model 单独计费。
      // result 在 try/catch 任一分支都已赋值（catch 兜底构造），此处可安全读取。
      const r = result!;
      this.hookSystem?.fireSubagentStopEvent({
        agent_id: agentId,
        agent_type: task.type,
        toolName: `subagent:${task.type}`,
        success: r?.success,
        model: r?.model,
        provider: r?.provider,
        turns: r?.turns,
        tool_use_count: r?.toolUseCount,
        usage: r?.usage,
        duration_ms: Date.now() - startedAt,
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
    // headless.ts 必须存在于磁盘（编译二进制中为虚拟路径，不可 spawn）
    if (!HEADLESS_AVAILABLE) return false;
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
      timeout: task.timeout ?? resolveAgent(task.type)?.timeout ?? 120_000,
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
      timeout: task.timeout ?? 120_000,  // 自定义代理无 AgentDefinition，保留 120s 默认
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

    // 构建启动参数——使用绝对路径，避免用户项目 cwd 下找不到 headless.ts
    const spawnArgs = ["run", HEADLESS_ENTRY];
    // 容器环境设堆限制
    const maxOldSpace = process.env.SIDCODE_MAX_OLD_SPACE_SIZE;
    if (maxOldSpace) {
      spawnArgs.unshift(`--max-old-space-size=${maxOldSpace}`);
    }

    log.info("SUBAGENT", `spawn 子进程: bun ${spawnArgs.join(" ")}`);

    // Spawn 子进程（cwd 保持用户项目目录，供子代理文件操作工具正确解析相对路径）
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
        // 纵深防御：signal abort 后主动 break，防止 kill 信号被忽略时 reader 永久阻塞
        if (signal?.aborted) {
          log.info("SUBAGENT", "signal aborted，退出 stdout 读取循环");
          break;
        }
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
    const log = getLogger();
    const tool = tools.get(name);

    if (!tool) {
      return { content: `工具 "${name}" 未找到`, is_error: true };
    }

    // pre_tool_use hook（spawn 路径同样接入 hook 链，与进程内 / 主循环对齐）。
    let effectiveInput = input;
    if (this.hookSystem) {
      try {
        const pre = await this.hookSystem.firePreToolUseEvent(name, input, undefined);
        if (pre.finalOutput?.isBlockingDecision()) {
          const reason = pre.finalOutput.getEffectiveReason();
          log.info("SUBAGENT:HOOK", `工具 ${name} 被 hook 阻止: ${reason}`);
          return { content: `Hook 阻止执行: ${reason}`, is_error: true };
        }
        if (pre.finalOutput && "getModifiedToolInput" in pre.finalOutput) {
          const modified = (pre.finalOutput as any).getModifiedToolInput?.();
          if (modified) effectiveInput = modified as Record<string, unknown>;
        }
      } catch (err: any) {
        log.error("SUBAGENT:HOOK", `pre_tool_use hook 失败: ${err.message}`);
      }
    }

    const startTime = Date.now();
    try {
      // zod 运行时校验：用注入 _agentId 之前的原始 input 校验
      const validation = validateToolInput(tool, effectiveInput);
      if (!validation.ok) {
        return { content: validation.message, is_error: true };
      }
      // 注入 _agentId 标记，防止子代理调用 enter_plan_mode 形成套娃
      const result = await tool.execute({ ...(validation.data as Record<string, unknown>), _agentId: "sub-agent" }, signal);
      const elapsed = Date.now() - startTime;
      const truncated = ContextManager.truncateToolOutput(result.output);
      // post_tool_use hook（驱动 execute_tool span）
      if (this.hookSystem) {
        this.hookSystem.firePostToolUseEvent(
          name,
          effectiveInput,
          { output: truncated, isError: result.isError ?? false },
          result.isError ?? false,
          undefined,
          { duration_ms: elapsed },
        ).catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use hook 失败: ${e.message}`));
      }
      return { content: truncated, is_error: result.isError ?? false };
    } catch (err: any) {
      if (this.hookSystem) {
        this.hookSystem.firePostToolUseFailureEvent(name, effectiveInput, err.message, undefined)
          .catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e.message}`));
      }
      return { content: `工具执行异常: ${err.message}`, is_error: true };
    }
  }

  /** 内部执行逻辑（含超时控制）
   *  M5: 使用共享 runAgentLoop() 替代自维护 while 循环，对标 claude-code runAgent() */
  private async executeInner(task: SubAgentTask, signal?: AbortSignal, taskId?: string): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    log.info("SUBAGENT", `启动子代理 [${task.type}]: ${task.description}`);

    // 超时控制：task.timeout > AgentDefinition.timeout > 默认 120 秒
    const agentDefForTimeout = resolveAgent(task.type);
    const timeout = task.timeout ?? agentDefForTimeout?.timeout ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    // try 块外部声明 ctxMgr，以便 catch 块在超时时能读取部分进度信息
    let ctxMgr: ContextManager | undefined;

    try {
      // 独立的上下文
      ctxMgr = new ContextManager({
        maxTokens: this.resolveSubAgentWindow(task),
      });

      const basePrompt = getSystemPrompt(task.type);
      let systemPrompt = await enhanceSubAgentPrompt(basePrompt, this.language, process.cwd());

      // M2(Dynamic Workflows): 带 schema 时,系统提示追加结构化输出强制段
      let structuredTool: StructuredOutputTool | undefined;
      if (task.schema) {
        structuredTool = new StructuredOutputTool(task.schema);
        systemPrompt += structuredOutputPromptSuffix();
      }
      ctxMgr.setSystemPrompt(systemPrompt);

      // 添加任务提示。Fork 模式：先把继承自主对话的消息序列灌入上下文
      // （buildForkMessages 已保证以 user 开头、无悬空 tool 块），让子代理接续父对话；
      // 末条已是 fork 子任务提示，故不再额外追加 task.prompt。
      if (task.forkMessages && task.forkMessages.length > 0) {
        for (const msg of task.forkMessages) {
          ctxMgr.addMessage({ role: msg.role as "user" | "assistant", content: msg.content });
        }
      } else {
        ctxMgr.addMessage({
          role: "user",
          content: [{ type: "text", text: task.prompt }],
        });
      }

      const sourceRegistry = task.tools ?? this.toolRegistry;
      const allTools = sourceRegistry.all();
      // 区分内置类型 vs 动态(自定义/插件)类型：
      // 内置走 tool-filter 的角色白名单(builtInType)；动态类型该白名单查不到，
      // 改用其 AgentDefinition 声明的 tools/disallowedTools(对标 cc resolveAgentTools)。
      const agentDef = resolveAgent(task.type);
      const isBuiltInType = task.type in BUILTIN_AGENTS;
      const filteredTools = filterToolsForAgent(allTools, {
        isBuiltIn: isBuiltInType,
        builtInType: isBuiltInType ? task.type : undefined,
        tools: agentDef?.tools,
        disallowedTools: agentDef?.disallowedTools,
        isAsync: task._isAsync,
      });
      const tools = this.buildIsolatedToolRegistry(filteredTools);
      // M2: 把 StructuredOutput 工具挂进隔离工具集(在过滤之后,确保不被裁剪掉)
      if (structuredTool) {
        tools.register(structuredTool);
      }
      const maxTurns = task.maxTurns ?? 10;
      const loopDetector = new LoopDetector();

      const toolNames = filteredTools.map(t => t.name());
      log.info("SUBAGENT", `[${task.type}] 可用工具: ${toolNames.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      // 动态获取 provider/model（registry 模式下按子代理类型选择）
      // M4(Dynamic Workflows): task.model 显式指定时优先于按类型查找的默认模型。
      const activeProvider = this.registry
        ? this.registry.getProviderForSubAgent(task.type)
        : this.provider;
      const activeModel = task.model
        ? task.model
        : this.registry
          ? this.registry.getModelForSubAgent(task.type)
          : this.model;

      // M5: 使用共享 runAgentLoop() 运行独立 Agent Loop
      let lastTextOutput = "";
      let toolUseCount = 0;
      let tokenCount = 0;

      // M4(Dynamic Workflows): effort → provider reasoningEffort（仅 high|max 两档）。
      // low/medium/high → "high"；xhigh/max → "max"（对齐 SendParams.reasoningEffort 契约）。
      const sendParamsExtra =
        task.effort !== undefined
          ? {
              reasoningEffort: (task.effort === "xhigh" || task.effort === "max"
                ? "max"
                : "high") as "high" | "max",
            }
          : undefined;

      const loopResult = await runAgentLoop({
        provider: activeProvider,
        model: activeModel,
        ctxMgr,
        tools,
        maxTurns,
        signal: mergedSignal,
        loopDetector,
        sendParamsExtra,
        hookSystem: this.hookSystem,
        onBeforeTurn: (turn) => {
          // 消费 SendMessage 注入的消息（从第 2 轮开始检查）
          if (taskId && turn > 1) {
            const injected = drainAgentMessages(taskId);
            for (const msg of injected) {
              log.info("SUBAGENT", `[${task.type}] 收到主代理消息: ${msg.slice(0, 100)}`);
              ctxMgr!.addMessage({
                role: "user",
                content: [{ type: "text", text: `<system-reminder>\n[主代理消息] ${msg}\n</system-reminder>` }],
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
      // M2: 若带 schema 且 StructuredOutput 工具已捕获合规输出,旁路 extractFinalText,
      //     直接用工具校验过的 JSON(序列化)作为 output——这是结构化契约的落点。
      let finalOutput: string;

      if (structuredTool?.hasCapturedOutput) {
        finalOutput = JSON.stringify(structuredTool.getCapturedOutput());
      } else if (structuredTool?.isExhausted) {
        // P0-1: 重试耗尽，返回空字符串（workflow 层 JSON.parse 失败 → 返回 null）
        log.warn("SUBAGENT", `[${task.type}] StructuredOutput 重试耗尽，返回空结果`);
        finalOutput = "";
      } else if (task.schema) {
        // P1-1: 工具未被调用的兜底路径（弱模型可能忽略 system prompt 指令直接输出文本）
        const rawText = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
        log.warn("SUBAGENT", `[${task.type}] 模型未调用 StructuredOutput 工具，尝试从文本兜底解析`);

        const fallbackResult = tryExtractJsonFromText(rawText, task.schema);
        if (fallbackResult.success) {
          log.info("SUBAGENT", `[${task.type}] 文本兜底解析成功`);
          finalOutput = JSON.stringify(fallbackResult.data);
        } else {
          log.warn("SUBAGENT", `[${task.type}] 文本兜底解析失败: ${fallbackResult.error}`);
          finalOutput = rawText; // 最终退化为文本（workflow 层 JSON.parse 失败返回 null）
        }
      } else {
        finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      }
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
        // 超时检测：runAgentLoop 内部消化了 abort 异常（不抛出），
        // 返回 success=false + 原始 AbortError message。此处补充友好超时提示，
        // 包含已完成轮次和工具调用数，帮助用户判断是否"只差一点"还是完全没进展。
        const isTimeout = timeoutCtrl.signal.aborted;
        const donePart = loopResult.turns > 0
          ? `，已完成 ${loopResult.turns} 轮、${toolUseCount} 次工具调用`
          : "";
        const output = isTimeout
          ? `子代理执行超时 (${Math.round(timeout / 1000)}秒${donePart})`
          : (loopResult.errorMessage || "子代理执行未成功");
        return {
          success: false,
          output,
          usage: totalUsage,
          turns: loopResult.turns,
          toolUseCount,
          model: activeModel,
          provider: activeProvider.name(),
        };
      }
    } catch (err: any) {
      // 超时中断时返回友好提示，包含部分进度信息
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[${task.type}] 超时 (${timeout}ms)`);
        // 从 ctxMgr 获取部分进度：子代理已完成的消息对数 ≈ 已执行轮次
        const msgCount = ctxMgr?.messageCount() ?? 0;
        const partialInfo = msgCount > 2 ? `，已执行约 ${Math.round((msgCount - 1) / 2)} 轮` : "";
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒${partialInfo})`,
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

    // 三级回退：task.timeout > 默认 300s（自定义 agent 执行复杂任务，与 task 类型对齐）
    const timeout = task.timeout ?? 300_000;
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
        hookSystem: this.hookSystem,
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
        const isTimeout = timeoutCtrl.signal.aborted;
        const donePart = loopResult.turns > 0
          ? `，已完成 ${loopResult.turns} 轮、${toolUseCount} 次工具调用`
          : "";
        const output = isTimeout
          ? `子代理执行超时 (${Math.round(timeout / 1000)}秒${donePart})`
          : (loopResult.errorMessage || "子代理执行未成功");
        return {
          success: false,
          output,
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
   *  只有在完全没有文本时才回退到 lastTextOutput。
   *
   *  增强：跳过纯 thinking/planning 文本（第三方模型 reasoning 混在 text block 中，
   *  CC 靠 thinking type 过滤，sid-code 需启发式判断）。 */
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
      if (!texts) continue;
      // 跳过纯 thinking/planning 文本（无实质结论）
      if (this.isLikelyThinking(texts)) continue;
      return texts;
    }
    return fallback;
  }

  /** 启发式判断文本是否为纯 thinking/planning（无结构化结论内容）。
   *  特征：短文本（<= 5 行有效行）且每行都是规划性开头。
   *  长文本（> 5 行）或含结构化标记（## / | / - ）的一般都包含结论，不过滤。
   *
   *  中英双语：enhanceSubAgentPrompt 强制子代理按用户语言（默认中文）输出，
   *  故规划文本多为中文（"现在我来看看…" / "让我检查一下…"）。仅匹配英文开头会
   *  让本项目最常见的中文子代理完全绕过这道防线，必须同时覆盖中文规划句式。 */
  private isLikelyThinking(text: string): boolean {
    const lines = text.split("\n").filter(l => l.trim());
    // 长文本通常包含结论（有实质内容）
    if (lines.length > 5) return false;
    // 含结构化标记（标题 / 表格 / 列表）的不是纯 thinking
    if (lines.some(l => /^#{1,3}\s|^\||\*\*/.test(l.trim()))) return false;
    // 全部是规划性开头才判定为 thinking
    const planningPatterns = [
      // 英文规划句式
      /^(Now |Let me |I need to |I should |I'll |I have |Also,? |Next,? )/i,
      /^(Let me check|Let me verify|Let me look|I have a complete|I want to )/i,
      /^(Looking at |Checking |This |The |So |OK |Alright )/i,
      // 中文规划句式（子代理默认中文输出，这是本项目主场景）
      /^(现在|接下来|然后|首先|让我|我需要|我应该|我来|我先|我还需要|我想)/,
      /^(让我们|我会|我可以|下一步|继续|那么|好的|接着|另外|此外)/,
      /^(检查一下|看一下|看看|确认一下|分析一下|我已经|目前为止|综上)/,
    ];
    return lines.every(l => planningPatterns.some(p => p.test(l.trim())));
  }
}

// ─── P1-1: 弱模型兜底解析辅助函数 ───────────────────────────────────────────

interface FallbackResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 从文本中尝试提取 JSON 并校验 schema（兜底路径）。
 * 当弱模型忽略 system prompt 中的工具调用指令、直接输出 JSON 文本时，
 * 此函数尝试恢复结构化数据，避免静默退化为字符串。
 */
function tryExtractJsonFromText(text: string, schema: Record<string, unknown>): FallbackResult {
  let jsonStr = text.trim();

  // 支持 ```json ... ``` 代码块
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: "文本非合法 JSON" };
  }

  const result = validateAgainstSchema(schema, data);
  if (!result.valid) {
    return { success: false, error: formatSchemaErrors(result.errors) };
  }
  return { success: true, data };
}
