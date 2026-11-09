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
 * 阈值放在本文件的常量里，作为**默认值与不可突破的上限**：`settings.monitor.*`
 * 只能在运行时把它们收紧（`getMaxConcurrentMonitors` / `getMaxMonitorTimeoutMs`
 * 取 `min`，解析在 `config/monitor-policy.ts`）。配置不允许把突发阀、总量阀调没——
 * 那些阀不是 monitor 生命周期阈值，也没有对应的配置项。
 */

import { spawn } from "child_process";
import { platform } from "os";
import { generateTaskId, type LocalMonitorTaskState, isTerminalStatus } from "./types.ts";
import { registerTask, updateTask, getTask, getRunningTasks } from "./registry.ts";
import { initTaskOutput, type DiskTaskOutput } from "./disk-output.ts";
import { enqueueTaskNotification } from "./notification.ts";
import {
  formatDeferredMergeNotice,
  formatDeliverySummary,
  formatOmittedLinesNotice,
} from "./monitor-text.ts";
import { getLogger } from "../debug/logger.ts";
import { getMonitorPolicySettings } from "../config/monitor-policy.ts";

/** 单行事件最大字符数：超过即截断（`.output` 里保留完整原文） */
export const MAX_EVENT_LINE_CHARS = 2_000;

/** 事件批处理窗口：第一行到达后开窗，窗口内的行合成一条通知（与 CC 同值） */
export const EVENT_BATCH_MS = 200;

/** 突发阀：10 秒内超过这么多行 → 停止 monitor（几乎一定是没加过滤的原始日志） */
export const BURST_WINDOW_MS = 10_000;
export const BURST_LINE_LIMIT = 40;

/** 持续阀：每分钟投递的**通知**条数（批处理之后计数）超过则合并进下一条 */
export const PER_MINUTE_NOTIFY_LIMIT = 6;

/** 持续阀的窗口长度（1 分钟）。抽成常量是因为测试要把它缩短到几百毫秒才跑得完 */
export const NOTIFY_WINDOW_MS = 60_000;

/** 总量阀：单个 monitor 累计投递的通知条数上限 */
export const TOTAL_NOTIFY_LIMIT = 60;

/**
 * 退出冲刷一条事件最多带多少行。
 *
 * 为什么需要上限：脚本退出前可能一次性吐出整段日志，一条通知正文无界会撑爆上下文。
 * 为什么**保尾不保头**：要的是失败分片与 `ALL_DONE` 汇总行，它们在输出的最后。
 */
export const MAX_FINAL_FLUSH_LINES = 200;

/**
 * 突发阀停止时，最终冲刷最多带多少行。
 *
 * 突发阀触发本身就说明「10 秒 40 行」，这批内容几乎一定是没加过滤的原始日志，
 * 逐行价值低但仍要留一份现场：取与 `BURST_LINE_LIMIT` 同值——刚好是「判定过密」
 * 的那个量级，够看清最后发生了什么，又不至于把上下文撑爆。其余行去 `.output` 看。
 */
export const MAX_BURST_FLUSH_LINES = 40;

/** 同一会话同时运行的 monitor 上限 */
export const MAX_CONCURRENT_MONITORS = 4;

/**
 * 父进程退出后等待 stdio 排空的宽限（与 `tool/bash.ts` 的 `PIPE_DRAIN_GRACE_MS` 同值同义）。
 *
 * `close` 要等**所有** stdio 流关闭。孙进程继承了 stdout 管道的写端，管道不关，
 * `close` 永远不触发——`sleep 60 & exit 0` 实测 1.5s 后任务仍是 running（D15）。
 * 所以 `exit` 到达后给 stdio 一个有界宽限：宽限内 `close` 到了走原路径（残行仍能带上，
 * T-M1-9）；宽限到了还没到，就按「脚本结束 = 监控结束」清掉进程组再收尾。
 */
export const EXIT_DRAIN_GRACE_MS = 400;

