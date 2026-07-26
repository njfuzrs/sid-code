/**
 * 子代理系统
 * 每个子代理有独立的短上下文，干完活只返回结果
 * 主代理当协调者，spawn 子代理执行子任务，汇总结果
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage, SendParams } from "../llm/types.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { SidechainWriter } from "../session/sidechain.ts";
import { validateToolInput } from "../tool/input-validator.ts";
import type { LegacyTool } from "../tool/types.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { FileReadTracker } from "../tool/file-read-tracker.ts";
import { createStatefulTools, STATEFUL_TOOL_NAMES } from "../tool/stateful-tools.ts";
import { TodoWriteTool } from "../tool/todo-write.ts";
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
import type { Checker, PermissionRequest } from "../permission/types.ts";
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
import { withIncrementedDepth } from "./depth-context.ts";

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
  /** 子代理最大轮次（默认见 resolveSubAgentMaxTurns：fork 任务 200，常规任务 30） */
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
  /** P1-3：额外消息拉取回调（swarm 团队成员用）。每轮开始时调用，返回的字符串作为
   *  user 消息注入子代理上下文——team.ts 用它把成员 mailbox 里的未读消息（来自 leader/peer）
   *  drain 出来，实现真正的双向通信。与 message-queue 的 drainAgentMessages 并列消费，
   *  互不干扰。缺省时不影响任何行为（向后兼容）。 */
  drainInbox?: () => string[];
}

/** P2-2：计算子代理默认 maxTurns（未显式指定 task.maxTurns 时）。
 *
 *  - fork 任务（task.forkMessages 非空，继承主对话上下文）：200，对齐 CC fork 子代理——
 *    继承完整父对话意味着任务复杂度约等于继续该对话，200 是"几乎不会触发，只防真正
 *    无限循环"的安全阀。
 *  - 常规任务（explore/task/verify 等独立窄范围任务）：30——比旧值 10 宽松，覆盖真实
 *    存在的"复杂子任务被过早截断"场景，但不直接照搬 200：这类任务上下文独立、范围
 *    较窄，跑到 200 轮更可能是卡住而非正当进展。
 *
 *  只对携带 forkMessages 字段的调用方（executeInner，进程内路径）生效 fork 档位；
 *  spawn 路径（ParentInitMessage 协议）不透传 forkMessages，跨进程边界后 fork 上下文
 *  已丢失，不适用 200 档位，调用方应始终传非 fork 语境的 task。
 *  导出供单测直接验证，避免依赖端到端跑满 30/200 轮 mock 循环。 */
export function resolveSubAgentMaxTurns(task: { maxTurns?: number; forkMessages?: unknown[] }): number {
  if (task.maxTurns !== undefined) return task.maxTurns;
  const isForkTask = Boolean(task.forkMessages && task.forkMessages.length > 0);
  return isForkTask ? 200 : 30;
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
  agentType?: string,
  skills?: string[],
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

  // P1-1：预加载技能段（对齐 CC §11.8 角色链）。放在语言铁律之后、env details 之前，
  // 与 agent memory 注入并列。skill 不存在时内部 warn 跳过，返回空串（向后兼容）。
  let skillSection = "";
  if (skills && skills.length > 0) {
    try {
      const { buildSkillPreloadSection } = await import("./skill-preload.ts");
      skillSection = await buildSkillPreloadSection(skills, agentType);
    } catch {
      // 技能预加载失败不阻断子代理启动
    }
  }

  // G13：按 agent 类型注入历史积累记忆（跨会话领域经验）。
  // 无该类型记忆时返回空串，行为与改动前一致（向后兼容）。
  let agentMemorySection = "";
  if (agentType) {
    try {
      const { buildAgentMemoryInjection } = await import("../memory/agent-store.ts");
      agentMemorySection = await buildAgentMemoryInjection(agentType);
    } catch {
      // 记忆读取失败不阻断子代理启动
    }
  }

  // 组装顺序：base prompt → 预加载技能（语言铁律后、env 前）→ notes（含语言/环境）→ agent memory。
  let enhanced = basePrompt;
  if (skillSection) enhanced += `\n\n---\n\n${skillSection}`;
  enhanced += `\n\n---\n\n${notes.join("\n")}`;
  return agentMemorySection ? `${enhanced}\n\n${agentMemorySection}` : enhanced;
}

