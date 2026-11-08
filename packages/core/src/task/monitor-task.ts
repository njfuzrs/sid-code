/**
 * LocalMonitorTask — 按行事件监控外部状态（M1）
 *
 * 对标 claude-code 的 `Monitor`：轮询发生在**后台脚本里**，脚本只在状态变化时往 stdout
 * 打一行，每行变成一条通知把空闲主循环叫醒。模型挂完 monitor 就 `end_turn`，等待期前台
 * 零请求——这是本模块存在的全部理由（事故会话 7dd98bf5 / 9e3a681d 里模型前台轮询
 * 96 / 106 次 `gh pr checks`）。
 *
 * ## 与 shell-task 的三处刻意差异
 *
 * 1. **stdout 是事件流**：父进程持有 pipe 逐行读，而不是把 stdout 直接交给文件描述符。
 *    每一行（经 200ms 批处理）变成一条 `<task-notification>`；stderr 只落 `.output`，
 *    不产生事件（报错不该刷屏叫醒主循环）。
 * 2. **有硬期限**：`timeout_ms` 由 harness 自己的定时器执行 kill + 终态通知，不依赖
 *    子进程配合（脚本里忘了加 timeout / 卡在 sleep 里都能收住）。到期通知里刻意写明
 *    「N 分钟内 0 条事件 → 检查过滤条件」——沉默不等于成功。
 * 3. **不进 shell 的静默判据**：`isShellTask` 为假、不调 `trackShellActivity`。
 *    普通 shell 静默 60s 会被判成「不值得等」（20261103 常驻服务事故的修复），
 *    monitor 静默恰恰是正常状态（等 CI 的大部分时间本来就没事件）。
 *
 * ## 限流为什么是三道阀（§5.4.5）
 *
 * 每条通知都会叫醒主循环跑一轮完整请求（20 万+ token），刷屏的代价比 TUI 难看大得多。
 * - 突发直接停：10 秒 40 行几乎一定是 `tail -f` 原始日志没加过滤，继续投递只是在烧钱；
 * - 持续超限**合并而不丢弃**：CI 分片结束这类事件丢一条就漏一个失败分片；
 * - 总量上限兜底：过滤器写宽了（比如每行都打）迟早撞上。
 *
 * 阈值放在本文件的常量里，后续可被 `settings.monitor.*` 覆盖（企业 policy 可收紧）。
 */

import { spawn } from "child_process";
import { platform } from "os";
import { generateTaskId, type LocalMonitorTaskState, isTerminalStatus } from "./types.ts";
import { registerTask, updateTask, getTask, getRunningTasks } from "./registry.ts";
import { initTaskOutput, type DiskTaskOutput } from "./disk-output.ts";
import { enqueueTaskNotification } from "./notification.ts";
import { getLogger } from "../debug/logger.ts";

/** 单行事件最大字符数：超过即截断（`.output` 里保留完整原文） */
export const MAX_EVENT_LINE_CHARS = 2_000;

/** 事件批处理窗口：第一行到达后开窗，窗口内的行合成一条通知（与 CC 同值） */
export const EVENT_BATCH_MS = 200;

/** 突发阀：10 秒内超过这么多行 → 停止 monitor（几乎一定是没加过滤的原始日志） */
export const BURST_WINDOW_MS = 10_000;
export const BURST_LINE_LIMIT = 40;

/** 持续阀：每分钟投递的**通知**条数（批处理之后计数）超过则合并进下一条 */
export const PER_MINUTE_NOTIFY_LIMIT = 6;

/** 总量阀：单个 monitor 累计投递的通知条数上限 */
export const TOTAL_NOTIFY_LIMIT = 60;

/** 同一会话同时运行的 monitor 上限 */
export const MAX_CONCURRENT_MONITORS = 4;

/** 期限边界（M1 schema）：下界 1s，上界 1800s（1_800_000 之上的入参被钳制） */
export const MIN_MONITOR_TIMEOUT_MS = 1_000;
export const MAX_MONITOR_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;

