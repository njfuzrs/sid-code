/**
 * LocalShellTask — 后台 Shell 命令执行
 * spawn 子进程，stdout/stderr 写入磁盘文件，完成后通知主循环
 */

import { spawn } from "child_process";
import { openSync, closeSync } from "fs";
import { platform } from "os";
import { generateTaskId, type LocalShellTaskState, isTerminalStatus } from "./types.ts";
import { registerTask, updateTask, getTask, graceDeadlineFor } from "./registry.ts";
import { initTaskOutput, getTaskOutputTail } from "./disk-output.ts";
import { enqueueTaskNotification } from "./notification.ts";

/** 获取平台 shell 配置 */
function getPlatformShell(): { shell: string; args: string[] } {
  if (platform() === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-Command"] };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-c"] };
}

/**
 * killShellTask / adoptRunningProcessAsTask 共用的最小进程接口——只依赖 pid + kill()。
 * Node 的 ChildProcess（spawnShellTask 自己 spawn 的）与 Bun 的 Subprocess（P1-4：
 * bash.ts 前台执行经 Ctrl+B 热转后台时过继过来的）都天然满足，无需为两个运行时
 * 分别维护跟踪表——统一走同一份 activeProcesses + kill 逻辑。
 */
interface AdoptableProcess {
  readonly pid?: number;
  kill(signal?: any): unknown;
}

/** 活跃子进程引用（用于 kill） */
const activeProcesses = new Map<string, AdoptableProcess>();

/**
 * 任务因子进程退出而进入终态：更新 registry 状态 + 入队完成通知。
 * spawnShellTask 的 child.on("exit") 与 adoptRunningProcessAsTask 的 markExited 共用。
 *
 * 终态守卫（对齐 agent-task.ts 的 complete/failAgentTask，见
 * tests/task/agent-task-terminal-guard.test.ts 的"缺口 A1"）：若任务已经因
 * killShellTask（用户 Ctrl+F 双击 / 未来 task_stop 主动终止）先行进入终态，这里必须
 * 短路——否则被 SIGKILL 的进程随后触发的 exit 事件会把已经广播过的 "killed" 状态和
 * 通知覆盖成 "failed"，造成状态倒退 + 矛盾的重复通知。此前 shell 任务未补齐这层
 * 守卫（agent-task 那边修过同类缺口，shell 这边是漏网的），随 P1-4 一并修正。
 */
function finalizeShellTaskExit(opts: {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  display: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}): void {
  const { taskId, toolUseId, outputFile, display, code, signal } = opts;
  const existing = getTask(taskId);
  if (!existing || isTerminalStatus(existing.status)) return;

  updateTask<LocalShellTaskState>(taskId, (t) => {
    if (isTerminalStatus(t.status)) return t;
    return {
      ...t,
      status: code === 0 ? "completed" : "failed",
      exitCode: code ?? -1,
      interrupted: signal !== null,
      endTime: Date.now(),
      evictAfter: graceDeadlineFor(code === 0 ? "completed" : "failed"),
      notified: true,
    };
  });

  enqueueTaskNotification({
    taskId,
    toolUseId,
    outputFile,
    status: code === 0 ? "completed" : "failed",
    summary: `命令 "${display.slice(0, 60)}" ${
      code === 0 ? "执行成功" : `失败 (exit code: ${code})`
    }`,
  });
}

/**
 * 任务因子进程 spawn/运行异常而失败：与 finalizeShellTaskExit 同款终态守卫。
 * spawnShellTask 的 child.on("error") 与 adoptRunningProcessAsTask 的 markError 共用。
 */
function finalizeShellTaskError(opts: {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  err: Error;
}): void {
  const { taskId, toolUseId, outputFile, err } = opts;
  const existing = getTask(taskId);
  if (!existing || isTerminalStatus(existing.status)) return;

  updateTask<LocalShellTaskState>(taskId, (t) => {
    if (isTerminalStatus(t.status)) return t;
    return {
      ...t,
      status: "failed",
      endTime: Date.now(),
      evictAfter: graceDeadlineFor("failed"),
      notified: true,
    };
  });

  enqueueTaskNotification({
    taskId,
    toolUseId,
    outputFile,
    status: "failed",
    summary: `命令启动失败`,
    error: err.message,
  });
}

