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
import { validateAgainstSchema, formatSchemaErrors } from "../workflow/json-schema-validator.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker, PermissionRequest } from "../permission/types.ts";
import { LoopDetector } from "./loop-detection.ts";
import { type LanguagePref, resolveEffectiveLanguage } from "../config/prompt-lang.ts";
import { filterToolsForAgent } from "./tool-filter.ts";
import { runAgentLoop } from "./agentic-loop.ts";
import { JitContextManager, JIT_CONTEXT_DEFAULT } from "../config/jit-context.ts";
import { collectJitAccessedPaths } from "../tool/jit-affected-paths.ts";
import { buildJitEventData, emitJitEvent } from "../trace/jit-telemetry.ts";
import { describeToolActivity, pushRecentActivity } from "./progress.ts";
// P0-1：超时不再丢弃成果——残卷（已改动文件 / 已确认结论 / 未完成部分 / 下一步）见 salvage.ts 头注释。
import { SalvageCollector, buildSalvageOutput } from "./salvage.ts";
// P0-1(a)(c)：detach 语义的硬 kill 倍数 + 按实测吞吐派生墙钟预算。
import {
  resolveSubAgentTimeout,
  recordTurnLatency,
  HARD_KILL_MULTIPLIER,
} from "./timeout-budget.ts";
import { SUBAGENT_HARD_KILL_REASON } from "../llm/errors.ts";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  appendAgentOutput,
  updateAgentProgress,
  updateTask,
  // P0-1：残卷要带上 output-file 路径（残卷是摘要，完整输出在磁盘上）。
  getTask,
} from "../task/index.ts";
import type { AgentTaskResult, LocalAgentTaskState } from "../task/types.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  type ToolDef,
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

/** spawn 子进程时定位 headless.ts 入口的绝对路径。
 *  编译二进制中 import.meta.url 指向 /$bunfs/root/...（虚拟路径），此时 headless.ts
 *  不存在于磁盘——shouldUseSpawn 检测到后自动回退进程内模式。
 *
 *  ⚠️ P2-2 分包：本文件在 **core**，`entrypoints/` 在 **cli**，跨包 ——
 *  packages/core/src/agent/ → ../../../cli/src/entrypoints/headless.ts。
 *  写成同包的 `../entrypoints/` 会让 HEADLESS_AVAILABLE 恒为 false，
 *  spawn 路径在 dev 下被静默停用（进度回灌、跨进程累积等行为一起消失）。 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS_ENTRY = join(
  __dirname,
  "..",
  "..",
  "..",
  "cli",
  "src",
  "entrypoints",
  "headless.ts",
);
/** headless 入口是否存在于磁盘（编译二进制中为 false） */
const HEADLESS_AVAILABLE = existsSync(HEADLESS_ENTRY);

/**
 * B4：自定义子代理的调用序号，用于给观测身份补一个「每次调用唯一」的后缀。
 *
 * 内置路径的 agentId 派生自 taskId（`generateTaskId` 随机生成，天然唯一），但
 * 自定义路径没有 taskId —— `executeCustomInner` 一直用 `task.type` 派生。若观测身份
 * 也只用 task.type，两个**同类型**自定义子代理并发跑就仍然共用一把快照 key，B4 的
 * 隔离在这条路径上等于没做（这是并发场景里最常见的形态：同一个 skill 被并发触发两次）。
 *
 * 用进程内自增计数而非随机串：调试时序号可读（`-c1` / `-c2` 一眼看出是第几次调用），
 * 且同一进程内不会重复。跨进程重复无所谓 —— 快照 Map 是进程内状态。
 */
let _customAgentSeq = 0;

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
  /** 是否让本子代理出现在「后台任务」面板 / bg_task_list / `<task-statuses>` 附件里
   *  （内部使用）。默认 true。
   *
   *  判据是**「这个子代理有没有自己的工具卡片」**，不是「同步还是异步」：
   *  - `false` —— 前台 `sub_agent`（tool.ts runSync）：结果已由 tool_result 渲染成
   *    `⏺ sub_agent explore` 工具卡片，再上面板就是同一个子代理渲染两遍（问题一）。
   *  - 默认 `true` —— swarm 团队成员、workflow 子代理：父层只有一张 team_create /
   *    Workflow 卡片，成员/子代理各自**没有**卡片，面板行是它们唯一的进度可见性。
   *
   *  只影响可见性，不影响注册：taskId、磁盘输出、task_output 查询一律照常。 */
  _showInPanel?: boolean;
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
  /** 进度回灌通道（内部使用）：每轮把进度快照推给**父工具卡片**，治"过程黑盒"。
   *
   *  与 `updateAgentProgress`（写 registry → 后台任务面板）并列而非替代，两者受众不同：
   *  - 这条 → 前台 `sub_agent` 的工具卡片下方（用户正在看的地方）；
   *  - registry → 后台任务面板（前台子代理经 `_showInPanel:false` 已不上面板）。
   *
   *  由 tool.ts runSync 把工具执行器的 onProgress 接进来；后台/swarm/workflow 路径不传，
   *  行为与改造前完全一致。 */
  _onProgress?: (snapshot: import("./progress.ts").AgentProgressSnapshot) => void;
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
export function resolveSubAgentMaxTurns(task: {
  maxTurns?: number;
  forkMessages?: unknown[];
}): number {
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
  return (
    getAgentSystemPrompt(type) ??
    `你是一个 ${type} 代理。完成指定任务并返回结果。\n规则：\n- 专注于完成指定任务\n- 完成后简洁地报告完成状态和关键输出`
  );
}

/**
 * 增强子代理系统提示词（L4，对标 Claude Code enhanceSystemPromptWithEnvDetails）
 *
 * 注入语言铁律、环境信息到子代理的基础系统提示词中。
 * 从硬编码改为统一增强函数，语言规则从主代理配置继承。
 */
