/**
 * durable 任务的磁盘存储（B43）
 *
 * `<project>/.sid-code/scheduled_tasks.json` 是 durable 任务的**唯一事实源**，
 * 内存里的 Map 只是缓存。所有写操作都走 `mutateDurableTasks`：
 * 互斥 → 读最新磁盘 → 改 → 原子写。
 *
 * 为什么不能沿用「内存 Map 全量覆盖写盘」（B43 之前的实现）：
 *   1. 写盘曾被「调度权」锁卡住——没抢到调度锁的会话（同项目已有别的会话 / daemon 在场 /
 *      `.sid-code/` 不存在导致抢锁失败）创建的 durable 任务只活在内存里，工具却回「已持久化」。
 *   2. 全量覆盖会互相吞任务：A 会话、daemon 各自拿着启动时那份 Map，谁后写谁就把对方
 *      之后新建的任务抹掉。
 *   3. 「触发」必须是一次认领：daemon 与交互会话交接调度权的窗口里，两边都可能认为任务到期。
 *      认领在互斥内比对磁盘上的 lastFiredAt，只有一方能成功，杜绝双触发。
 *
 * 「谁有权写」与「谁有权触发」是两件事：写入任何会话都可以；触发只有调度驱动者能做。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { CronTask } from "./types.ts";

/** 相对项目根的路径 */
export const DURABLE_FILE = ".sid-code/scheduled_tasks.json";

/** 互斥只包住一次读改写（毫秒级）。超过这个年龄必是持有者崩溃残留。 */
const MUTEX_STALE_MS = 10_000;
/** 抢互斥的总等待上限。等不到就抛错，由调用方如实报告失败，不静默降级。 */
const MUTEX_WAIT_MS = 3_000;
const MUTEX_SPIN_MS = 15;

export function durableFilePath(projectDir: string): string {
  return join(projectDir, DURABLE_FILE);
}

function isValidTask(t: unknown): t is CronTask {
  const x = t as CronTask;
  return (
    !!x &&
    typeof x.id === "string" &&
    !!x.id &&
    typeof x.prompt === "string" &&
    !!x.prompt &&
    typeof x.cron === "string" &&
    (x.cron !== "" || typeof x.fireAt === "number")
  );
}

/**
 * 读某项目的 durable 任务。文件不存在返回 []。
 * 文件损坏时抛错——把损坏当成「空」继续写，会把用户全部任务覆盖成 []。
 */
export function readDurableTasks(projectDir: string): CronTask[] {
  const path = durableFilePath(projectDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${path} 不是任务数组`);
  return parsed.filter(isValidTask).map((t) => ({ ...t, durable: true }));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 互斥目录 = 目标文件 + ".mutex"：mkdir 在 POSIX 上原子，EEXIST 即被占用 */
function acquireMutex(targetPath: string): () => void {
  const dir = `${targetPath}.mutex`;
  mkdirSync(dirname(dir), { recursive: true });
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
      return () => {
        try {
          rmdirSync(dir);
        } catch {
          /* 已被 stale 回收 */
        }
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(dir).mtimeMs > MUTEX_STALE_MS) {
          rmdirSync(dir);
          continue;
        }
      } catch {
        continue; // 期间被释放，重抢
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待 ${dir} 超时（${MUTEX_WAIT_MS}ms），另一进程正在写定时任务`);
      }
      sleepSync(MUTEX_SPIN_MS);
    }
  }
}

/**
 * 在文件级互斥内执行 fn。跨进程的读改写都要包在这里，否则两个进程交错时
 * 后写的一方会把先写的一方的改动整个覆盖掉。
 */
export function withFileMutex<R>(targetPath: string, fn: () => R): R {
  const release = acquireMutex(targetPath);
  try {
    return fn();
  } finally {
    release();
  }
}

/** 原子写：同目录临时文件 + rename，读方要么看到旧文件、要么看到新文件 */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 不掩盖原错误 */
    }
    throw err;
  }
}

/**
 * 在互斥内对某项目的任务做一次读改写。
 * `fn` 返回 `{ tasks, result }`；`tasks` 为 undefined 表示不写盘（只读认领失败等）。
 * 任何 IO 失败都抛出，绝不吞掉——吞掉就是 B43 的「回成功、其实没写」。
 */
export function mutateDurableTasks<R>(
  projectDir: string,
  fn: (tasks: CronTask[]) => { tasks?: CronTask[]; result: R },
): R {
  const path = durableFilePath(projectDir);
  return withFileMutex(path, () => {
    const { tasks, result } = fn(readDurableTasks(projectDir));
    if (tasks) writeAtomic(path, JSON.stringify(tasks, null, 2));
    return result;
  });
}
