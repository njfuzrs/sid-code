/**
 * WebSocket 传输实现
 *
 * 对标 Claude Code 的 WebSocket 传输：
 * - 心跳保活
 * - 断线指数退避重连（最长 10 分钟放弃）
 * - 通过 SerialBatchUploader 批量发送（背压 + 失败重试）
 */

import type { BridgeTransport, BridgeOutMessage } from "./types.ts";
import { SerialBatchUploader } from "./serial-batch-uploader.ts";
import { getLogger } from "../debug/logger.ts";

/** 心跳间隔 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 批量刷新间隔 */
const BATCH_FLUSH_INTERVAL_MS = 200;
/** 重连基础延迟 */
const RECONNECT_BASE_DELAY_MS = 1000;
/** 重连最大延迟 */
const RECONNECT_MAX_DELAY_MS = 30_000;
/** 重连放弃阈值（10 分钟） */
const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000;

export class WebSocketBridgeTransport implements BridgeTransport {
  private ws?: WebSocket;
  private url: string;
  private authToken?: string;
  private uploader: SerialBatchUploader<BridgeOutMessage>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectStartTime?: number;
  private closedByUser = false;

  private onDataCb?: (data: string) => void;
  private onCloseCb?: (code?: number) => void;
  private onConnectCb?: () => void;

  constructor(url: string, authToken?: string) {
    this.url = url;
    this.authToken = authToken;
    this.uploader = new SerialBatchUploader({
      postFn: (batch) => this.sendBatch(batch),
    });
  }

  setOnData(callback: (data: string) => void): void {
    this.onDataCb = callback;
  }
  setOnClose(callback: (code?: number) => void): void {
    this.onCloseCb = callback;
  }
  setOnConnect(callback: () => void): void {
    this.onConnectCb = callback;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      const wsUrl = this.authToken
        ? `${this.url}${this.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.authToken)}`
        : this.url;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectStartTime = undefined;
        this.startHeartbeat();
        this.startFlushTimer();
        this.onConnectCb?.();
        getLogger().info("BRIDGE", "WebSocket 已连接");
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        this.onDataCb?.(data);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.stopHeartbeat();
        this.stopFlushTimer();
        // 非正常关闭且非用户主动关闭 → 尝试重连
        if (event.code !== 1000 && !this.closedByUser) {
          void this.attemptReconnect();
        }
        this.onCloseCb?.(event.code);
      };

      this.ws.onerror = () => {
        reject(new Error("WebSocket 连接失败"));
      };
    });
  }

  async write(message: BridgeOutMessage): Promise<void> {
    await this.uploader.enqueue([message]);
  }

  async writeBatch(messages: BridgeOutMessage[]): Promise<void> {
    await this.uploader.enqueue(messages);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getStateLabel(): string {
    if (!this.ws) return "disconnected";
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return "connecting";
      case WebSocket.OPEN:
        return "connected";
      case WebSocket.CLOSING:
        return "closing";
      case WebSocket.CLOSED:
        return "closed";
      default:
        return "unknown";
    }
  }

  async flush(): Promise<void> {
    await this.uploader.flush();
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.stopFlushTimer();
    this.uploader.stop();
    try {
      this.ws?.close(1000, "客户端主动关闭");
    } catch {}
    this.ws = undefined;
  }

  // ─── 内部方法 ───

  /** 发送一批消息（uploader 的 postFn） */
  private async sendBatch(batch: BridgeOutMessage[]): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    for (const msg of batch) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(
            JSON.stringify({ type: "status", data: { ping: true }, timestamp: Date.now() }),
          );
        } catch {
          /* 忽略 */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => void this.flush(), BATCH_FLUSH_INTERVAL_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closedByUser) return;
    if (!this.reconnectStartTime) this.reconnectStartTime = Date.now();

    let attempt = 0;
    while (Date.now() - this.reconnectStartTime < RECONNECT_GIVE_UP_MS && !this.closedByUser) {
      attempt++;
      const delay =
        Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY_MS) *
        (0.8 + Math.random() * 0.4); // 抖动避免惊群

      getLogger().info("BRIDGE", `重连尝试 #${attempt}，等待 ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
      if (this.closedByUser) return;

      try {
        await this.connect();
        getLogger().info("BRIDGE", "重连成功");
        return;
      } catch {
        // 继续重试
      }
    }

    getLogger().error("BRIDGE", "重连超时（10 分钟），放弃");
  }
}