/** 启动后台 Shell 任务 */
export function spawnShellTask(opts: {
  command: string;
  cwd: string;
  toolUseId?: string;
  agentId?: string;
  signal?: AbortSignal;
  /**
   * 用于展示/通知的原始命令（持久 Shell 会话场景：command 已被包成
   * `source 快照 && eval '原命令'`，displayCommand 保留干净的原命令用于描述）。
   * 不传则回退 command。
   */
  displayCommand?: string;
}): LocalShellTaskState {
  const taskId = generateTaskId("local_shell");
  const output = initTaskOutput(taskId);
  const { shell, args } = getPlatformShell();
  // 展示用命令（干净），与实际执行命令（可能含快照前缀）分离
  const display = opts.displayCommand ?? opts.command;

  const outFd = openSync(output.filePath, "w");
  // detached（仅 POSIX）→ 子进程成进程组组长，killShellTask 的 process.kill(-child.pid) 才能
  // 清理整棵进程树（含 `sleep 30 &` 类孙子进程）。若为 false，负 pid kill 会打到错误的
  // 进程组或落入单进程 fallback，导致孤儿泄漏（已复现）。Windows 无进程组，走 taskkill /T。
  const child = spawn(shell, [...args, opts.command], {
    cwd: opts.cwd,
    stdio: ["ignore", outFd, outFd],
    detached: platform() !== "win32",
  });

  // fd 交给子进程后关闭父进程引用
  closeSync(outFd);

  const taskState: LocalShellTaskState = {
    id: taskId,
    type: "local_shell",
    status: "running",
    description: display.slice(0, 100),
    toolUseId: opts.toolUseId,
    startTime: Date.now(),
    outputFile: output.filePath,
    outputOffset: 0,
    notified: false,
    command: display,
    interrupted: false,
    isBackgrounded: true,
    agentId: opts.agentId,
  };

  registerTask(taskState);
  activeProcesses.set(taskId, child);

  child.on("exit", (code, signal) => {
    activeProcesses.delete(taskId);
    finalizeShellTaskExit({
      taskId,
      toolUseId: opts.toolUseId,
      outputFile: output.filePath,
      display,
      code,
      signal,
    });
  });

  child.on("error", (err) => {
    activeProcesses.delete(taskId);
    finalizeShellTaskError({ taskId, toolUseId: opts.toolUseId, outputFile: output.filePath, err });
  });

  // abort 信号处理
  opts.signal?.addEventListener("abort", () => {
    killShellTask(taskId);
  });

  // 启动停滞检测
  startStallWatchdog(taskId);

  return taskState;
}

/**
 * 收养一个已经在前台运行的进程，登记为后台 Shell 任务（Ctrl+B 热转后台，P1-4）。
 *
 * 与 spawnShellTask 的关键区别：进程已经由调用方（bash.ts 前台 execute()）spawn 并读了
 * 一部分输出，本函数只做"事后过继"——不再 spawn 新进程，只接管注册表 + 磁盘输出 +
 * kill 跟踪 + 停滞检测。调用方仍在跑的 pump 循环通过返回的 appendLiveOutput 把后续输出
 * 接着写盘，进程最终退出/异常时经 markExited/markError 收尾——与 spawnShellTask 的
 * child.on("exit"/"error") 走同一套 finalizeShellTaskExit/Error，保证"模型主动
 * run_in_background=true"与"用户 Ctrl+B 热转"两条路径在面板展示、kill、通知上完全一致。
 */