async function enhanceSubAgentPrompt(
  basePrompt: string,
  preferredLanguage?: LanguagePref,
  workingDir?: string,
  agentType?: string,
  skills?: string[],
): Promise<string> {
  const notes: string[] = [];

  // 子代理的语言必须**二选一**落定，不能留 auto：
  // auto 的语义是"跟随用户输入语言"，而子代理根本看不到用户的原始消息——它收到的是
  // 主代理下发的任务描述。让它自己"跟随"等于让它猜，结果是同一次任务里几个子代理
  // 各写一种语言，主代理再把中英混杂的报告拼给用户。所以这里用 resolveEffectiveLanguage
  // 把 auto 解析成具体语言（按系统 locale，兜底 zh），子代理拿到的永远是确定值。
  const lang = resolveEffectiveLanguage(preferredLanguage);
  const isEn = lang === "en";

  // 语言约束。措辞与主代理身份段保持同一取向：强约束 + 保留用户显式要求的穿透口
  // （子代理虽不直接面对用户，但任务描述里可能转述了"用英文写这份文档"这类要求，
  // 一句不留余地的铁律会让它硬拒那个要求，重演主代理曾经的硬拒事故）。
  if (isEn) {
    notes.push(
      "[TOP PRIORITY] Write all output and reasoning in English. " +
        "Keep code and paths verbatim, but explanations and reasoning must be in English. " +
        "Exception: if the task description explicitly asks for another language, honour that request.",
    );
    // 显式压过 base prompt 里的中文小节标题。
    //
    // 内置 agent 的 systemPrompt 仍以中文写就（它们是 agent 的身份契约，55%–79% 中文），
    // 其中包含「以 "## 发现" 开头」这类**具体到字面量**的格式要求。en 模式下不点破它，
    // 模型面临两个都不好的选项：照做（在英文报告里插中文标题，污染 en 输出）或不照做
    // （悄悄违反格式约束，主代理按标题解析结论时可能拿不到）。这里把二选一变成明确指令。
    notes.push(
      "[FORMAT OVERRIDE] The instructions above may specify Chinese section headings " +
        "(e.g. 'start with \"## 发现\"' or '\"## 结论\"'). In English mode, use the English equivalent instead " +
        '("## Findings", "## Conclusion", "## Result", "## Problem"). Keep the required structure; only the heading language changes.',
    );
  } else {
    notes.push(
      "【最高优先级】你的所有输出和思考必须使用中文。" +
        "代码和路径可保持原文，但解释和推理必须用中文。" +
        "例外：任务描述里明确要求用其它语言时，按任务描述的要求执行。",
    );
  }

  // 结论输出约束（防止 max_turns 退出时 result 是 thinking 碎片）
  // 对标 CC：Anthropic 模型 thinking 有独立 block type 自然被过滤，
  // 但第三方模型（DeepSeek 等）reasoning 混在 text block 中无法靠 type 过滤，
  // 必须在 prompt 层面预防性约束。
  //
  // 标题必须跟着语言走：en 模式下要求模型"以「## 结论」开头"，等于逼它在英文报告里
  // 插一个中文标题——要么它照做（污染 en 输出），要么它不照做（这条约束失效）。
  notes.push(
    isEn
      ? "[CRITICAL] Your final message must be a structured summary/conclusion, not planning or reasoning. " +
          "If you sense you are close to the turn limit, stop exploring immediately and output the conclusions you already have. " +
          'Format: start with "## Conclusion" or "## Findings" and organise findings as a table or list.'
      : "【关键约束】你的最后一条消息必须是结构化总结/结论，不能是规划或思考过程。" +
          "如果你感觉快要达到轮次限制，请立即停止探索并输出目前已有的结论。" +
          "格式要求：以「## 结论」或「## 发现」开头，用表格/列表组织发现内容。",
  );

  // 环境信息
  const dir = workingDir ?? cwd();
  const home = homedir();
  const os = platform();
  const date = new Date().toISOString().split("T")[0];
  if (isEn) {
    notes.push(`Working directory: ${dir}`);
    notes.push(`Home directory: ${home}`);
    notes.push(`Platform: ${os}`);
    notes.push(`Today's date: ${date}`);
  } else {
    notes.push(`当前工作目录: ${dir}`);
    notes.push(`用户主目录: ${home}`);
    notes.push(`操作系统: ${os}`);
    notes.push(`当前日期: ${date}`);
  }

  // D13：若工作目录落在隔离 worktree 内，明确告知子代理，避免它输出主仓路径或误判仓库状态。
  if (dir.includes(`${sep}.sid-code${sep}worktrees${sep}`)) {
    notes.push(
      isEn
        ? "[ISOLATED ENVIRONMENT] You are running inside an isolated Git worktree (a separate working tree sharing the main repo's object store). " +
            "Your file changes affect only this working tree and will not pollute the main repo. Use the working directory above as the project root; " +
            "do not assume you are in the main repository directory, and do not reference the main repo's absolute paths."
        : "【隔离环境提示】你当前运行在一个隔离的 Git Worktree 中（独立工作区，与主仓共享对象库）。" +
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

/**
 * B5-4（§5 缺口 D）：把"已重试 N 次 / 最后一次因为什么"拼进子代理失败文案。
 *
 * 修的是一处**错误归因**：超时路径按 `timeoutCtrl.signal.aborted` 判定后，一律报
 * 「子代理执行超时」并**整句丢弃** `loopResult.errorMessage`。于是限流打满退避耗尽
 * 预算这种最常见的失败，用户看到的是"超时"——排查方向被带去查网络配置 / 调大 timeout，
 * 而真正该做的是降并发或换模型。缺口 C 又说明"超时"本身也常常是重试退避累计撞上
 * wall-clock 的结果，两件事叠加：**最该看到的那个数字（重试了几次）恰好一个都看不到。**
 *
 * 抽成共享函数而非在两个 return 点各写一遍：`execute` 与 `executeCustom` 的失败文案
 * 本就是逐字重复的两份，再各加一段拼接必然漂移（改一处忘一处 = 自定义子代理又看不到
 * 重试信息，且不会有任何报错）。
 *
 * 无重试时返回空串——顺利跑完却拼一句"重试 0 次"是噪音。
 *
 * **覆盖边界（诚实声明，勿当已全覆盖）**：本函数只覆盖 `runAgentLoop` **正常返回**
 * `success:false` 的两条路径（`execute` / `executeCustom`）。仍未覆盖 3 处，都是拿不到
 * `loopResult` 的结构性原因，不是漏改：
 *   ① 两处 `catch (err)` 超时分支 —— runAgentLoop 抛异常而非返回，结果对象不存在
 *      （它内部会消化 abort 后正常返回，故这条路径罕见）；
 *   ② spawn 子进程模式 —— 重试发生在**另一个进程**里，父进程只拿到退出码，
 *      要透出得先给子进程加结构化结果回传通道，属独立工单。
 */
function formatRetryHint(result: { retryAttempts?: number; lastRetryReason?: string }): string {
  const attempts = result.retryAttempts ?? 0;
  if (attempts <= 0) return "";
  const reason = result.lastRetryReason ? `，最后一次原因 ${result.lastRetryReason}` : "";
  return `，其间 LLM 重试 ${attempts} 次${reason}`;
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
  /** 语言偏好（继承主代理）。含 auto 档，落到 enhanceSubAgentPrompt 时才归一化成具体语言。 */
  private language?: LanguagePref;

  /** P2-10：父会话 id（用于给子代理开 sidechain JSONL）。由 SubAgentTool 注入；
   *  未注入时 sidechain 持久化静默禁用（不影响子代理执行）。 */
  private parentSessionId?: string;

  /** Spawn 模式配置（子进程启动所需的 Provider 信息） */
  private spawnConfig?: { providerName: string; apiKey: string; baseURL?: string };

  constructor(
    provider: Provider,
    model: string,
    toolRegistry: ToolRegistry,
    hookSystem?: HookSystem,
  ) {
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

  /**
   * P2-1：为一次子代理执行创建**独立**的 JIT 发现回调。
   *
   * ## 为什么每次执行新建实例，而不是 SubAgent 的字段
   *
   * 对齐 CC 为 forked agent 分配独立 `loadedNestedMemoryPaths`（`forkedAgent.ts:383`）
   * 的做法，并且更进一步：连同一个 SubAgent 对象的**多次**执行之间也不共享。
   * 每次执行有各自的 ctxMgr（各自的上下文窗口），共享去重集会让第二次执行
   * 认为规则「已加载」而跳过 —— 但它的 ctxMgr 是全新的，里面什么都没有，
   * 于是规则静默丢失。这类「看起来接了 JIT、实际失效」比不接更难排查。
   *
   * 注入路径：把 JIT 正文追加到子代理**自己**的 ctxMgr 系统提示词末尾。
   * 子代理的 ctxMgr 同样注册了 jitBlocksProvider（见下），所以其内部任何
   * 覆盖式重建也不会丢这些规则。
   *
   * @param ctxMgr 该次执行的上下文管理器（JIT 注入目标）
   * @param jitDisabled 配置关闭 JIT 时传 true → 返回 undefined，loop 侧不触发
   */
  private createJitDiscoverer(
    ctxMgr: ContextManager,
    jitDisabled = false,
  ): ((toolBlocks: Array<{ name: string; input: unknown }>) => void) | undefined {
    if (jitDisabled) return undefined;

    const mgr = new JitContextManager();
    // 与主路径同构：子代理 ctxMgr 的覆盖式写入也自动回灌 JIT
    ctxMgr.setJitBlocksProvider(() => mgr.getLoadedBlocks());

    // 串行队列：多个工具块并发触发时，read-modify-write 会互相覆盖
    let queue: Promise<void> = Promise.resolve();

    return (toolBlocks) => {
      const paths = collectJitAccessedPaths(
        toolBlocks as Array<{ name: string; input: unknown }> as any,
        process.cwd(),
        (name) => {
          const tool = this.toolRegistry.get(name) as
            | { jitAffectedPaths?: (input: unknown) => string[] }
            | undefined;
          return tool?.jitAffectedPaths ? (input) => tool.jitAffectedPaths!(input) : undefined;
        },
      );
      if (paths.length === 0) return;

      queue = queue
        .then(async () => {
          const log = getLogger();
          for (const p of paths) {
            try {
              const cwd = process.cwd();
              const r = await mgr.discoverDetailed(p, cwd);

              // 第 5 批：子代理侧也要打点。此前只有主循环打，子代理这条通道
              // （P2-1 接的独立 manager）完全不进统计 —— 用到子代理的会话，
              // JIT 命中率与字节量会系统性偏低，第 6 批的成本治理会建立在错的曲线上。
              // 与主循环共用 buildJitEventData，`source: "subagent"` 供分通道归因。
              // 未命中也打（分母不能缺），所以放在 `!r.text` 提前返回之前。
              emitJitEvent(
                buildJitEventData({
                  accessedPath: p,
                  projectRoot: cwd,
                  discovery: r,
                  cumulativeBytes: mgr.getLoadedBytes(),
                  source: "subagent",
                }),
              );

              if (!r.text) continue;
              // 走 setSystemPrompt（内部逐块幂等回灌），不手工拼接
              ctxMgr.setSystemPrompt(ctxMgr.getSystemPrompt());
              log.info(
                "JIT",
                `子代理已加载 JIT 上下文 ${r.loaded.length} 份 (${r.text.length} 字符): ` +
                  r.loaded.map((l) => l.relPath).join(", "),
              );
            } catch (err: any) {
              log.warn("JIT", `子代理 JIT 发现失败: ${p} (${err?.message})`);
            }
          }
        })
        .catch(() => {
          /* JIT 失败绝不影响子代理主流程 */
        });
    };
  }

  /**
   * B0：两条 runAgentLoop 路径（`executeInner` 内置子代理 / `executeCustomInner` 自定义子代理）
   * 共有字段的工厂函数。
   *
   * 为什么要抽这个：此前两条路径各自手写完整 config 字面量，`availability`/`deadlineAt`/
   * `discoverJitContext` 等字段靠人工在两处同步“记得传”——`sub-agent.ts:1471` 附近的注释
   * 早就写过“两条路径都要接，只接一条就会成为隐形差异”，结果自定义路径依然漏传了
   * `permissionChecker`（本次修复的 P0 缺口）。把公共字段收进一个工厂，两处只需
   * `...this.buildBaseLoopConfig(...)`，新增公共字段时天然同步，不会再靠人记。
   *
   * 差异项（querySource / agentId / sendParamsExtra / onBeforeTurn / onTurnEnd）仍由
   * 调用处显式传，保持两条路径的差异清晰可读，不被工厂吞掉。
   */
  private buildBaseLoopConfig(
    ctxMgr: ContextManager,
    startTime: number,
    timeout: number,
  ): Pick<
    Parameters<typeof runAgentLoop>[0],
    "hookSystem" | "permissionChecker" | "availability" | "deadlineAt" | "discoverJitContext"
  > {
    return {
      hookSystem: this.hookSystem,
      // B0：permissionChecker 从 AgentLoopConfig 的必填字段——此处必须显式传值
      // （可以是 undefined），漏传在类型层就会报错，不再是静默降级。
      permissionChecker: this.permissionChecker ?? undefined,
      // H9：透传共享的 availability（与主 fallback 引擎同一实例），terminal 类错误跨路径拉黑。
      availability: this.registry?.availability,
      // S3：与调用方 timeoutCtrl 同源的截止时刻，缺省不传则漏斗退化为纯次数上界。
      deadlineAt: startTime + timeout,
      // P2-1：子代理 JIT 上下文发现（每次调用独立实例，见 createJitDiscoverer 注释）。
      // B2：`jitContext: false` 必须对子代理也生效 —— 这个第二参此前从不传值，
      // 于是开关只关得住主代理（`createJitDiscoverer` 的 `jitDisabled` 逻辑一直是对的，
      // 只是没人传）。**一个半失效的开关比没有开关更糟**：用户配了 false 却照样看到
      // 规则注入，下次会去怀疑整套机制而不是这一条穿线。
      //
      // 两种降级都**保持 JIT 开启**（与落地前行为一致，不引入回归）：
      //   - `registry` 缺失：`new SubAgent(...)` 直接构造的路径。
      //   - `registry` 存在但没有这个方法：`ProviderRegistry` 常被 `as unknown as`
      //     强转的替身对象充当（如 tests/agent/sub-agent.test.ts:81），类型层拦不住。
      //     同一文件里 `getSpawnConfig?.()` 已有同样的先例 —— 这不是给测试让路，
      //     是承认「registry 是个接口位而非保证完整的实现」。
      discoverJitContext: this.createJitDiscoverer(
        ctxMgr,
        !(this.registry?.getJitContextEnabled?.() ?? JIT_CONTEXT_DEFAULT),
      ),
    };
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
    try {
      agent.spawnConfig = registry.getSpawnConfig?.();
    } catch {
      /* registry 未实现 getSpawnConfig，spawn 模式自动回退 */
    }
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
    } catch {
      /* registry 未实现 getContextWindow 或派生失败，回退兜底 */
    }
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
    return this.parentSessionId ? `${this.parentSessionId}-sub-${suffix}` : `subagent-${suffix}`;
  }

  /** 执行子代理任务 */
  async execute(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    // 创建或获取 task 状态（后台执行时由 runAsync 预先创建）
    let taskId: string;
    // 只为满足下面 if/else 两支的赋值对称性而声明——两支各自的 abortController
    // 实际消费者是 activeAgentControllers 这个模块级 Map（按 taskId 查）与
    // executeInBackground 传入的 abortController.signal，都不经这个局部变量。
    let _abortController: AbortController;
    if (task._taskId && task._abortController) {
      taskId = task._taskId;
      _abortController = task._abortController;
    } else {
      // 面板可见性由调用方声明（_showInPanel），不由"有没有预建任务"推断——
      // 这个 else 分支同时容纳三类调用方，它们的正确取值并不一致：
      //   · tool.ts runSync（前台子代理）：自己就有 `⏺ sub_agent explore` 工具卡片
      //     → _showInPanel=false，否则同一个子代理渲染两遍（用户报的问题一：
      //     工具卡片与面板 `◓ [AG explore]` 完全重合）。
      //   · team.ts in-process 成员 / workflow sub-agent-runner：**没有**各自的工具卡片
      //     （父层 team_create / Workflow 只有一张卡），面板行是它们唯一的进度可见性
      //     → 保持默认 true，不能一起摘掉。
      // 故默认 true（保持既有行为），只有显式声明 false 的才摘下面板。
      //
      // 关键：不论取值如何，任务**始终注册**进 registry——taskId 被 appendAgentOutput /
      // updateAgentProgress / task_output 工具依赖，磁盘输出照常落盘。摘掉的只是
      // 「上面板」这一个属性，判据收敛在 isPanelTask()。
      //
      // 上一轮只修了通知层（notify=false，见下方 `const notify`），没回头问"同一个错误
      // 还有没有别的出口"——registry 这条出口就是漏的那个。
      const created = createAgentTask({
        agentType: task.type,
        prompt: task.prompt,
        description: task.description,
        isBackgrounded: task._showInPanel !== false,
      });
      taskId = created.taskState.id;
      _abortController = created.abortController;
    }

    let result: SubAgentResult;
    // 稳定 agentId：贯穿 start → stop，让遥测能把一个子代理的 start/stop 配对成同一 span。
    const agentId = `subagent-${task.type}-${taskId}`;
    const startedAt = Date.now();
    try {
      // SubagentStart hook（带预期 model/provider，供遥测按 model 分类）
      const expectedModel =
        task.model ?? (this.registry ? this.registry.getModelForSubAgent(task.type) : this.model);
      this.hookSystem
        ?.fireSubagentStartEvent(agentId, task.type, undefined, {
          model: expectedModel,
          description: task.description,
        })
        .catch((err) => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

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
      this.hookSystem
        ?.fireSubagentStopEvent({
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
        })
        .catch((err) => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  /** 执行自定义子代理任务（Skills/Agents 用） */
  async executeCustom(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    let result: SubAgentResult;
    try {
      // SubagentStart hook（description 取自 userPrompt 首段，便于轨迹排查识别派活意图）
      this.hookSystem
        ?.fireSubagentStartEvent(`subagent-custom-${Date.now()}`, "custom", undefined, {
          description: task.userPrompt?.slice(0, 120),
        })
        .catch((err) => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

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
      this.hookSystem
        ?.fireSubagentStopEvent({
          toolName: "subagent:custom",
        })
        .catch((err) => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
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

  /**
   * 统一的工具过滤逻辑（spawn 与进程内路径共用）。
   *
   * 审计第 2 条修复：此前 `getToolDefs`（spawn 路径）硬编码 `isBuiltIn: true`
   * 且不透传 `agentDef.tools/disallowedTools`，导致自定义/插件子代理的
   * `tools:` 白名单与 `disallowedTools:` 黑名单被 fail-open 忽略，拿到全部工具。
   * 与 `executeInner`（进程内路径，过滤逻辑正确）是「同一逻辑两处并列实现、
   * 其中一处忘记传参」的结构性缺陷（审计结构性模式 2）。此处收敛为单一函数，
   * spawn 与进程内路径共用，避免新增过滤字段时再漏一处。
   */
  private resolveFilteredToolsForTask(
    task: SubAgentTask,
    agentDef?: { tools?: string[]; disallowedTools?: string[] },
  ): LegacyTool[] {
    const sourceRegistry = task.tools ?? this.toolRegistry;
    const allTools = sourceRegistry.all();
    const isBuiltInType = task.type in BUILTIN_AGENTS;
    return filterToolsForAgent(allTools, {
      isBuiltIn: isBuiltInType,
      builtInType: isBuiltInType ? task.type : undefined,
      tools: agentDef?.tools,
      disallowedTools: agentDef?.disallowedTools,
      isAsync: task._isAsync,
    });
  }

  /**
   * 从工具注册表获取工具定义列表（用于 spawn init 消息）。
   *
   * 审计第 18 条修复：此前手写 `{name, description, inputSchema}` 三字段映射，
   * 绕过 `registry.definitionsForTools()` → `toolToDefinition()` 正路径，导致
   * ① `usageGuide()` 拼接丢失（实测描述丢失 86.1%）；② `strict` 标记丢失
   * （Constrained Decoding 失效）；③ `zodSchema` 优先链被绕过。现改为复用正路径，
   * 与进程内路径同源。同时本函数复用 `resolveFilteredToolsForTask`（第 2 条），
   * 两条同源缺陷在此收敛为单一函数一次修掉。
   *
   * ⚠️ 前提：spawn 路径在编译二进制中不可达（`HEADLESS_AVAILABLE=false` →
   * `shouldUseSpawn` 恒退回进程内）。此修复面向源码运行模式与未来 headless embed
   * 进二进制的场景——一旦后者发生，第 2 条立即升为真 P0（权限越界）。
   */
  private getToolDefs(task: SubAgentTask): ToolDef[] {
    const agentDef = resolveAgent(task.type);
    const filteredTools = this.resolveFilteredToolsForTask(task, agentDef);
    const defs = (task.tools ?? this.toolRegistry).definitionsForTools(filteredTools);
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.input_schema,
      strict: d.strict,
    }));
  }

  /**
   * 获取自定义子代理的工具定义（spawn 路径）。
   *
   * 与 `getToolDefs` 同源修复（审计第 18 条）：手写三字段映射 → 复用正路径。
   * 自定义子代理的 `allowedTools` 是显式白名单（由调用方解析自 frontmatter），
   * 经 `Registry.filter` 精确筛出后走 `definitionsForTools`。
   */
  private getCustomToolDefs(allowedTools: string[]): ToolDef[] {
    const filtered = this.toolRegistry.filter(allowedTools);
    const defs = filtered.definitionsForTools(filtered.all());
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.input_schema,
      strict: d.strict,
    }));
  }

  /** Spawn 子代理（标准类型） */
  private async executeSpawned(
    task: SubAgentTask,
    signal?: AbortSignal,
    taskId?: string,
  ): Promise<SubAgentResult> {
    const basePrompt = getSystemPrompt(task.type);
    const systemPrompt = await enhanceSubAgentPrompt(
      basePrompt,
      this.language,
      process.cwd(),
      task.type,
    );
    const toolDefs = this.getToolDefs(task);

    // 计费口径对齐：spawn 模式按子代理类型解析模型 + 对应 provider 配置，
    // 与进程内 executeInner 的 getModelForSubAgent/getProviderForSubAgent 口径一致。
    // 缺省（registry 未实现）回退主模型 + 主 spawn 配置。
    const sc = this.registry?.getSpawnConfigForSubAgent?.(task.type);
    const model = sc?.model ?? this.model;
    // 真名必须显式过管道：子进程是独立 OS 进程，不读配置、别名表恒空，
    // 只给别名会让它把 "xxx-gateway" 当模型名发给厂商（见 sub-agent-protocol wire_model）。
    const wireModel = sc?.wireModel;
    // 整张别名表：单条 wireModel 只覆盖「本次要发的模型」，而子进程内 ModelFallback
    // 降级会**换模型**并靠别名表翻译新目标。只播种一条 → fallback 目标发别名 → 400。
    const wireModelAliases = sc?.wireModelAliases;
    const providerName = sc?.providerName ?? this.spawnConfig!.providerName;
    const apiKey = sc?.apiKey ?? this.spawnConfig!.apiKey;
    const baseURL = sc?.baseURL ?? this.spawnConfig?.baseURL;

    const initMsg: ParentInitMessage = {
      type: "init",
      session_id: `subagent-${task.type}-${Date.now()}`,
      task_type: task.type,
      system_prompt: systemPrompt,
      user_prompt: task.prompt,
      allowed_tools: toolDefs.map((t) => t.name),
      tool_defs: toolDefs,
      model,
      wire_model: wireModel,
      wire_model_aliases: wireModelAliases,
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

    // C4b：spawn 路径同样要把进度回灌父工具卡片，不只是进程内路径。task._onProgress
    // 由 tool.ts runSync 接进来（前台子代理），后台/swarm/workflow 路径不传，穿透即可。
    return this.executeSpawnedInternal(
      initMsg,
      task.tools ?? this.toolRegistry,
      signal,
      taskId,
      task._onProgress,
    );
  }

  /** Spawn 自定义子代理 */
  private async executeSpawnedCustom(
    task: CustomSubAgentTask,
    signal?: AbortSignal,
  ): Promise<SubAgentResult> {
    const enhancedSystemPrompt = await enhanceSubAgentPrompt(
      task.systemPrompt,
      this.language,
      process.cwd(),
    );
    const tools =
      task.allowedTools.length > 0
        ? this.toolRegistry.filter(task.allowedTools)
        : new ToolRegistry();
    const toolDefs = this.getCustomToolDefs(task.allowedTools);

    // 计费口径对齐 executeCustomInner：modelOverride 优先，否则按 "task" 类型解析。
    const sc = this.registry?.getSpawnConfigForSubAgent?.("task");
    const model = this.modelOverride ?? sc?.model ?? this.model;
    // 真名要按**最终生效的 model** 重新解析：modelOverride 会绕过 sc.model，
    // 此时 sc.wireModel 是 "task" 类型模型的真名，与实际要发的模型不是一回事。
    // 直接用会把 A 模型的别名配上 B 模型的真名发出去——比不翻译更糟。
    const wireModel = this.modelOverride
      ? this.registry?.resolveWireModelForAlias?.(model)
      : sc?.wireModel;
    // 整张别名表与 model 的选择无关（它是全量映射，不是"本次那条"），
    // 故 modelOverride 分支同样直接用，不需要重新解析。子进程内换模型时靠它翻译。
    const wireModelAliases = sc?.wireModelAliases;
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
      wire_model: wireModel,
      wire_model_aliases: wireModelAliases,
      // P2-2：与 executeCustomInner 对齐为 30（旧值 10 过于保守，CustomSubAgentTask 无 fork 概念）。
      max_turns: task.maxTurns ?? 30,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 300_000, // G4：与进程内 executeCustomInner 对齐为 300s，消除同一自定义代理走 spawn/进程内两条路径超时值不一致（此前 spawn=120s、进程内=300s）
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
    onProgress?: (snapshot: import("./progress.ts").AgentProgressSnapshot) => void,
  ): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    const timeout = initMsg.timeout;
    // 最近活动滑动窗口（跨轮累积，容量 MAX_RECENT_ACTIVITIES）：子进程每轮只报
    // **单条** lastActivity（headless.ts 的 progress 消息），窗口状态必须在父进程这层攒。
    // 与进程内路径（executeInner 的 onTurnEnd）同一形态，只是数据来源是跨进程消息而非
    // 直接的 info.tools。
    let recentActivities: string[] = [];

    /**
     * P0-1(b)：spawn 路径的残卷收集器。
     *
     * 这条路径能攒出残卷的关键事实：**工具是父进程执行的**（子进程只跑 LLM 循环，
     * 每次工具调用都经 `tool_use` 消息回传父进程执行，见本文件 executeToolForChild），
     * 所以父进程手里有完整的工具名 + 入参——与进程内路径信息量等价。
     *
     * 唯一不如进程内路径的是 findings：子进程只报 `lastActivity` 文案，不报每轮
     * 文本输出（`ChildProgressMessage` 无该字段）。所以 spawn 残卷的"已确认结论"段
     * 会是空的，其余三段（已改动文件 / 未完成部分 / 下一步）齐全。这是协议限制，
     * 补它要改 sub-agent-protocol.ts 的消息形状 + headless 侧发送逻辑，属独立工单——
     * 但**已改动文件清单**（§1.6 的核心验收项）在这条路径上是齐的。
     */
    const salvage = new SalvageCollector();
    /** spawn 侧的轮次计数（子进程 progress 消息带 turn）。 */
    let spawnTurn = 0;
    let spawnToolUseCount = 0;
    let spawnTokenCount = 0;

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
                // P0-1(b)：喂残卷。只在**执行成功**时记——失败的 write/edit 没有真的改动
                // 文件，记进"已改动文件清单"就是假信息（与 agentic-loop 只把非 is_error
                // 的 edit/write 纳入 LSP 诊断作用域同一判据）。
                if (!toolResult.is_error) {
                  try {
                    salvage.recordTurn({
                      turn: spawnTurn,
                      textOutput: "",
                      tools: [{ name: msg.name, input: msg.input as Record<string, unknown> }],
                      tokenCount: spawnTokenCount,
                      toolUseCount: ++spawnToolUseCount,
                    });
                  } catch {
                    /* 残卷收集失败不影响子代理执行 */
                  }
                }
                writeParentMsg(subprocess.stdin, {
                  type: "tool_result",
                  tool_use_id: msg.id,
                  content: toolResult.content,
                  is_error: toolResult.is_error,
                });
                break;
              }

              case "progress":
                // P0-1(b)：记住子进程报的轮次/累计量，供残卷的 progress 段用真实值
                // （残卷的 turns 不能靠父进程数 tool_use 次数推——一轮可以有多次调用）。
                spawnTurn = msg.turn ?? spawnTurn;
                if (msg.tokenCount != null) spawnTokenCount = msg.tokenCount;
                if (msg.toolUseCount != null) spawnToolUseCount = msg.toolUseCount;
                // 实时进度回写：spawn 子进程每轮上报真实 token / 工具次数 / 活动文案。
                // 两路消费，同一份窗口数据：
                //   - registry（updateAgentProgress）→ 后台任务面板；
                //   - onProgress（C4b）→ 前台 sub_agent 自己的工具卡片，治过程黑盒。
                if (msg.tokenCount != null || msg.toolUseCount != null) {
                  if (msg.lastActivity) {
                    recentActivities = pushRecentActivity(recentActivities, msg.lastActivity);
                  }
                  if (taskId) {
                    updateAgentProgress(taskId, {
                      toolUseCount: msg.toolUseCount ?? 0,
                      tokenCount: msg.tokenCount ?? 0,
                      lastActivity: msg.lastActivity
                        ? { toolName: "", input: {}, activityDescription: msg.lastActivity }
                        : undefined,
                      // 与卡片同一份窗口（此前恒 []，面板 verbose 分支形同虚设）
                      recentActivities: recentActivities.map((d) => ({
                        toolName: "",
                        input: {},
                        activityDescription: d,
                      })),
                    });
                  }
                  onProgress?.({
                    agentType: initMsg.task_type,
                    toolUseCount: msg.toolUseCount ?? 0,
                    tokenCount: msg.tokenCount ?? 0,
                    elapsedMs: Date.now() - startTime,
                    recentActivities,
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
                throw new Error(`子代理崩溃: ${msg.error}${msg.stack ? `\n${msg.stack}` : ""}`);
            }
          }

          if (result) break;
        }
      } finally {
        // T5-B1：无论正常结束 / abort / 抛错，都释放 reader 锁，防止 stdout 流锁泄漏。
        // cancel 会同时丢弃底层缓冲并解锁；已被 kill 的进程 cancel 静默失败即可。
        try {
          await stdoutReader.cancel();
        } catch {
          /* reader 可能已释放 */
        }
        try {
          stdoutReader.releaseLock();
        } catch {
          /* 已释放 */
        }
        // 修（监听器泄漏）：移除挂在共享父 signal 上的 abort 监听器。未 abort 时它不会
        // 自动移除（once:true 仅在触发后移除），退出循环时必须显式清理。
        if (signal && onAbortListener) {
          try {
            signal.removeEventListener("abort", onAbortListener);
          } catch {
            /* ignore */
          }
        }
      }

      // 等待子进程退出
      await subprocess.exited;

      if (!result) {
        // P0-1(b)：三条无结果出口（超时 / 被中止 / 意外退出）统一交回残卷。
        //
        // 这是 §1.5(b) 四处落点的第四处。改造前三条出口都是「一句文案 + usage/turns 归零」，
        // 而 spawn 路径的工具**是父进程执行的**，父进程明明知道子代理改过哪些文件——
        // 那份信息就在手里却被丢掉，是三条出口里最可惜的一种。
        const snap = salvage.snapshot();
        const spawnUsage = { inputTokens: snap.tokenCount, outputTokens: 0 };
        // G3：区分超时 vs 意外退出。让模型知道是"跑太久被中断"而非"子进程崩溃"，
        // 便于决策（简化任务重试 vs 报错）。
        if (timedOut) {
          log.warn("SUBAGENT", `spawn 子代理墙钟到点 (${Math.round(timeout / 1000)}秒)，交回残卷`);
          return {
            success: false,
            output: buildSalvageOutput(snap, {
              reason: "timeout",
              timeoutMs: timeout,
              taskId,
              outputFile: taskId ? getTask(taskId)?.outputFile : undefined,
            }),
            usage: spawnUsage,
            turns: snap.turns,
            toolUseCount: snap.toolUseCount,
          };
        }
        // 父进程主动 abort（用户取消）导致的退出。用户取消同样要交回残卷——
        // 用户按 ESC 不代表他想丢掉子代理已经改好的文件。
        if (signal?.aborted) {
          return {
            success: false,
            output: buildSalvageOutput(snap, {
              reason: "aborted",
              taskId,
              outputFile: taskId ? getTask(taskId)?.outputFile : undefined,
            }),
            usage: spawnUsage,
            turns: snap.turns,
            toolUseCount: snap.toolUseCount,
          };
        }
        const exitCode = subprocess.exitCode;
        return {
          success: false,
          output: buildSalvageOutput(snap, {
            reason: "error",
            errorMessage: `子进程意外退出 (exit code: ${exitCode})`,
            taskId,
            outputFile: taskId ? getTask(taskId)?.outputFile : undefined,
          }),
          usage: spawnUsage,
          turns: snap.turns,
          toolUseCount: snap.toolUseCount,
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
      const decision = await this.permissionChecker.check(permReq, tool, undefined, {
        hookPermissionDecision,
      });
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
        // 与主循环/子代理 tool-executor 同源：校验失败也要 fire Failure 收尾，
        // 否则这条路径的失败（模型漏 required 字段，最高频的真实失败）
        // 既不进 hook 链也不产 execute_tool span，在 trace 里完全隐身。
        if (this.hookSystem) {
          this.hookSystem
            .firePostToolUseFailureEvent(name, effectiveInput, validation.message, undefined, {
              duration_ms: Date.now() - startTime,
            })
            .catch((e: any) =>
              log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e.message}`),
            );
        }
        return { content: validation.message, is_error: true };
      }
      // 注入 _agentId 标记，防止子代理调用 enter_plan_mode 形成套娃
      const result = await tool.execute(
        { ...(validation.data as Record<string, unknown>), _agentId: "sub-agent" },
        signal,
      );
      const elapsed = Date.now() - startTime;
      const truncated = ContextManager.truncateToolOutput(result.output);
      // post_tool_use hook（驱动 execute_tool span）
      if (this.hookSystem) {
        this.hookSystem
          .firePostToolUseEvent(
            name,
            effectiveInput,
            { output: truncated, isError: result.isError ?? false },
            result.isError ?? false,
            undefined,
            { duration_ms: elapsed },
          )
          .catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use hook 失败: ${e.message}`));
      }
      return { content: truncated, is_error: result.isError ?? false };
    } catch (err: any) {
      if (this.hookSystem) {
        this.hookSystem
          .firePostToolUseFailureEvent(
            name,
            effectiveInput,
            err.message,
            undefined,
            // 与上方成功路径 duration_ms 同口径（纯执行耗时）
            { duration_ms: Date.now() - startTime },
          )
          .catch((e: any) =>
            log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e.message}`),
          );
      }
      return { content: `工具执行异常: ${err.message}`, is_error: true };
    }
  }

  /** 内部执行逻辑（含超时控制）
   *  M5: 使用共享 runAgentLoop() 替代自维护 while 循环，对标 claude-code runAgent() */
  private async executeInner(
    task: SubAgentTask,
    signal?: AbortSignal,
    taskId?: string,
  ): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    log.info("SUBAGENT", `启动子代理 [${task.type}]: ${task.description}`);

    // 超时控制：task.timeout > env > 实测派生 > AgentDefinition.timeout > 默认 120 秒。
    // P0-1(c)：不再所有模型共用一个写死的 300s，见 timeout-budget.ts 头注释
    // （实测同会话单轮 p50=6.1s/p95=19.1s，300s 对慢模型连"读懂上下文"都不够）。
    const agentDefForTimeout = resolveAgent(task.type);
    const modelForBudget =
      task.model ?? (this.registry ? this.registry.getModelForSubAgent(task.type) : this.model);
    const budget = resolveSubAgentTimeout({
      definitionTimeoutMs: agentDefForTimeout?.timeout,
      explicitTimeoutMs: task.timeout,
      model: modelForBudget,
      fallbackMs: 120_000,
    });
    const timeout = budget.timeoutMs;

    // ── P0-1(a)：墙钟到点 = detach（转后台继续跑），**不是** abort ──
    //
    // 改造前这里是 `setTimeout(() => timeoutCtrl.abort(), timeout)`：到点直接掐死，
    // 已完成的成果被下面的超时分支整句替换成一句"超时"，1.84M input token 产出归零。
    //
    // 对齐 CC：`LocalAgentTask.tsx:582-606` 到点只置 `isBackgrounded` 标志位并 resolve
    // backgroundSignal，**没有任何 abort**（在 `AgentTool/` 与 `LocalAgentTask/` 下 grep
    // `abortController.abort()` 零命中）；且这个 auto-background 默认还是**关闭**的
    // （`AgentTool.tsx:72` 返回 0）——CC 的前台子代理默认没有墙钟上限。
    //
    // 我们保留墙钟（无人值守长任务需要一个可预期的前台返回点），但把它的语义从
    // "kill 并丢弃"改成"交回残卷 + 后台续跑"。硬 kill 只留给三种情况：
    //   ① 用户显式 task_stop（killAgentTask → activeAgentControllers）；
    //   ② 用户/父代理 abort（外层 signal，不经这里）；
    //   ③ detach 之后又跑满 timeout × HARD_KILL_MULTIPLIER —— 那已是失控不是慢。
    //
    // 为什么 detach 只有在 `_isAsync`（后台子代理）路径上才是真"续跑"：前台
    // `sub_agent` 的调用方（tool.ts runSync）在 await 这个 Promise，我们一旦提前
    // return，函数栈就走完了，续跑无处附着。所以前台路径 detach 时仍要结束执行，
    // 只是**带着残卷**结束（reason "timeout"），而后台路径能真正甩掉前台等待。
    const timeoutCtrl = new AbortController();
    /** detach 是否已触发（墙钟到点）。超时分支据此判定，不再看 `timeoutCtrl.signal.aborted`。 */
    let detached = false;
    /** detach 后的硬 kill 定时器；只有它才会真的 abort。 */
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      detached = true;
      log.warn(
        "SUBAGENT",
        `[${task.type}] 达到墙钟预算 ${Math.round(timeout / 1000)}s（来源 ${budget.source}），` +
          `转 detach：交回残卷、不终止执行（硬 kill 在 ${HARD_KILL_MULTIPLIER}× 后）`,
      );
      // 到点**不** abort。只挂硬 kill 兜底，避免 detach 后无限跑。
      hardKillTimer = setTimeout(
        () => {
          log.warn(
            "SUBAGENT",
            `[${task.type}] detach 后仍未结束，达到硬 kill 期限（${HARD_KILL_MULTIPLIER}×${Math.round(timeout / 1000)}s），终止`,
          );
          // reason 必须登记于 ABORT_REASONS（历史事故：自定义 reason 绕过 isAbortError
          // 闸门致崩溃）。detach 后的续跑没有前台 await，底层 fetch 会以这个裸字符串
          // reject，未登记就是一条孤儿 rejection。
          timeoutCtrl.abort(SUBAGENT_HARD_KILL_REASON);
        },
        timeout * (HARD_KILL_MULTIPLIER - 1),
      );
    }, timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    // try 块外部声明 ctxMgr，以便 catch 块在超时时能读取部分进度信息
    let ctxMgr: ContextManager | undefined;

    /** P0-1(b)：残卷收集器。每轮喂 onTurnEnd 快照，超时/异常分支据此交回已完成的成果。 */
    const salvage = new SalvageCollector();
    /** 上一轮结束的时刻，用于算单轮耗时喂给预算派生（timeout-budget.recordTurnLatency）。 */
    let lastTurnAt = startTime;

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
      let systemPrompt = await enhanceSubAgentPrompt(
        basePrompt,
        this.language,
        process.cwd(),
        task.type,
        agentDef?.skills,
      );

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

      // 工具过滤复用 resolveFilteredToolsForTask（与 spawn 路径共用），
      // 消除此前「进程内/spawn 两处并列调用 filterToolsForAgent、其中 spawn 那处
      // 忘记传 agentDef.tools/disallowedTools」的结构性缺陷（审计第 2 条）。
      const filteredTools = this.resolveFilteredToolsForTask(task, agentDef);
      const tools = this.buildIsolatedToolRegistry(filteredTools, task.type);
      // M2: 把 StructuredOutput 工具挂进隔离工具集(在过滤之后,确保不被裁剪掉)
      if (structuredTool) {
        tools.register(structuredTool);
      }
      // P2-2：fork 任务默认 200、常规任务默认 30，见 resolveSubAgentMaxTurns 注释。
      const maxTurns = resolveSubAgentMaxTurns(task);
      const loopDetector = new LoopDetector();

      const toolNames = filteredTools.map((t) => t.name());
      log.info(
        "SUBAGENT",
        `[${task.type}] 可用工具: ${toolNames.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`,
      );

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
      /** 最近活动滑动窗口（跨轮累积，容量 MAX_RECENT_ACTIVITIES）。
       *  onTurnEnd 拿到的 info.tools 只是**本轮**的工具，所以窗口状态必须挂在这一层。 */
      let recentActivities: string[] = [];

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
      const { getMaxThinkingTokensOverride, mapThinkingCapToEffort } =
        await import("../llm/effort.ts");
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
        // B0：两条 runAgentLoop 路径共有字段收进工厂（hookSystem / permissionChecker /
        // availability / deadlineAt / discoverJitContext），见 buildBaseLoopConfig 注释。
        ...this.buildBaseLoopConfig(ctxMgr, startTime, timeout),
        // B2（D1）：内置子代理走漏斗时的来源标签。与自定义路径（agent:custom）区分，
        // 让遥测能回答"哪类子代理在重试"——两条路径共用一个标签就丧失了这个分辨力。
        querySource: "agent:builtin",
        // 复用 masking 用的派生 sessionId：它已含 parentSessionId + taskId，
        // 天然唯一，B4 做 per-agent 状态隔离时可直接当快照 key 的身份维度。
        agentId: this.deriveSubAgentSessionId(taskId),
        onBeforeTurn: (turn) => {
          // 消费 SendMessage 注入的消息（从第 2 轮开始检查）
          if (taskId && turn > 1) {
            const injected = drainAgentMessages(taskId);
            for (const msg of injected) {
              log.info("SUBAGENT", `[${task.type}] 收到主代理消息: ${msg.slice(0, 100)}`);
              ctxMgr!.addMessage({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<system-reminder>\n[主代理消息] ${msg}\n</system-reminder>`,
                  },
                ],
              });
            }
          }
          // P1-3：消费 swarm mailbox 里的未读消息（来自 leader / peer 成员）。
          // 与主代理消息队列并列 drain，从第 2 轮起检查——首轮已带初始任务，无需重复注入。
          if (task.drainInbox && turn > 1) {
            let inboxMsgs: string[] = [];
            try {
              inboxMsgs = task.drainInbox();
            } catch {
              /* drain 失败不阻断本轮 */
            }
            for (const msg of inboxMsgs) {
              log.info("SUBAGENT", `[${task.type}] 收到团队消息: ${msg.slice(0, 100)}`);
              ctxMgr!.addMessage({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<system-reminder>\n[团队消息] ${msg}\n</system-reminder>`,
                  },
                ],
              });
            }
          }
        },
        onTurnEnd: (info) => {
          lastTextOutput = info.textOutput || lastTextOutput;
          // 真实进度直接取 runAgentLoop 累计值（token 来自 totalUsage，非伪造估算）
          toolUseCount = info.toolUseCount;
          tokenCount = info.tokenCount;

          // P0-1(b)：喂残卷收集器。onTurnEnd 在**工具执行之后**触发且带本轮工具名+入参
          // （agentic-loop.ts 的 turnToolInfo），所以在这一层就能攒出"已改动文件 / 已确认
          // 结论 / 停在哪一步"，无需改动被主路径与两条子代理路径共用的 runAgentLoop 契约。
          // try/catch 兜住：残卷是止损手段，它自己绝不能成为让子代理白跑的新故障源。
          try {
            salvage.recordTurn(info);
          } catch {
            /* 残卷收集失败不影响子代理执行 */
          }
          // P0-1(c)：单轮耗时样本喂给预算派生（下次同模型子代理据此放宽墙钟）。
          const now = Date.now();
          recordTurnLatency(modelForBudget, now - lastTurnAt);
          lastTurnAt = now;

          // P2-10：把本轮新增的对话消息落盘到 sidechain。用游标记录已持久化的消息数，
          // 每轮从 ctxMgr 取增量顺序追加，避免重复写。落盘失败不影响子代理执行。
          if (sidechain) {
            try {
              const all = ctxMgr!.getMessages();
              for (let i = sidechainCursor; i < all.length; i++) {
                const m = all[i];
                sidechain.appendMessage(
                  m.role as "user" | "assistant" | "tool",
                  m.content,
                  info.turn,
                );
              }
              sidechainCursor = all.length;
            } catch {
              /* sidechain 落盘失败静默 */
            }
          }

          // 实时写输出到磁盘（支持 task_output 增量读取）
          if (taskId && info.textOutput) {
            appendAgentOutput(taskId, `[轮次 ${info.turn}] ${info.textOutput}\n`);
          }

          // 最近活动滑动窗口：info.tools 是**本轮**的工具（agentic-loop.ts:710 的
          // turnToolInfo），不是累计——所以窗口必须在这里跨轮累积，不能每轮拿 info.tools
          // 当全量。此前 recentActivities 恒传 `[]`（死字段，方案附2），面板的 verbose
          // 展开分支因此永远走不到。
          for (const t of info.tools) {
            recentActivities = pushRecentActivity(
              recentActivities,
              describeToolActivity(t.name, t.input),
            );
          }

          // 进度回灌父工具卡片（治问题三"过程黑盒"）：与下面写 registry 并列，受众不同
          // （见 SubAgentTask._onProgress 注释）。每轮一次，不额外节流——轮次本身就是
          // 天然的时间闸门（一轮至少一次 LLM 往返），比按毫秒节流更贴合"有实质进展才刷新"。
          task._onProgress?.({
            agentType: task.type,
            toolUseCount,
            tokenCount,
            elapsedMs: Date.now() - startTime,
            recentActivities,
          });

          // 更新任务进度（供 pollTasks / TUI 实时读取）。每轮都更新——
          // 即便本轮无工具调用，token 与耗时也在推进，面板需要随之刷新。
          if (taskId) {
            const lastToolEntry =
              info.tools.length > 0 ? info.tools[info.tools.length - 1] : undefined;
            updateAgentProgress(taskId, {
              toolUseCount,
              tokenCount,
              lastActivity: lastToolEntry
                ? {
                    toolName: lastToolEntry.name,
                    input: lastToolEntry.input,
                    activityDescription: describeToolActivity(
                      lastToolEntry.name,
                      lastToolEntry.input,
                    ),
                  }
                : undefined,
              // 与卡片同一份窗口数据（此前恒 []，面板 verbose 分支形同虚设）
              recentActivities: recentActivities.map((d) => ({
                toolName: "",
                input: {},
                activityDescription: d,
              })),
            });

            // M5 opt-in: 周期性进度摘要（每 5 轮生成一次）
            if (process.env.SIDCODE_AGENT_PROGRESS_SUMMARY === "1" && info.turn % 5 === 0) {
              const toolNames = info.tools.map((t) => t.name).join(", ");
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
      log.info(
        "SUBAGENT",
        `[${task.type}] 完成，共 ${loopResult.turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`,
      );

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
        // ── P0-1(b)：超时/失败分支**不得替换** finalOutput，改为交回结构化残卷 ──
        //
        // 改造前这里是 `output = isTimeout ? "子代理执行超时 (300秒…)" : …`，把 finalOutput
        // 整句**替换**掉。实测代价：那个 explore 子代理已经读出了 Color 类型的真实定义
        // （整个任务的关键前提），主代理收到的却只有一句 `<error>子代理执行超时</error>`，
        // 1.84M input token 产出归零。
        //
        // 现在 buildSalvageOutput 把 finalText **原样置顶**再追加四段残卷（已改动文件 /
        // 已确认结论 / 未完成部分 / 建议的下一步）。判据："300s 改 600s 只是把同样的浪费
        // 翻倍，交回残卷才是止损。"
        //
        // 判"是否墙钟到点"看 `detached` 标志而**不是** `timeoutCtrl.signal.aborted`：
        // detach 语义下墙钟到点根本不 abort，signal 只在硬 kill / 外层取消时才 aborted。
        // 这与「判超时看 abort reason 白名单而非错误文本」是同一条原则的延伸——
        // 判据要对准真正表达该语义的那个状态位。
        const hardKilled = timeoutCtrl.signal.reason === SUBAGENT_HARD_KILL_REASON;
        const isTimeout = detached || hardKilled;
        // P2-10：超时/中断记为 aborted（可恢复），其余非成功记为 failed。
        sidechainStatus = isTimeout ? "aborted" : "failed";
        const snap = salvage.snapshot();
        // B5-4（缺口 D）：重试次数仍要带上（限流打满退避耗尽会被误读成"超时"，
        // 见 formatRetryHint 注释）。非超时分支的 errorMessage 里漏斗已含重试信息，不重复拼。
        const retryHint = isTimeout ? formatRetryHint(loopResult) : "";
        const output = buildSalvageOutput(snap, {
          // 前台 detach 也归 "timeout"：真正能"转后台续跑"的只有 _isAsync 路径，
          // 前台调用方在 await 我们，提前 return 就没有栈可以承载续跑（见上方 detach 注释）。
          reason: isTimeout
            ? task._isAsync === true && !hardKilled
              ? "detached"
              : "timeout"
            : "error",
          finalText: finalOutput,
          timeoutMs: timeout,
          errorMessage: isTimeout
            ? retryHint.replace(/^，/, "") || undefined
            : loopResult.errorMessage || "子代理执行未成功",
          taskId,
          outputFile: taskId ? getTask(taskId)?.outputFile : undefined,
        });
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
      // ── P0-1(b)：catch 分支同样交回残卷，且**禁止把 usage/turns 归零** ──
      //
      // 改造前这里硬写 `usage: {inputTokens:0, outputTokens:0}, turns:0, toolUseCount:0`。
      // 那是双重损失：成果丢了，连"这次烧了多少钱"都测不出来（北极星「更省」那条依赖
      // 这个数据）。归零不是保守估计，是**假数据**——它让一次 40 万 token 的失败在账上
      // 与一次零成本失败完全同形。现在按残卷里的实际累计值回填。
      const snap = salvage.snapshot();
      const hardKilled = timeoutCtrl.signal.reason === SUBAGENT_HARD_KILL_REASON;
      const isTimeout = detached || hardKilled;
      if (isTimeout) {
        log.warn("SUBAGENT", `[${task.type}] 墙钟到点抛出（${timeout}ms），交回残卷`);
      } else {
        log.error("SUBAGENT", `[${task.type}] 执行异常`, { error: err.message });
      }
      return {
        success: false,
        output: buildSalvageOutput(snap, {
          reason: isTimeout ? "timeout" : "error",
          timeoutMs: timeout,
          errorMessage: isTimeout ? undefined : err.message,
          taskId,
          outputFile: taskId ? getTask(taskId)?.outputFile : undefined,
        }),
        // ── usage 回填的口径（诚实声明，勿当精确值读）──
        //
        // 这条路径是 `runAgentLoop` **抛异常**而非正常返回，所以 `loopResult` 不存在，
        // `totalUsage`（唯一带 input/output 拆分的来源）在这里客观上拿不到。能观测到的
        // 只有 `onTurnEnd` 每轮带的 `tokenCount`，而它已经是 **input + output 之和**
        // （agentic-loop.ts:791 `totalUsage.inputTokens + totalUsage.outputTokens`）——
        // 拆分信息在进入本函数前就已经被压平了，不是我们漏读。
        //
        // 于是有三种处理，选第三种：
        //   ① 归零 —— 改造前的做法，**明确禁止**：它让一次 40 万 token 的失败在账上与
        //      一次零成本失败完全同形，是假数据而非保守估计。
        //   ② 编一个拆分比例把 sum 拆开 —— 更糟，凭空造出两个都不真的数字。
        //   ③ 把**能观测到的 sum** 如实记进 inputTokens，outputTokens 记 0 并在此注明
        //      「0 = 未观测到，不是真的为零」。
        //
        // 选 ③ 且把 sum 归到 input 侧的依据是实测量级：事故会话 4 个子代理合计
        // input 1,842,462 / output 8,873，**比值 208:1**——sum 的 99.5% 本就是 input。
        // 归到 input 侧的口径误差在 0.5% 量级，而归零的误差是 100%。
        //
        // 想要精确拆分需要改 `agentic-loop.ts` 的 onTurnEnd 契约（透出未压平的 Usage），
        // 那是独立工单：本次任务禁止改动该文件（它正被另一个 agent 并行修改）。
        usage: { inputTokens: snap.tokenCount, outputTokens: 0 },
        turns: snap.turns,
        toolUseCount: snap.toolUseCount,
      };
    } finally {
      clearTimeout(timer);
      // detach 后的硬 kill 定时器同样要清——不清会让进程多挂住 2×timeout 才退出
      // （Node/Bun 的 pending timer 会阻止事件循环空转退出）。
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      // P2-10：无论成功/失败/异常，都写 sidechain_end 收尾。sidechainStatus 默认 aborted，
      // 仅成功/明确失败分支改写——恢复扫描据此过滤已结束的 sidechain。
      sidechain?.end(sidechainStatus);
    }
  }

  /** 自定义子代理内部执行逻辑（M5: 使用共享 runAgentLoop） */
  private async executeCustomInner(
    task: CustomSubAgentTask,
    signal?: AbortSignal,
  ): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    log.info("SUBAGENT", `启动自定义子代理`);

    // 三级回退：task.timeout > env/派生 > 默认 300s（与 task 类型对齐）。
    // P0-1(c)：与内置路径共用 resolveSubAgentTimeout，避免"两条路径各写一份预算逻辑"——
    // buildBaseLoopConfig 的注释记录过同型教训（漏传 permissionChecker 是靠人工两处同步失败）。
    const customBudget = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      explicitTimeoutMs: task.timeout,
      model: this.modelOverride ?? this.model,
      fallbackMs: 300_000,
    });
    const timeout = customBudget.timeoutMs;
    const timeoutCtrl = new AbortController();
    /** P0-1(a)：墙钟到点标志。自定义路径同样不再到点即 abort，见 executeInner 的 detach 注释。 */
    let detached = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      detached = true;
      log.warn(
        "SUBAGENT",
        `[custom] 达到墙钟预算 ${Math.round(timeout / 1000)}s（来源 ${customBudget.source}），交回残卷`,
      );
      // 自定义路径（skill/agent 调用）**没有** taskId、不进 registry，所以"转后台续跑"
      // 无处附着：调用方在 await 我们，提前 return 就没有栈能承载续跑。因此这里 detach
      // 的收益只有「交回残卷」这一半，硬 kill 仍要挂——否则自定义子代理会无限跑下去。
      hardKillTimer = setTimeout(
        () => {
          log.warn("SUBAGENT", `[custom] detach 后仍未结束，硬 kill`);
          timeoutCtrl.abort(SUBAGENT_HARD_KILL_REASON);
        },
        timeout * (HARD_KILL_MULTIPLIER - 1),
      );
    }, timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    /** P0-1(b)：自定义路径的残卷收集器（与内置路径同一实现，不另写一份）。 */
    const salvage = new SalvageCollector();
    let lastTurnAt = startTime;

    // B4：观测身份必须「每次调用唯一」，而 masking 的 sessionId 刻意按 task.type
    // 复用（同类型自定义代理共用一个临时目录，见下方注释）。两者目的不同，故分开派生：
    // 复用 sessionId 当观测 id 会让两个同类型并发实例共用快照 key，隔离形同虚设。
    const observerAgentId = `${this.deriveSubAgentSessionId(task.type)}-c${++_customAgentSeq}`;

    try {
      const ctxMgr = new ContextManager({
        maxTokens: this.resolveSubAgentWindow(task),
        // 自定义子代理无 taskId，用 task.type 派生独立 masking 会话目录。
        sessionId: this.deriveSubAgentSessionId(task.type),
      });

      const systemPrompt = await enhanceSubAgentPrompt(
        task.systemPrompt,
        this.language,
        process.cwd(),
        task.type,
      );
      ctxMgr.setSystemPrompt(systemPrompt);
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.userPrompt }],
      });

      const tools =
        task.allowedTools.length > 0
          ? this.buildIsolatedToolRegistry(
              this.toolRegistry.filter(task.allowedTools).all(),
              task.type,
            )
          : new ToolRegistry();
      // P2-2：CustomSubAgentTask 无 forkMessages，resolveSubAgentMaxTurns 自然落到常规档 30。
      const maxTurns = resolveSubAgentMaxTurns(task);
      const loopDetector = new LoopDetector();

      log.info(
        "SUBAGENT",
        `[custom] 可用工具: ${task.allowedTools.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`,
      );

      // 动态获取 provider/model（registry 模式下使用 modelOverride 或主模型）
      const activeProvider = this.registry
        ? this.modelOverride
          ? this.registry.getProviderForSubAgent("task") // 自定义 agent 按 task 类型查找
          : this.registry.getProvider()
        : this.provider;
      const activeModel =
        this.modelOverride || (this.registry ? this.registry.getCurrentModel() : this.model);

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
        // B2（D1）：自定义子代理的来源标签。与内置路径（agent:builtin）区分——
        // 两条 runAgentLoop 路径都要接，只接一条就会让"自定义 agent 的重试在遥测里
        // 伪装成内置 agent"，与 P2-1 注释记录的同型隐形差异。
        querySource: "agent:custom",
        // B4：带调用序号的唯一观测身份（见上方 observerAgentId 定义处注释）。
        agentId: observerAgentId,
        // B0：两条 runAgentLoop 路径共有字段收进工厂。此前这条自定义路径唯独漏传
        // permissionChecker——权限层被整体绕过（自定义子代理调 edit/bash 不经检查），
        // 是本次修复的 P0 安全缺口。现在用工厂统一收敛，不再靠人工在两处分别记住传参。
        ...this.buildBaseLoopConfig(ctxMgr, startTime, timeout),
        sendParamsExtra: customSendParamsExtra,
        onTurnEnd: (info) => {
          lastTextOutput = info.textOutput || lastTextOutput;
          toolUseCount += info.tools.length;
          // P0-1(b)(c)：与内置路径同口径地喂残卷 + 吞吐样本。
          try {
            salvage.recordTurn(info);
          } catch {
            /* 残卷收集失败不影响子代理执行 */
          }
          const now = Date.now();
          recordTurnLatency(this.modelOverride ?? this.model, now - lastTurnAt);
          lastTurnAt = now;
        },
      });

      const totalUsage = loopResult.totalUsage;

      // 提取最终结果：从所有 assistant 消息中回溯查找最后一条有文本内容的
      const finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      log.info(
        "SUBAGENT",
        `[custom] 完成，共 ${loopResult.turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`,
      );

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
        // P0-1(b)：与内置路径同口径交回残卷，不再把 finalOutput 替换成一句"超时"。
        // 两条路径必须同时改：§1.5(b) 列了 4 处落点，只改内置那处会让 skill/自定义 agent
        // 继续丢成果，且不会有任何报错（formatRetryHint 的注释记录过同型的"两处逐字重复
        // 各改一遍必然漂移"教训）。
        const hardKilled = timeoutCtrl.signal.reason === SUBAGENT_HARD_KILL_REASON;
        const isTimeout = detached || hardKilled;
        const snap = salvage.snapshot();
        const retryHint = isTimeout ? formatRetryHint(loopResult) : "";
        const output = buildSalvageOutput(snap, {
          // 自定义路径无 taskId、不进 registry，转后台无处附着 → 一律 "timeout"，
          // 不谎报 "detached"（说了转后台却取不回来，比不说更坏）。见上方 detach 注释。
          reason: isTimeout ? "timeout" : "error",
          finalText: finalOutput,
          timeoutMs: timeout,
          errorMessage: isTimeout
            ? retryHint.replace(/^，/, "") || undefined
            : loopResult.errorMessage || "子代理执行未成功",
        });
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
      // P0-1(b)：catch 分支同样交回残卷，usage/turns 不归零（口径说明见 executeInner 同位注释）。
      const snap = salvage.snapshot();
      const hardKilled = timeoutCtrl.signal.reason === SUBAGENT_HARD_KILL_REASON;
      const isTimeout = detached || hardKilled;
      if (isTimeout) {
        log.warn("SUBAGENT", `[custom] 墙钟到点抛出（${timeout}ms），交回残卷`);
      } else {
        log.error("SUBAGENT", `[custom] 执行异常`, { error: err.message });
      }
      return {
        success: false,
        output: buildSalvageOutput(snap, {
          reason: isTimeout ? "timeout" : "error",
          timeoutMs: timeout,
          errorMessage: isTimeout ? undefined : err.message,
        }),
        usage: { inputTokens: snap.tokenCount, outputTokens: 0 },
        turns: snap.turns,
        toolUseCount: snap.toolUseCount,
      };
    } finally {
      clearTimeout(timer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
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
      if (
        !replacement &&
        agentType &&
        t.name() === "save_memory" &&
        typeof (t as any).withAgentType === "function"
      ) {
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
  private extractFinalText(
    messages: Array<{ role: string; content: ContentBlock[] }>,
    fallback: string,
  ): string {
    // 倒序遍历所有消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      const texts = (msg.content as ContentBlock[])
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
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
    const lines = text.split("\n").filter((l) => l.trim());
    // 长文本通常包含结论（有实质内容）
    if (lines.length > 5) return false;
    // 含结构化标记（标题 / 表格 / 列表）的不是纯 thinking
    if (lines.some((l) => /^#{1,3}\s|^\||\*\*/.test(l.trim()))) return false;
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
    return lines.every((l) => planningPatterns.some((p) => p.test(l.trim())));
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