/** 失败通知里 stderr 尾巴的字符数：monitor 脚本最常见的失败都在 stderr 里 */
const STDERR_TAIL_CHARS = 500;

/** 获取平台 shell 配置（与 shell-task 保持一致：Windows 走 powershell） */
function getPlatformShell(): { shell: string; args: string[] } {
  if (platform() === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-Command"] };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-c"] };
}

// ── 行切分 ──

/**
 * 按 `\n` 切行，残行缓存到下一次 chunk。
 *
 * 为什么不能直接把 chunk 当行：pipe 的 chunk 边界由内核决定，与行的边界无关——
 * `printf 'a\nb\n'` 可能一次到达、也可能拆成两个 chunk。不缓存残行会把一行事件劈成两条。
 */
export class LineSplitter {
  private buf = "";

  /** 送入一段解码后的文本，返回其中完整成行的行（已截断超长行） */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      out.push(truncateEventLine(raw));
      idx = this.buf.indexOf("\n");
    }
    return out;
  }

  /** 进程退出：把残行作为最后一个事件冲出（`printf abc` 后退出 → 事件 "abc"） */
  flush(): string | null {
    if (this.buf.length === 0) return null;
    const line = truncateEventLine(this.buf);
    this.buf = "";
    return line;
  }

  /** 当前残行长度（测试用） */
  get pendingLength(): number {
    return this.buf.length;
  }
}

/** 单行截断：按码点切，避免把多字节字符切坏 */
export function truncateEventLine(line: string): string {
  // 行尾 \r（Windows / CRLF 脚本输出）不参与事件，去掉再看长度
  const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
  const chars = Array.from(clean);
  if (chars.length <= MAX_EVENT_LINE_CHARS) return clean;
  return chars.slice(0, MAX_EVENT_LINE_CHARS).join("") + "…[截断]";
}

// ── 限流 ──

export interface MonitorGateDecision {
  /** emit：本批立即投递；defer：暂存到下一批；stop：停止 monitor */
  action: "emit" | "defer" | "stop";
  /** emit 时的事件正文（可能带上被合并的暂存行） */
  event?: string;
  /** stop 时的原因 */
  reason?: "rate_burst" | "rate_total";
}

/**
 * monitor 事件限流器（纯逻辑，便于单测）。
 *
 * 三个计数窗口刻意分开：
 * - **突发**按**原始行**计（10s 窗口）：它要抓的是「没过滤的日志」，批处理会掩盖真实行数；
 * - **持续**按**通知**计（60s 窗口）：它要控的是「叫醒主循环的成本」，一行一通知都算；
 * - **总量**按通知累计：兜底。
 */
export class MonitorRateGate {
  /** 突发窗口内的行时间戳 */
  private burstTimes: number[] = [];
  /** 持续窗口起点 */
  private notifyWindowStart = 0;
  /** 本窗口内已投递的通知数 */
  private notifyInWindow = 0;
  /** 被持续阀拦下、等下一批一起发的行 */
  private deferred: string[] = [];
  /** 累计投递的通知数 */
  private totalNotified = 0;

  /** 记一行到达；返回是否触发突发阀 */
  recordLine(now: number): boolean {
    this.burstTimes.push(now);
    const cutoff = now - BURST_WINDOW_MS;
    while (this.burstTimes.length > 0 && this.burstTimes[0]! < cutoff) this.burstTimes.shift();
    return this.burstTimes.length > BURST_LINE_LIMIT;
  }

  /** 突发窗口内的行数（测试用） */
  get burstCount(): number {
    return this.burstTimes.length;
  }

  /** 累计投递的通知数（测试用） */
  get totalDelivered(): number {
    return this.totalNotified;
  }

