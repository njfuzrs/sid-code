/**
 * sid-code daemon — 本地调度守护进程（缺口 C1）
 *
 * 常驻进程，无会话也能定时跑：关掉交互式 REPL 后，durable 定时任务仍按 cron 触发。
 * 对标 cc Desktop Scheduled Tasks：每分钟检查、catch-up「只补最近一次」、fresh session 执行。
 *
 * 进程形态（§6）：合并为一个进程，内部两个触发源——
 *   - ScheduleSource：Scheduler(daemonMode) 每分钟检查 → onFireTask → HeadlessExecutor
 *   - WebhookSource（可选）：Bun.serve 接 GitHub webhook → HeadlessExecutor（无 secret 自动关）
 *   - HeadlessExecutor：共用，fork `sid-code -p`，WorkspaceProvider + StorageAdapter
 *
 * 生命周期：
 *   1. 抢单例锁（daemon.lock），已有守护进程则拒绝启动
 *   2. 注册 SessionKind="daemon"（/ps 可见）
 *   3. 启动 Scheduler（daemonMode）+ 可选 webhook server
 *   4. 信号处理：SIGINT/SIGTERM → 优雅停机（停调度器、关 server、释放锁、注销会话）
 */

import { join } from "node:path";
import type { CronTask } from "../cron/types.ts";
import type { ConcurrencyGate, DaemonConfig, HeadlessJob } from "./types.ts";
import { Scheduler } from "../cron/scheduler.ts";
import { HeadlessExecutor } from "./headless-executor.ts";
import { FileStorageAdapter } from "./storage.ts";
import { tryAcquireDaemonLock, releaseDaemonLock, readDaemonLock } from "./lock.ts";
import { registerSession, unregisterSession } from "../session/concurrent.ts";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { randomBytes } from "node:crypto";
import { resolveWebhookSecret } from "./webhook-secret.ts";

/** 守护进程默认配置 */
export const DAEMON_DEFAULTS = {
  scheduleCheckIntervalMs: 60_000, // 每分钟检查（对齐 cc Desktop）
  maxConcurrent: 3,
  jobTimeoutMs: 30 * 60_000, // 30 分钟
  /** 待跑队列上限：入队速率由 cron 决定、出队速率由并发/耗时决定，两者无关联，必须有背压 */
  maxQueueLength: 100,
} as const;

/** 队列项：额外记来源任务，用于周期任务按 task.id 折叠 */
interface QueuedJob {
  job: HeadlessJob;
  taskId: string;
  recurring: boolean;
}

export interface DaemonRuntimeOptions {
  /** 调度检查间隔（ms）；默认 60_000 */
  scheduleCheckIntervalMs?: number;
  /** 最大并发 headless job */
  maxConcurrent?: number;
  /** 单个 job 超时（ms） */
  jobTimeoutMs?: number;
  /** 待跑队列上限；默认 100 */
  maxQueueLength?: number;
  /** 全局兜底工具白名单（任务未声明 allowedTools 时使用，默认只读） */
  allowedTools?: string[];
  /** 是否启用 webhook 源（需 SID_CODE_WEBHOOK_SECRET 或显式开） */
  webhookEnabled?: boolean;
  /** webhook 端口（默认 3847） */
  webhookPort?: number;
}

