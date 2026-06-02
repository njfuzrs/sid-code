// src/analytics/exporters/otlp.ts
// OTLP HTTP 事件导出器——将事件转换为 OTLP LogRecord 格式
//
// 对应 spec 17 §4.2(可选扩展)。
// 通过标准 OTLP/HTTP logs 协议发送,支持 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量。
// 复用 HttpExporter 的批量/重试/磁盘缓存能力,仅替换序列化格式。

import type { SinkBackend } from "../sink.ts";
import type { EventMetadata, EventMetadataValue } from "../index.ts";
import { EventDiskCache } from "../disk-cache.ts";
import { QuadraticBackoff } from "../backoff.ts";

export interface OtlpExporterConfig {
  name?: string;
  /** OTLP logs 端点,默认读 OTEL_EXPORTER_OTLP_ENDPOINT + /v1/logs */
  endpoint?: string;
  authHeader?: string;
  allowedEvents?: Set<string>;
  batchSize?: number;
  flushIntervalMs?: number;
  networkTimeoutMs?: number;
  stripProtected?: boolean;
  diskCache?: EventDiskCache;
  /** service.name 资源属性 */
  serviceName?: string;
}

interface BatchedEvent {
  eventName: string;
  metadata: EventMetadata;
  timestamp: number;
}

/** 将元数据值映射为 OTLP AnyValue */
function toAnyValue(v: EventMetadataValue): Record<string, unknown> {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  }
  if (v === undefined) return { stringValue: "" };
  return { stringValue: String(v) };
}

export class OtlpExporter implements SinkBackend {
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
  private readonly serviceName: string;
  private readonly diskCache?: EventDiskCache;

  constructor(config: OtlpExporterConfig = {}) {
    this.name = config.name ?? "otlp";
    this.stripProtected = config.stripProtected ?? true;
    const base =
      config.endpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "http://localhost:4318";
    // 若给的是 base(不含 /v1/logs),补全
    this.endpoint = base.endsWith("/v1/logs") ? base : `${base.replace(/\/$/, "")}/v1/logs`;
    this.authHeader = config.authHeader;
    this.allowedEvents = config.allowedEvents;
    this.batchSize = config.batchSize ?? 100;
    this.flushIntervalMs = config.flushIntervalMs ?? 15_000;
    this.networkTimeoutMs = config.networkTimeoutMs ?? 5_000;
    this.serviceName = config.serviceName ?? "sid-code";
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

  async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    const events = [...this.batch];
    this.batch.length = 0;
    this.cancelScheduledFlush();

    try {
      await this.sendBatch(events);
      this.backoff.reset();
    } catch {
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
      this.backoff.schedule(() => this.retryFromDisk());
    }
  }

  async recoverFromDisk(): Promise<void> {
    await this.retryFromDisk().catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.cancelScheduledFlush();
    this.backoff.reset();
    await this.flush();
  }

  /** 将事件批转换为 OTLP logs payload */
  private buildPayload(events: BatchedEvent[]): Record<string, unknown> {
    const logRecords = events.map((e) => ({
      timeUnixNano: String(e.timestamp * 1_000_000),
      severityText: "INFO",
      body: { stringValue: e.eventName },
      attributes: Object.entries(e.metadata).map(([key, value]) => ({
        key,
        value: toAnyValue(value),
      })),
    }));

    return {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
            ],
          },
          scopeLogs: [{ scope: { name: "sid-code.analytics" }, logRecords }],
        },
      ],
    };
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
        body: JSON.stringify(this.buildPayload(events)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OTLP HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async retryFromDisk(): Promise<void> {
    if (!this.diskCache) return;
    await this.diskCache.retryPreviousBatches((events) =>
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
    this.flushTimer.unref?.();
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
