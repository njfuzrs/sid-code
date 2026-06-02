// src/analytics/exporters/http.ts
// 通用 HTTP 事件导出器——批量发送、认证、超时、磁盘缓存兜底、退避重试
//
// 对应 spec 17 §4.2。
// 非特权后端(默认 stripProtected=true):只看脱敏数据。
// fire-and-forget:发送失败 → 写入磁盘缓存 + 调度退避重试,绝不阻塞主流程。

import type { SinkBackend } from "../sink.ts";
import type { EventMetadata } from "../index.ts";
import { EventDiskCache, type FailedEvent } from "../disk-cache.ts";
import { QuadraticBackoff } from "../backoff.ts";

export interface HttpExporterConfig {
  /** 后端名称(用于日志和 killswitch) */
  name: string;
  /** 远程端点 URL */
  endpoint: string;
  /** 认证头(可选) */
  authHeader?: string;
  /** 事件白名单(为空则接受所有事件) */
  allowedEvents?: Set<string>;
  /** 批量大小 */
  batchSize?: number;
  /** 刷新间隔(ms) */
  flushIntervalMs?: number;
  /** 网络超时(ms) */
  networkTimeoutMs?: number;
  /** 是否脱敏 _PROTECTED_* 字段 */
  stripProtected?: boolean;
  /** 磁盘缓存(失败兜底) */
  diskCache?: EventDiskCache;
}

interface BatchedEvent {
  eventName: string;
  metadata: EventMetadata;
  timestamp: number;
}

export class HttpExporter implements SinkBackend {
  readonly name: string;
  readonly stripProtected: boolean;

  private batch: BatchedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = new QuadraticBackoff();

  private readonly endpoint: string;
  private readonly authHeader?: string;
  private readonly allowedEvents?: Set<string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly networkTimeoutMs: number;
  private readonly diskCache?: EventDiskCache;

  constructor(config: HttpExporterConfig) {
    this.name = config.name;
    this.stripProtected = config.stripProtected ?? true;
    this.endpoint = config.endpoint;
    this.authHeader = config.authHeader;
    this.allowedEvents = config.allowedEvents;
    this.batchSize = config.batchSize ?? 100;
    this.flushIntervalMs = config.flushIntervalMs ?? 15_000;
    this.networkTimeoutMs = config.networkTimeoutMs ?? 5_000;
    this.diskCache = config.diskCache;
  }

  accepts(eventName: string): boolean {
    if (!this.allowedEvents) return true;
    return this.allowedEvents.has(eventName);
  }

  send(eventName: string, metadata: EventMetadata): void {
    this.batch.push({ eventName, metadata, timestamp: Date.now() });

    if (this.batch.length >= this.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** 立即刷新所有缓冲事件 */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const events = [...this.batch];
    this.batch.length = 0;
    this.cancelScheduledFlush();

    try {
      await this.sendBatch(events);
      this.backoff.reset();
    } catch {
      // 发送失败 → 写入磁盘缓存
      if (this.diskCache) {
        await this.diskCache
          .queueFailedEvents(
            events.map((e) => ({
              eventName: e.eventName,
              metadata: e.metadata as Record<string, unknown>,
              timestamp: e.timestamp,
              attempts: 0,
            })),
          )
          .catch(() => {});
      }
      // 调度退避重试
      this.backoff.schedule(() => this.retryFromDisk());
    }
  }

  /** 启动时从磁盘恢复上次未发送成功的事件 */
  async recoverFromDisk(): Promise<void> {
    await this.retryFromDisk().catch(() => {});
  }

  /** 关闭导出器,刷新剩余事件 */
  async shutdown(): Promise<void> {
    this.cancelScheduledFlush();
    this.backoff.reset();
    await this.flush();
  }

  private async sendBatch(events: BatchedEvent[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.networkTimeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async retryFromDisk(): Promise<void> {
    if (!this.diskCache) return;
    await this.diskCache.retryPreviousBatches((events: FailedEvent[]) =>
      this.sendBatch(
        events.map((e) => ({
          eventName: e.eventName,
          metadata: e.metadata as EventMetadata,
          timestamp: e.timestamp,
        })),
      ),
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.(); // 不阻止进程退出
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
