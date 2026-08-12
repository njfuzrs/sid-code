/**
 * Cron 调度器（Spec 18 §5.3.2）
 *
 * 进程内调度器：每 30s 检查一次到期任务，触发时把 prompt 注入主循环（onFire）。
 * REPL 忙时（isLoading）跳过触发，避免污染当前对话上下文。
 *
 * 任务两类：
 * - 会话级（durable=false）：只活在本进程内存
 * - 持久（durable=true）：写盘 .sid-code/scheduled_tasks.json，跨会话存活，
 *   并通过文件锁保证只有一个会话负责触发持久任务
 *
 * 循环任务最多存活 7 天后自动过期删除。
 *
 * 持久任务文件刻意放在 <project>/.sid-code/（而非用户 HOME），与锁文件同理：
 * 调度权是"同项目并发协调"语义，详见 lock.ts 文件头注。对标 claude-code 的
 * cronTasks.ts（"stored in <project>/.claude/scheduled_tasks.json"）。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { type CronTask, DEFAULTS } from "./types.ts";
import { computeNextCronRun, jitteredNextFireMs, computeLatestMissedRun } from "./parser.ts";
import { tryAcquireSchedulerLock, releaseSchedulerLock } from "./lock.ts";
import { getLogger } from "../debug/logger.ts";

export interface SchedulerOptions {
  /** 触发时执行：把 prompt 注入主循环 */
  onFire: (prompt: string) => void;
  /** REPL 是否忙（忙时跳过触发） */
  isLoading: () => boolean;
  /** 当前会话 ID（锁协调用） */
  sessionId: string;
  /** 工作目录（持久任务/锁文件存放处） */
  workspaceDir: string;
  /**
   * 守护进程模式（缺口 C1）。开启后：
   * - 跨多个项目加载 durable 任务（而非仅 workspaceDir 一个项目）
   * - start() 时执行 catch-up「只补最近一次」
   * - 触发时把 task 整体（含 workspaceDir/allowedTools）交给 onFireTask
   * - 不抢项目级锁（守护进程是 durable 任务的唯一权威驱动者，见 §4.3 C1-Lock-B）
   */
  daemonMode?: boolean;
  /**
   * 守护进程触发出口：拿到完整 task（含 workspaceDir/allowedTools），
   * 而非仅 prompt。daemonMode=true 时优先用它；否则回退 onFire(prompt)。
   */
  onFireTask?: (task: CronTask) => void;
  /** 检查间隔覆盖（ms）；守护进程默认 60_000（每分钟，对齐 cc） */
  checkIntervalMs?: number;
}

const DURABLE_FILE = ".sid-code/scheduled_tasks.json";

export class Scheduler {
  private sessionTasks = new Map<string, CronTask>();
  private durableTasks = new Map<string, CronTask>();
  private nextFireAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 是否持有持久任务调度权 */
  private hasDurableLock = false;
  /** 守护进程模式下：durable 任务来源项目根（taskId → projectDir），决定持久化写哪个 json */
  private durableTaskOrigin = new Map<string, string>();

  constructor(private opts: SchedulerOptions) {}

