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
import { computeNextCronRun, jitteredNextFireMs } from "./parser.ts";
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

  constructor(private opts: SchedulerOptions) {}

  /** 启动调度器 */
  start(): void {
    if (this.timer) return;
    // 尝试获取持久任务调度锁（失败也能跑，只是不负责持久任务触发）
    this.hasDurableLock = tryAcquireSchedulerLock(
      this.opts.workspaceDir,
      this.opts.sessionId,
    );
    if (this.hasDurableLock) {
      this.durableTasks = this.loadDurableTasks();
    }
    this.timer = setInterval(() => this.check(), DEFAULTS.checkIntervalMs);
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
    if (this.hasDurableLock) {
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
        const base = task.lastFiredAt ?? task.createdAt;
        const computed = task.recurring
          ? jitteredNextFireMs(task.cron, base, task.id)
          : computeNextCronRun(task.cron, task.createdAt);
        next = computed ?? Infinity;
        this.nextFireAt.set(task.id, next);
      }

      if (now < next) continue;

      // 触发
      this.inFlight.add(task.id);
      try {
        this.opts.onFire(task.prompt);
      } catch (err: any) {
        getLogger().error("CRON", `任务 ${task.id} 触发失败: ${err.message}`);
      } finally {
        this.inFlight.delete(task.id);
      }

      // 过期检查（循环任务超过 maxAgeDays 则删除）
      const maxAgeMs = DEFAULTS.maxAgeDays * 24 * 60 * 60 * 1000;
      const isAged = task.recurring && now - task.createdAt >= maxAgeMs;

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
    this.flushDurable();
  }

  private removeDurableTask(_taskId: string): void {
    if (!this.hasDurableLock) return;
    this.flushDurable();
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