/** 期限边界（M1 schema）：下界 1s，上界 1800s（1_800_000 之上的入参被钳制） */
export const MIN_MONITOR_TIMEOUT_MS = 1_000;
export const MAX_MONITOR_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;

/**
 * 运行时生效的并发上限 = `min(代码常量, settings.monitor.maxConcurrent)`。
 *
 * 常量是默认值也是**不可突破的上限**：配置写 99 不会把上限放宽到 99（否则管理员
 * 一次误配就能把「每个 monitor 都是常驻进程 + 通知源」的成本约束调没）。
 * 缺省不配 = 常量。最小值钳到 1：schema 已拒绝 0 / 负数，这里再兜一层，
 * 避免手改文件或未来 schema 放宽时出现「上限 0 = monitor 全不可用但不报错」。
 */
export function getMaxConcurrentMonitors(): number {
  const configured = getMonitorPolicySettings().maxConcurrent;
  if (configured === undefined) return MAX_CONCURRENT_MONITORS;
  return Math.max(1, Math.min(MAX_CONCURRENT_MONITORS, configured));
}

/**
 * 运行时生效的期限上限 = `min(代码常量, settings.monitor.maxTimeoutMs)`。
 *
 * 下限钳到 `MIN_MONITOR_TIMEOUT_MS`：配置比最小值还小没有意义（工具层还会按
 * schema 下限再抬回去），钳到下限让「上限 ≥ 下限」这个不变量始终成立。
 */
export function getMaxMonitorTimeoutMs(): number {
  const configured = getMonitorPolicySettings().maxTimeoutMs;
  if (configured === undefined) return MAX_MONITOR_TIMEOUT_MS;
  return Math.max(MIN_MONITOR_TIMEOUT_MS, Math.min(MAX_MONITOR_TIMEOUT_MS, configured));
}

/**
 * 未传 `timeout_ms` 时的默认期限 = `min(DEFAULT, 生效上限)`。
 *
 * 只钳上限不钳下限：默认值本身就在 [MIN, MAX] 内，配置收紧上限后默认值必须跟着降，
 * 否则会出现「默认 300s、上限 60s」这种自相矛盾的说明文案。
 */
export function getDefaultMonitorTimeoutMs(): number {
  return Math.min(DEFAULT_MONITOR_TIMEOUT_MS, getMaxMonitorTimeoutMs());
}

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
 * 限流阈值覆盖（仅测试用）。
 *
 * 生产路径一律用上面的常量；测试要验「总量阀已满时退出仍能送出剩余行」，
 * 真跑 60 条通知不现实（持续阀每分钟只放 6 条），所以允许注入更小的阈值。
 */
export interface MonitorGateLimits {
  perMinuteNotifyLimit?: number;
  totalNotifyLimit?: number;
  /**
   * 持续阀窗口长度（默认 `NOTIFY_WINDOW_MS`）。
   *
   * 仅测试用：验证「窗口重置时冲刷暂存行」得等满一个 60s 窗口，缩到几百毫秒
   * 才能在单测超时内用真实 `setTimeout` 走完整条路径。
   */
  notifyWindowMs?: number;
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
  private readonly perMinuteLimit: number;
  private readonly totalLimit: number;
  private readonly windowMs: number;

  constructor(limits: MonitorGateLimits = {}) {
    this.perMinuteLimit = limits.perMinuteNotifyLimit ?? PER_MINUTE_NOTIFY_LIMIT;
    this.totalLimit = limits.totalNotifyLimit ?? TOTAL_NOTIFY_LIMIT;
    this.windowMs = limits.notifyWindowMs ?? NOTIFY_WINDOW_MS;
  }

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

  /** 当前被持续阀暂存、等下一次投递的行数（测试用） */
  get deferredCount(): number {
    return this.deferred.length;
  }

