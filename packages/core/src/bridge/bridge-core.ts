/**
 * Bridge 核心 — 管理远程控制的完整生命周期
 *
 * 启动流程：
 * 1. 建立传输连接（WebSocket）
 * 2. 注册消息处理器
 * 3. 进入消息循环
 *
 * 消息流：
 * 远程客户端 → BridgeTransport → 消息去重 → 消息路由
 *   ├── user_message → onUserMessage 回调（上层接 QueryEngine.submitMessage）
 *   ├── permission_response → PermissionProxy.handleResponse()
 *   └── control → 控制命令处理（abort / ping）
 *
 * Agent 输出 → 消息格式化 → BridgeTransport → 远程客户端
 *
 * 设计差异（与原 spec §7.3.6）：
 * sid-code 的 QueryEngine 通过 `submitMessage()` 异步生成器驱动，而非
 * `submit()`。为避免紧耦合，BridgeCore 通过 onUserMessage/onAbort 回调
 * 与上层交互，由上层负责桥接到 QueryEngine。
 */

import type { BridgeTransport, BridgeInMessage, BridgeOutMessage } from "./types.ts";
import { BoundedUUIDSet } from "./message-dedup.ts";
import { PermissionProxy } from "./permission-proxy.ts";
import { formatStatusMessage } from "./bridge-messaging.ts";
import { getLogger } from "../debug/logger.ts";

export interface BridgeCoreOptions {
  transport: BridgeTransport;
  /** 收到远程用户消息时的回调 */
  onUserMessage: (text: string) => void | Promise<void>;
  /** 收到中断控制命令时的回调 */
  onAbort?: () => void;
  /** 去重环形缓冲容量 */
  dedupCapacity?: number;
  /** 权限请求超时（毫秒） */
  permissionTimeoutMs?: number;
}

export class BridgeCore {
  private transport: BridgeTransport;
  private dedup: BoundedUUIDSet;
  private permissionProxy: PermissionProxy;
  private onUserMessage: (text: string) => void | Promise<void>;
  private onAbort?: () => void;
  private started = false;

  constructor(options: BridgeCoreOptions) {
    this.transport = options.transport;
    this.dedup = new BoundedUUIDSet(options.dedupCapacity ?? 10000);
    this.permissionProxy = new PermissionProxy(this.transport, options.permissionTimeoutMs);
    this.onUserMessage = options.onUserMessage;
    this.onAbort = options.onAbort;
  }

  /** 启动 Bridge */
  async start(): Promise<void> {
    if (this.started) return;

    this.transport.setOnData((data) => {
      let msg: BridgeInMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        getLogger().debug("BRIDGE", "收到非法 JSON 消息，已忽略");
        return;
      }
      this.handleIncoming(msg);
    });

    this.transport.setOnClose((code) => {
      getLogger().info("BRIDGE", `连接关闭 (code=${code})`);
      this.permissionProxy.cleanup();
    });

    this.transport.setOnConnect(() => {
      void this.transport.write(formatStatusMessage("ready"));
    });

    await this.transport.connect();
    this.started = true;
    getLogger().info("BRIDGE", "Bridge 已启动");
  }

  /** 停止 Bridge */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.transport.flush().catch(() => {});
    this.transport.close();
    this.permissionProxy.cleanup();
    this.started = false;
  }

  /** 发送消息给远程客户端 */
  async send(message: BridgeOutMessage): Promise<void> {
    if (!this.transport.isConnected()) return;
    await this.transport.write(message);
  }

  /** 获取权限代理（供权限检查器使用） */
  getPermissionProxy(): PermissionProxy {
    return this.permissionProxy;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  // ─── 内部方法 ───

  private handleIncoming(msg: BridgeInMessage): void {
    // 去重
    if (msg.id) {
      if (this.dedup.has(msg.id)) return;
      this.dedup.add(msg.id);
    }

    switch (msg.type) {
      case "user_message": {
        const text =
          typeof msg.data === "string" ? msg.data : ((msg.data as { text?: string })?.text ?? "");
        if (text)
          void Promise.resolve(this.onUserMessage(text)).catch((err) => {
            getLogger().error("BRIDGE", `处理远程消息失败: ${err.message}`);
          });
        break;
      }
      case "permission_response":
        this.permissionProxy.handleResponse(msg);
        break;
      case "control":
        this.handleControl(msg);
        break;
    }
  }

  private handleControl(msg: BridgeInMessage): void {
    const cmd = (msg.data as { command?: string })?.command;
    switch (cmd) {
      case "abort":
        this.onAbort?.();
        void this.transport.write(formatStatusMessage("aborted"));
        break;
      case "ping":
        void this.transport.write(formatStatusMessage("pong"));
        break;
      default:
        getLogger().debug("BRIDGE", `未知控制命令: ${cmd}`);
    }
  }
}
