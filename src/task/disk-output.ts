/**
 * 磁盘输出持久化
 * 使用写入队列 + 单线程 drain 循环，避免内存膨胀
 */

import { appendFile, mkdir, stat, open, unlink } from "fs/promises";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";

/** 输出目录 */
function getOutputDir(): string {
  return sidPaths.tasks();
}

/** 磁盘上限：1GB */
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024 * 1024;

export class DiskTaskOutput {
  #queue: string[] = [];
  #bytesWritten = 0;
  #capped = false;
  /** 当前在途的 drain промise；null 表示空闲。flush() 必须 await 这一个实例，
   *  而不是另起一个竞争的 drain——否则新 drain 可能先看到空队列而提前 resolve，
   *  让 flush() 在真正的 appendFile 落盘前就返回（读端拿到不存在/空文件）。 */
  #drainPromise: Promise<void> | null = null;
  #filePath: string;

  constructor(taskId: string) {
    this.#filePath = join(getOutputDir(), `${taskId}.output`);
  }

  get filePath(): string {
    return this.#filePath;
  }

  append(content: string): void {
    if (this.#capped) return;
    this.#bytesWritten += Buffer.byteLength(content);
    if (this.#bytesWritten > MAX_OUTPUT_BYTES) {
      this.#capped = true;
      this.#queue.push("\n[输出已截断：超过 1GB 磁盘上限]\n");
    } else {
      this.#queue.push(content);
    }
    this.#ensureDraining();
  }

  /** 确保有且仅有一个 drain 在跑；已有则复用。 */
  #ensureDraining(): void {
    if (!this.#drainPromise) {
      this.#drainPromise = this.#drain().finally(() => {
        this.#drainPromise = null;
      });
    }
  }

  async #drain(): Promise<void> {
    await mkdir(getOutputDir(), { recursive: true });
    while (this.#queue.length > 0) {
      const chunks = this.#queue.splice(0);
      const data = chunks.join("");
      await appendFile(this.#filePath, data);
    }
  }

  async flush(): Promise<void> {
    // 等待在途 drain 完成；若期间又排入新内容（drain 已退出循环但 flush 尚未返回），
    // 重新拉起 drain 直至队列彻底排空，保证返回时磁盘已写全。
    while (this.#drainPromise || this.#queue.length > 0) {
      this.#ensureDraining();
      await this.#drainPromise;
    }
  }
}

/** 全局输出管理器 */
const outputs = new Map<string, DiskTaskOutput>();

export function initTaskOutput(taskId: string): DiskTaskOutput {
  const output = new DiskTaskOutput(taskId);
  outputs.set(taskId, output);
  return output;
}

export function appendTaskOutput(taskId: string, content: string): void {
  outputs.get(taskId)?.append(content);
}

export async function flushTaskOutput(taskId: string): Promise<void> {
  await outputs.get(taskId)?.flush();
}

/** 增量读取输出（从 offset 开始，最多 maxBytes） */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ content: string; newOffset: number } | null> {
  const output = outputs.get(taskId);
  if (!output) return null;

  try {
    const fileStat = await stat(output.filePath);
    if (fileStat.size <= fromOffset) return null;

    const readSize = Math.min(fileStat.size - fromOffset, maxBytes);
    const fd = await open(output.filePath, "r");
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, fromOffset);
      return {
        content: buffer.toString("utf-8"),
        newOffset: fromOffset + readSize,
      };
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/** 读取输出末尾（用于停滞检测） */
export async function getTaskOutputTail(
  taskId: string,
  tailBytes = 1024,
): Promise<string | null> {
  const output = outputs.get(taskId);
  if (!output) return null;

  try {
    const fileStat = await stat(output.filePath);
    const readStart = Math.max(0, fileStat.size - tailBytes);
    const readSize = fileStat.size - readStart;
    const fd = await open(output.filePath, "r");
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, readStart);
      return buffer.toString("utf-8");
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/** 清理输出引用（驱逐时调用）。
 *  除删除内存 Map 条目外，同时删除磁盘 `.output` 文件——否则 `~/.sid-code/tasks/`
 *  下的输出文件永不清理，长会话堆积到 GB 级；且同一 taskId 被复用时新实例会
 *  append 到磁盘残留的旧文件、导致输出内容错乱。删除文件是 fire-and-forget，
 *  失败（文件不存在/权限）忽略，不阻塞驱逐主流程。 */
export function evictTaskOutput(taskId: string): void {
  const output = outputs.get(taskId);
  outputs.delete(taskId);
  if (output) {
    void unlink(output.filePath).catch(() => { /* 文件可能不存在或已被删，忽略 */ });
  }
}