  /**
   * 判定本批事件能否立即投递。
   *
   * @param lines 本次批处理窗口内的行
   * @param now   当前墙钟（测试可注入）
   */
  admit(lines: string[], now: number): MonitorGateDecision {
    if (this.totalNotified >= TOTAL_NOTIFY_LIMIT) {
      return { action: "stop", reason: "rate_total" };
    }
    if (now - this.notifyWindowStart >= 60_000) {
      this.notifyWindowStart = now;
      this.notifyInWindow = 0;
    }
    if (this.notifyInWindow >= PER_MINUTE_NOTIFY_LIMIT) {
      // 持续超限：**合并**进下一条，不丢（CI 分片结束丢一条就漏一个失败分片）
      this.deferred.push(...lines);
      return { action: "defer" };
    }

    const deferredCount = this.deferred.length;
    const merged = deferredCount > 0 ? [...this.deferred, ...lines] : lines;
    this.deferred = [];
    this.notifyInWindow += 1;
    this.totalNotified += 1;

    const event =
      deferredCount > 0 ? `${merged.join("\n")}\n…另有 ${deferredCount} 条` : merged.join("\n");
    return { action: "emit", event };
  }

  /** 取出暂存行（进程退出前调用，保证不丢） */
  takeDeferred(): string[] {
    const out = this.deferred;
    this.deferred = [];
    return out;
  }
}

// ── 任务 ──

/** 活跃 monitor 子进程引用（供 kill 用） */
interface ActiveMonitor {
  pid?: number;
  kill(signal?: any): unknown;
  /** 停止时控制终态文案；见 `finalizeMonitor` */
  stopReason?: "timeout" | "rate_burst" | "rate_total";
  /** 终态已写入（防止 exit 事件与期限定时器各发一条通知） */
  finalized: boolean;
  /** 期限定时器 */
  deadlineTimer: NodeJS.Timeout | null;
  /** 批处理定时器 */
  batchTimer: NodeJS.Timeout | null;
  gate: MonitorRateGate;
  splitter: LineSplitter;
  pendingLines: string[];
  stderrTail: string;
}

const activeMonitors = new Map<string, ActiveMonitor>();

/** 当前运行中的 monitor 任务数（工具层做并发上限判定用） */
export function countRunningMonitors(): number {
  return getRunningTasks().filter((t) => t.type === "local_monitor").length;
}

/**
 * 启动一个 monitor 任务。
 *
 * 返回时任务已注册、期限定时器已挂——工具立即同步返回，模型不必等第一条事件。
 * 期限钳制由工具层完成，这里按传入值执行（便于测试注入小期限）。
 */
