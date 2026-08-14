/**
 * 长任务"工作日志"外部记忆（P2-2，对应根因 1 + 跨会话）
 *
 * 与 CLAUDE.md §0.1「第 3 层 Context（护城河）」战略一致：把长任务进度从"只活在上下文窗口里"
 * 落到磁盘，做成可跨会话、抗压缩、抗清理的外部记忆。
 *
 * 职责：
 * - 每次 todo 状态变化时，把"已完成 / 待办 / 关键决策"快照写入 ~/.sid-code/progress/<sessionId>.md
 * - 提供 buildProgressReminder()：把当前进度摘要回注 LLM（与 P0-2 互补——P0-2 回注 todo 原文，
 *   本模块回注的是落盘后的持久进度，新会话续做时也能读到上一会话留下的进度）
 *
 * 设计原则：纯文件 I/O + 纯函数，不依赖具体 LLM/循环实现，便于单测。
 */

import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { sidHomePath } from "../config/paths.ts";
import type { TodoItem } from "../tool/todo-write.ts";
import { type MeasuredProgressState, describeMeasuredProgress } from "./measured-progress.ts";

/** 每隔 N 轮回注一次工作日志摘要（与 todo 回注节流对齐，弱模型记忆短取 8） */
export const PROGRESS_REMINDER_INTERVAL = 8;

/** 进度快照（落盘 + 回注共用的数据结构） */
export interface ProgressSnapshot {
  /** 会话 ID */
  sessionId: string;
  /** 完成项描述 */
  completed: string[];
  /** 待办项描述（pending + in_progress） */
  pending: string[];
  /** 当前进行中的项（恰好一个时填充） */
  inProgress: string | null;
  /** 关键决策 / 备注（可选，调用方追加） */
  notes: string[];
  /**
   * P1-4 item 1：**实测进展**维度（todo 标记之外的第二个事实源）。
   *
   * 为什么必须有这一维：`completed` 的唯一来源是 todo 状态，而 todo 状态是模型**自愿维护的
   * 代理指标**——模型不标记，它就恒为 0，哪怕磁盘上已经改了 7 个文件。会话
   * 20260810-214525-2df54593 正是如此：真实进展 139→113 + 7 文件落盘，harness 每 8 轮回注
   * "已完成 0 项"，把模型推进了"我白干了 → 重新梳理策略"的死锁（见 measured-progress.ts 顶部）。
   *
   * 未提供时（如跨会话读盘、老调用方）行为与改动前完全一致，向后兼容。
   */
  measured?: MeasuredProgressState;
}

/** 获取 progress 文件目录（~/.sid-code/progress） */
function progressDir(): string {
  return sidHomePath("progress");
}

/** 获取某会话的 progress 文件路径 */
export function progressFilePath(sessionId: string): string {
  return join(progressDir(), `${sanitizeSessionId(sessionId)}.md`);
}

