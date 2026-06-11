/**
 * 磁盘输出持久化
 * 使用写入队列 + 单线程 drain 循环，避免内存膨胀
 */

import { appendFile, mkdir, stat, open } from "fs/promises";
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
  #draining = false;
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
    if (!this.#draining) {
      this.#draining = true;
      void this.#drain();
    }
  }

  async #drain(): Promise<void> {
    await mkdir(getOutputDir(), { recursive: true });
    while (this.#queue.length > 0) {
      const chunks = this.#queue.splice(0);
      const data = chunks.join("");
      await appendFile(this.#filePath, data);
    }
    this.#draining = false;
  }

  async flush(): Promise<void> {
    if (this.#queue.length > 0 || this.#draining) {
      await this.#drain();
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

/** 清理输出引用（驱逐时调用，不删除磁盘文件） */
export function evictTaskOutput(taskId: string): void {
  outputs.delete(taskId);
}
