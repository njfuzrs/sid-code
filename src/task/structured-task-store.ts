/**
 * 结构化任务清单存储（对标 claude-code TaskCreate/TaskUpdate/TaskGet/TaskList）
 *
 * 与「后台任务注册表」（src/task/index.ts，管 shell/agent/workflow 运行态）是两个不同语义族：
 * - 后台任务：按 task_id 读输出/停止，对应 CC 的 TaskOutput/TaskStop。
 * - 结构化清单：带依赖关系（blocks/blockedBy）与归属（owner）的持久化 TODO 系统，
 *   服务 agent swarms / teams 派活，对应 CC 的 TaskCreate/TaskUpdate/TaskGet/TaskList。
 *
 * 本模块只负责内存态存储 + 依赖图维护，不涉及运行态调度。
 */

export type StructuredTaskStatus = "pending" | "in_progress" | "completed";

export interface StructuredTask {
  /** 自增数字 ID（字符串形式，如 "1"、"2"），对齐 CC 简洁可读的清单 ID */
  id: string;
  subject: string;
  description: string;
  status: StructuredTaskStatus;
  /** in_progress 时 spinner 展示的进行时描述（如 "Running tests"） */
  activeForm?: string;
  /** 归属的 agent 名（teams 派活用），空表示未认领 */
  owner?: string;
  /** 本任务完成后才能开始的下游任务 ID（本任务 blocks 它们） */
  blocks: string[];
  /** 必须先完成、否则本任务不能开始的上游任务 ID（它们 block 本任务） */
  blockedBy: string[];
  /** 任意元数据 */
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** 内存态清单：id → 任务。 */
const tasks = new Map<string, StructuredTask>();
let idCounter = 0;

/** 生成下一个自增 ID（字符串）。 */
function nextId(): string {
  return String(++idCounter);
}

export interface CreateStructuredTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

/** 新建任务，初始 status=pending，无依赖。 */
export function createStructuredTask(input: CreateStructuredTaskInput): StructuredTask {
  const now = Date.now();
  const task: StructuredTask = {
    id: nextId(),
    subject: input.subject,
    description: input.description,
    status: "pending",
    activeForm: input.activeForm,
    owner: undefined,
    blocks: [],
    blockedBy: [],
    metadata: input.metadata ? { ...input.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);
  return task;
}

export function getStructuredTask(id: string): StructuredTask | undefined {
  return tasks.get(id);
}

export function getAllStructuredTasks(): StructuredTask[] {
  // 按数字 ID 升序返回，保证清单展示稳定
  return Array.from(tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

export interface UpdateStructuredTaskInput {
  status?: StructuredTaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  /** 合并进 metadata；值为 null 的键表示删除该键 */
  metadata?: Record<string, unknown>;
  /** 本任务 blocks 的下游任务 ID（会同步维护对端 blockedBy） */
  addBlocks?: string[];
  /** block 本任务的上游任务 ID（会同步维护对端 blocks） */
  addBlockedBy?: string[];
}

export interface UpdateResult {
  ok: boolean;
  /** 失败原因（任务不存在 / 引用了不存在的依赖 / 依赖成环） */
  error?: string;
  task?: StructuredTask;
  /** status=deleted 时为 true */
  deleted?: boolean;
}

/**
 * 检测「若在 fromId → toId 之间加一条 blocks 边（from 完成后 to 才能开始）」是否成环。
 * 沿 blocks 方向从 toId 出发做 DFS，若能回到 fromId 说明成环。
 */
function wouldCreateCycle(fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const visited = new Set<string>();
  const stack = [toId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const t = tasks.get(cur);
    if (t) stack.push(...t.blocks);
  }
  return false;
}

/** 加一条依赖边：blockerId 完成后 blockedId 才能开始。同步维护双向引用。 */
function addDependencyEdge(blockerId: string, blockedId: string): string | undefined {
  const blocker = tasks.get(blockerId);
  const blocked = tasks.get(blockedId);
  if (!blocker) return `依赖任务 "${blockerId}" 不存在`;
  if (!blocked) return `依赖任务 "${blockedId}" 不存在`;
  // blocker.blocks 追加 blockedId：即 blocker → blocked 的边。检测是否成环。
  if (wouldCreateCycle(blockerId, blockedId)) {
    return `添加依赖会导致循环依赖（${blockerId} ↔ ${blockedId}）`;
  }
  if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
  return undefined;
}

/** 从依赖图里彻底摘除某任务的所有边（删除任务时用）。 */
function detachDependencies(id: string): void {
  for (const t of tasks.values()) {
    t.blocks = t.blocks.filter((x) => x !== id);
    t.blockedBy = t.blockedBy.filter((x) => x !== id);
  }
}

/** 更新任务。status="deleted" 时删除任务并摘除其依赖边。 */
export function updateStructuredTask(id: string, input: UpdateStructuredTaskInput): UpdateResult {
  const task = tasks.get(id);
  if (!task) return { ok: false, error: `任务 "${id}" 不存在` };

  // 删除：摘边 + 移除
  if (input.status === "deleted") {
    detachDependencies(id);
    tasks.delete(id);
    return { ok: true, deleted: true };
  }

  // 依赖边（先校验后写，任一失败整体不生效）
  if (input.addBlocks) {
    for (const toId of input.addBlocks) {
      const err = addDependencyEdge(id, toId); // 本任务完成后 toId 才能开始
      if (err) return { ok: false, error: err };
    }
  }
  if (input.addBlockedBy) {
    for (const fromId of input.addBlockedBy) {
      const err = addDependencyEdge(fromId, id); // fromId 完成后本任务才能开始
      if (err) return { ok: false, error: err };
    }
  }

  if (input.status !== undefined) task.status = input.status;
  if (input.subject !== undefined) task.subject = input.subject;
  if (input.description !== undefined) task.description = input.description;
  if (input.activeForm !== undefined) task.activeForm = input.activeForm;
  if (input.owner !== undefined) task.owner = input.owner;
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      if (v === null) delete task.metadata[k];
      else task.metadata[k] = v;
    }
  }
  task.updatedAt = Date.now();
  return { ok: true, task };
}

/** 某任务是否可被认领/开始：blockedBy 里所有上游任务都已完成或已不存在。 */
export function isTaskUnblocked(task: StructuredTask): boolean {
  return task.blockedBy.every((depId) => {
    const dep = tasks.get(depId);
    return !dep || dep.status === "completed";
  });
}

// ============================================================
// P2-2：持久化快照 + 认领调度（供 swarm team 共享任务列表用）
// ============================================================

/** 序列化当前全部任务为可落盘的快照（深拷贝，隔离外部改动）。 */
export function serializeStructuredTasks(): StructuredTask[] {
  return getAllStructuredTasks().map((t) => ({
    ...t,
    blocks: [...t.blocks],
    blockedBy: [...t.blockedBy],
    metadata: { ...t.metadata },
  }));
}

/**
 * 从快照恢复任务（P2-2 进程重启/团队接续）。替换当前内存态，
 * 并把 idCounter 重置为快照里的最大数字 ID，避免新建任务 ID 撞车。
 * 非法条目（缺 id/subject）跳过。
 */
export function restoreStructuredTasks(snapshot: StructuredTask[]): void {
  tasks.clear();
  idCounter = 0;
  let maxId = 0;
  for (const t of snapshot) {
    if (!t || typeof t.id !== "string" || typeof t.subject !== "string") continue;
    tasks.set(t.id, {
      ...t,
      blocks: Array.isArray(t.blocks) ? [...t.blocks] : [],
      blockedBy: Array.isArray(t.blockedBy) ? [...t.blockedBy] : [],
      metadata: t.metadata && typeof t.metadata === "object" ? { ...t.metadata } : {},
    });
    const n = Number(t.id);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  }
  idCounter = maxId;
}

/**
 * 认领下一个可执行任务（P2-2 team 成员自协调调度）。
 *
 * 挑选首个 `pending` 且 `isTaskUnblocked`（所有上游已完成）的任务，
 * 置 owner + in_progress 后返回；无可认领任务返回 undefined。
 * 按数字 ID 升序挑选，保证认领顺序稳定可预测。
 */
export function claimNextUnblockedTask(owner: string): StructuredTask | undefined {
  for (const task of getAllStructuredTasks()) {
    if (task.status !== "pending") continue;
    if (!isTaskUnblocked(task)) continue;
    task.owner = owner;
    task.status = "in_progress";
    task.updatedAt = Date.now();
    return task;
  }
  return undefined;
}

/** 是否还有未完成（pending/in_progress）的任务。供调度循环判断终止。 */
export function hasUnfinishedTasks(): boolean {
  for (const t of tasks.values()) {
    if (t.status === "pending" || t.status === "in_progress") return true;
  }
  return false;
}

/** 测试辅助：清空全部结构化任务并重置 ID 计数。 */
export function __clearStructuredTasks(): void {
  tasks.clear();
  idCounter = 0;
}