  /**
   * 判定本批事件能否立即投递。
   *
   * @param lines 本次批处理窗口内的行
   * @param now   当前墙钟（测试可注入）
   */
  admit(lines: string[], now: number): MonitorGateDecision {
    if (this.totalNotified >= this.totalLimit) {
      return { action: "stop", reason: "rate_total" };
    }
    if (now - this.notifyWindowStart >= this.windowMs) {
      this.notifyWindowStart = now;
      this.notifyInWindow = 0;
    }
    if (this.notifyInWindow >= this.perMinuteLimit) {
      // 持续超限：**合并**进下一条，不丢（CI 分片结束丢一条就漏一个失败分片）
      this.deferred.push(...lines);
      return { action: "defer" };
    }

    const deferredCount = this.deferred.length;
    const merged = deferredCount > 0 ? [...this.deferred, ...lines] : lines;
    this.deferred = [];
    this.notifyInWindow += 1;
    this.totalNotified += 1;

    // 暂存行的提示放在**末尾**：`TaskNotificationMessage` 只取事件首行作摘要，
    // 放末尾不会污染摘要行；而且措辞说的是「以上含」，本来就得在行后（D18）。
    const event =
      deferredCount > 0
        ? `${merged.join("\n")}\n${formatDeferredMergeNotice(deferredCount)}`
        : merged.join("\n");
    return { action: "emit", event };
  }

  /**
   * 距离持续阀窗口重置还有多少毫秒；没有暂存行时返回 `null`（不需要定时器）。
   *
   * 调用方据此挂一个「窗口重置时冲刷」的定时器：暂存行原来只能等**下一行**到达
   * 时随 `admit` 带出，最后一个分片失败后脚本沉默到期限，这批行就一直不投递（D3）。
   */
  msUntilWindowReset(now: number): number | null {
    if (this.deferred.length === 0) return null;
    return Math.max(0, this.notifyWindowStart + this.windowMs - now);
  }

  /**
   * 窗口重置时冲刷暂存行（定时器到点调用）。
   *
   * 与 `admit` 的差别：这是在「没有新行到达」的情况下主动把暂存行送出去，所以自己
   * 负责新窗口的记账（`notifyWindowStart` / `notifyInWindow` / `totalNotified`）。
   *
   * 返回 `null` 有两种含义：暂存已空（无需动作），或窗口尚未真正重置（定时器早到，
   * 调用方应重挂）。总量阀已满时返回 `stop`——此时调用方走停止路径，`finalizeAndDrain`
   * 的 `drainAll` 仍会把暂存行送出去，不会丢。
   */
  flushDeferred(now: number): MonitorGateDecision | null {
    if (this.deferred.length === 0) return null;
    if (this.totalNotified >= this.totalLimit) return { action: "stop", reason: "rate_total" };
    if (now - this.notifyWindowStart < this.windowMs) return null;

    const merged = this.deferred.splice(0);
    this.notifyWindowStart = now;
    this.notifyInWindow = 1;
    this.totalNotified += 1;
    return { action: "emit", event: merged.join("\n") };
  }

  /**
   * 进程退出前的最终冲刷：暂存行与本批行合成一条事件，**不受任何限流阀约束**。
   *
   * 为什么退出路径不该限流：限流阀限制的是「叫醒主循环的频率」，而进程退出时无论如何
   * 都要发一条终态通知把主循环叫醒。这条事件与终态通知会合进同一条注入消息
   * （`_meta.notif` 数组），不会多叫醒一轮——继续走 `admit` 只会在持续阀 / 总量阀
   * 已满时把这批行静默丢掉，而它们往往正是失败分片与 `ALL_DONE` 汇总行（D2）。
   *
   * @param lines 本批行（调用方已把残行、批处理缓冲按输出顺序拼好）
   * @param maxLines 最多保留多少行（默认 `MAX_FINAL_FLUSH_LINES`；突发阀停止时用更小的
   *   `MAX_BURST_FLUSH_LINES`——那批内容本身就说明行太多）
   * @returns 事件正文；没有可投递的行时返回 null
   */
  drainAll(lines: string[], maxLines = MAX_FINAL_FLUSH_LINES): string | null {
    const merged = this.deferred.length > 0 ? [...this.deferred, ...lines] : lines;
    this.deferred = [];
    if (merged.length === 0) return null;

    // 保尾不保头：汇总行在最后，被省略的行去 `.output` 里看
    const omitted = merged.length - maxLines;
    const kept = omitted > 0 ? merged.slice(omitted) : merged;
    const body = kept.join("\n");
    return omitted > 0 ? `${formatOmittedLinesNotice(omitted)}\n${body}` : body;
  }
}