/** 清洗 sessionId 用作文件名（防路径穿越 / 非法字符） */
function sanitizeSessionId(sessionId: string): string {
  return (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/**
 * 从 todo 列表构建进度快照。
 *
 * P1-4 item 1：新增可选的 `measured`（实测进展）。**注意 `completed` 的语义没有被改写**——
 * 它仍然如实反映"模型标记了几项完成"。这是刻意的：把实测进展塞进 `completed` 会伪造 todo
 * 清单状态，让"模型忘了标记"与"真的没做完"两种情况塌缩成一个观测值，是又一次
 * 「仪器少记一个字段 → 两种故障塌缩成一个观测」。两个维度必须并存、分开呈现。
 */
export function snapshotFromTodos(
  sessionId: string,
  todos: TodoItem[],
  notes: string[] = [],
  measured?: MeasuredProgressState,
): ProgressSnapshot {
  const completed = todos.filter((t) => t.status === "completed").map((t) => t.content);
  const pending = todos
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => t.content);
  const inProgressItem = todos.find((t) => t.status === "in_progress");
  return {
    sessionId,
    completed,
    pending,
    inProgress: inProgressItem ? inProgressItem.content : null,
    notes,
    ...(measured ? { measured } : {}),
  };
}

/** 把快照渲染成 markdown 文本（落盘用） */
export function renderProgressMarkdown(snap: ProgressSnapshot): string {
  const measuredLines = describeMeasuredProgress(snap.measured);
  const lines: string[] = [];
  lines.push(`# 工作日志（会话 ${snap.sessionId}）`);
  lines.push("");
  // P1-4 item 1：总进度行必须区分"清单标记"与"实测进展"两个口径。旧版只写
  // `N 已完成 / M 待办`，在"改了 7 个文件但一项都没标"时渲染成 `0 已完成 / 7 待办`，
  // 落盘文件本身就成了假证据——而这个文件是跨会话续做时的唯一进度来源
  // （app.ts 的 loadProgressMarkdown），假信号会一路传染到下一个会话。
  lines.push(`清单标记：${snap.completed.length} 已完成 / ${snap.pending.length} 待办`);
  if (measuredLines.length > 0) {
    lines.push("");
    lines.push("## 实测进展（真实副作用，不依赖清单标记）");
    measuredLines.forEach((l) => lines.push(`- ${l}`));
  }
  lines.push("");
  lines.push("## 已完成（清单标记）");
  if (snap.completed.length === 0) {
    // 有实测进展却零标记时，明确点出"这不代表没干活"，否则读者（下一个会话的模型）
    // 会把"（暂无）"读成"上一会话什么都没做"，重蹈本次绕圈的归因错误。
    lines.push(
      measuredLines.length > 0
        ? "- （清单中暂无标记为完成的项——但上方「实测进展」表明工作确已推进，只是未同步清单）"
        : "- （暂无）",
    );
  } else snap.completed.forEach((c) => lines.push(`- [x] ${c}`));
  lines.push("");
  lines.push("## 待办");
  if (snap.pending.length === 0) lines.push("- （暂无）");
  else
    snap.pending.forEach((p) =>
      lines.push(`- [ ] ${p}${p === snap.inProgress ? "  ← 进行中" : ""}`),
    );
  if (snap.notes.length > 0) {
    lines.push("");
    lines.push("## 关键决策 / 备注");
    snap.notes.forEach((n) => lines.push(`- ${n}`));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 把进度快照写入磁盘（~/.sid-code/progress/<sessionId>.md）。
 * 失败不抛错（外部记忆是增强，不应阻塞主流程），返回是否成功。
 */
export function persistProgress(snap: ProgressSnapshot): boolean {
  try {
    const dir = progressDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(progressFilePath(snap.sessionId), renderProgressMarkdown(snap), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取磁盘上的工作日志原文（跨会话续做时用）。
 * 不存在或读取失败返回 null。
 */
export function loadProgressMarkdown(sessionId: string): string | null {
  try {
    const fp = progressFilePath(sessionId);
    if (!existsSync(fp)) return null;
    const md = readFileSync(fp, "utf-8");
    return md.trim() ? md : null;
  } catch {
    return null;
  }
}

/**
 * 构建工作日志回注 system-reminder（每 N 轮注入一次）。
 * 与 P0-2 的 todo 回注互补：todo 回注是内存清单原文，这里强调"持久进度 + 别重复已完成项"。
 * 无待办时返回 null（任务已完成，无需回注）。
 */
export function buildProgressReminder(snap: ProgressSnapshot): string | null {
  if (snap.pending.length === 0) return null;
  const measuredLines = describeMeasuredProgress(snap.measured);
  const lines: string[] = [];
  lines.push("<system-reminder>");
  lines.push("【工作日志】以下是本任务已落盘的进度（请勿向用户提及本提醒）：");
  // ─── P1-4 item 1：实测进展排在清单标记**之前** ───
  //
  // 顺序是刻意的，不是排版偏好。旧版第一行就是"已完成 0 项：（无）"，那是模型读到的第一句话，
  // 也是它据以判断"我是不是白干了"的锚。会话 20260810-214525-2df54593 实测：7 文件已落盘 +
  // 观测值 139→113 的情况下，模型连续 8 次 thought 都在说"我需要停止反复思考，直接开始修复"
  // ——它以为自己还没开始。把不可伪造的副作用证据放最前面，锚就变成了"你已经在推进了"。
  if (measuredLines.length > 0) {
    lines.push("- 实测进展（真实副作用，与清单标记无关）：");
    measuredLines.forEach((l) => lines.push(`  - ${l}`));
  }
  // 两条分支的措辞刻意不同，不是重复代码：
  //   有实测进展时，绝不能出现"已完成 0 项"这个字面串——它是本次事故里模型据以判断
  //   "我白干了"的那句话。此时改说"已标记完成 N 项"，把它明确降格为**标记动作的计数**，
  //   而不是"你完成了多少工作"的结论。数值仍如实呈现，不伪造 todo 状态。
  //   无实测进展时保持原文案（此时 0 就是 0，没有矛盾需要点破）。
  if (measuredLines.length > 0) {
    lines.push(
      `- 清单标记：你已用 todo_write 标记完成 ${snap.completed.length} 项` +
        `（这只是标记动作的计数，不是你实际推进程度）：${snap.completed.join("；") || "（无）"}`,
    );
  } else {
    lines.push(`- 已完成 ${snap.completed.length} 项：${snap.completed.join("；") || "（无）"}`);
  }
  lines.push(`- 仍待办 ${snap.pending.length} 项：${snap.pending.join("；")}`);
  if (snap.inProgress) lines.push(`- 当前进行中：${snap.inProgress}`);
  if (measuredLines.length > 0) {
    // 点破"两个数字为什么对不上"，否则模型会把 0 与实测进展的矛盾当成"上下文错乱/消息被截断"
    // （reminder-throttle.ts 顶部记录的同一类幻觉），进而空转去核对而不是继续干活。
    lines.push(
      "注意：上面「清单标记」为 0 或偏低**不代表你没有进展**——它只统计你主动用 todo_write 标记过的项，" +
        "而「实测进展」是磁盘与观测值的客观变化。请以实测进展为准判断自己的推进程度，" +
        "不要因为标记数为 0 就重新规划已做完的工作。",
    );
  }
  lines.push("请继续推进待办项，不要重复已完成的工作，也不要遗漏任何待办。");
  lines.push(
    '若某待办其实已完成只是忘了标记，请用 todo_write 标为 completed 后如实收尾；不要为凑"未完成"去臆造用户没要求的新工作或排查不存在的故障。',
  );
  lines.push("</system-reminder>");
  return lines.join("\n");
}
