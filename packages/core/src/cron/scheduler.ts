/**
 * Cron 调度器（Spec 18 §5.3.2）
 *
 * 进程内调度器：定期检查到期任务，触发时把 prompt 注入主循环（onFire）。
 * REPL 忙时（isLoading）跳过触发，避免污染当前对话上下文。
 *
 * 任务两类：
 * - 会话级（durable=false）：只活在本进程内存
 * - 持久（durable=true）：写盘 <project>/.sid-code/scheduled_tasks.json，跨会话存活
 *
 * ── durable 任务的两条权利是分开的（B43）──
 * - **写权**：任何会话都能创建 / 删除 durable 任务，写盘走 durable-store 的
 *   「互斥 → 读最新磁盘 → 改 → 原子写」，写失败就抛，调用方如实报错。
 * - **触发权**：同一项目只允许一个驱动者——daemon 在场时是 daemon，否则是抢到
 *   项目级调度锁的那个交互会话。驱动者**每轮检查都重读磁盘**，所以别的会话
 *   （或 daemon 运行期间）新建的任务下一轮就会被看见，不必重启。
 *   触发前在磁盘上**认领**（比对 lastFiredAt），交接窗口里两边同时到期也只有一方能触发。
 * 驱动者身份每轮重新判定：daemon 起来，会话下一轮就让出；daemon 停了，会话下一轮接回。
 *
 * B43 之前写权被调度锁卡住：没抢到锁（`.sid-code/` 不存在、同项目已有会话、daemon 在场）
 * 的会话建的 durable 任务只活在内存里，工具照样回「已持久化」。
 *
 * 会话级循环任务最多存活 7 天后自动过期删除；durable 任务不自动过期（见 check）。
 *
 * 持久任务文件刻意放在 <project>/.sid-code/（而非用户 HOME），与锁文件同理：
 * 调度权是"同项目并发协调"语义，详见 lock.ts 文件头注。对标 claude-code 的
 * cronTasks.ts（"stored in <project>/.claude/scheduled_tasks.json"）。
 */

import {
  type CronTask,
  DEFAULTS,
  MAX_SESSION_CRON_JOBS,
  MAX_DAEMON_CRON_JOBS,
  isCronDisabled,
} from "./types.ts";
import { computeNextCronRun, jitteredNextFireMs, computeLatestMissedRun } from "./parser.ts";
import {
  tryAcquireSchedulerLock,
  releaseSchedulerLock,
  isSchedulerLockHeldByOther,
} from "./lock.ts";
import { existsSync } from "fs";
import { readDurableTasks, mutateDurableTasks, durableFilePath } from "./durable-store.ts";
import { grantDurableTask, revokeDurableTask, isDurableTaskGranted } from "./durable-grants.ts";
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
   * - 跨多个项目加载 durable 任务（而非仅 workspaceDir 一个项目），每轮重读注册表与各项目文件
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
  /**
   * 交互模式下本会话能否驱动 durable 任务（缺省 true）。
   * 宿主没有执行提示词的能力（`-p` 无头、bridge）时必须传 false：
   * 驱动者触发前会在磁盘上认领任务，认领了却执行不了就是静默丢任务。
   */
  driveDurable?: boolean;
  /** 测试注入：判断 daemon 是否在场。缺省读 daemon/lock.ts。 */
  isDaemonRunning?: () => boolean;
}

/** 认领结果：claimed=false 说明别的驱动者已经触发过 / 任务已被删 */
type Claim = { claimed: boolean };

export class Scheduler {
  private sessionTasks = new Map<string, CronTask>();
  /** durable 任务的内存缓存（磁盘才是事实源，每轮 refresh 重建） */
  private durableTasks = new Map<string, CronTask>();
  private nextFireAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 交互模式：本会话当前是否为本项目 durable 任务的驱动者 */
  private drivingDurable = false;
  /** taskId → 来源项目根（决定写回哪个 json） */
  private durableTaskOrigin = new Map<string, string>();
  /** daemon 模式的 catch-up 只跑一次 */
  private caughtUp = false;