// ── 任务 ──

/** 活跃 monitor 子进程引用（供 kill 用） */
interface ActiveMonitor {
  pid?: number;
  kill(signal?: any): unknown;
  /** 终态已写入（防止 exit 宽限、close、期限定时器各发一条通知） */
  finalized: boolean;
  /** 期限定时器 */
  deadlineTimer: NodeJS.Timeout | null;
  /** 批处理定时器 */
  batchTimer: NodeJS.Timeout | null;
  /** 持续阀窗口重置时的暂存行冲刷定时器（见 `scheduleDeferredFlush`） */
  deferredTimer: NodeJS.Timeout | null;
  /** `exit` 到达后的 stdio 排空宽限（见 `EXIT_DRAIN_GRACE_MS`） */
  exitDrainTimer: NodeJS.Timeout | null;
  gate: MonitorRateGate;
  splitter: LineSplitter;
  pendingLines: string[];
  /** 脚本 stdout 的累计输出行数（含被限流合并 / 冲刷截断的行），终态文案据此给「输出共 M 行」 */
  outputLines: number;
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
  /** 测试钩子：收紧限流阈值（生产调用方不要传）；见 `MonitorGateLimits` */
  __gateLimitsForTest?: MonitorGateLimits;
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
    outputLines: 0,
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
    deferredTimer: null,
    exitDrainTimer: null,
    gate: new MonitorRateGate(opts.__gateLimitsForTest),
    splitter: new LineSplitter(),
    pendingLines: [],
    outputLines: 0,
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

  /** 投递一条事件通知（批处理 / 窗口冲刷 / 终态冲刷共用） */
  const deliverEvent = (event: string): void => enqueueMonitorEvent(taskId, event);

  /**
   * 暂存行非空时挂一个「窗口重置即冲刷」的定时器。
   *
   * 没有它，暂存行只能等**下一行**到达时随 `admit` 带出。最后一批分片失败后脚本
   * 往往沉默到期限，这批行就一直不投递（D3：实测 `err7` 到期限时被整个丢掉）。
   */
  function scheduleDeferredFlush(): void {
    if (ctl.deferredTimer !== null || isFinalized(ctl)) return;
    const delay = ctl.gate.msUntilWindowReset(Date.now());
    if (delay === null) return;
    // +20ms 余量：定时器与 `flushDeferred` 读时钟的时刻不同，早到一毫秒会白跑一次
    // 再重挂；留点余量比「精确到毫秒」少一次空转
    ctl.deferredTimer = setTimeout(flushDeferredByWindow, delay + 20);
    ctl.deferredTimer.unref?.();
  }

