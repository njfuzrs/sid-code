/**
 * Q1：后台任务等待期的轮询——回执禁令文案 + 主循环拦截。
 *
 * 事故（opus 批次 R0/L3f/S1v/S2v/S3v）：后台任务运行期间主代理发了 28 次「看进度」调用
 * （read `.output`、`ls ~/.sid-code/tasks | grep`、阻塞式 task_output），7 次撞空报错。
 * 根因是离行动最近的三处回执（子代理 / bash 后台 / Ctrl+B）都在给「需要时 read output_file」
 * 的许可，墓碑又把模型推向阻塞式 task_output；system 里那段禁令离行动太远，压不住。
 *
 * 两层：
 * 1. `BACKGROUND_RECEIPT_NOTICE`（定义在 `background-receipt.ts`）：三处回执共用的禁令文案（用常量而不是三份字面量，
 *    测试锁住「三处引用同一常量」，防止以后改一处漏两处）；
 * 2. `checkBackgroundPoll`：主循环在 `tool.execute` 之前调用，命中则不执行、直接回
 *    「仍在运行，完成后自动通知」。与模型强弱无关，弱模型漏读文案时兜底。
 *
 * 只拦**运行中**的任务：已终态任务读完整结论是合法行为（完成通知里的 <output-file>）。
 * `block=false` 的显式快照不拦，用户主动要看进度走这条。
 */