  constructor(private opts: SchedulerOptions) {}

  /** 启动调度器 */
  start(): void {
    if (this.timer) return;

    // 整体禁用：不启动轮询。已持久化的 durable 任务因此也不会被触发——
    // 只在工具层拒绝创建挡不住「上次会话留下的任务」。
    if (isCronDisabled()) {
      getLogger().info("CRON", "SID_CODE_DISABLE_CRON 已设置，调度器不启动轮询");
      return;
    }

    this.refreshDurable();
    if (this.opts.daemonMode && !this.caughtUp) {
      this.caughtUp = true;
      this.runCatchUp();
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
    this.releaseDriving();
  }

  /**
   * 添加会话级任务。
   * 上限按「本调度器实例管理的会话级任务」计数（对齐 CC 的单会话 50），
   * 达上限返回 false 且不入队——三个创建入口（cron_create / schedule_wakeup / /loop）
   * 都走这里，守卫放工具层会被任一入口绕过。
   */
  addSessionTask(task: CronTask): boolean {
    if (this.sessionTasks.size >= this.sessionCap()) return false;
    this.sessionTasks.set(task.id, task);
    this.nextFireAt.delete(task.id); // 重新计算
    return true;
  }

  /**
   * 添加持久任务：先落盘，成功才进内存。
   * 返回 false = 达上限（未写盘）；写盘失败抛错（调用方必须如实报告，不能回「已持久化」）。
   *
   * 上限分档：daemon 模式按全机聚合上限（500）；会话模式按「本项目磁盘上的 durable 任务
   * + 本会话会话级任务」计 50——按磁盘计数，别的会话建的也算。
   */
  addDurableTask(task: CronTask): boolean {
    const projectDir = task.workspaceDir ?? this.opts.workspaceDir;
    const cap = this.durableCap();
    // 先登记再写盘：登记失败（抛错）则什么都没写；写盘失败留下的登记项会被
    // listDurableProjects 自愈剔除。反过来的顺序会留下「在盘上但 daemon 永远发现不了」的任务。
    // 登记放在这里而不是某个工具里：任何入口建的 durable 任务都必须能被 daemon 发现。
    const { registerDurableProject } = require("../daemon/durable-projects.ts");
    registerDurableProject(projectDir);
    const stored: CronTask = { ...task, durable: true, workspaceDir: projectDir };
    // 本机授权先于写盘：任务一旦落盘就可能被驱动者看见，没授权的会被拒绝执行。
    grantDurableTask(projectDir, stored);
    const ok = mutateDurableTasks(projectDir, (tasks) => {
      const used = this.opts.daemonMode
        ? this.durableTasks.size
        : this.sessionTasks.size + tasks.length;
      if (used >= cap) return { result: false };
      return { tasks: [...tasks.filter((t) => t.id !== stored.id), stored], result: true };
    });
    if (!ok) {
      revokeDurableTask(projectDir, stored.id);
      return false;
    }
    this.durableTasks.set(stored.id, stored);
    this.durableTaskOrigin.set(stored.id, projectDir);
    this.nextFireAt.delete(stored.id);
    return true;
  }

  /**
   * 删除任务（两类都查）。durable 任务按磁盘删：别的会话建的任务也能删。
   * 写盘失败抛错。
   */
  removeTask(taskId: string): boolean {
    let removed = false;
    if (this.sessionTasks.delete(taskId)) removed = true;

    const origins = new Set<string>();
    const known = this.durableTaskOrigin.get(taskId);
    if (known) origins.add(known);
    if (!this.opts.daemonMode) origins.add(this.opts.workspaceDir);
    for (const dir of origins) {
      // 没有任务文件就没什么可删——别为了删一个会话级任务在任意 cwd 下建出 .sid-code/
      if (!existsSync(durableFilePath(dir))) continue;
      const hit = mutateDurableTasks(dir, (tasks) => {
        const rest = tasks.filter((t) => t.id !== taskId);
        return rest.length === tasks.length ? { result: false } : { tasks: rest, result: true };
      });
      if (hit) {
        removed = true;
        this.revokeQuietly(dir, taskId);
      }
    }
    this.durableTasks.delete(taskId);
    this.durableTaskOrigin.delete(taskId);
    this.nextFireAt.delete(taskId);
    return removed;
  }

  /** 会话级任务上限（供报错文案使用，与 addSessionTask 的判据同源）。 */
  sessionCap(): number {
    return MAX_SESSION_CRON_JOBS;
  }

  /** 持久任务上限：daemon 聚合全机用高档，会话模式与会话级共用一档。 */
  durableCap(): number {
    return this.opts.daemonMode ? MAX_DAEMON_CRON_JOBS : MAX_SESSION_CRON_JOBS;
  }

  /**
   * 列出所有任务。durable 部分现读磁盘（不管本会话是不是驱动者），
   * 所以 /cron、cron_list 看到的是真实状态，而不是本进程启动时的快照。
   */
  listTasks(): CronTask[] {
    this.refreshDurable();
    return [...this.sessionTasks.values(), ...this.durableTasks.values()];
  }

  /**
   * 本项目 durable 任务此刻由谁触发。现场判定（不依赖上一轮 check），
   * 供 cron_create 如实回报——「已写盘」不等于「到点会执行」。
   */
  durableDriver(): "daemon" | "self" | "other-session" | "none" {
    if (this.opts.daemonMode) return "self";
    if (this.daemonPresent()) return "daemon";
    if (this.opts.driveDurable !== false && this.timer) {
      this.updateDriving();
      if (this.drivingDurable) return "self";
    }
    return isSchedulerLockHeldByOther(this.opts.workspaceDir, this.opts.sessionId)
      ? "other-session"
      : "none";
  }

  /** 本会话当前是否在驱动 durable 任务（交互模式；daemon 模式恒 true） */
  isDrivingDurable(): boolean {
    return this.opts.daemonMode ? true : this.drivingDurable;
  }

  private revokeQuietly(projectDir: string, taskId: string): void {
    try {
      revokeDurableTask(projectDir, taskId);
    } catch (err: any) {
      // 登记表残留一条不影响安全（同 id 新任务指纹不同就对不上），只记日志
      getLogger().warn("CRON", `撤销任务 ${taskId} 授权失败: ${err?.message ?? err}`);
    }
  }

  // ── 驱动者判定 ──

  private daemonPresent(): boolean {
    if (this.opts.isDaemonRunning) return this.opts.isDaemonRunning();
    try {
      // 动态 require 避免 cron 层强依赖 daemon 层
      const { isDaemonRunning } = require("../daemon/lock.ts");
      return isDaemonRunning() === true;
    } catch {
      return false;
    }
  }

  /**
   * 交互模式：每轮重新判定本会话是否该驱动本项目的 durable 任务。
   * daemon 在场 → 让出（并释放项目锁，daemon 不抢它但别的会话可以）；
   * daemon 不在 → 尝试抢项目级锁（lock.ts 自带 mkdir，`.sid-code/` 不存在也能抢）。
   */
  private updateDriving(): void {
    if (this.opts.daemonMode) return;
    if (this.opts.driveDurable === false) return;
    if (this.daemonPresent()) {
      if (this.drivingDurable) {
        getLogger().info("CRON", "检测到守护进程在场，本会话让出 durable 任务驱动");
      }
      this.releaseDriving();
      return;
    }
    const got = tryAcquireSchedulerLock(this.opts.workspaceDir, this.opts.sessionId);
    if (got && !this.drivingDurable) {
      getLogger().info("CRON", "本会话接管本项目 durable 任务驱动");
    }
    this.drivingDurable = got;
  }

  private releaseDriving(): void {
    if (this.opts.daemonMode) return;
    if (this.drivingDurable) {
      releaseSchedulerLock(this.opts.workspaceDir, this.opts.sessionId);
      this.drivingDurable = false;
    }
  }

  // ── 磁盘同步 ──

  /** 要读的项目根：daemon = 注册表全部；交互 = 本项目 */
  private durableProjects(): string[] {
    if (!this.opts.daemonMode) return [this.opts.workspaceDir];
    try {
      const { listDurableProjects } = require("../daemon/durable-projects.ts");
      return listDurableProjects();
    } catch (err: any) {
      getLogger().warn("CRON", `加载 durable-projects 注册表失败: ${err?.message ?? err}`);
      return [...new Set(this.durableTaskOrigin.values())];
    }
  }

  /**
   * 用磁盘重建 durable 缓存。读失败的项目保留旧缓存（不能因为一次读坏就当它没任务）。
   * 已不在磁盘上的任务（别的进程删了 / 已被认领执行掉）从缓存与 nextFireAt 中移除。
   */
  private refreshDurable(): void {
    const next = new Map<string, CronTask>();
    const nextOrigin = new Map<string, string>();
    for (const projectDir of this.durableProjects()) {
      let tasks: CronTask[];
      try {
        tasks = readDurableTasks(projectDir);
      } catch (err: any) {
        getLogger().warn("CRON", `读取项目 ${projectDir} 的持久任务失败: ${err?.message ?? err}`);
        for (const [id, origin] of this.durableTaskOrigin) {
          if (origin === projectDir && this.durableTasks.has(id)) {
            next.set(id, this.durableTasks.get(id)!);
            nextOrigin.set(id, origin);
          }
        }
        continue;
      }
      for (const t of tasks) {
        // workspaceDir 缺省回退到该任务来源项目根（§4.4 向后兼容老任务）
        if (!t.workspaceDir) t.workspaceDir = projectDir;
        const prev = this.durableTasks.get(t.id);
        // 磁盘上 lastFiredAt 变了（别的驱动者触发过）→ 下次触发时刻要重算
        if (prev && prev.lastFiredAt !== t.lastFiredAt) this.nextFireAt.delete(t.id);
        next.set(t.id, t);
        nextOrigin.set(t.id, projectDir);
      }
    }
    for (const id of this.durableTasks.keys()) {
      if (!next.has(id)) this.nextFireAt.delete(id);
    }
    this.durableTasks = next;
    this.durableTaskOrigin = nextOrigin;
  }

  /**
   * 在磁盘上认领一次触发。互斥内比对 lastFiredAt：与本进程看到的不一致说明
   * 别的驱动者已经触发过，放弃。认领成功即落盘新状态（循环：更新 lastFiredAt；
   * 一次性：删除），之后才真正 fire——宁可「认领了但 fire 抛错」（有日志），
   * 也不要「fire 了但没认领」（交接窗口双触发）。
   */
  private claimDurable(task: CronTask, now: number, keep: boolean): Claim {
    const origin = this.durableTaskOrigin.get(task.id);
    if (!origin) return { claimed: false };
    return {
      claimed: mutateDurableTasks(origin, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === task.id);
        if (idx === -1) return { result: false };
        if (tasks[idx].lastFiredAt !== task.lastFiredAt) return { result: false };
        if (!keep) return { tasks: tasks.filter((_, i) => i !== idx), result: true };
        const updated = [...tasks];
        updated[idx] = { ...tasks[idx], lastFiredAt: now };
        return { tasks: updated, result: true };
      }),
    };
  }

  // ── 检查循环 ──

  /** 核心检查循环 */
  private check(): void {
    // REPL 忙时不触发，避免上下文污染
    if (this.opts.isLoading()) return;

    this.updateDriving();
    this.refreshDurable();

    const now = Date.now();
    const candidates = [
      ...this.sessionTasks.values(),
      ...(this.isDrivingDurable() ? this.durableTasks.values() : []),
    ];

    for (const task of candidates) {
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

      // 过期检查：
      // - 会话级循环任务：超过 maxAgeDays 自动过期删除（对齐 cc 7 天）
      // - durable 任务：不自动过期（§9 待决 3 拍板：要长期跑才会建 durable），只能手动删除。
      //   B43 前只在 daemon 驱动时不过期——同一个任务由会话驱动 7 天后被删、由 daemon 驱动永不删，
      //   语义取决于「这一刻谁在驱动」，用户无从预期。
      const maxAgeMs = DEFAULTS.maxAgeDays * 24 * 60 * 60 * 1000;
      const isAged = task.recurring && !task.durable && now - task.createdAt >= maxAgeMs;
      const keep = task.recurring && !isAged;

      this.fireOnce(task, now, keep, "CRON");
    }
  }

  /**
   * 触发一个任务并推进状态。durable 任务先认领后 fire；
   * 会话级任务只动内存。
   */
  /** @returns 是否真的触发了（未授权 / 认领失败 / 被别人抢先 = false） */
  private fireOnce(task: CronTask, now: number, keep: boolean, tag: string): boolean {
    if (task.durable) {
      const origin = this.durableTaskOrigin.get(task.id);
      if (!origin || !isDurableTaskGranted(origin, task)) {
        this.warnUngranted(task, origin);
        return false;
      }
      let claim: Claim;
      try {
        claim = this.claimDurable(task, now, keep);
      } catch (err: any) {
        // 认领写盘失败：本轮不触发，下一轮重试（不 fire 是为了不双触发、不丢状态）
        getLogger().error("CRON", `任务 ${task.id} 认领失败，本轮跳过: ${err?.message ?? err}`);
        return false;
      }
      if (!claim.claimed) {
        this.nextFireAt.delete(task.id);
        return false;
      }
    }

    this.inFlight.add(task.id);
    try {
      this.fireTask(task);
    } catch (err: any) {
      getLogger().error(tag, `任务 ${task.id} 触发失败: ${err?.message ?? err}`);
    } finally {
      this.inFlight.delete(task.id);
    }

    if (keep) {
      // 循环任务：从 now 重新调度（避免快速追赶历史）
      task.lastFiredAt = now;
      const newNext = jitteredNextFireMs(task.cron, now, task.id);
      this.nextFireAt.set(task.id, newNext ?? Infinity);
    } else if (task.durable) {
      // 磁盘上已在认领时删掉，这里只清缓存与授权
      const origin = this.durableTaskOrigin.get(task.id);
      if (origin) this.revokeQuietly(origin, task.id);
      this.durableTasks.delete(task.id);
      this.durableTaskOrigin.delete(task.id);
      this.nextFireAt.delete(task.id);
    } else {
      this.sessionTasks.delete(task.id);
      this.nextFireAt.delete(task.id);
    }
    return true;
  }

  /** 未授权任务每个只告警一次（每分钟一轮，不能刷屏） */
  private warnedUngranted = new Set<string>();
  private warnUngranted(task: CronTask, origin: string | undefined): void {
    const key = `${origin}::${task.id}::${task.prompt}`;
    if (this.warnedUngranted.has(key)) return;
    this.warnedUngranted.add(key);
    getLogger().warn(
      "CRON",
      `跳过未授权的 durable 任务 ${task.id}（${origin ?? "?"}）：不是本机创建的，或创建后被改过。` +
        `确认无误请在该项目里用 cron_delete 删除后重新创建`,
    );
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

  // ── 守护进程模式（缺口 C1）──

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
      let due = false;
      if (task.fireAt !== undefined) {
        // fireAt 一次性绝对唤醒：错过即触发（语义本就只跑一次）
        due = task.fireAt <= now;
      } else if (task.recurring) {
        due = computeLatestMissedRun(task.cron, task.lastFiredAt ?? task.createdAt, now) !== null;
      } else {
        // 一次性 cron 任务：若其唯一触发时刻已过，补一次后自删
        const at = computeNextCronRun(task.cron, task.createdAt);
        due = at !== null && at <= now;
      }
      if (!due) continue;
      if (this.fireOnce(task, now, task.recurring && task.fireAt === undefined, "CRON")) caught++;
    }

    getLogger().info(
      "CRON",
      `守护进程加载 ${tasks.length} 个 durable 任务，catch-up 补跑 ${caught} 个（每个只补最近一次）`,
    );
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
      // 工具/命令在调度器未初始化时调用：返回一个兜底实例（不轮询，但写盘照常）
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