  /** 启动调度器 */
  start(): void {
    if (this.timer) return;

    if (this.opts.daemonMode) {
      // 守护进程模式（缺口 C1）：跨项目加载 durable 任务，不抢项目级锁，启动时 catch-up。
      this.hasDurableLock = true; // 守护进程是 durable 任务的唯一权威驱动者
      this.loadAllDurableProjects();
      this.runCatchUp();
    } else {
      // 交互式模式：C1-Lock-B —— 若本机守护进程在场，主动放弃 durable 任务驱动，
      // 只跑自己的会话级任务，把 durable 全交给守护进程，避免双触发。
      let deferToDaemon = false;
      try {
        // 动态 require 避免 cron 层强依赖 daemon 层（仅交互式启动时探测一次）
        const { isDaemonRunning } = require("../daemon/lock.ts");
        deferToDaemon = isDaemonRunning() === true;
      } catch {
        deferToDaemon = false;
      }

      if (deferToDaemon) {
        this.hasDurableLock = false;
        getLogger().info(
          "CRON",
          "检测到守护进程在场，本会话放弃 durable 任务驱动（只跑会话级任务）",
        );
      } else {
        // 尝试获取持久任务调度锁（失败也能跑，只是不负责持久任务触发）
        this.hasDurableLock = tryAcquireSchedulerLock(this.opts.workspaceDir, this.opts.sessionId);
        if (this.hasDurableLock) {
          this.durableTasks = this.loadDurableTasks();
        }
      }
    }

    const interval = this.opts.checkIntervalMs ?? DEFAULTS.checkIntervalMs;
    this.timer = setInterval(() => this.check(), interval);
    // Bun/Node：不阻止进程退出
    if (this.timer && typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  /** 停止调度器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 守护进程模式不持有项目级锁，无需释放
    if (this.hasDurableLock && !this.opts.daemonMode) {
      releaseSchedulerLock(this.opts.workspaceDir, this.opts.sessionId);
      this.hasDurableLock = false;
    }
  }

  /** 添加会话级任务 */
  addSessionTask(task: CronTask): void {
    this.sessionTasks.set(task.id, task);
    this.nextFireAt.delete(task.id); // 重新计算
  }

  /** 添加持久任务 */
  addDurableTask(task: CronTask): void {
    task.durable = true;
    this.durableTasks.set(task.id, task);
    this.nextFireAt.delete(task.id);
    this.persistIfDurable(task);
  }

  /** 删除任务（两类都查） */
  removeTask(taskId: string): boolean {
    let removed = false;
    if (this.sessionTasks.delete(taskId)) removed = true;
    if (this.durableTasks.delete(taskId)) {
      this.removeDurableTask(taskId);
      removed = true;
    }
    this.nextFireAt.delete(taskId);
    return removed;
  }

  /** 列出所有任务 */
  listTasks(): CronTask[] {
    return [...this.sessionTasks.values(), ...this.durableTasks.values()];
  }

  /** 核心检查循环 */
  private check(): void {
    // REPL 忙时不触发，避免上下文污染
    if (this.opts.isLoading()) return;

    const now = Date.now();
    const allTasks = this.listTasks();

    for (const task of allTasks) {
      if (this.inFlight.has(task.id)) continue;

      // 计算下次触发时间
      let next = this.nextFireAt.get(task.id);
      if (next === undefined) {
        if (task.fireAt !== undefined) {
          // 相对延迟一次性唤醒（ScheduleWakeup）：直接用绝对触发时刻，绕过 cron 解析
          next = task.fireAt;
        } else {
          const base = task.lastFiredAt ?? task.createdAt;
          const computed = task.recurring
            ? jitteredNextFireMs(task.cron, base, task.id)
            : computeNextCronRun(task.cron, task.createdAt);
          next = computed ?? Infinity;
        }
        this.nextFireAt.set(task.id, next);
      }

      if (now < next) continue;

      // 触发
      this.inFlight.add(task.id);
      try {
        this.fireTask(task);
      } catch (err: any) {
        getLogger().error("CRON", `任务 ${task.id} 触发失败: ${err.message}`);
      } finally {
        this.inFlight.delete(task.id);
      }

      // 过期检查：
      // - 交互式会话级 / 普通循环任务：超过 maxAgeDays 自动过期删除（对齐 cc 7 天）
      // - 守护进程的 durable 任务：不自动过期（无人值守场景就是要长期跑，§9 待决 3 拍板），
      //   只能手动 cron_delete。
      const maxAgeMs = DEFAULTS.maxAgeDays * 24 * 60 * 60 * 1000;
      const durableNeverExpires = this.opts.daemonMode && task.durable;
      const isAged = task.recurring && !durableNeverExpires && now - task.createdAt >= maxAgeMs;

      if (task.recurring && !isAged) {
        // 循环任务：从 now 重新调度（避免快速追赶历史）
        const newNext = jitteredNextFireMs(task.cron, now, task.id);
        this.nextFireAt.set(task.id, newNext ?? Infinity);
        task.lastFiredAt = now;
        this.persistIfDurable(task);
      } else {
        // 一次性或过期任务：删除
        this.removeTask(task.id);
      }
    }
  }

  /**
   * 触发一个任务。守护进程模式优先走 onFireTask（携带完整 task：workspaceDir/allowedTools），
   * 否则回退 onFire(prompt)（交互式宿主）。
   */
  private fireTask(task: CronTask): void {
    if (this.opts.daemonMode && this.opts.onFireTask) {
      this.opts.onFireTask(task);
    } else {
      this.opts.onFire(task.prompt);
    }
  }

  // ── 持久化 ──

  private durableFilePath(): string {
    return join(this.opts.workspaceDir, DURABLE_FILE);
  }

  private loadDurableTasks(): Map<string, CronTask> {
    const map = new Map<string, CronTask>();
    const path = this.durableFilePath();
    if (!existsSync(path)) return map;
    try {
      const arr: CronTask[] = JSON.parse(readFileSync(path, "utf-8"));
      for (const t of arr) {
        if (t && t.id && t.cron && t.prompt) {
          t.durable = true;
          map.set(t.id, t);
        }
      }
    } catch (err: any) {
      getLogger().warn("CRON", `加载持久任务失败: ${err.message}`);
    }
    return map;
  }

  private persistIfDurable(task: CronTask): void {
    if (!task.durable || !this.hasDurableLock) return;
    if (this.opts.daemonMode) {
      this.flushDurableForOrigin(this.durableTaskOrigin.get(task.id));
    } else {
      this.flushDurable();
    }
  }

  private removeDurableTask(taskId: string): void {
    if (!this.hasDurableLock) return;
    if (this.opts.daemonMode) {
      const origin = this.durableTaskOrigin.get(taskId);
      this.durableTaskOrigin.delete(taskId);
      this.flushDurableForOrigin(origin);
    } else {
      this.flushDurable();
    }
  }

  private flushDurable(): void {
    const path = this.durableFilePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...this.durableTasks.values()], null, 2));
    } catch (err: any) {
      getLogger().warn("CRON", `持久化任务失败: ${err.message}`);
    }
  }

  // ── 守护进程模式（缺口 C1）──

  /**
   * 跨多个项目加载 durable 任务（守护进程模式）。
   * 从 durable-projects 注册表取已知项目清单，逐个读其 scheduled_tasks.json 合并。
   * 记录每个任务的来源项目（durableTaskOrigin），持久化时写回各自的 json。
   */
  private loadAllDurableProjects(): void {
    let projects: string[] = [];
    try {
      const { listDurableProjects } = require("../daemon/durable-projects.ts");
      projects = listDurableProjects();
    } catch (err: any) {
      getLogger().warn("CRON", `加载 durable-projects 注册表失败: ${err?.message ?? err}`);
      return;
    }

    let count = 0;
    for (const projectDir of projects) {
      const path = join(projectDir, DURABLE_FILE);
      if (!existsSync(path)) continue;
      try {
        const arr: CronTask[] = JSON.parse(readFileSync(path, "utf-8"));
        for (const t of arr) {
          if (t && t.id && t.cron && t.prompt) {
            t.durable = true;
            // workspaceDir 缺省回退到该任务来源项目根（§4.4 向后兼容老任务）
            if (!t.workspaceDir) t.workspaceDir = projectDir;
            this.durableTasks.set(t.id, t);
            this.durableTaskOrigin.set(t.id, projectDir);
            count++;
          }
        }
      } catch (err: any) {
        getLogger().warn("CRON", `加载项目 ${projectDir} 的持久任务失败: ${err?.message ?? err}`);
      }
    }
    getLogger().info("CRON", `守护进程加载 ${count} 个 durable 任务（${projects.length} 个项目）`);
  }

  /**
   * catch-up「只补最近一次」（守护进程启动时，对齐 cc「discards anything older」）。
   * 对每个 recurring durable 任务：枚举 (lastFiredAt, now] 区间内错过的触发点，
   * 只补 max(missed) 一次，丢弃更早的；一次性任务错过则直接执行后自删。
   */
  private runCatchUp(): void {
    const now = Date.now();
    const tasks = [...this.durableTasks.values()];
    let caught = 0;

    for (const task of tasks) {
      // fireAt 一次性绝对唤醒：错过即触发（语义本就只跑一次）
      if (task.fireAt !== undefined) {
        if (task.fireAt <= now) {
          this.catchUpFire(task, now);
          caught++;
        }
        continue;
      }

      const base = task.lastFiredAt ?? task.createdAt;
      if (task.recurring) {
        const latest = computeLatestMissedRun(task.cron, base, now);
        if (latest !== null) {
          this.catchUpFire(task, now);
          caught++;
        }
      } else {
        // 一次性 cron 任务：若其唯一触发时刻已过，补一次后自删
        const due = computeNextCronRun(task.cron, task.createdAt);
        if (due !== null && due <= now) {
          this.catchUpFire(task, now);
          caught++;
        }
      }
    }

    if (caught > 0) {
      getLogger().info("CRON", `catch-up 补跑 ${caught} 个错过的任务（每个只补最近一次）`);
    }
  }

  /** 执行一次 catch-up 触发，并更新 lastFiredAt / 调度下一次或删除 */
  private catchUpFire(task: CronTask, now: number): void {
    if (this.inFlight.has(task.id)) return;
    this.inFlight.add(task.id);
    try {
      this.fireTask(task);
    } catch (err: any) {
      getLogger().error("CRON", `catch-up 任务 ${task.id} 触发失败: ${err?.message ?? err}`);
    } finally {
      this.inFlight.delete(task.id);
    }

    if (task.recurring && task.fireAt === undefined) {
      const newNext = jitteredNextFireMs(task.cron, now, task.id);
      this.nextFireAt.set(task.id, newNext ?? Infinity);
      task.lastFiredAt = now;
      this.persistIfDurable(task);
    } else {
      // 一次性（cron 或 fireAt）：补跑后删除
      this.removeTask(task.id);
    }
  }

  /** 守护进程模式：把某个来源项目的 durable 任务写回它自己的 json */
  private flushDurableForOrigin(origin: string | undefined): void {
    if (!origin) return;
    const path = join(origin, DURABLE_FILE);
    const tasksForOrigin = [...this.durableTasks.values()].filter(
      (t) => this.durableTaskOrigin.get(t.id) === origin,
    );
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(tasksForOrigin, null, 2));
    } catch (err: any) {
      getLogger().warn("CRON", `持久化项目 ${origin} 的任务失败: ${err?.message ?? err}`);
    }
  }
}

// ── 单例 ──

let instance: Scheduler | null = null;

/**
 * 获取调度器单例。
 * 首次调用必须传 opts（由 cli.ts 在启动时调用）；
 * 后续调用（如工具/命令）不传 opts 直接取已有实例。
 */
export function getScheduler(opts?: SchedulerOptions): Scheduler {
  if (!instance) {
    if (!opts) {
      // 工具/命令在调度器未初始化时调用：返回一个 no-op 兜底实例
      instance = new Scheduler({
        onFire: () => {},
        isLoading: () => false,
        sessionId: "default",
        workspaceDir: process.cwd(),
      });
    } else {
      instance = new Scheduler(opts);
    }
  }
  return instance;
}

/** 重置单例（测试用） */
export function resetScheduler(): void {
  if (instance) instance.stop();
  instance = null;
}
