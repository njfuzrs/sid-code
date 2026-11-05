/**
 * 远程权限代理
 *
 * Bridge 模式下工具执行需要用户确认时，将权限请求转发给远程客户端，
 * 等待远程用户决策。
 *
 * 对标 Claude Code 的权限代理机制：
 * - 发送 permission_request 消息
 * - 等待 permission_response 消息
 * - 超时自动拒绝（默认 60 秒，安全默认）
 */

import type { BridgeTransport, BridgeInMessage, BridgePermissionRequest } from "./types.ts";
import { formatStatusMessage } from "./bridge-messaging.ts";
import {
  BRIDGE_PERMISSION_EVENT_NAME,
  emitBridgeTelemetry,
  type BridgeTelemetrySink,
} from "./bridge-telemetry.ts";
import { getLogger } from "../debug/logger.ts";

export class PermissionProxy {
  private transport: BridgeTransport;
  private pendingRequests = new Map<
    string,
    {
      resolve: (allowed: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
      /** 请求发出时刻：`wait_ms` = 结果时刻 - 它（远程决策慢不慢，只有这个数说得清） */
      startedAtMs: number;
      /** 工具名随条目走：应答只带 request_id，不能回头再问请求对象 */
      toolName: string;
    }
  >();
  private readonly timeoutMs: number;
  /** 桥接事件埋点（由 BridgeCore 透传；未注入时静默） */
  private readonly onTelemetry?: BridgeTelemetrySink;
  /** 单调递增序号（不依赖随机数，保证 id 唯一） */
  private seq = 0;

  constructor(
    transport: BridgeTransport,
    timeoutMs: number = 60_000,
    onTelemetry?: BridgeTelemetrySink,
  ) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.onTelemetry = onTelemetry;
  }

  /**
   * 请求远程用户确认。
   * @returns true = 允许，false = 拒绝（含超时）
   */
  async requestPermission(request: BridgePermissionRequest): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${++this.seq}`;
    const startedAtMs = Date.now();

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        getLogger().warn("BRIDGE", `权限请求 ${requestId} 超时，自动拒绝`);
        emitBridgeTelemetry(this.onTelemetry, BRIDGE_PERMISSION_EVENT_NAME, {
          tool_name: request.toolName,
          decision: "timeout",
          wait_ms: Date.now() - startedAtMs,
        });
        resolve(false);
        // 超时已经是拒绝。再告诉控制端「过期」而不是装成 agent 出错——
        // 管理台按 data.status === "permission_expired" 展示。发送失败忽略：
        // 连接可能已经死，onclose 里的 cleanup 会再拒一次。
        void this.transport
          .write(formatStatusMessage("permission_expired", { request_id: requestId }))
          .catch(() => {});
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        timer,
        startedAtMs,
        toolName: request.toolName,
      });

      void this.transport
        .write({
          type: "permission_request",
          id: requestId,
          data: request,
          timestamp: Date.now(),
        })
        .catch((err) => {
          // 发送失败 → 立即拒绝
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          getLogger().error("BRIDGE", `权限请求发送失败: ${err.message}`);
          // 发送失败也是一次「远程没批」：与远程明确拒绝共用 deny，
          // wait_ms 通常个位数——它和用户在管理台上想了 30 秒才拒绝，靠这个数分得开。
          emitBridgeTelemetry(this.onTelemetry, BRIDGE_PERMISSION_EVENT_NAME, {
            tool_name: request.toolName,
            decision: "deny",
            wait_ms: Date.now() - startedAtMs,
          });
          resolve(false);
        });
    });
  }

  /** 处理远程客户端的权限响应 */
  handleResponse(message: BridgeInMessage): void {
    if (message.type !== "permission_response" || !message.id) return;

    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    const allowed = (message.data as { allowed?: boolean })?.allowed ?? false;
    emitBridgeTelemetry(this.onTelemetry, BRIDGE_PERMISSION_EVENT_NAME, {
      tool_name: pending.toolName,
      decision: allowed ? "allow" : "deny",
      wait_ms: Date.now() - pending.startedAtMs,
    });
    pending.resolve(allowed);
  }

  /** 是否有待处理的权限请求 */
  hasPending(): boolean {
    return this.pendingRequests.size > 0;
  }

  /** 清理所有待处理请求（连接关闭时调用，全部拒绝） */
  cleanup(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingRequests.clear();
  }
}