export function spawnMonitorTask(opts: {
  description: string;
  command: string;
  timeoutMs: number;
  cwd: string;
  toolUseId?: string;
}): LocalMonitorTaskState {
  const taskId = generateTaskId("local_monitor");
  // `.output` 落盘失败（只读目录 / 磁盘满）**不得**影响事件投递（T-M1-12）：
  // 事件是主循环的输入，日志只是事后取证。失败时降级为空路径，一切照常。
  let output: DiskTaskOutput | undefined;
  let outputFile = "";
  try {
    output = initTaskOutput(taskId);
    outputFile = output.filePath;
  } catch (err) {
    getLogger().warn(
      "TASK",
      `monitor ${taskId} 无法创建输出文件，事件照常投递但不再落盘: ${(err as Error)?.message ?? err}`,
    );
  }

  const deadlineAt = Date.now() + opts.timeoutMs;
  const taskState: LocalMonitorTaskState = {
    id: taskId,
    type: "local_monitor",
    status: "running",
    description: opts.description.slice(0, 100),
    toolUseId: opts.toolUseId,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
    notified: false,
    command: opts.command,
    deadlineAt,
    eventCount: 0,
    isBackgrounded: true,
  };

  const { shell, args } = getPlatformShell();
  const child = spawn(shell, [...args, opts.command], {
    cwd: opts.cwd,
    // stdout/stderr 都由父进程读：stdout 逐行变事件，stderr 只落 `.output`。
    // 刻意不像 shell-task 那样把 fd 直接交给子进程——**两个写者写同一个文件**会互相
    // 覆盖偏移（父进程 append stdout + 子进程直写 stderr），实测会丢内容。
    stdio: ["ignore", "pipe", "pipe"],
    // detached（仅 POSIX）→ 进程组组长，kill(-pid) 才能清掉 `sleep 60 &` 类孙进程
    detached: platform() !== "win32",
  });

  registerTask(taskState);

  const ctl: ActiveMonitor = {
    pid: child.pid,
    kill: (sig?: any) => child.kill(sig),
    finalized: false,
    deadlineTimer: null,
    batchTimer: null,
    gate: new MonitorRateGate(),
    splitter: new LineSplitter(),
    pendingLines: [],
    stderrTail: "",
  };
  activeMonitors.set(taskId, ctl);

  const appendOutput = (text: string): void => {
    try {
      output?.append(text);
    } catch {
      /* 落盘失败不影响事件（T-M1-12） */
    }
  };

  /** 把一批行投递成一条通知；被限流拦下时按判定处理 */
  const flushBatch = (): void => {
    ctl.batchTimer = null;
    const lines = ctl.pendingLines.splice(0);
    if (lines.length === 0) return;

    const decision = ctl.gate.admit(lines, Date.now());
    if (decision.action === "stop") {
      stopMonitorProcess(taskId, decision.reason!);
      return;
    }
    if (decision.action === "defer") return;

    // 更新已投递事件数（面板统计列 + bg_task_list 进展签名）
    updateTask<LocalMonitorTaskState>(taskId, (t) =>
      isTerminalStatus(t.status) ? t : { ...t, eventCount: t.eventCount + 1 },
    );
    enqueueTaskNotification({
      taskId,
      toolUseId: opts.toolUseId,
      outputFile,
      status: "running",
      summary: `监控事件：${opts.description}`,
      event: decision.event,
      description: opts.description,
    });
  };

  const pushLines = (lines: string[]): void => {
    if (isFinalized(ctl)) return;
    // 突发阀按**原始行**逐条计（批处理窗口会掩盖真实行数）——这里只关心次数，
    // 不关心内容，故按长度循环。
    for (let i = 0; i < lines.length; i++) {
      if (ctl.gate.recordLine(Date.now())) {
        stopMonitorProcess(taskId, "rate_burst");
        return;
      }
    }
    ctl.pendingLines.push(...lines);
    // 200ms 窗口：第一行到达即开窗，窗口内的行合并（CI 一次完成多个分片时自然合并）
    if (ctl.batchTimer === null) {
      ctl.batchTimer = setTimeout(flushBatch, EVENT_BATCH_MS);
      ctl.batchTimer.unref?.();
    }
  };

  const stdoutDecoder = new TextDecoder("utf-8");
  child.stdout?.on("data", (chunk: Buffer) => {
    if (isFinalized(ctl)) return;
    // stream:true 防多字节字符被 chunk 边界切坏（中文日志在 UTF-8 里 3 字节）
    const text = stdoutDecoder.decode(chunk, { stream: true });
    appendOutput(text);
    pushLines(ctl.splitter.push(text));
  });
  child.stdout?.on("end", () => {
    // 冲掉解码器内部残字节，再冲残行（`printf abc` 后退出 → 事件 "abc"）
    const tailText = stdoutDecoder.decode();
    if (tailText) appendOutput(tailText);
    const rest = ctl.splitter.flush();
    if (rest !== null) pushLines([rest]);
  });

  const stderrDecoder = new TextDecoder("utf-8");
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = stderrDecoder.decode(chunk, { stream: true });
    appendOutput(text);
    ctl.stderrTail = (ctl.stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });

  // 用 **close** 而不是 exit：Node 的 `exit` 在 stdio 流关闭**之前**触发，
  // `printf abc`（无换行）的残行还在 stdout 缓冲里 —— exit 里把 finalized 置位后，
  // 随后到达的 stdout `end` 会被短路，最后一个事件就丢了（实测 T-M1-9 失败）。
  // close 在进程退出且所有 stdio 流关闭后触发，此时 data/end 都已处理完。
  child.on("close", (code, signal) => {
    // 期限定时器与进程退出同时到达：只发一条终态（T-M1-16）
    if (isFinalized(ctl)) return;
    ctl.finalized = true;
    if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
    if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
    ctl.batchTimer = null;

    // 退出前把残行、批处理缓冲与限流暂存都投递掉——不丢事件是限流设计的硬约束。
    // pendingLines 里可能已经有 stdout `end` 冲进来的残行，必须一起带上（否则丢最后一行）。
    const rest = ctl.splitter.flush();
    if (rest !== null) ctl.pendingLines.push(rest);
    const lines = [...ctl.gate.takeDeferred(), ...ctl.pendingLines.splice(0)];
    if (lines.length > 0) {
      const decision = ctl.gate.admit(lines, Date.now());
      if (decision.action === "emit") {
        updateTask<LocalMonitorTaskState>(taskId, (t) =>
          isTerminalStatus(t.status) ? t : { ...t, eventCount: t.eventCount + 1 },
        );
        enqueueTaskNotification({
          taskId,
          toolUseId: opts.toolUseId,
          outputFile,
          status: "running",
          summary: `监控事件：${opts.description}`,
          event: decision.event,
          description: opts.description,
        });
      }
    }

    finalizeMonitorExit({
      taskId,
      code,
      signal,
      description: opts.description,
      outputFile,
      stderrTail: ctl.stderrTail,
      eventCount: (getTask(taskId) as LocalMonitorTaskState | undefined)?.eventCount ?? 0,
    });
    activeMonitors.delete(taskId);
  });

  child.on("error", (err) => {
    if (isFinalized(ctl)) return;
    ctl.finalized = true;
    if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
    if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
    updateTask<LocalMonitorTaskState>(taskId, (t) =>
      isTerminalStatus(t.status)
        ? t
        : { ...t, status: "failed", endTime: Date.now(), notified: true },
    );
    enqueueTaskNotification({
      taskId,
      toolUseId: opts.toolUseId,
      outputFile,
      status: "failed",
      summary: `监控启动失败：${opts.description}`,
      error: err.message,
    });
    activeMonitors.delete(taskId);
  });

  // 期限：harness 自己的定时器（不依赖子进程配合）；unref 不阻止进程退出
  ctl.deadlineTimer = setTimeout(() => {
    stopMonitorProcess(taskId, "timeout");
  }, opts.timeoutMs);
  ctl.deadlineTimer.unref?.();

  return taskState;
}