  /** 窗口重置：把被持续阀暂存的行主动送出去（不必等下一行到达） */
  function flushDeferredByWindow(): void {
    ctl.deferredTimer = null;
    if (isFinalized(ctl)) return;
    const decision = ctl.gate.flushDeferred(Date.now());
    if (decision === null) {
      // 定时器早到（时钟抖动）或暂存已被别的路径送走：还有暂存就重挂，否则什么都不做
      scheduleDeferredFlush();
      return;
    }
    if (decision.action === "stop") {
      stopMonitorProcess(taskId, decision.reason!);
      return;
    }
    if (decision.event !== undefined) deliverEvent(decision.event);
  }

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
    if (decision.action === "defer") {
      // 暂存行不能只等下一行：窗口重置时必须自己送出去（D3）
      scheduleDeferredFlush();
      return;
    }
    if (decision.event !== undefined) deliverEvent(decision.event);
  };

  const pushLines = (lines: string[]): void => {
    if (isFinalized(ctl)) return;
    // 输出行数在这里累计（D18）：限流合并、冲刷截断都不影响它，终态文案的
    // 「输出共 M 行」必须等于脚本真实打过多少行，而不是投递了几条通知。
    ctl.outputLines += lines.length;
    // 突发阀按**原始行**逐条计（批处理窗口会掩盖真实行数）——这里只关心次数，
    // 不关心内容，故按长度循环。
    for (let i = 0; i < lines.length; i++) {
      if (ctl.gate.recordLine(Date.now())) {
        // 触发这一批的行**还没进缓冲**（recordLine 在 push 之前）：先收进来再停，
        // 否则 `seq 1 100` 一次到达时整批消失——模型只看到「事件过密」，没有现场（D3）
        ctl.pendingLines.push(...lines);
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
  //
  // 但 close 有一个它自己关不掉的前提：**所有**写端都关闭。孙进程继承了 stdout
  // 管道的写端（`sleep 60 & exit 0`），父 shell 早已退出，close 却要等到孙进程结束
  // 甚至永远不来（D15 / R8：1.5s 后仍是 running）。所以另听 `exit`：给它一个有界
  // 宽限，宽限内 close 到了走原路径；没到就按「脚本结束 = 监控结束」清进程组再收尾。
  child.on("exit", (code, signal) => {
    if (isFinalized(ctl)) return;
    // 已经有一个在跑（exit 理论上只触发一次，防重复挂）
    if (ctl.exitDrainTimer !== null) return;
    ctl.exitDrainTimer = setTimeout(() => {
      ctl.exitDrainTimer = null;
      // 宽限内 close 到了：stdout/stderr 已排空，交给 close 的常规出口（残行不丢）
      if (isFinalized(ctl)) return;
      // close 迟迟不到 = 孙进程占着管道写端。先清进程组（否则它继续跑、继续占并发名额），
      // 再销毁流：`destroy` 之后的 data 不再到达，剩余内容以已缓冲的为准（取舍见 D15）。
      killMonitorProcessGroup(ctl);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finalizeAndDrain(taskId, ctl, { kind: "exit", code, signal, stderrTail: ctl.stderrTail });
    }, EXIT_DRAIN_GRACE_MS);
    ctl.exitDrainTimer.unref?.();
  });

  child.on("close", (code, signal) => {
    finalizeAndDrain(taskId, ctl, { kind: "exit", code, signal, stderrTail: ctl.stderrTail });
  });

  child.on("error", (err) => {
    finalizeAndDrain(taskId, ctl, { kind: "error", message: err.message });
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

/** 终态出口的四种来源，决定冲刷上限与终态文案 */
type MonitorFinalizeOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stderrTail: string }
  | { kind: "error"; message: string }
  | { kind: "stop"; reason: "timeout" | "rate_burst" | "rate_total" }
  | { kind: "kill" };

/** 进程组 kill（POSIX 用 `kill(-pid)` 清整棵树；Windows 走 taskkill /T） */
function killMonitorProcessGroup(ctl: ActiveMonitor): void {
  const pid = ctl.pid;
  if (!pid) return;
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

/** 清掉 monitor 的四类定时器（期限 / 200ms 批处理 / 持续阀窗口冲刷 / exit 排空宽限） */
function clearMonitorTimers(ctl: ActiveMonitor): void {
  if (ctl.deadlineTimer) clearTimeout(ctl.deadlineTimer);
  if (ctl.batchTimer) clearTimeout(ctl.batchTimer);
  if (ctl.deferredTimer) clearTimeout(ctl.deferredTimer);
  if (ctl.exitDrainTimer) clearTimeout(ctl.exitDrainTimer);
  ctl.deadlineTimer = null;
  ctl.batchTimer = null;
  ctl.deferredTimer = null;
  ctl.exitDrainTimer = null;
}

/** 投递一条事件通知并累加已投递事件数（面板统计列 + `bg_task_list` 进展签名） */
function enqueueMonitorEvent(taskId: string, event: string): void {
  const task = getTask(taskId) as LocalMonitorTaskState | undefined;
  if (!task) return;
  updateTask<LocalMonitorTaskState>(taskId, (t) =>
    isTerminalStatus(t.status) ? t : { ...t, eventCount: t.eventCount + 1 },
  );
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "running",
    summary: `监控事件：${task.description}`,
    event,
    description: task.description,
  });
}

/**
 * 唯一的终态出口：**先**把剩下的行送出去，**再**置 `finalized`、写终态。
 *
 * 四条路径共用：进程 close / 启动 error / 到期或限流 stop / `task_stop`（kill）。
 *
 * 两个顺序都不能颠倒：
 * 1. **冲刷先于终态通知**：模型读到的顺序决定它先看到「哪个分片失败」还是先看到
 *    「监控结束了」。后者不带现场，看到了也只能再起一个同样的 monitor；
 * 2. **冲刷先于 `finalized`**：`pushLines` / `data` 回调都以 `finalized` 为短路条件，
 *    先置位会让「终态前把剩下的行送出去」这件事在下一个出口被悄悄跳过（D3 的形态）。
 *
 * 这里**不走 `admit`**：持续阀 / 总量阀已满时 `admit` 返回 defer / stop，会把残行、
 * 批处理缓冲与暂存行连同 ctl 一起丢掉（D2 / D3）。`drainAll` 与随后的终态通知同批入队，
 * 会合进同一条注入消息（`_meta.notif` 数组），不会多叫醒一轮，所以「终态不限流」不增加请求数。
 *
 * `monitor-task.ts` 里 `ctl.finalized = true` **只允许出现在本函数**（终态出口收敛守卫）。
 */
function finalizeAndDrain(
  taskId: string,
  ctl: ActiveMonitor,
  outcome: MonitorFinalizeOutcome,
): void {
  if (ctl.finalized) return;

  // 1) 冲刷：残行 + 200ms 批处理缓冲 + 持续阀暂存，按输出顺序合成一条事件
  const rest = ctl.splitter.flush();
  if (rest !== null) {
    ctl.pendingLines.push(rest);
    // 残行（`printf abc` 无换行）也是脚本的一行输出，不能漏计（D18）
    ctl.outputLines += 1;
  }
  // 突发阀停止说明行太多：只带最后 MAX_BURST_FLUSH_LINES 行（汇总行在最后），其余去 .output 看
  const maxLines =
    outcome.kind === "stop" && outcome.reason === "rate_burst"
      ? MAX_BURST_FLUSH_LINES
      : MAX_FINAL_FLUSH_LINES;
  const event = ctl.gate.drainAll(ctl.pendingLines.splice(0), maxLines);
  if (event !== null) enqueueMonitorEvent(taskId, event);

  // 2) 再置位、清定时器（四处手写的 finalized = true 收成这一处）
  ctl.finalized = true;
  clearMonitorTimers(ctl);

  // 输出行数写进任务状态：终态文案从 task 读，四个出口不必各抄一份计数（D18）
  updateTask<LocalMonitorTaskState>(taskId, (t) => ({ ...t, outputLines: ctl.outputLines }));

  // 3) 写终态
  switch (outcome.kind) {
    case "exit":
      finalizeMonitorExit({
        taskId,
        code: outcome.code,
        signal: outcome.signal,
        stderrTail: outcome.stderrTail,
      });
      break;
    case "error":
      finalizeMonitorError(taskId, outcome.message);
      break;
    case "stop":
      finalizeMonitorStop(taskId, outcome.reason);
      break;
    case "kill":
      finalizeMonitorKill(taskId);
      break;
  }

  activeMonitors.delete(taskId);
}

/**
 * 停止 monitor 进程并写终态（到期 / 突发阀 / 总量阀三条路径）。
 *
 * `task_stop` 走 `killMonitorTask`；两者都经由 `finalizeAndDrain` 冲刷与写终态。
 */
function stopMonitorProcess(taskId: string, reason: "timeout" | "rate_burst" | "rate_total"): void {
  const ctl = activeMonitors.get(taskId);
  if (!ctl || ctl.finalized) return;
  killMonitorProcessGroup(ctl);
  finalizeAndDrain(taskId, ctl, { kind: "stop", reason });
}

/**
 * 主动停止 monitor（`task_stop` / Ctrl+F / 会话退出）。
 *
 * 与 `killShellTask` 的差异：终态文案要说明「是谁停的」——模型 `task_stop` 之后
 * 还看到「到期」会以为期限到了而重新挂一个同样的 monitor。
 */
export function killMonitorTask(taskId: string): void {
  const ctl = activeMonitors.get(taskId);
  if (ctl && !ctl.finalized) {
    killMonitorProcessGroup(ctl);
    finalizeAndDrain(taskId, ctl, { kind: "kill" });
    return;
  }
  // ctl 已不在（进程已退出并被 close 清理，或活跃表被测试重置）：任务还没终态时补一条，
  // 不能只依赖 ctl——原实现的兜底分支就是为此保留的
  finalizeMonitorKill(taskId);
}

/** 进程退出（正常 / 异常）的终态写入 */
function finalizeMonitorExit(opts: {
  taskId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}): void {
  const task = getTask(opts.taskId) as LocalMonitorTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return;
  const ok = opts.code === 0 && opts.signal === null;
  const stderrTail = opts.stderrTail.trim();
  const summary = ok
    ? `监控结束：${task.description}（${formatDeliverySummary(task.eventCount, task.outputLines)}，退出码 0）`
    : `监控异常退出：${task.description}（退出码 ${opts.code ?? "null"}${
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
    outputFile: task.outputFile,
    status: ok ? "completed" : "failed",
    summary,
  });
}

/** 启动失败（spawn error）：进程根本没跑起来 */
function finalizeMonitorError(taskId: string, message: string): void {
  const task = getTask(taskId) as LocalMonitorTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return;
  updateTask<LocalMonitorTaskState>(taskId, (t) =>
    isTerminalStatus(t.status)
      ? t
      : { ...t, status: "failed", endTime: Date.now(), notified: true },
  );
  enqueueTaskNotification({
    taskId,
    toolUseId: task.toolUseId,
    outputFile: task.outputFile,
    status: "failed",
    summary: `监控启动失败：${task.description}`,
    error: message,
  });
}

/** 到期 / 限流停止的终态写入 */
function finalizeMonitorStop(
  taskId: string,
  reason: "timeout" | "rate_burst" | "rate_total",
): void {
  const task = getTask(taskId) as LocalMonitorTaskState | undefined;
  if (!task || isTerminalStatus(task.status)) return;

  const description = task.description;
  const elapsedMin = Math.max(1, Math.round((Date.now() - task.startTime) / 60_000));
  const summary =
    reason === "timeout"
      ? `监控到期：${description}（${elapsedMin} 分钟内${formatDeliverySummary(task.eventCount, task.outputLines)}）。${
          task.eventCount === 0
            ? "未投递任何通知，请检查过滤条件是否覆盖了失败状态"
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

/** `task_stop` / Ctrl+F / 会话退出的终态写入 */
function finalizeMonitorKill(taskId: string): void {
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
    summary: `监控已停止（task_stop）：${task.description}（${formatDeliverySummary(task.eventCount, task.outputLines)}）`,
  });
}

/** 测试辅助：清空活跃表（不 kill 进程；仅供 `__reset` 用） */
export function __clearActiveMonitorsForTest(): void {
  for (const ctl of activeMonitors.values()) {
    clearMonitorTimers(ctl);
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
