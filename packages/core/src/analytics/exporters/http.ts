// src/analytics/exporters/http.ts
// 通用 HTTP 事件导出器——批量发送、认证、超时、磁盘缓存兜底、退避重试
//
// 对应 spec 17 §4.2。
// 非特权后端(默认 stripProtected=true):只看脱敏数据。
// fire-and-forget:发送失败 → 写入磁盘缓存 + 调度退避重试,绝不阻塞主流程。
//
// M4 PR-4.1：内置 sid-backend 上报带设备凭据（applyDeviceAuth），静态 authHeader 仅作回落。
// 设备凭据只在构造时显式 attachDeviceCredential 才带：analytics.backends[] 的第三方 collector
// 不认本平台凭据，带过去既是凭据外泄（违背「只发往 backend.url 同源」），又会顶掉它自己的 authHeader。无身份 / 明文非本地 / 401 是稳定不发，
// 必须 throw 而不是 return——disk-cache 把 resolve 当成功并 unlink（见 disk-cache.ts T2）。

import type { SinkBackend } from "../sink.ts";
import type { EventMetadata } from "../index.ts";
import { EventDiskCache, type FailedEvent } from "../disk-cache.ts";
import { QuadraticBackoff } from "../backoff.ts";
import {
  applyDeviceAuth,
  getCredentialGeneration,
  RELOGIN_HINT,
  reportCredentialRejected,
} from "../../identity/credential.ts";
import { isNonLocalHttp } from "../../identity/endpoints.ts";
import { getLogger } from "../../debug/logger.ts";

export interface HttpExporterConfig {
  /** 后端名称(用于日志和 killswitch) */
  name: string;
  /** 远程端点 URL */
  endpoint: string;
  /** 认证头(可选)。无设备凭据时回落用；OTLP / 自建 collector 走这条 */
  authHeader?: string;
  /**
   * 是否携带设备凭据。默认 false：只有内置 sid-backend（地址由 backend.url 派生）可以打开。
   * 默认关而不是默认开，是为了让「新增一个 exporter」不会悄悄把凭据带出 backend.url 的同源边界
   * （同类防线：mcp/backend-auth.ts、cli 的 plugin/market.ts）。
   */
  attachDeviceCredential?: boolean;
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

/** 稳定不发：无身份或明文非本地。disk-cache 必须看到 throw 才会留盘。 */
class SkipRemoteExportError extends Error {
  constructor(readonly reason: "no_auth" | "plaintext_http") {
    super(reason);
    this.name = "SkipRemoteExportError";
  }
}

/** 401：凭据不会自己变好，不写盘、不退避。 */
class UnauthorizedExportError extends Error {
  constructor() {
    super("401");
    this.name = "UnauthorizedExportError";
  }
}

export class HttpExporter implements SinkBackend {
  readonly name: string;
  readonly stripProtected: boolean;

  private batch: BatchedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = new QuadraticBackoff();
  // 无凭据 / 401 告警按「凭据代数」去重而不是布尔：重新登录（代数 +1）后凭据再次失效，
  // 用户要能再看到一次告警（登录闭环方案 §5.6）
  private warnedSkipNoAuthGen = -1;
  private warnedSkipPlaintext = false;
  private warnedUnauthorizedGen = -1;
  /** 本批是否带的是设备凭据（而不是 authHeader 兜底）——只有设备凭据的 401 才算「需要重新登录」 */
  private lastBatchUsedDeviceCredential = false;

  private readonly endpoint: string;
  private readonly authHeader?: string;
  private readonly attachDeviceCredential: boolean;
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
    this.attachDeviceCredential = config.attachDeviceCredential ?? false;
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
    } catch (err) {
      if (err instanceof UnauthorizedExportError || err instanceof SkipRemoteExportError) {
        // 稳定不发：这批远程副本丢弃。不写盘、不退避。
        // 告警已在 sendBatch 里 once。recoverFromDisk 走 sendBatch throw → 留盘（T2）。
        return;
      }
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
    // 明文 POST 会在 301 之前把 body（含 metadata）发出去。https / loopback 放行。
    if (isNonLocalHttp(this.endpoint)) {
      this.failStable(new SkipRemoteExportError("plaintext_http"));
    }

    const base = { "Content-Type": "application/json" };
    const headers: Record<string, string> = this.attachDeviceCredential
      ? applyDeviceAuth(base)
      : base;
    // 只有带了设备凭据的 401 才上报「企业登录失效」：第三方 collector 的 401 与企业登录无关
    this.lastBatchUsedDeviceCredential = Boolean(headers.Authorization);
    if (!headers.Authorization && this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    if (!headers.Authorization) {
      this.failStable(new SkipRemoteExportError("no_auth"));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.networkTimeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        if (this.lastBatchUsedDeviceCredential) reportCredentialRejected(`events:${this.name}`);
        this.failStable(new UnauthorizedExportError());
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private failStable(err: SkipRemoteExportError | UnauthorizedExportError): never {
    this.warnStableSkip(err);
    throw err;
  }

  /** 401 / 无凭据 / 明文：每种只告警一次，避免每批刷屏。 */
  private warnStableSkip(err: SkipRemoteExportError | UnauthorizedExportError): void {
    const log = getLogger();
    if (err instanceof UnauthorizedExportError) {
      if (this.warnedUnauthorizedGen === getCredentialGeneration()) return;
      this.warnedUnauthorizedGen = getCredentialGeneration();
      log.warn(
        "TELEMETRY",
        // 实际行为是「这一批丢弃，下一批照常带凭据发」（flush 没有会话级停发开关），
        // 所以重新登录后自动恢复。旧文案写「本会话不再重试」与行为不符。
        `远程事件 ${this.name} 401：设备凭据无效或已吊销，这一批已丢弃（不写磁盘）；凭据修好后自动恢复上报。${RELOGIN_HINT}`,
      );
      return;
    }
    if (err.reason === "no_auth") {
      if (this.warnedSkipNoAuthGen === getCredentialGeneration()) return;
      this.warnedSkipNoAuthGen = getCredentialGeneration();
      log.warn(
        "TELEMETRY",
        `远程事件 ${this.name} 无可用凭据（设备凭据与 authHeader 皆空），不上报远程、不写磁盘重试`,
      );
      return;
    }
    if (this.warnedSkipPlaintext) return;
    this.warnedSkipPlaintext = true;
    log.warn(
      "TELEMETRY",
      `远程事件 ${this.name} 拒绝明文非本地 endpoint（只允许 https:// 或 http://127.0.0.1|localhost）: ${this.endpoint}`,
    );
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