/** 该 monitor 是否已进入终态流程（读 ctl.finalized 的小包装，避免各处手抄） */
function isFinalized(ctl: ActiveMonitor): boolean {
  return ctl.finalized;
}

/**
 * 停止 monitor 进程并写终态。
 *
 * 三条路径共用：到期（timeout）/ 突发阀 / 总量阀。`task_stop` 走 `killMonitorTask`。
 * 进程组 kill 与 shell-task 同款：POSIX 用 `kill(-pid)` 清整棵树。
 */
function stopMonitorProcess(taskId: string, reason: "timeout" | "rate_burst" | "rate_total"): void {
  const ctl = activeMonitors.get(taskId);
  if (!ctl || ctl.finalized) return;
  ctl.finalized = true;
  ctl.stopReason = reason;
  if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
  if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
  ctl.batchTimer = null;

  const pid = ctl.pid;
  if (pid) {
    if (platform() === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        try {
          ctl.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          ctl.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }

  const task = getTask(taskId) as LocalMonitorTaskState | undefined;
  activeMonitors.delete(taskId);
  if (!task || isTerminalStatus(task.status)) return;

  const description = task.description;
  const elapsedMin = Math.max(1, Math.round((Date.now() - task.startTime) / 60_000));
  const summary =
    reason === "timeout"
      ? `监控到期：${description}（${elapsedMin} 分钟内 ${task.eventCount} 条事件）。${
          task.eventCount === 0
            ? "0 条事件请检查过滤条件是否覆盖了失败状态"
            : "若仍需等待请重新启动"
        }`
      : reason === "rate_burst"
        ? `监控已停止：事件过密（${BURST_WINDOW_MS / 1000} 秒内超过 ${BURST_LINE_LIMIT} 条），请收窄过滤条件后重启`
        : `监控已停止：累计事件过多（超过 ${TOTAL_NOTIFY_LIMIT} 条通知），请改用更粗的过滤条件`;

  updateTask<LocalMonitorTaskState>(taskId, (t) =>
    isTerminalStatus(t.status)
      ? t
      : { ...t, status: "killed", stopReason: reason, endTime: Date.now(), notified: true },
  );
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "killed",
    summary,
  });
}