export class Daemon implements ConcurrencyGate {
  private scheduler: Scheduler | null = null;
  private executor: HeadlessExecutor;
  private storage: FileStorageAdapter;
  private sessionId: string;
  private running = 0;
  private queue: QueuedJob[] = [];
  private webhookServer: { stop: () => void } | null = null;
  private started = false;
  private shuttingDown = false;
  private signalHandlers: Array<{ sig: NodeJS.Signals; handler: () => void }> = [];
  /** 保活心跳：Scheduler 的 timer 被 unref（为交互式会话设计，不阻止退出），
   *  守护进程必须自己持有一个 ref'd handle 保持事件循环存活，否则启动后立即退出。 */
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: DaemonRuntimeOptions = {}) {
    this.sessionId = `daemon-${process.pid}`;
    this.storage = new FileStorageAdapter(join(sidPaths.trajectories(), "daemon-jobs"));
    this.executor = new HeadlessExecutor({ storage: this.storage });
  }

  /**
   * 启动守护进程。
   * @returns true 启动成功；false 已有守护进程在场（拒绝启动）
   */
  start(): boolean {
    if (this.started) return true;

    // 1. 抢单例锁
    if (!tryAcquireDaemonLock()) {
      const existing = readDaemonLock();
      getLogger().error(
        "DAEMON",
        `已有守护进程在运行（pid=${existing?.pid ?? "?"}），拒绝启动第二个`,
      );
      return false;
    }

    // 2. 注册 SessionKind="daemon"（/ps 可见）
    registerSession({
      sessionId: this.sessionId,
      pid: process.pid,
      kind: "daemon",
      cwd: process.cwd(),
      startedAt: Date.now(),
    });

    // 3. 启动调度源
    const interval = this.opts.scheduleCheckIntervalMs ?? DAEMON_DEFAULTS.scheduleCheckIntervalMs;
    this.scheduler = new Scheduler({
      daemonMode: true,
      checkIntervalMs: interval,
      onFire: () => {}, // daemon 模式不用（走 onFireTask）
      onFireTask: (task: CronTask) => this.enqueueTask(task),
      isLoading: () => false, // 守护进程不"忙"，并发由 executor 队列限流
      sessionId: this.sessionId,
      workspaceDir: process.cwd(),
    });
    this.scheduler.start();

    // 4. 可选 webhook 源
    this.maybeStartWebhook();

    // 5. 信号处理
    this.registerSignalHandlers();

    // 6. 保活心跳：持有一个 ref'd timer，阻止事件循环清空导致进程退出。
    //    （Scheduler 的 check timer 已 unref，不足以保活。）
    this.keepAlive = setInterval(() => {
      /* 仅用于保持进程存活；实际工作由 Scheduler/webhook 的回调驱动 */
    }, 60_000);

    this.started = true;
    getLogger().info(
      "DAEMON",
      `守护进程已启动 pid=${process.pid} 调度间隔=${interval}ms 并发上限=${this.maxConcurrent()}`,
    );
    return true;
  }

  /** 优雅停机 */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    getLogger().info("DAEMON", "守护进程停机中…");

    try {
      this.scheduler?.stop();
    } catch {
      /* 忽略 */
    }
    try {
      this.webhookServer?.stop();
    } catch {
      /* 忽略 */
    }
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    try {
      unregisterSession(this.sessionId);
    } catch {
      /* 忽略 */
    }
    try {
      releaseDaemonLock();
    } catch {
      /* 忽略 */
    }

    // 解绑信号 handler（避免重复触发）
    for (const { sig, handler } of this.signalHandlers) {
      try {
        process.off(sig, handler);
      } catch {
        /* 忽略 */
      }
    }
    this.signalHandlers = [];
    this.started = false;
    getLogger().info("DAEMON", "守护进程已停止");
  }

  // ── ConcurrencyGate：webhook worker 与调度队列共用 this.running ──
  // 此前 webhook 另有一份计数，同时有负载时子进程最多 2×max-concurrent。
  canAccept(): boolean {
    return this.running < this.maxConcurrent();
  }

  acquire(): void {
    this.running++;
  }

  release(): void {
    this.running--;
    // webhook job 结束腾出的名额也要让给排队中的调度任务
    this.drainQueue();
  }

  private maxConcurrent(): number {
    return this.opts.maxConcurrent ?? DAEMON_DEFAULTS.maxConcurrent;
  }

  /**
   * 把调度任务转成 HeadlessJob 入队；并发空闲时立即抽干队列。
   *
   * 一次性任务错过 = 语义损失，故排队（不丢）。周期任务相反：只有最新一次有意义——
   * 「每分钟检查 CI」积压 38 份 = 把同一个检查重跑 38 遍、起 38 个子进程。所以周期任务
   * 按 task.id **折叠**：已有待跑副本就原位替换，不追加（jobId 带随机后缀，按 jobId 去重不可能生效）。
   * 队列另有总上限，超限丢弃本次并告警，不静默无界增长。
   */
  private enqueueTask(task: CronTask): void {
    const job: HeadlessJob = {
      jobId: `sched-${task.id}-${randomBytes(3).toString("hex")}`,
      prompt: task.prompt,
      workspaceDir: task.workspaceDir ?? process.cwd(),
      timeoutMs: this.opts.jobTimeoutMs ?? DAEMON_DEFAULTS.jobTimeoutMs,
      source: "schedule",
      // 任务级 allowedTools 优先，否则全局兜底白名单（缺省默认只读，§5.3）
      allowedTools:
        task.allowedTools && task.allowedTools.length > 0
          ? task.allowedTools
          : (this.opts.allowedTools ?? []),
    };
    const entry: QueuedJob = { job, taskId: task.id, recurring: task.recurring };
    if (task.recurring) {
      const idx = this.queue.findIndex((q) => q.recurring && q.taskId === task.id);
      if (idx !== -1) {
        this.queue[idx] = entry;
        getLogger().info(
          "DAEMON",
          `周期任务 id=${task.id} 已有待跑副本，折叠为最新一次（队列长=${this.queue.length}）`,
        );
        this.drainQueue();
        return;
      }
    }
    const cap = this.opts.maxQueueLength ?? DAEMON_DEFAULTS.maxQueueLength;
    if (this.queue.length >= cap) {
      getLogger().error(
        "DAEMON",
        `待跑队列已满（${cap}），丢弃任务 id=${task.id} 本次触发：job 执行速度跟不上触发频率`,
      );
      return;
    }
    this.queue.push(entry);
    getLogger().info("DAEMON", `调度任务入队 id=${task.id} 队列长=${this.queue.length}`);
    this.drainQueue();
  }

  /** 抽干队列：在并发上限内尽量多跑 */
  private drainQueue(): void {
    while (this.running < this.maxConcurrent() && this.queue.length > 0) {
      const { job } = this.queue.shift()!;
      this.running++;
      void this.executor
        .run(job)
        .catch((err) => {
          getLogger().error(
            "DAEMON",
            `headless job 未捕获异常 id=${job.jobId}: ${err?.message ?? err}`,
          );
        })
        .finally(() => {
          this.running--;
          // 一个 job 结束，可能腾出并发名额，继续抽干
          this.drainQueue();
        });
    }
  }

  /** 可选启动 webhook 源（无 secret 且未显式开 → 不监听端口） */
  private maybeStartWebhook(): void {
    // 环境变量缺省时读 install 写下的 0600 secret 文件（服务进程不继承 shell 环境，见 webhook-secret.ts）
    const secret = resolveWebhookSecret();
    const enabled = this.opts.webhookEnabled ?? secret !== "";
    if (!enabled) {
      getLogger().info("DAEMON", "webhook 源未启用（无 secret 且未显式开），纯调度模式");
      return;
    }
    if (secret === "") {
      // 显式 --webhook 但没 secret：server 对所有请求 401（fail-closed），开端口没有意义
      getLogger().warn(
        "DAEMON",
        "指定了 --webhook 但未设置 SID_CODE_WEBHOOK_SECRET（也没有 secret 文件）：所有请求都会被拒（401），webhook 源不启动",
      );
      return;
    }

    try {
      const { createDaemonServer } = require("./server.ts");
      const config: DaemonConfig = {
        port: this.opts.webhookPort ?? 3847,
        host: "127.0.0.1",
        max_concurrent: this.maxConcurrent(),
        webhook_secret: secret,
        workspace_base: join(sidPaths.state(), "daemon-workspaces"),
        storage_type: "file",
        storage_path: join(sidPaths.trajectories(), "daemon-jobs"),
        job_timeout_ms: this.opts.jobTimeoutMs ?? DAEMON_DEFAULTS.jobTimeoutMs,
        allowed_tools: this.opts.allowedTools ?? [],
      };
      this.webhookServer = createDaemonServer(config, this);
      getLogger().info("DAEMON", `webhook 源已启动 :${config.port}`);
    } catch (err: any) {
      getLogger().warn("DAEMON", `webhook 源启动失败（继续纯调度）: ${err?.message ?? err}`);
    }
  }

  private registerSignalHandlers(): void {
    const onSignal = (sig: NodeJS.Signals) => {
      getLogger().info("DAEMON", `收到信号 ${sig}，优雅停机`);
      void this.stop().then(() => process.exit(0));
    };
    for (const sig of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
      const handler = () => onSignal(sig);
      process.on(sig, handler);
      this.signalHandlers.push({ sig, handler });
    }
  }

  /** 阻塞直到收到停机信号（供 CLI 子命令前台运行用） */
  async waitForever(): Promise<void> {
    await new Promise<void>(() => {
      /* 永不 resolve；由信号 handler 触发 process.exit */
    });
  }
}
