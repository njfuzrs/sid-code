/**
 * Dynamic Workflows M1 — 独立并发调度器
 *
 * 为什么独立:
 *  - 不复用 SubAgentTool.running(静态计数,默认 3):那是给模型即兴开 subagent 用的配额,
 *    workflow 一次要开几十个 agent,共用会互相饿死。
 *  - 不裸用 Promise.all(像 swarm/team.ts:93):无背压,4096 个 item 会一次性全发出去打爆
 *    provider 限流。
 *
 * 语义:信号量 + FIFO 等待队列。cap = min(16, cpu核数 - 2)(对齐 cc 一手 spec)。
 * 超额的 acquire 进队列,等有 agent 完成 release 时按 FIFO 唤醒。
 *
 * 这是纯并发原语,不关心 agent 内容——runtime.ts 用它包住每次真实的 SubAgent.execute()。
 */

import os from "node:os";

/** 解析并发上限:min(16, cpu核数 - 2),至少 1。可被 SID_WORKFLOW_MAX_CONCURRENT 覆盖(测试/调优用) */
export function resolveWorkflowConcurrency(
  raw: string | undefined = process.env.SID_WORKFLOW_MAX_CONCURRENT,
): number {
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  let cores = 4;
  try {
    cores = os.cpus().length || 4;
  } catch {
    /* 拿不到核数,用兜底 4 */
  }
  return Math.max(1, Math.min(16, cores - 2));
}

/**
 * 信号量调度器。
 *
 * 用法:
 *   const sched = new Scheduler(8)
 *   const result = await sched.run(() => someAsyncWork())
 *
 * run() 会在槽位可用前挂起,可用后执行 thunk,无论成败都释放槽位。
 */
export class Scheduler {
  private readonly cap: number;
  private active = 0;
  /** FIFO 等待队列:每项是一个"放行"回调 */
  private readonly waiters: Array<() => void> = [];

  constructor(cap: number = resolveWorkflowConcurrency()) {
    this.cap = Math.max(1, cap);
  }

  /** 当前并发上限 */
  get capacity(): number {
    return this.cap;
  }

  /** 当前正在执行的任务数(测试/可观测用) */
  get running(): number {
    return this.active;
  }

  /** 当前排队等待的任务数 */
  get queued(): number {
    return this.waiters.length;
  }

  /** 获取一个槽位(槽位满则进 FIFO 队列等待) */
  private acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  /** 释放一个槽位,按 FIFO 唤醒下一个等待者 */
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * 在并发约束下执行 thunk。
   * thunk 抛错会原样向上抛(由调用方决定吞掉成 null 还是传播),但槽位**一定**释放。
   */
  async run<T>(thunk: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await thunk();
    } finally {
      this.release();
    }
  }
}