/** 自定义子代理任务（Skills/Agents 用） */
export interface CustomSubAgentTask {
  systemPrompt: string;
  userPrompt: string;
  allowedTools: string[];
  maxTurns?: number;
  maxTokens?: number;
  timeout?: number;
  /** 子代理类型（G13：save_memory 的 agent scope 据此定位记忆目录；不传则 agent scope 不可用） */
  type?: string;
  /**
   * P1-1：推理努力程度（skill frontmatter effort 透传而来）。
   * low|medium|high → provider reasoningEffort "high"；xhigh|max → "max"
   * （provider 层仅接受 high|max，对齐 SendParams.reasoningEffort 契约）。
   * 显式指定即开 thinking + 下发 reasoningEffort；不传则关 thinking（与 executeInner 同口径）。
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export class SubAgent {
  private provider: Provider;
  private model: string;
  private toolRegistry: ToolRegistry;
  private hookSystem?: HookSystem;
  /** 权限检查器（dontAsk 语义：危险命令/safetyCheck 拦截，ask→deny） */
  private permissionChecker: Checker | null = null;
  /** ProviderRegistry 引用（fromRegistry 创建时设置） */
  private registry?: ProviderRegistry;
  /** 模型覆盖（自定义 Agent/Skill 指定模型时使用） */
  private modelOverride?: string;
  /** 输出语言偏好（L4，从主代理配置继承） */
  private language?: "zh" | "en";

  /** P2-10：父会话 id（用于给子代理开 sidechain JSONL）。由 SubAgentTool 注入；
   *  未注入时 sidechain 持久化静默禁用（不影响子代理执行）。 */
  private parentSessionId?: string;

  /** Spawn 模式配置（子进程启动所需的 Provider 信息） */
  private spawnConfig?: { providerName: string; apiKey: string; baseURL?: string };

  constructor(provider: Provider, model: string, toolRegistry: ToolRegistry, hookSystem?: HookSystem) {
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.hookSystem = hookSystem;
  }

  /** 设置权限检查器（dontAsk 语义，由外部工厂创建后注入） */
  setPermissionChecker(checker: Checker | null): void {
    this.permissionChecker = checker;
  }

  /** P2-10：设置父会话 id，启用子代理 sidechain 持久化（由 SubAgentTool 注入）。 */
  setParentSessionId(sessionId: string | undefined): void {
    this.parentSessionId = sessionId;
  }