/**
 * 主动停止 monitor（`task_stop` / Ctrl+F / 会话退出）。
 *
 * 与 `killShellTask` 的差异：终态文案要说明「是谁停的」——模型 `task_stop` 之后
 * 还看到「到期」会以为期限到了而重新挂一个同样的 monitor。
 */
export function killMonitorTask(taskId: string): void {
  const ctl = activeMonitors.get(taskId);
  if (!ctl || ctl.finalized) {
    const task = getTask(taskId) as LocalMonitorTaskState | undefined;
    if (!task || isTerminalStatus(task.status)) return;
  }
  if (ctl && !ctl.finalized) {
    ctl.finalized = true;
    if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
    if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
    ctl.batchTimer = null;
    const pid = ctl.pid;
    if (pid) {
      if (platform() === "win32") {
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          try {
            ctl.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            ctl.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
    }
    activeMonitors.delete(taskId);
  }

  const task = getTask(taskId) as LocalMonitorTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return;
  updateTask<LocalMonitorTaskState>(taskId, (t) =>
    isTerminalStatus(t.status)
      ? t
      : { ...t, status: "killed", endTime: Date.now(), notified: true },
  );
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "killed",
    summary: `监控已停止（task_stop）：${task.description}（共 ${task.eventCount} 条事件）`,
  });
}

/** 进程退出（正常 / 异常）的终态写入 */
function finalizeMonitorExit(opts: {
  taskId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  description: string;
  outputFile: string;
  stderrTail: string;
  eventCount: number;
}): void {
  const task = getTask(opts.taskId) as LocalMonitorTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return;
  const ok = opts.code === 0 && opts.signal === null;
  const stderrTail = opts.stderrTail.trim();
  const summary = ok
    ? `监控结束：${opts.description}（共 ${opts.eventCount} 条事件，退出码 0）`
    : `监控异常退出：${opts.description}（退出码 ${opts.code ?? "null"}${
        opts.signal ? `，信号 ${opts.signal}` : ""
      }${stderrTail ? `，stderr 末尾：${stderrTail}` : ""}）`;

  updateTask<LocalMonitorTaskState>(opts.taskId, (t) =>
    isTerminalStatus(t.status)
      ? t
      : {
          ...t,
          status: ok ? "completed" : "failed",
          exitCode: opts.code ?? -1,
          endTime: Date.now(),
          notified: true,
        },
  );
  enqueueTaskNotification({
    taskId: opts.taskId,
    toolUseId: task.toolUseId,
    outputFile: opts.outputFile,
    status: ok ? "completed" : "failed",
    summary,
  });
}

/** 测试辅助：清空活跃表（不 kill 进程；仅供 `__reset` 用） */
export function __clearActiveMonitorsForTest(): void {
  for (const ctl of activeMonitors.values()) {
    if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
    if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
    // 必须真的 kill 进程组，不能只清表：孤儿进程会在**下一个测试文件**跑的时候才退出，
    // 它 close 回调里的通知会污染那边「等自己的通知」的断言（实测：tool 文件先跑、
    // task 文件后跑时 4 条 spawn 用例变红）。先置 finalized 阻止 close 回调再入队。
    ctl.finalized = true;
    const pid = ctl.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          ctl.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
  activeMonitors.clear();
}
