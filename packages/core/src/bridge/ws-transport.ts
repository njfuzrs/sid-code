/**
 * WebSocket 传输实现
 *
 * 对标 Claude Code 的 WebSocket 传输：
 * - 心跳**保活 + 探活**（D12：原本只有保活）
 * - 断线指数退避重连（最长 10 分钟放弃），**但永久失败码不重试**（D11）
 * - 通过 SerialBatchUploader 批量发送（背压 + 失败重试 + 丢弃上限）
 */

import type { BridgeTransport, BridgeOutMessage, BridgeTransportStats } from "./types.ts";
import { SerialBatchUploader } from "./serial-batch-uploader.ts";
import { getLogger } from "../debug/logger.ts";

/** 心跳间隔 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * 探活超时（D12）：发出心跳后，多久没收到**任何**入向消息就判定连接半开。
 * 取 2 个心跳周期 —— 1 个周期会把一次正常的网络抖动误判成半开，
 * 而 3 个周期意味着最坏情况要 90 秒才发现对端已死。
 */
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2;
/** 批量刷新间隔 */
const BATCH_FLUSH_INTERVAL_MS = 200;
/** 重连基础延迟 */
const RECONNECT_BASE_DELAY_MS = 1000;
/** 重连最大延迟 */
const RECONNECT_MAX_DELAY_MS = 30_000;
/** 重连放弃阈值（10 分钟） */
const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000;
/** 半开连接的自定义关闭码（区别于对端主动关闭，便于日志与统计归因） */
const CLOSE_CODE_HALF_OPEN = 4900;

/**
 * **永久失败关闭码**：不可能通过重试解决的失败（D11）。
 *
 * 原实现只排除 1000（正常关闭），其余全部进重试循环，而重试总预算是 **10 分钟**。
 * 于是认证失败这类**立刻能报出来的错**变成**10 分钟后才报的错**，
 * 而这 10 分钟里用户完全不知道发生了什么（只有 debug 日志里有重连记录）。
 *
 * 判据（与本仓 `attribution-decoupled-from-signal-antipattern` 同源）：
 * **状态码 > 数字边界 > 裸子串**。协议给了权威状态码时必须用它分流，
 * 别去猜错误消息里的关键词。
 *
 * - `1002` 协议错误 —— 我们和对端说的不是同一种协议，重试一万次也一样
 * - `1003` 数据类型不被接受
 * - `1008` 违反策略（服务端明确拒绝）
 * - `4001` 认证失败 —— token 错了，重试不会让它变对
 * - `4003` 会话过期 / 无权限
 *
 * ⚠️ 刻意**不含** 1006（异常关闭，无 close frame）：那恰恰是网络抖动、
 * 代理超时、进程重启的典型码，是**最该重试**的一类。
 */
const PERMANENT_CLOSE_CODES = new Set([1002, 1003, 1008, 4001, 4003]);

/** 关闭码 → 人话（只覆盖我们会主动分流的那些） */
function describeCloseCode(code: number): string {
  switch (code) {
    case 1002:
      return "协议错误";
    case 1003:
      return "数据类型不被接受";
    case 1008:
      return "违反服务端策略";
    case 4001:
      return "认证失败（token 无效）";
    case 4003:
      return "会话过期或无权限";
    default:
      return `关闭码 ${code}`;
  }
}

export class WebSocketBridgeTransport implements BridgeTransport {
  private ws?: WebSocket;
  private url: string;
  private authToken?: string;
  private uploader: SerialBatchUploader<BridgeOutMessage>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectStartTime?: number;
  private closedByUser = false;
  /** 已判定永久失败：不再重连，且 isConnected() 之外的调用方靠它区分"断了"与"没救了" */
  private permanentlyFailed = false;

  /** 最后一次收到**任何**入向消息的时间戳（D12 探活的唯一判据） */
  private lastInboundAt = 0;

  private reconnectCount = 0;
  private halfOpenDetectedCount = 0;
  private permanentFailureCount = 0;

