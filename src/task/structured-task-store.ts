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
// 团队命名空间（同一 Map 内按 metadata.team 分区）
//
// 本 store 是模块级单例，同时服务两类消费方：
//   ① 主会话 LLM 的 TODO 清单（task_create/task_update/task_list/task_get），无 team 标记；
//   ② swarm TeamManager 的共享任务列表，建任务时打 metadata.team = <团队名>。
// 二者混在一个 Map 里，若团队侧用全量 clear/serialize，会连带清掉/落盘主会话任务。
// 故团队侧一律走下面这组带 teamName 的分区 API，全量 API 只留给主会话与测试。
// ============================================================

/** 任务是否属于指定团队分区。 */
function belongsToTeam(task: StructuredTask, teamName: string): boolean {
  return (task.metadata as { team?: unknown })?.team === teamName;
}

/** 取某团队分区内的全部任务（按数字 ID 升序）。 */
export function getTeamTasks(teamName: string): StructuredTask[] {
  return getAllStructuredTasks().filter((t) => belongsToTeam(t, teamName));
}

/**
 * 只清除某团队分区的任务（主会话 TODO 与其他团队不受影响）。
 * 同时摘除被删任务的依赖边，避免残留悬空引用。
 */
export function clearTeamTasks(teamName: string): void {
  for (const t of getTeamTasks(teamName)) {
    detachDependencies(t.id);
    tasks.delete(t.id);
  }
}

/** 序列化某团队分区的任务快照（深拷贝）。 */
export function serializeTeamTasks(teamName: string): StructuredTask[] {
  return getTeamTasks(teamName).map((t) => ({
    ...t,
    blocks: [...t.blocks],
    blockedBy: [...t.blockedBy],
    metadata: { ...t.metadata },
  }));
}

/**
 * 把某团队分区的快照恢复进内存态（只替换该团队的任务，不动主会话/其他团队）。
 *
 * ID 冲突处理：快照里的 ID 可能与当前内存态已有的**其他**任务（主会话 TODO / 另一团队）
 * 撞车——团队任务文件是独立落盘的，各自 ID 空间从 1 开始。撞车时把该任务重映射到一个
 * 新 ID，并按映射表同步重写 blocks/blockedBy，保证依赖图在合并后依然自洽。
 * 指向快照外未知 ID 的边直接丢弃（对端已不存在，留着只会永久阻塞）。
 *
 * @returns oldId → newId 的重映射表（未改变的 ID 也在表内，方便调用方统一查表）
 */
export function restoreTeamTasks(
  teamName: string,
  snapshot: StructuredTask[],
): Map<string, string> {
  // 先清掉该团队现存任务，避免与快照重复（同一 ID 视为同一任务的旧态）。
  clearTeamTasks(teamName);

  const valid = snapshot.filter(
    (t) => t && typeof t.id === "string" && typeof t.subject === "string",
  );

  // 第一遍：分配最终 ID（撞车则取新 ID）。
  const idMap = new Map<string, string>();
  for (const t of valid) {
    idMap.set(t.id, tasks.has(t.id) ? nextId() : t.id);
  }

  // 第二遍：按映射表落盘任务 + 重写依赖边。
  const remapEdges = (ids: unknown): string[] =>
    Array.isArray(ids)
      ? (ids as string[]).map((x) => idMap.get(x)).filter((x): x is string => !!x)
      : [];

  for (const t of valid) {
    const id = idMap.get(t.id)!;
    tasks.set(id, {
      ...t,
      id,
      blocks: remapEdges(t.blocks),
      blockedBy: remapEdges(t.blockedBy),
      metadata:
        t.metadata && typeof t.metadata === "object"
          ? { ...t.metadata, team: teamName }
          : { team: teamName },
    });
    // 保持 idCounter 高于所有已用数字 ID，防后续新建撞车。
    const n = Number(id);
    if (Number.isFinite(n) && n > idCounter) idCounter = n;
  }

  return idMap;
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

/** 任务是否预分配给了某个具体成员（metadata.member 非空）。 */
export function isPreassignedTask(task: StructuredTask): boolean {
  const m = (task.metadata as { member?: unknown })?.member;
  return typeof m === "string" && m.length > 0;
}

/**
 * 认领下一个可执行任务（P2-2 team 成员自协调调度）。
 *
 * 挑选首个 `pending` 且 `isTaskUnblocked`（所有上游已完成）的任务，
 * 置 owner + in_progress 后返回；无可认领任务返回 undefined。
 * 按数字 ID 升序挑选，保证认领顺序稳定可预测。
 *
 * @param teamName 限定只在该团队分区内认领（团队调度必传）。省略则在全部任务里挑，
 *                 仅供测试/单团队场景——生产路径一律传团队名，避免抢走主会话 TODO。
 * @param opts.onlyUnassigned 只认领**未预分配**的共享池任务（跳过 metadata.member 已指定
 *                 给某成员的任务）。团队共享池调度必传 true，否则成员会互相抢走对方的活。
 */
export function claimNextUnblockedTask(
  owner: string,
  teamName?: string,
  opts?: { onlyUnassigned?: boolean },
): StructuredTask | undefined {
  const pool = teamName ? getTeamTasks(teamName) : getAllStructuredTasks();
  for (const task of pool) {
    if (task.status !== "pending") continue;
    if (opts?.onlyUnassigned && isPreassignedTask(task)) continue;
    if (!isTaskUnblocked(task)) continue;
    task.owner = owner;
    task.status = "in_progress";
    task.updatedAt = Date.now();
    return task;
  }
  return undefined;
}

/**
 * 是否还有未完成（pending/in_progress）的任务。供调度循环判断终止。
 * @param teamName 限定只看该团队分区（团队调度循环必传，否则主会话 TODO 会让循环永不退出）。
 */
export function hasUnfinishedTasks(teamName?: string): boolean {
  const pool = teamName ? getTeamTasks(teamName) : Array.from(tasks.values());
  for (const t of pool) {
    if (t.status === "pending" || t.status === "in_progress") return true;
  }
  return false;
}

/** 测试辅助：清空全部结构化任务并重置 ID 计数。 */
export function __clearStructuredTasks(): void {
  tasks.clear();
  idCounter = 0;
}
