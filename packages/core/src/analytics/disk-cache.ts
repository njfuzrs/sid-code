// src/analytics/disk-cache.ts
// 失败事件的磁盘持久化——支持跨会话恢复
//
// 对应 spec 17 §4.1.1。
// JSON Lines 格式追加写入(原子操作,并发安全)。
// 文件名含 sessionId + batchUUID,确保不同会话/进程不互相干扰。
//
// T2（M4 验收尾巴，别当 bug 查）：凭据过期 / 无身份 / 明文拒绝时，盘上的
// failed_events*.jsonl 会堆到 24h（MAX_AGE_MS）再被 cleanup 清掉。
// 前提是 sendFn **throw**——本模块把成功 resolve 当「这批已送达」并 unlink。
// HttpExporter 对 SkipRemoteExportError / UnauthorizedExportError 必须 throw，
// 不能 return；return 会被当成成功，过期凭据堆积自清的意图落空。

import { appendFile, readdir, readFile, unlink, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE_PREFIX = "failed_events";
/** 超过此时长的缓存文件视为过期(24h) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FailedEvent {
  eventName: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  attempts: number;
}

export interface DiskCacheConfig {
  /** 缓存目录,默认 ~/.sid-code/telemetry/ */
  cacheDir: string;
  /** 当前会话 ID */
  sessionId: string;
  /** 最大重试次数 */
  maxRetries: number;
}

export class EventDiskCache {
  private batchUUID = randomUUID().slice(0, 8);
  private dirReady = false;

  constructor(private config: DiskCacheConfig) {}

  /** 将失败事件追加写入磁盘(JSON Lines 格式) */
  async queueFailedEvents(events: FailedEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureDir();
    const filePath = this.getCurrentBatchFilePath();
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(filePath, lines, "utf-8");
  }

  /**
   * 启动时扫描并重试上次会话的失败事件。
   * sendFn 成功 resolve → 删除文件；throw → 保留文件等下次启动再试。
   *
   * 不要把「稳定不发」（无凭据 / 明文 / 401）在 sendFn 里 return：
   * 那是成功路径，文件会被 unlink。HttpExporter 对这些情况 throw，
   * 于是过期凭据的机器会把文件留到 MAX_AGE_MS 自清（T2，可接受）。
   */
  async retryPreviousBatches(sendFn: (events: FailedEvent[]) => Promise<void>): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.config.cacheDir))
        .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(".jsonl"))
        .filter((f) => !f.includes(this.batchUUID)); // 排除当前批次
    } catch {
      return; // 目录不存在,跳过
    }

    for (const file of files) {
      const filePath = join(this.config.cacheDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const events = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FailedEvent);

        if (events.length > 0) {
          // 超过最大重试次数的事件丢弃(避免无限重试)
          const live = events.filter((e) => (e.attempts ?? 0) < this.config.maxRetries);
          if (live.length > 0) {
            await sendFn(live.map((e) => ({ ...e, attempts: (e.attempts ?? 0) + 1 })));
          }
        }
        // sendFn resolve（或本文件事件全部超过 maxRetries）→ 删除。
        // throw 才进 catch 留盘。稳定不发也必须 throw，见文件头 T2。
        await unlink(filePath);
      } catch {
        // 重试失败 / 稳定不发,保留文件等下次启动再试
      }
    }
  }

  /** 清理过期的缓存文件(超过 24h) */
  async cleanup(): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.config.cacheDir)).filter(
        (f) => f.startsWith(FILE_PREFIX) && f.endsWith(".jsonl"),
      );
    } catch {
      return;
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const file of files) {
      const filePath = join(this.config.cacheDir, file);
      try {
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {
        // ignore
      }
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.config.cacheDir, { recursive: true });
    this.dirReady = true;
  }

  private getCurrentBatchFilePath(): string {
    return join(
      this.config.cacheDir,
      `${FILE_PREFIX}.${this.config.sessionId}.${this.batchUUID}.jsonl`,
    );
  }
}
