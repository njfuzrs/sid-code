// src/analytics/exporters/local.ts
// 本地事件后端——将 logEvent 事件持久化到 JSONL
//
// 对应 spec 17 §3.2 路由架构中的 LocalBackend。
// 特权后端:stripProtected=false,看到完整数据(含 _PROTECTED_* 字段)。
// 接受所有事件,追加写入 ~/.sid-code/telemetry/events.jsonl(异步,fire-and-forget)。

import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sidPaths } from "../../config/paths.ts";
import type { SinkBackend } from "../sink.ts";
import type { EventMetadata } from "../index.ts";

const EVENTS_FILE = "events.jsonl";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES = 5;

export class LocalEventBackend implements SinkBackend {
  readonly name = "local";
  readonly stripProtected = false;

  private dir: string;
  private filePath: string;
  private dirCreated = false;
  /** 串行化写入,避免并发 append 交错 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private sessionId: string,
    dir: string = sidPaths.telemetry(),
  ) {
    this.dir = dir;
    this.filePath = join(dir, EVENTS_FILE);
  }

  accepts(_eventName: string): boolean {
    return true;
  }

  send(eventName: string, metadata: EventMetadata): void {
    const line =
      JSON.stringify({
        eventName,
        metadata,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      }) + "\n";

    // 串行追加,错误静默(遥测旁路)
    this.writeChain = this.writeChain
      .then(() => this.write(line))
      .catch(() => {});
  }

  async shutdown(): Promise<void> {
    // 等待挂起的写入完成
    await this.writeChain.catch(() => {});
  }

  private async write(line: string): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(this.dir, { recursive: true });
      this.dirCreated = true;
    }
    await appendFile(this.filePath, line, "utf-8");
    await this.rotateIfNeeded();
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if (info.size < MAX_FILE_SIZE) return;
    } catch {
      return;
    }
    const prefix = "events";
    const oldest = join(this.dir, `${prefix}.${MAX_FILES}.jsonl`);
    try { await unlink(oldest); } catch {}
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = join(this.dir, `${prefix}.${i}.jsonl`);
      const to = join(this.dir, `${prefix}.${i + 1}.jsonl`);
      try { await rename(from, to); } catch {}
    }
    try { await rename(this.filePath, join(this.dir, `${prefix}.1.jsonl`)); } catch {}
  }
}
