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
import { getLogger } from "../debug/logger.ts";

export class PermissionProxy {
  private transport: BridgeTransport;
  private pendingRequests = new Map<string, {
    resolve: (allowed: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly timeoutMs: number;
  /** 单调递增序号（不依赖随机数，保证 id 唯一） */
  private seq = 0;

  constructor(transport: BridgeTransport, timeoutMs: number = 60_000) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 请求远程用户确认。
   * @returns true = 允许，false = 拒绝（含超时）
   */
  async requestPermission(request: BridgePermissionRequest): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${++this.seq}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        getLogger().warn("BRIDGE", `权限请求 ${requestId} 超时，自动拒绝`);
        resolve(false);
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, { resolve, timer });

      void this.transport.write({
        type: "permission_request",
        id: requestId,
        data: request,
        timestamp: Date.now(),
      }).catch((err) => {
        // 发送失败 → 立即拒绝
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        getLogger().error("BRIDGE", `权限请求发送失败: ${err.message}`);
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
