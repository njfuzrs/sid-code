/**
 * LocalShellTask — 后台 Shell 命令执行
 * spawn 子进程，stdout/stderr 写入磁盘文件，完成后通知主循环
 */

import { spawn, type ChildProcess } from "child_process";
import { openSync, closeSync } from "fs";
import { platform } from "os";
import {
  generateTaskId,
  type LocalShellTaskState,
  isTerminalStatus,
} from "./types.ts";
import { registerTask, updateTask, getTask, EVICT_GRACE_MS } from "./registry.ts";
import { initTaskOutput, getTaskOutputTail } from "./disk-output.ts";
import {
  formatNotification,
  enqueuePendingNotification,
} from "./notification.ts";

/** 获取平台 shell 配置 */
function getPlatformShell(): { shell: string; args: string[] } {
  if (platform() === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-Command"] };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-c"] };
}

/** 活跃子进程引用（用于 kill） */
const activeProcesses = new Map<string, ChildProcess>();

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

    updateTask<LocalShellTaskState>(taskId, (t) => ({
      ...t,
      status: code === 0 ? "completed" : "failed",
      exitCode: code ?? -1,
      interrupted: signal !== null,
      endTime: Date.now(),
      evictAfter: Date.now() + EVICT_GRACE_MS,
      notified: true,
    }));

    enqueuePendingNotification(
      formatNotification({
        taskId,
        toolUseId: opts.toolUseId,
        outputFile: output.filePath,
        status: code === 0 ? "completed" : "failed",
        summary: `命令 "${display.slice(0, 60)}" ${
          code === 0 ? "执行成功" : `失败 (exit code: ${code})`
        }`,
      }),
    );
  });

  child.on("error", (err) => {
    activeProcesses.delete(taskId);

    updateTask<LocalShellTaskState>(taskId, (t) => ({
      ...t,
      status: "failed",
      endTime: Date.now(),
      evictAfter: Date.now() + EVICT_GRACE_MS,
      notified: true,
    }));

    enqueuePendingNotification(
      formatNotification({
        taskId,
        toolUseId: opts.toolUseId,
        outputFile: output.filePath,
        status: "failed",
        summary: `命令启动失败`,
        error: err.message,
      }),
    );
  });

  // abort 信号处理
  opts.signal?.addEventListener("abort", () => {
    killShellTask(taskId);
  });

  // 启动停滞检测
  startStallWatchdog(taskId);

  return taskState;
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
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
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
      evictAfter: Date.now() + EVICT_GRACE_MS,
      notified: true,
    };
  });

  // 补发 killed 通知，与 killAgentTask / killWorkflowTask 对称。
  // 修复缺口：killShellTask 此前设 notified=true 却从不入队通知，
  // 导致被 kill 的 shell 任务被 evictTerminalTasks 静默驱逐，主代理
  // 既看不到面板条目也收不到任何通知，任务无声消失。
  enqueuePendingNotification(
    formatNotification({
      taskId,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: "killed",
      summary: `命令 "${(task.command ?? task.description).slice(0, 60)}" 已被终止`,
    }),
  );
}

// --- 停滞检测 ---

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;

const PROMPT_PATTERNS = [
  /\(y\/n\)/i, /\[y\/n\]/i, /\(yes\/no\)/i,
  /Continue\?/i, /Overwrite\?/i,
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

      if (tail && PROMPT_PATTERNS.some(p => p.test(tail))) {
        const tailSnippet = tail.length > 200
          ? `…${tail.slice(-200)}`
          : tail;
        enqueuePendingNotification(
          formatNotification({
            taskId,
            outputFile: task.outputFile,
            status: "running",
            summary: `命令似乎在等待用户输入，末尾：${tailSnippet}`,
          }),
          "next",
        );
        lastGrowth = Date.now();
      }
    } catch { /* ignore */ }
  }, STALL_CHECK_INTERVAL_MS);

  // 确保 interval 不阻止进程退出
  if (interval.unref) interval.unref();
}