import { homedir } from "os";
import { realpathSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import { getAllTasks, getTask } from "./registry.ts";
import { taskIdFromOutputPath } from "./lifecycle.ts";
import { isTerminalStatus, type TaskState } from "./types.ts";

export { BACKGROUND_RECEIPT_NOTICE } from "./background-receipt.ts";

/** 拦截命中的形态（进 `BackgroundPollIntercepted` 事件，F2 按 kind 归因） */
export type BackgroundPollKind = "read_output" | "bash_tasks_dir" | "blocking_wait";

export type BackgroundPollCheck =
  | { intercept: false }
  | { intercept: true; kind: BackgroundPollKind; taskIds: string[]; output: string };

export interface BackgroundPollContext {
  getTask: (id: string) => TaskState | undefined;
  /** 当前所有非终态的后台任务 */
  runningBackgroundTasks: () => TaskState[];
  /** tasks 根目录（`sidPaths.tasks()`） */
  tasksDir: string;
  /** 用户主目录，用于识别 `~/...` 与 `$HOME/...` 形式 */
  home: string;
}

export function defaultBackgroundPollContext(): BackgroundPollContext {
  return {
    getTask,
    runningBackgroundTasks: () =>
      getAllTasks().filter((t) => t.isBackgrounded && !isTerminalStatus(t.status)),
    tasksDir: sidPaths.tasks(),
    home: homedir(),
  };
}

function isRunning(task: TaskState | undefined): task is TaskState {
  return !!task && !isTerminalStatus(task.status);
}

function interceptText(taskIds: string[]): string {
  const who = taskIds.length > 0 ? `任务 ${taskIds.join(", ")} 仍在运行` : "后台任务仍在运行";
  return (
    `${who}，本次调用未执行。完成时会自动以 <task-notification> 把结果送给你，` +
    `不需要查看它的输出文件或阻塞等待。可以继续做不依赖它的工作，或告诉用户已启动什么后结束本轮。`
  );
}

/** tasks 根目录在命令文本里可能出现的写法：绝对路径、realpath、`~`、`$HOME`、`${HOME}` */
function tasksDirForms(tasksDir: string, home: string): string[] {
  const abs = new Set<string>([tasksDir]);
  try {
    abs.add(realpathSync(tasksDir));
  } catch {
    /* 目录还没建出来：只认字面路径 */
  }
  const forms = new Set<string>(abs);
  const h = home.replace(/\/+$/, "");
  for (const p of abs) {
    if (h && p.startsWith(h + "/")) {
      const rest = p.slice(h.length);
      forms.add(`~${rest}`);
      forms.add(`$HOME${rest}`);
      forms.add(`\${HOME}${rest}`);
    }
  }
  // 长的优先匹配，避免 realpath 前缀被短形式截走
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * bash 命令是否在看运行中后台任务的产出。命中条件（且有运行中后台任务）：
 * - 引用了某个运行中任务的 `<id>.output`；或
 * - 引用的是 tasks 根目录本身（`tasks/`、`tasks/*.output` 这类通配）。
 * `tasks/sessions/...`、`tasks/<team>/tasks.json` 是别的存储，不在范围内。
 */
function checkBash(command: string, ctx: BackgroundPollContext): string[] | null {
  const running = ctx.runningBackgroundTasks();
  if (running.length === 0) return null;
  const runningIds = new Set(running.map((t) => t.id));
  let rootRef = false;
  const hitIds = new Set<string>();
  for (const form of tasksDirForms(ctx.tasksDir, ctx.home)) {
    let from = 0;
    for (;;) {
      const at = command.indexOf(form, from);
      if (at < 0) break;
      from = at + form.length;
      // 紧跟的必须是路径边界，防止 `tasks-old/` 这类同前缀目录误命中
      const rest = /^[^\s'"|;&)<>]*/.exec(command.slice(from))![0];
      if (rest !== "" && !rest.startsWith("/")) continue;
      const seg = rest.replace(/^\/+/, "");
      if (seg === "" || /^[*?[]/.test(seg)) {
        rootRef = true;
        continue;
      }
      const m = /^([^/]+)\.output$/.exec(seg);
      if (m && runningIds.has(m[1]!)) hitIds.add(m[1]!);
    }
  }
  if (hitIds.size > 0) return [...hitIds];
  return rootRef ? [...runningIds] : null;
}

/**
 * 判定一次工具调用是不是「等待期看进度」。纯函数，`ctx` 注入，便于单测。
 */
export function checkBackgroundPoll(
  toolName: string,
  input: unknown,
  ctx: BackgroundPollContext = defaultBackgroundPollContext(),
): BackgroundPollCheck {
  const params = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (toolName === "read") {
    const filePath = typeof params.file_path === "string" ? params.file_path : "";
    if (!filePath) return { intercept: false };
    const id = taskIdFromOutputPath(filePath);
    if (!id || !isRunning(ctx.getTask(id))) return { intercept: false };
    return { intercept: true, kind: "read_output", taskIds: [id], output: interceptText([id]) };
  }

  if (toolName === "bash") {
    // 自己转后台的命令不是「看进度」
    if (params.run_in_background === true) return { intercept: false };
    const command = typeof params.command === "string" ? params.command : "";
    if (!command) return { intercept: false };
    const ids = checkBash(command, ctx);
    if (!ids) return { intercept: false };
    return { intercept: true, kind: "bash_tasks_dir", taskIds: ids, output: interceptText(ids) };
  }

  if (toolName === "task_output" || toolName === "bg_task_get") {
    // 与工具自身口径一致：`!== false` 即阻塞（工具默认 block=true）
    if (params.block === false) return { intercept: false };
    const id = typeof params.task_id === "string" ? params.task_id : "";
    if (!id || !isRunning(ctx.getTask(id))) return { intercept: false };
    return { intercept: true, kind: "blocking_wait", taskIds: [id], output: interceptText([id]) };
  }

  return { intercept: false };
}

// ─────────────────────────── BackgroundPollIntercepted 事件 ───────────────────────────

export const BACKGROUND_POLL_INTERCEPTED_EVENT_NAME = "BackgroundPollIntercepted";

type BackgroundPollSink = (data: Record<string, unknown>) => void;
let sink: BackgroundPollSink | null = null;

/** 注入/清除事件通道（App 在 collector 就绪后调用；测试收尾传 null 复位） */
export function setBackgroundPollSink(s: BackgroundPollSink | null): void {
  sink = s;
}

/** F2 的取数源：§1.1 计数减去本事件命中的 tool_use_id = 实际执行的轮询 */
export function emitBackgroundPollIntercepted(data: {
  tool_name: string;
  tool_use_id: string;
  kind: BackgroundPollKind;
  task_ids: string[];
}): void {
  if (!sink) return;
  try {
    sink({ ...data, ts: Date.now() });
  } catch {
    /* 埋点失败不影响主流程 */
  }
}