export function adoptRunningProcessAsTask(opts: {
  /** 已在运行的子进程（Bun Subprocess 或 Node ChildProcess，只需 pid + kill()）。 */
  proc: AdoptableProcess;
  /** 展示/存档用的干净命令（不含 shell 快照注入前缀）。 */
  command: string;
  toolUseId?: string;
  /** detach 发生前已经在内存里攒下的输出，先整块写入磁盘，保持输出连续不丢。 */
  alreadyCaptured: string;
  /** 原前台执行的 abort signal；该信号后续 abort 时联动 kill 本任务（对齐 spawnShellTask）。 */
  signal?: AbortSignal;
  /**
   * 进程真实起跑时刻（毫秒时间戳）。不传则用当前时刻兜底——但那会让任务面板把
   * "已经跑了很久才被转后台的命令"误显示成刚开始，调用方应尽量传真实 spawn 时间。
   */
  startTime?: number;
}): {
  taskState: LocalShellTaskState;
  appendLiveOutput: (text: string) => void;
  markExited: (exitCode: number | null) => void;
  markError: (err: Error) => void;
} {
  const taskId = generateTaskId("local_shell");
  const output = initTaskOutput(taskId);
  const display = opts.command;

  if (opts.alreadyCaptured) output.append(opts.alreadyCaptured);

  const taskState: LocalShellTaskState = {
    id: taskId,
    type: "local_shell",
    status: "running",
    description: display.slice(0, 100),
    toolUseId: opts.toolUseId,
    startTime: opts.startTime ?? Date.now(),
    outputFile: output.filePath,
    outputOffset: 0,
    notified: false,
    command: display,
    interrupted: false,
    isBackgrounded: true,
  };

  registerTask(taskState);
  activeProcesses.set(taskId, opts.proc);

  // abort 信号处理（对齐 spawnShellTask）：原前台执行所属的那一轮若在任务仍活跃时被
  // 上游 abort，联动 kill——语义与"模型主动 run_in_background=true"完全一致。
  opts.signal?.addEventListener("abort", () => {
    killShellTask(taskId);
  });

  // 启动停滞检测（复用同一套 "等待 y/n" 探测）
  startStallWatchdog(taskId);

  return {
    taskState,
    appendLiveOutput: (text: string) => output.append(text),
    markExited: (exitCode: number | null) => {
      activeProcesses.delete(taskId);
      finalizeShellTaskExit({
        taskId,
        toolUseId: opts.toolUseId,
        outputFile: output.filePath,
        display,
        code: exitCode,
        signal: null,
      });
    },
    markError: (err: Error) => {
      activeProcesses.delete(taskId);
      finalizeShellTaskError({
        taskId,
        toolUseId: opts.toolUseId,
        outputFile: output.filePath,
        err,
      });
    },
  };
}

/** 终止 Shell 任务 */
export function killShellTask(taskId: string): void {
  const child = activeProcesses.get(taskId);
  if (child?.pid) {
    if (platform() === "win32") {
      // Windows 无进程组：taskkill /T 递归杀子进程，/F 强制
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
  activeProcesses.delete(taskId);

  const task = getTask(taskId) as LocalShellTaskState | undefined;
  // 已终态：仅 kill 进程（上面已做），不重复改状态、不重复发通知（幂等）。
  if (!task || isTerminalStatus(task.status)) return;

  updateTask<LocalShellTaskState>(taskId, (t) => {
    if (isTerminalStatus(t.status)) return t;
    return {
      ...t,
      status: "killed",
      interrupted: true,
      endTime: Date.now(),
      // killed 走短档（3s，对齐 CC STOPPED_DISPLAY_MS）。见 graceDeadlineFor。
      evictAfter: graceDeadlineFor("killed"),
      notified: true,
    };
  });

  // 补发 killed 通知，与 killAgentTask / killWorkflowTask 对称。
  // 修复缺口：killShellTask 此前设 notified=true 却从不入队通知，
  // 导致被 kill 的 shell 任务被 evictTerminalTasks 静默驱逐，主代理
  // 既看不到面板条目也收不到任何通知，任务无声消失。
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "killed",
    summary: `命令 "${(task.command ?? task.description).slice(0, 60)}" 已被终止`,
  });
}

// --- 停滞检测 ---

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /Continue\?/i,
  /Overwrite\?/i,
  /Press (any key|Enter)/i,
  /Are you sure/i,
];

function startStallWatchdog(taskId: string): void {
  let lastSize = 0;
  let lastGrowth = Date.now();

  const interval = setInterval(async () => {
    const task = getTask(taskId);
    if (!task || isTerminalStatus(task.status)) {
      clearInterval(interval);
      return;
    }

    try {
      const tail = await getTaskOutputTail(taskId, 1024);
      const currentSize = tail?.length ?? 0;
      if (currentSize > lastSize) {
        lastSize = currentSize;
        lastGrowth = Date.now();
        return;
      }
      if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

      if (tail && PROMPT_PATTERNS.some((p) => p.test(tail))) {
        const tailSnippet = tail.length > 200 ? `…${tail.slice(-200)}` : tail;
        enqueueTaskNotification(
          {
            taskId,
            outputFile: task.outputFile,
            status: "running",
            summary: `命令似乎在等待用户输入，末尾：${tailSnippet}`,
          },
          "next",
        );
        lastGrowth = Date.now();
      }
    } catch {
      /* ignore */
    }
  }, STALL_CHECK_INTERVAL_MS);

  // 确保 interval 不阻止进程退出
  if (interval.unref) interval.unref();
}
