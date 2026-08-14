/**
 * 实测进展信号（P1-4 item 1）：把"进展"从 todo 标记这一个代理指标，改为真实副作用信号
 *
 * 背景（会话 20260810-214525-2df54593，8 分 44 秒绕圈、约 30 轮、edit 次数 = 0）：
 * work-log 回注给模型的"已完成 N 项"唯一数据源是 todo 状态（`snapshotFromTodos`）。模型全程
 * 只调了 3 次 todo_write 且每次 `completed: 0`，于是 harness 每 8 轮告诉它"已完成 0 项：（无）"。
 * **而同期真实进展是 7 个文件已落盘、可量化检查指标从 139 降到 113。** 这个假信号形成正反馈：
 *
 *   模型没标 completed → work-log 报"已完成 0 项" → 模型以为自己白干了
 *     → 重新梳理策略而不是继续干 → 更不会去标 completed ┐
 *     └──────────────────────────────────────────────────┘
 *
 * 本模块提供 todo 之外的**第二个进展事实源**，两个维度：
 *   1. `filesChanged`：edit/write/notebook_edit 真实落盘过哪些文件——这是不可伪造的副作用；
 *   2. `metrics`：**可量化观测值**的首末变化（如 139 → 113）。
 *
 * ⚠ 为什么第 2 维刻意不硬编码 "tsc" / "错误数" / "测试通过数"：
 * harness 不知道、也不该知道用户项目的检查命令是什么（tsc / cargo check / pytest / make lint /
 * 自研脚本），把命令名写进 harness 等于只对 TypeScript 项目有效，换个语言这条信号就静默失效——
 * 而"静默失效的信号"比没有信号更糟（它会让下一轮排查以为这里已经有覆盖）。
 * 改用**形态判据**：同一条命令被反复执行、其输出可解析成单个标量 → 就是一个可量化观测值，
 * 首末值不同即为"世界确实变了"。`grep -c` / `wc -l` / 自研脚本吐一个数字，全都天然命中，
 * 且方向不做解释（只报 139 → 113，不判定"降了就是好"）——是升是降由模型自己结合任务判断，
 * harness 不替它下价值判断，避免"错误数升高但那是新增测试暴露出来的"这类误导。
 *
 * 设计原则：纯数据 + 纯函数，副作用（何时记录、何时读取）留在 loop.ts，便于单测。
 */

/**
 * 有文件落盘副作用的工具名单。
 *
 * 判据是"执行成功后磁盘上的文件内容会变"，这类调用是**不可伪造的进展证据**。
 * 刻意不含 todo_write：它写的是清单本身，把它算进"真实进展"会让本模块退化回
 * "只数 todo"——那正是本次要消掉的假信号来源。
 * 也不含 bash：bash 可能在写文件（`sed -i`）也可能只是探查，无法从工具名判定，
 * 宁可漏报不误报（漏报只是少一条证据，误报会让停滞被当成进展而撤掉催更）。
 */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "notebook_edit"]);

/** 某个可量化观测值的变化记录。 */
export interface MetricObservation {
  /** 观测来源的可读标签（命令原文，截断后用于回注文案）。 */
  label: string;
  /** 首次观测到的值。 */
  first: number;
  /** 最近一次观测到的值。 */
  last: number;
  /** 观测次数（同一条命令跑了几遍）。 */
  count: number;
}

/** 实测进展状态（会话级累积，挂 SessionState —— 见下方 MEASURED_PROGRESS_KEY 注释）。 */
export interface MeasuredProgressState {
  /** 已真实落盘改动过的文件路径（去重）。 */
  filesChanged: Set<string>;
  /** 可量化观测值：命令标签 → 首末值。 */
  metrics: Map<string, MetricObservation>;
}

/**
 * 状态存放在 SessionState 而非 LoopState 的理由（与 LAST_TODO_WRITE_VERSION_KEY 同构）：
 * LoopState 每条用户消息重建，而"这个会话已经改过哪些文件"是**跨用户消息的会话级事实**。
 * 放 LoopState 会让用户追问一句（新消息）就把已有进展清零，work-log 立刻退回报"已完成 0 项"
 * ——本次要修的假信号会以另一种形式复活。
 */
export const MEASURED_PROGRESS_KEY = "measuredProgressState";

/** 创建空状态。 */
export function createMeasuredProgressState(): MeasuredProgressState {
  return { filesChanged: new Set(), metrics: new Map() };
}

