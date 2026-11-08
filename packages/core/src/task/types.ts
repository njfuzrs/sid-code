/**
 * Task 类型体系
 * 统一的并发执行单元抽象，为后台 Shell 和后台 Agent 提供共享的类型定义
 */

import { randomBytes } from "crypto";

/** 任务类型 */
export type TaskType = "local_shell" | "local_agent" | "local_workflow" | "local_monitor";

/** 任务状态机：pending → running → completed | failed | killed */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

/** Agent 进度信息 */
export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription?: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[];
}

/** Agent 任务结构化结果（对标 claude-code AgentToolResult）
 *  替代原来的纯字符串 result，保留 usage、工具调用次数等结构化信息 */
export interface AgentTaskResult {
  /** 文本输出（子代理的最终结论） */
  output: string;
  /** 工具调用次数 */
  totalToolUseCount: number;
  /** 总 token 消耗 */
  totalTokens: number;
  /** LLM 用量明细 */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** 任务状态基类 */
export interface TaskStateBase {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
  /** 终态已写入、完成信息已有投递通道（入队通知 / 前台 tool_result）。**不是**「已送达模型」——
   *  送达看 `notificationDeliveredTurn`（S3：两者混为一谈正是 `.output` 被提前删的根因）。 */
  notified: boolean;
  /**
   * 完成通知**送达模型**时的回合纪元（registry `getTurnEpoch()`），未送达为 undefined。
   *
   * 由 `markNotificationsDelivered` 在 `injectPendingNotifications` 里置位；前台子代理
   * （notify=false，结果走 tool_result）在终态写入时直接置位。驱逐判据要求
   * 「送达之后主循环又完整跑完至少一个回合」，按回合而不是按毫秒——单次调用可长达
   * 116s（S3 事故 call 40），任何固定毫秒窗口都会被越过。
   */
  notificationDeliveredTurn?: number;
  /**
   * 终态结果**由哪条自动通道送达**（单次所有权，`claimResultDelivery` 首次认领后不再变）。
   *
   * 与 `notified` 刻意分开：`notified` 表示「有了投递通道」，在入队**之前**就置位，驱逐判据
   * 与 S3 修复都依赖这个语义，不能借用。本字段回答的是另一个问题——这份结果是否已被
   * 某一路送进模型上下文，另一路就不该再自动送一遍（20261019 双投递：同一结论三份）。
   * - `notification`：完成通知已注入；之后 task_output 读到属于模型的显式重读，照常返回；
   * - `tool_result`：task_output / 前台 tool_result 已送达；队列里的终态通知须撤回 / 跳过。
   */
  resultDeliveredVia?: "notification" | "tool_result";
  /** task_output 读取续期截止时间（LRU touch）。**只由 task_output 写**，终态写入点不再写它：
   *  驱逐判据由 registry 统一计算（见 `isEvictable`），散落 9 处的固定计时已收口。 */
  evictAfter?: number;
  /**
   * 用户已手动从面板划掉这条终态条目（Ctrl+X），面板**立即**不再显示它。
   *
   * 为什么要独立字段、而不是像 cc 那样把 `evictAfter` 设成 0 当哨兵
   * （`teammateViewHelpers.ts:126` 的 `evictAfter === 0` + 面板过滤器 `evictAfter !== 0`）：
   * cc 让一个字段背了三种语义（`undefined`=无期限 / `0`=立即隐藏 / 时间戳=到点隐藏），
   * 读代码时 `evictAfter !== 0` 完全看不出是在判断"用户手动划掉了"。这里拆成显式布尔，
   * 语义自明；`evictAfter` 回归单一含义"缓冲期截止时间戳"。
   *
   * 边界：这是**纯 UI 可见性**标记，只有面板消费它（见 `isPanelVisible`）。
   * `bg_task_list` / `/ps` 仍照常报这条任务——用户把条目从面板划掉，不代表
   * "这个任务不曾存在"，模型该查得到。
   */
  dismissed?: boolean;
  /**
   * 任务进入终态那一刻的「人工等待累计值」（`humanInputWaitElapsedMs()` 快照）。
   *
   * 安全阀（`UNDELIVERED_SAFETY_VALVE_MS`）兜的是「主循环不转了」，而主循环阻塞在
   * fallback 询问 / 权限弹窗 / MCP elicitation 里也满足「完成通知没送达」——
   * 那段时间通知是会送达的，只是在等用户作答。所以驱逐判据要把「终态之后新增的
   * 等待时长」从时钟里扣掉，扣减基线就是本字段。
   *
   * 由 `updateTask` 在「非终态 → 终态」的跃迁上写入；缺省（旧任务 / 直接注册成终态）
   * 视为 0，即不扣等待——与引入本字段之前的行为一致。
   */
  hitlWaitAtTerminalMs?: number;
}

/** Shell 任务状态 */
export interface LocalShellTaskState extends TaskStateBase {
  type: "local_shell";
  command: string;
  exitCode?: number;
  interrupted: boolean;
  isBackgrounded: boolean;
  agentId?: string;
}

/** Agent 任务状态 */
export interface LocalAgentTaskState extends TaskStateBase {
  type: "local_agent";
  agentId: string;
  agentType: string;
  prompt: string;
  model?: string;
  result?: AgentTaskResult;
  error?: string;
  isBackgrounded: boolean;
  progress?: AgentProgress;
  /** 周期性进度摘要（M5 opt-in 双轨特性） */
  progressSummary?: string;
  /**
   * 子代理执行时的工作目录（仅显式指定 cwd 时记录，典型是 isolation=worktree 的隔离工作区）。
   * send_message 续跑靠它回到原工作区：不记的话续跑落到主会话 cwd，
   * 隔离 agent 一续跑就直接写主仓（PR #398 review）。
   */
  cwd?: string;
  /**
   * 子代理 sidechain transcript 的落盘路径（F3-5）。
   *
   * `.output` 会被驱逐删除，sidechain **不会**（它按会话归档，随会话目录保留）。
   * 墓碑（`formatTaskOutputTombstone`）靠它给出「数据其实还在，去这里找」的指针——
   * 事故本会话里模型读到「清理前未留存到输出内容」就以为成果丢了，然后自己重做了
   * 一遍（输入从 81k 涨到 313k）。
   *
   * 缺省（父会话 id 缺失 / sidechain 写入失败）时不写，墓碑退回旧文案。
   */
  sidechainFile?: string;
}

/** Workflow 任务状态（Dynamic Workflows M6:后台运行的编排脚本） */
export interface LocalWorkflowTaskState extends TaskStateBase {
  type: "local_workflow";
  /** workflow 名(来自脚本 meta.name) */
  workflowName: string;
  /** 运行 ID(wf_<...>,用于 resume) */
  runId: string;
  /** 脚本来源摘要(name / scriptPath / inline) */
  source: string;
  /** 已发起的 agent 调用数(进度可观测) */
  agentCount?: number;
  /** 当前 phase 标题 */
  currentPhase?: string;
  /** 完成后的结构化结果(JSON 序列化) */
  result?: AgentTaskResult;
  error?: string;
  isBackgrounded: boolean;
  progress?: AgentProgress;
}

/**
 * Monitor 任务状态（M1：按行事件监控外部状态）。
 *
 * 与 shell 任务的关键差异（这三点决定了它必须单列一个类型，而不是复用 `local_shell`）：
 * 1. **有硬期限**：`deadlineAt` 是承诺（`registerWait` 的 deadline 源），到期由 harness
 *    自己的定时器 kill + 通知，不依赖子进程配合。普通后台 shell 没有这个承诺。
 * 2. **stdout 是事件流**：每一行都会变成一条通知，所以父进程持有 pipe 而不是直接把
 *    stdout 交给文件描述符（`local_shell` 是 `stdio: [ignore, outFd, outFd]`）。
 * 3. **不进 `isAwaitedBackgroundTask` 的静默判据**：`isShellTask` 为假，60s 静默不会
 *    把它判成「不值得等」——它有期限，期限就是它的承诺。
 */
export interface LocalMonitorTaskState extends TaskStateBase {
  type: "local_monitor";
  /** 展示/通知用的原始命令（面板 Ctrl+O 展开时看） */
  command: string;
  /** 硬期限（墙钟毫秒）。到期由 harness 定时器 kill + 发 killed 通知。 */
  deadlineAt: number;
  /** 已投递的事件通知条数（面板统计列 + bg_task_list 的进展签名） */
  eventCount: number;
  /** 非正常结束的原因（到期 / 事件过密 / 累计过多），终态通知据此选文案 */
  stopReason?: "timeout" | "rate_burst" | "rate_total";
  /** 被限流合并掉的原始行数（事件过密判定用，只进通知，不上面板） */
  mergedLineCount?: number;
  /** 恒为 true：monitor 进后台面板（见 `isPanelTask`）。与 shell 一样显式声明，
   *  不用「有 outputFile 就算后台」这种推断——那会让前台路径漏标时静默漏上面板。 */
  isBackgrounded: boolean;
}

/** 联合类型 */
export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | LocalWorkflowTaskState
  | LocalMonitorTaskState;

/**
 * 面板/后台可见性的**唯一闸门**（对标 claude-code `isPanelAgentTask`）。
 *
 * 所有「后台任务面板 / pill / 计数 / 模型可见的后台任务清单」消费端**必须**走这个谓词，
 * 各自另写 filter 就会漂移——问题一（前台子代理同时渲染成 `⏺ sub_agent explore` 工具卡片
 * 与面板 `[AG explore]` 行）正是漂移的产物：源头把前台子代理也标成 `isBackgrounded: true`，
 * 而渲染端从不问"这个任务该不该上面板"。**要改闸门，只改这里。**
 *
 * 判据用显式布尔字段 `isBackgrounded`，不用 cc 的 `agentType !== 'main-session'`
 * 字符串魔法值：语义自明，且不依赖 agentType 命名约定。
 *
 * 边界（哪些消费端该走、哪些不该）：
 * - **该走**：面板（state-bridge）、`bg_task_list` 工具、`/ps` 的后台任务区、
 *   Ctrl+F 终止全部后台任务、注入系统提示词的 `<task-statuses>` 附件。
 *   共同点是它们都在回答"当前有哪些**后台**任务在跑"。
 * - **不该走**：领域专用清单，如 `/workflows` 按 `isWorkflowTask` 列 workflow 运行态——
 *   它问的是"有哪些 workflow"，不是"有哪些后台任务"，套面板闸门是张冠李戴。
 */
export function isPanelTask(task: TaskState): boolean {
  return task.isBackgrounded === true;
}

/**
 * 面板**当前该不该渲染**这条任务 = 是后台任务（`isPanelTask`）且用户没手动划掉它。
 *
 * 与 `isPanelTask` 的分工（两者都要，别合并成一个）：
 * - `isPanelTask` 回答**归属**——"这是一个后台任务吗"。稳定属性，
 *   `bg_task_list` / `/ps` / `<task-statuses>` / Ctrl+F 全都问这个，它们不关心用户划没划。
 * - `isPanelVisible` 回答**此刻可见性**——只有 TUI 面板（state-bridge）问这个。
 *
 * 对标 cc `CoordinatorAgentStatus.tsx:32` 的 `isPanelAgentTask(t) && t.evictAfter !== 0`：
 * 同样是"归属谓词 && 未被划掉"两段，只是把 cc 的 `evictAfter !== 0` 哨兵换成显式
 * `!dismissed`（见 `TaskStateBase.dismissed` 的说明）。
 */
export function isPanelVisible(task: TaskState): boolean {
  return isPanelTask(task) && task.dismissed !== true;
}

/** 类型守卫 */
export function isShellTask(task: TaskState): task is LocalShellTaskState {
  return task.type === "local_shell";
}

export function isAgentTask(task: TaskState): task is LocalAgentTaskState {
  return task.type === "local_agent";
}

export function isWorkflowTask(task: TaskState): task is LocalWorkflowTaskState {
  return task.type === "local_workflow";
}

/**
 * monitor 任务守卫。
 *
 * ⚠️ 刻意**不**让 `isShellTask` 覆盖它：monitor 有硬期限，不走「60s 静默判成不值得等」
 * 的 shell 语义（见 `wait-registry.ts` 的派生分支）。任何按类型分派 kill / 通知的地方
 * 都要单独处理它，不能因为「它也是 spawn 子进程」就套 shell 的路径。
 */
export function isMonitorTask(task: TaskState): task is LocalMonitorTaskState {
  return task.type === "local_monitor";
}

/** Task ID 生成：类型前缀 + 8 位随机字符 */
const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_shell: "s",
  local_agent: "a",
  local_workflow: "w",
  // m 前缀：与 shell(s)/agent(a)/workflow(w) 一致的单字母风格。monitor 事件通知里
  // 模型会看到这个 id（`task_stop m7k2`），短前缀比 `mon_` 更省 token。
  local_monitor: "m",
};

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type];
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return id;
}