  /** 获取权限检查器（供 runAgentLoop config 透传） */
  getPermissionChecker(): Checker | null {
    return this.permissionChecker;
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

  /**
   * 为子代理 ContextManager 派生一个独立的 masking 会话 ID。
   *
   * masking 服务按 sessionId 建会话级临时目录（ensureSessionTempDir，0o700）落盘被遮罩的
   * 大工具输出。子代理必须用独立 id，避免与主会话 / 并发子代理的临时文件互相覆盖。
   * 优先用 parentSessionId 作前缀（便于溯源归属），拼上 taskId/task 标识做后缀；
   * 二者皆缺时回退一个通用前缀（masking 目录仍隔离，只是不带溯源信息）。
   */
  private deriveSubAgentSessionId(taskKey?: string): string {
    const suffix = taskKey || "anon";
    return this.parentSessionId
      ? `${this.parentSessionId}-sub-${suffix}`
      : `subagent-${suffix}`;
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
        { model: expectedModel, description: task.description },
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式（独立进程，避免 V8 OOM）
      // M4: task.cwd 存在时强制进程内模式——ALS cwd 上下文无法跨进程传递,
      //     必须在本进程内用 withAgentCwd 包裹才能让文件类工具以 worktree 为基准。
      const runInner = () =>
        task.cwd
          ? withAgentCwd(task.cwd, () => this.executeInner(task, signal, taskId))
          : this.executeInner(task, signal, taskId);

      // P3-1：把整个子代理执行体包进「深度 +1」上下文。子代理内部若再调 sub_agent，
      // canSpawnSubAgent 读到的就是自己那一层的深度，据此裁决放行/拒绝。
      // spawn 模式是独立子进程（ALS 不跨进程），但子进程内也从 depth 0 起算——
      // 其 sub_agent 工具在子进程里同样受 canSpawnSubAgent 约束，故仍不会无限套娃。
      result = await withIncrementedDepth(async () => {
        if (this.shouldUseSpawn() && !task.cwd) {
          try {
            const spawned = await this.executeSpawned(task, signal, taskId);
            log.info("SUBAGENT", `[${task.type}] spawn 模式完成`);
            return spawned;
          } catch (err: any) {
            log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
            return await this.executeInner(task, signal, taskId);
          }
        }
        return await runInner();
      });

      // 前台子代理（runSync，非 _isAsync）：结果已由 tool.ts runSync 作为 tool_result 返回并
      // 渲染成工具卡片，此处不再发 <task-notification>（否则双投递，见根治方案 §5.1）。
      // 后台子代理（runAsync，_isAsync=true）：主循环靠这条通知感知完成，必须投递。
      const notify = task._isAsync === true;

      // 成功：标记任务完成并（按需）发送通知（结构化结果）
      if (result.success) {
        const agentResult: AgentTaskResult = {
          output: result.output,
          totalToolUseCount: result.toolUseCount,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          usage: result.usage,
        };
        await completeAgentTask(taskId, agentResult, notify);
      } else {
        await failAgentTask(taskId, result.output, notify);
      }
    } catch (err: any) {
      // 顶层异常兜底
      log.error("SUBAGENT", `[${task.type}] 顶层异常`, { error: err.message });
      await failAgentTask(taskId, err.message, task._isAsync === true).catch(() => {});
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
      // SubagentStart hook（description 取自 userPrompt 首段，便于轨迹排查识别派活意图）
      this.hookSystem?.fireSubagentStartEvent(
        `subagent-custom-${Date.now()}`,
        "custom",
        undefined,
        { description: task.userPrompt?.slice(0, 120) },
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
    const systemPrompt = await enhanceSubAgentPrompt(basePrompt, this.language, process.cwd(), task.type);
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
      // P2-2：与 executeInner 的常规子代理默认对齐为 30（旧值 10 过于保守）。
      // 注：ParentInitMessage 协议不透传 task.forkMessages（跨进程边界），fork 模式
      // 走 spawn 时上下文本就无法继承，不适用 fork=200 的档位，统一按非 fork 默认处理。
      max_turns: task.maxTurns ?? 30,
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
      // P2-2：与 executeCustomInner 对齐为 30（旧值 10 过于保守，CustomSubAgentTask 无 fork 概念）。
      max_turns: task.maxTurns ?? 30,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 300_000,  // G4：与进程内 executeCustomInner 对齐为 300s，消除同一自定义代理走 spawn/进程内两条路径超时值不一致（此前 spawn=120s、进程内=300s）
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

    // 超时控制（G3 修复）：用 timedOut 标志区分"超时 kill"与"崩溃/意外退出"，
    // 否则超时后 result=null 会误报为"子代理意外退出 (exit code)"，模型无法得知是超时。
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
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

      // T5-B1：abort race。signal 在 .read() await 期间触发、且 subprocess kill
      // 延迟时，裸 .read() 会一直阻塞。用 Promise.race 让 abort 立刻让出控制权，
      // 避免 reader 永久挂死。
      //
      // 修（监听器泄漏）：此前每次循环都 addEventListener("abort", ..., {once:true})，
      // 但 once:true 仅在 abort **触发后**自动移除；正常读取路径（每收到一个 chunk）abort
      // 不触发，监听器永不移除，在**共享父 signal** 上随 chunk 数线性累加。改为：全程只挂
      // 一个 abort 监听器（abortPromise 单次创建），循环内复用；退出循环时 finally 统一移除。
      let onAbortListener: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<{ done: true; value: undefined }>((resolve) => {
            onAbortListener = () => resolve({ done: true, value: undefined });
            signal.addEventListener("abort", onAbortListener, { once: true });
          })
        : null;
      const readWithAbort = (): Promise<
        ReadableStreamReadResult<Uint8Array> | { done: true; value: undefined }
      > => {
        if (!signal) return stdoutReader.read();
        if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
        return Promise.race([stdoutReader.read(), abortPromise!]);
      };

      try {
        while (true) {
          // 纵深防御：signal abort 后主动 break，防止 kill 信号被忽略时 reader 永久阻塞
          if (signal?.aborted) {
            log.info("SUBAGENT", "signal aborted，退出 stdout 读取循环");
            break;
          }
          const { done, value } = await readWithAbort();
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
      } finally {
        // T5-B1：无论正常结束 / abort / 抛错，都释放 reader 锁，防止 stdout 流锁泄漏。
        // cancel 会同时丢弃底层缓冲并解锁；已被 kill 的进程 cancel 静默失败即可。
        try {
          await stdoutReader.cancel();
        } catch { /* reader 可能已释放 */ }
        try {
          stdoutReader.releaseLock();
        } catch { /* 已释放 */ }
        // 修（监听器泄漏）：移除挂在共享父 signal 上的 abort 监听器。未 abort 时它不会
        // 自动移除（once:true 仅在触发后移除），退出循环时必须显式清理。
        if (signal && onAbortListener) {
          try { signal.removeEventListener("abort", onAbortListener); } catch { /* ignore */ }
        }
      }

      // 等待子进程退出
      await subprocess.exited;

      if (!result) {
        // G3：区分超时 vs 意外退出。超时给友好文案（与进程内模式 942 行口径一致），
        // 让模型知道是"跑太久被中断"而非"子进程崩溃"，便于决策（简化任务重试 vs 报错）。
        if (timedOut) {
          log.warn("SUBAGENT", `spawn 子代理超时 (${Math.round(timeout / 1000)}秒)`);
          return {
            success: false,
            output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
            usage: { inputTokens: 0, outputTokens: 0 },
            turns: 0,
            toolUseCount: 0,
          };
        }
        // 父进程主动 abort（用户取消）导致的退出，也给明确文案而非裸 exit code。
        if (signal?.aborted) {
          return {
            success: false,
            output: "子代理被中止",
            usage: { inputTokens: 0, outputTokens: 0 },
            turns: 0,
            toolUseCount: 0,
          };
        }
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
    let hookPermissionDecision: "allow" | "ask" | undefined;
    if (this.hookSystem) {
      try {
        const pre = await this.hookSystem.firePreToolUseEvent(name, input, undefined);
        // G3：与主循环/进程内子代理共享同一 PreToolUse 解读
        const { interpretPreToolUse } = await import("../query/tool-executor.ts");
        const interp = interpretPreToolUse(pre, input);
        if (interp.blocked) {
          log.info("SUBAGENT:HOOK", `工具 ${name} 被 hook 阻止: ${interp.blockReason}`);
          return { content: `Hook 阻止执行: ${interp.blockReason ?? "无原因"}`, is_error: true };
        }
        hookPermissionDecision = interp.permissionDecision;
        if (interp.modifiedInput !== undefined) effectiveInput = interp.modifiedInput;
      } catch (err: any) {
        log.error("SUBAGENT:HOOK", `pre_tool_use hook 失败: ${err.message}`);
      }
    }

    // 权限检查（dontAsk 语义：危险命令/safetyCheck 拦截，ask→deny）
    if (this.permissionChecker) {
      const permReq: PermissionRequest = {
        toolName: name,
        input: effectiveInput,
        description: `${name}: ${JSON.stringify(effectiveInput).slice(0, 120)}`,
      };
      const decision = await this.permissionChecker.check(permReq, tool, undefined, { hookPermissionDecision });
      if (!decision.allowed) {
        const reason = decision.reason || "子代理不允许此操作";
        log.info("SUBAGENT:PERM", `权限拒绝 ${name}: ${reason}`);
        return { content: `权限拒绝: ${reason}`, is_error: true };
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

    // P2-10：子代理 sidechain 持久化。仅当父会话 id 与 taskId（作 agentId）都在时启用；
    // 缺任一则 writer 为 undefined，所有写入调用经可选链安全跳过（不影响执行）。
    const sidechain =
      this.parentSessionId && taskId
        ? new SidechainWriter(this.parentSessionId, taskId)
        : undefined;
    /** P2-10：已持久化到 sidechain 的消息数游标（onTurnEnd 增量落盘用）。 */
    let sidechainCursor = 0;
    /** P2-10：子代理最终结束状态，finally 中据此写 sidechain_end。默认 aborted——
     *  只有走到明确成功/失败分支才改写，若中途抛出未捕获异常/被 kill 则保持 aborted。 */
    let sidechainStatus: "completed" | "failed" | "aborted" = "aborted";

    try {
      // 独立的上下文
      ctxMgr = new ContextManager({
        maxTokens: this.resolveSubAgentWindow(task),
        // 传派生 sessionId → 创建即启用工具输出遮罩。子代理是 token 消耗大户
        // （大量 read/grep/bash），用独立 id 让 masking 落盘目录与主会话隔离，
        // 避免临时文件互相覆盖。缺 parentSessionId 时退化为仅 taskId。
        sessionId: this.deriveSubAgentSessionId(taskId),
      });

      // P2-10：落 sidechain_start（记录子代理身份，供恢复时展示）。
      sidechain?.start(task.type, task.description, this.modelOverride || this.model);

      const basePrompt = getSystemPrompt(task.type);
      // P1-1：解析 agent 定义拿到 skills（预加载技能）。resolveAgent 覆盖 built-in + custom + plugin。
      // 复用到下方 tool 过滤（agentDef.tools/disallowedTools），避免重复解析。
      const agentDef = resolveAgent(task.type);
      let systemPrompt = await enhanceSubAgentPrompt(basePrompt, this.language, process.cwd(), task.type, agentDef?.skills);

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
      // agentDef 已在上方（P1-1 skills 解析处）解析，此处复用。
      const isBuiltInType = task.type in BUILTIN_AGENTS;
      const filteredTools = filterToolsForAgent(allTools, {
        isBuiltIn: isBuiltInType,
        builtInType: isBuiltInType ? task.type : undefined,
        tools: agentDef?.tools,
        disallowedTools: agentDef?.disallowedTools,
        isAsync: task._isAsync,
      });
      const tools = this.buildIsolatedToolRegistry(filteredTools, task.type);
      // M2: 把 StructuredOutput 工具挂进隔离工具集(在过滤之后,确保不被裁剪掉)
      if (structuredTool) {
        tools.register(structuredTool);
      }
      // P2-2：fork 任务默认 200、常规任务默认 30，见 resolveSubAgentMaxTurns 注释。
      const maxTurns = resolveSubAgentMaxTurns(task);
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
      //
      // H8：子代理 thinking 收口。此前 sendParamsExtra 只在显式传 effort 时给 reasoningEffort，
      // 从不给 thinking 开关——子代理用思考模型时全程沿用服务端默认（enabled），思考不可控，
      // 与主循环「thinking 是受控旋钮」的口径分裂（主循环能关，子代理关不掉），对 explore/
      // summarize 这类只读调研子代理成本与延迟双放大。
      //
      // 收口规则：thinking 显式跟随 effort——
      //   • 显式指定 effort（task.effort 非空）→ 视为「要思考」，开 thinking + 下发 reasoningEffort；
      //   • 未指定 effort → 关 thinking（SIDE_CALL_NO_THINK），子代理默认不思考。
      // 显式下发 enabled:false 对不支持思考开关的模型是 no-op（anthropic 忽略；openai.ts 仅对
      // DeepSeek/GLM 下发 thinking:{type:disabled}），不会引发 400，安全。
      // §12 P2-1 复审：思考预算上限（SID_CODE_MAX_THINKING_TOKENS / MAX_THINKING_TOKENS / settings）
      // 对子代理同样生效。此前子代理直接手写 thinking/reasoningEffort、绕过 effort.ts 的钳制层，
      // 用户设了上限却只约束主循环——子代理（尤其并发派多个）才是思考 token 的大头，属于
      // 「配置了但对最花钱的路径不起作用」。这里按上限把档位降下来，与主循环 adaptive 路径同一映射。
      const { getMaxThinkingTokensOverride, mapThinkingCapToEffort } = await import("../llm/effort.ts");
      const thinkingCap = getMaxThinkingTokensOverride();
      const cappedEffort = thinkingCap !== null ? mapThinkingCapToEffort(thinkingCap) : null;
      const sendParamsExtra: Partial<SendParams> =
        task.effort !== undefined
          ? {
              thinking: { enabled: true, budgetTokens: 0 },
              // 上限映射出更低档位时取更低者（只降不升，与 effort.ts applyAnthropicNative 一致）
              reasoningEffort: ((task.effort === "xhigh" || task.effort === "max") &&
              cappedEffort === null
                ? "max"
                : "high") as "high" | "max",
              // 透传上限，供 provider 侧 effort 映射层做精确钳制（manual 线格式模型）
              maxThinkingTokens: thinkingCap ?? undefined,
            }
          : { thinking: SIDE_CALL_NO_THINK };

      const loopResult = await runAgentLoop({
        provider: activeProvider,
        model: activeModel,
        ctxMgr,
        tools,
        maxTurns,
        signal: mergedSignal,
        loopDetector,
        sendParamsExtra,
        // H9：透传共享的 availability（与主 fallback 引擎同一实例），子代理 terminal 类错误
        // 跨路径拉黑。registry 缺省（旧测试）时为 undefined，runAgentLoop 内做空值保护。
        availability: this.registry?.availability,
        hookSystem: this.hookSystem,
        permissionChecker: this.permissionChecker ?? undefined,
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
          // P1-3：消费 swarm mailbox 里的未读消息（来自 leader / peer 成员）。
          // 与主代理消息队列并列 drain，从第 2 轮起检查——首轮已带初始任务，无需重复注入。
          if (task.drainInbox && turn > 1) {
            let inboxMsgs: string[] = [];
            try { inboxMsgs = task.drainInbox(); } catch { /* drain 失败不阻断本轮 */ }
            for (const msg of inboxMsgs) {
              log.info("SUBAGENT", `[${task.type}] 收到团队消息: ${msg.slice(0, 100)}`);
              ctxMgr!.addMessage({
                role: "user",
                content: [{ type: "text", text: `<system-reminder>\n[团队消息] ${msg}\n</system-reminder>` }],
              });
            }
          }
        },
        onTurnEnd: (info) => {
          lastTextOutput = info.textOutput || lastTextOutput;
          // 真实进度直接取 runAgentLoop 累计值（token 来自 totalUsage，非伪造估算）
          toolUseCount = info.toolUseCount;
          tokenCount = info.tokenCount;

          // P2-10：把本轮新增的对话消息落盘到 sidechain。用游标记录已持久化的消息数，
          // 每轮从 ctxMgr 取增量顺序追加，避免重复写。落盘失败不影响子代理执行。
          if (sidechain) {
            try {
              const all = ctxMgr!.getMessages();
              for (let i = sidechainCursor; i < all.length; i++) {
                const m = all[i];
                sidechain.appendMessage(m.role as "user" | "assistant" | "tool", m.content, info.turn);
              }
              sidechainCursor = all.length;
            } catch { /* sidechain 落盘失败静默 */ }
          }

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
        sidechainStatus = "completed";
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
        // P2-10：超时/中断记为 aborted（可恢复），其余非成功记为 failed。
        sidechainStatus = isTimeout ? "aborted" : "failed";
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
      // P2-10：无论成功/失败/异常，都写 sidechain_end 收尾。sidechainStatus 默认 aborted，
      // 仅成功/明确失败分支改写——恢复扫描据此过滤已结束的 sidechain。
      sidechain?.end(sidechainStatus);
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
        // 自定义子代理无 taskId，用 task.type 派生独立 masking 会话目录。
        sessionId: this.deriveSubAgentSessionId(task.type),
      });

      const systemPrompt = await enhanceSubAgentPrompt(task.systemPrompt, this.language, process.cwd(), task.type);
      ctxMgr.setSystemPrompt(systemPrompt);
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.userPrompt }],
      });

      const tools = task.allowedTools.length > 0
        ? this.buildIsolatedToolRegistry(this.toolRegistry.filter(task.allowedTools).all(), task.type)
        : new ToolRegistry();
      // P2-2：CustomSubAgentTask 无 forkMessages，resolveSubAgentMaxTurns 自然落到常规档 30。
      const maxTurns = resolveSubAgentMaxTurns(task);
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

      // P1-1：effort → provider reasoningEffort，与 executeInner 同口径（仅 high|max 两档）。
      // low/medium/high → "high"；xhigh/max → "max"。显式指定 effort 视为「要思考」，开 thinking；
      // 未指定则关 thinking（SIDE_CALL_NO_THINK），自定义子代理默认不思考。skill frontmatter
      // 声明 effort: high 时经此生效（此前 executeCustomInner 从不消费 effort，写了不起作用）。
      const customSendParamsExtra: Partial<SendParams> =
        task.effort !== undefined
          ? {
              thinking: { enabled: true, budgetTokens: 0 },
              reasoningEffort: (task.effort === "xhigh" || task.effort === "max"
                ? "max"
                : "high") as "high" | "max",
            }
          : { thinking: SIDE_CALL_NO_THINK };

      const loopResult = await runAgentLoop({
        provider: activeProvider,
        model: activeModel,
        ctxMgr,
        tools,
        maxTurns,
        signal: mergedSignal,
        loopDetector,
        hookSystem: this.hookSystem,
        sendParamsExtra: customSendParamsExtra,
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
  private buildIsolatedToolRegistry(filteredTools: LegacyTool[], agentType?: string): ToolRegistry {
    const subTracker = new FileReadTracker();
    const rebuilt = new Map<string, LegacyTool>();
    for (const t of createStatefulTools(subTracker)) rebuilt.set(t.name(), t);

    const tools = new ToolRegistry();
    for (const t of filteredTools) {
      // 有状态工具用子代理独立 tracker 重建；无状态工具直接复用（安全）
      let replacement = STATEFUL_TOOL_NAMES.has(t.name()) ? rebuilt.get(t.name()) : undefined;
      // P1-2：todo_write 持有 currentTodos 内存态（也是"先读后写"外的可变状态载体）。
      // 子代理若复用父级同一实例，并发写会污染主会话清单——给每个子代理一份**独立实例**，
      // 实现进程内 todo 追踪隔离（与 FileReadTracker 工具同构思路，无需跨执行器传 agentId）。
      if (!replacement && t.name() === "todo_write") {
        replacement = new TodoWriteTool();
      }
      // G13：save_memory 绑定当前子代理类型，让 agent scope 能定位到该类型记忆目录。
      // 用鸭子类型探测 withAgentType，避免对 MemoryTool 的强类型 import 依赖。
      if (!replacement && agentType && t.name() === "save_memory" && typeof (t as any).withAgentType === "function") {
        replacement = (t as any).withAgentType(agentType) as LegacyTool;
      }
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