/** 回注文案里每个维度最多列几项（防止长任务把 reminder 撑爆、伤 prompt cache）。 */
export const MAX_LISTED_FILES = 8;
export const MAX_LISTED_METRICS = 3;

/** 观测标签的截断长度（命令原文可能很长，只用于人/模型辨认是哪条命令）。 */
const MAX_LABEL_LEN = 120;

/**
 * 把一条命令输出解析成单个标量；不是"单标量输出"则返回 null。
 *
 * 判据刻意极窄——**整个输出 trim 后恰好是一个数字**。这正是"低信息量观测"的形态特征
 * （`grep -c` / `wc -l` / `... | wc -l` 只回一个计数），也是它能当量化指标的前提。
 * 多行输出不解析：那种输出本身已含可执行信息，模型不需要 harness 替它提炼。
 *
 * `wc -l file` 的输出是 `      12 /tmp/e.txt`（数字 + 文件名），也接受——取第一个 token，
 * 但要求剩余部分不含数字以外的第二个数值，避免把 `139 errors in 34 files` 当成单标量
 * （那种输出有两个数，取哪个都可能错）。
 */
export function extractScalarMetric(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  // bash 工具把空输出替换成这个哨兵（bash.ts），它不是数值。
  if (trimmed === "(命令无输出)") return null;
  if (trimmed.includes("\n")) return null;

  // 形态 1：整个输出就是一个数字。
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // 形态 2：`wc -l` 风格——数字 + 一个不含数字的尾巴（通常是文件名）。
  const m = /^(-?\d+(?:\.\d+)?)\s+(\S.*)$/.exec(trimmed);
  if (m && !/\d/.test(m[2])) return Number(m[1]);

  return null;
}

/** 记录一次文件落盘副作用。路径为空则忽略。 */
export function recordFileChange(state: MeasuredProgressState, filePath: unknown): void {
  if (typeof filePath !== "string") return;
  const p = filePath.trim();
  if (p) state.filesChanged.add(p);
}

/**
 * 记录一次可量化观测。输出不是单标量则什么都不做（不是所有命令都能当指标）。
 *
 * 同一 label 首次记 first，后续只更新 last —— 于是 `first !== last` 就等价于
 * "这个可量化观测值确实变了"，无需保存全部历史。
 */
export function recordScalarObservation(
  state: MeasuredProgressState,
  label: string,
  output: string,
): void {
  const value = extractScalarMetric(output);
  if (value === null) return;
  const key = label.trim().slice(0, MAX_LABEL_LEN);
  if (!key) return;
  const existing = state.metrics.get(key);
  if (existing) {
    existing.last = value;
    existing.count++;
  } else {
    state.metrics.set(key, { label: key, first: value, last: value, count: 1 });
  }
}

/** 有变化（first !== last）的量化观测。 */
export function changedMetrics(state: MeasuredProgressState): MetricObservation[] {
  return [...state.metrics.values()].filter((m) => m.first !== m.last);
}

/**
 * 是否存在**真实进展**（work-log 与 todo nag 两处共用的唯一判据）。
 *
 * 两个维度取"或"：改过文件，或某个量化观测值变了。任一成立就说明世界确实被改动过，
 * 此时再对模型说"已完成 0 项"就是在撒谎。
 */
export function hasRealProgress(state: MeasuredProgressState | undefined): boolean {
  if (!state) return false;
  return state.filesChanged.size > 0 || changedMetrics(state).length > 0;
}

/**
 * 把实测进展渲染成若干行（work-log 落盘与回注共用）。
 * 无实测进展时返回空数组，让调用方决定回退到什么文案。
 */
export function describeMeasuredProgress(state: MeasuredProgressState | undefined): string[] {
  if (!state) return [];
  const lines: string[] = [];

  if (state.filesChanged.size > 0) {
    const files = [...state.filesChanged];
    const shown = files.slice(0, MAX_LISTED_FILES).join("；");
    const more =
      files.length > MAX_LISTED_FILES ? `（另有 ${files.length - MAX_LISTED_FILES} 个）` : "";
    lines.push(`已落盘改动 ${files.length} 个文件：${shown}${more}`);
  }

  const changed = changedMetrics(state);
  if (changed.length > 0) {
    for (const m of changed.slice(0, MAX_LISTED_METRICS)) {
      lines.push(`观测值变化：\`${m.label}\` ${m.first} → ${m.last}（共观测 ${m.count} 次）`);
    }
  }

  return lines;
}