  private onDataCb?: (data: string) => void;
  private onCloseCb?: (code?: number) => void;
  private onConnectCb?: () => void;
  /** 永久失败回调：让上层能立刻报错，而不是等 10 分钟 */
  private onPermanentFailureCb?: (code: number, reason: string) => void;

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
  /** 注册永久失败回调（D11：让"没救了"能立刻传上去） */
  setOnPermanentFailure(callback: (code: number, reason: string) => void): void {
    this.onPermanentFailureCb = callback;
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
        this.permanentlyFailed = false;
        // 探活基线必须在这里置一次：否则首个心跳周期里 lastInboundAt 还是 0，
        // 会把一条刚建好、对端只是还没说话的连接立刻判成半开。
        this.lastInboundAt = Date.now();
        this.startHeartbeat();
        this.startFlushTimer();
        this.onConnectCb?.();
        getLogger().info("BRIDGE", "WebSocket 已连接");
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        // D12：任何入向消息都刷新探活基线 —— 判据是"对端还在说话"，
        // 不是"我发的 ping 收到了配对的 pong"。后者要求对端实现配对回应，
        // 而我们的对端是自托管中继，不能假定它会。
        this.lastInboundAt = Date.now();
        const data = typeof event.data === "string" ? event.data : String(event.data);
        this.onDataCb?.(data);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.stopHeartbeat();
        this.stopFlushTimer();

        // D11：永久失败码不进重试循环，立刻上报。
        if (!this.closedByUser && PERMANENT_CLOSE_CODES.has(event.code)) {
          this.permanentlyFailed = true;
          this.permanentFailureCount++;
          const reason = describeCloseCode(event.code);
          getLogger().error("BRIDGE", `连接被永久拒绝：${reason}，不再重连`);
          this.onPermanentFailureCb?.(event.code, reason);
        } else if (event.code !== 1000 && !this.closedByUser) {
          // 非正常关闭且非用户主动关闭 → 尝试重连
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

  /** 是否已判定永久失败（认证失败等，重连也没用） */
  isPermanentlyFailed(): boolean {
    return this.permanentlyFailed;
  }

  getStateLabel(): string {
    if (this.permanentlyFailed) return "permanently-failed";
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

  async flush(timeoutMs?: number): Promise<boolean> {
    return this.uploader.flush(timeoutMs);
  }

  getStats(): BridgeTransportStats {
    return {
      droppedBatchCount: this.uploader.droppedBatchCount,
      droppedItemCount: this.uploader.droppedItemCount,
      reconnectCount: this.reconnectCount,
      halfOpenDetectedCount: this.halfOpenDetectedCount,
      permanentFailureCount: this.permanentFailureCount,
    };
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

  /**
   * 心跳：**保活 + 探活**（D12）。
   *
   * 原实现只做了两个目的里的一个：
   * | 目的 | 原状 |
   * | --- | --- |
   * | 保活（骗过代理/NAT 的空闲回收） | ✅ 30s < 常见的 60s 空闲超时 |
   * | 探活（检测对端还在不在） | ❌ 没有任何超时判定 |
   *
   * 后果是连接进入**半开状态**（TCP 层没断、对端进程已死）时，我们会一直往黑洞里
   * 写，而 `isConnected()` **返回 true** —— 它会说谎。半开连接只能靠"发出去的探测
   * 没有回应"发现，没有超时判定就永远发现不了。
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      // 先判探活再发新 ping：顺序反了会把刚发出去的 ping 也算进"静默时长"里。
      const silentFor = Date.now() - this.lastInboundAt;
      if (silentFor > HEARTBEAT_TIMEOUT_MS) {
        this.halfOpenDetectedCount++;
        getLogger().warn(
          "BRIDGE",
          `连接半开：${Math.round(silentFor / 1000)}s 未收到任何入向消息，主动断开重连`,
        );
        try {
          // 用自定义码而非 1000：1000 会被 onclose 当成"正常关闭"从而**不重连**，
          // 那就把一次可恢复的半开变成了永久断线。
          this.ws.close(CLOSE_CODE_HALF_OPEN, "心跳探活超时");
        } catch {
          /* 已经关了：onclose 会照常触发重连 */
        }
        return;
      }

      try {
        this.ws.send(
          JSON.stringify({ type: "status", data: { ping: true }, timestamp: Date.now() }),
        );
      } catch {
        /* 忽略：写失败下一轮探活会判定 */
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
    if (this.closedByUser || this.permanentlyFailed) return;
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
        this.reconnectCount++;
        getLogger().info("BRIDGE", "重连成功");
        return;
      } catch {
        // 继续重试；永久失败由 onclose 置位，这里及时收手
        if (this.permanentlyFailed) return;
      }
    }

    getLogger().error("BRIDGE", "重连超时（10 分钟），放弃");
  }
}
