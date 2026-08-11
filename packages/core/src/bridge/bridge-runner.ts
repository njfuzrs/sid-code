/**
 * Bridge 运行器 — 把 Bridge 子系统接入 sid-code 内核
 *
 * 这是 Phase 4 的"胶水层"：BridgeCore / PermissionProxy / Transport 都是
 * 无状态的能力组件，本文件负责把它们与具体的 QueryEngine、PermissionChecker
 * 串起来，形成可运行的远程控制会话。
 *
 * 数据流：
 *   远程客户端 ──ws──▶ BridgeCore.onUserMessage ──▶ submitMessage()
 *   submitMessage() 的事件流 ──▶ isEligibleForBridge 过滤 ──▶ BridgeCore.send ──ws──▶ 远程
 *   工具权限确认 ──▶ checker.bridgePermissionDelegate ──▶ PermissionProxy ──ws──▶ 远程
 *
 * 设计要点：
 * - 与 App 解耦：通过 BridgeRunnerDeps 接口注入 submitMessage / setStreamCallback /
 *   permissionChecker / abort，避免 bridge 反向依赖 app.ts。
 * - 一次只跑一轮：远程消息在上一轮未结束时排队，串行消费（与 TUI 单轮语义一致）。
 */

import type {
  QueryEngineEvent,
} from "../query/types.ts";
import { BridgeCore } from "./bridge-core.ts";
import { createBridgeTransport } from "./transport.ts";
import {
  formatTextMessage,
  formatToolUseMessage,
  formatToolResultMessage,
  formatStatusMessage,
} from "./bridge-messaging.ts";
import { getLogger } from "../debug/logger.ts";

/** Bridge 运行器对内核的依赖（依赖反转，避免耦合 app.ts） */
export interface BridgeRunnerDeps {
  /** 提交一条用户消息，返回事件异步流（即 QueryEngine.submitMessage） */
  submitMessage: (input: string) => AsyncGenerator<QueryEngineEvent, void, unknown>;
  /** 设置流式文本回调（null 清除） */
  setStreamTextCallback: (cb: ((text: string) => void) | null) => void;
  /** 中断当前执行 */
  abort: () => void;
  /**
   * 注入远程权限代理：返回一个清理函数用于卸载。
   * delegate 返回 true=允许 / false=拒绝。
   */
  setPermissionDelegate: (
    delegate: ((req: {
      toolName: string;
      toolInput: unknown;
      description: string;
      dangerLevel: string;
    }) => Promise<boolean>) | null,
  ) => void;
}

export interface BridgeRunnerOptions {
  /** 中继服务器 WebSocket URL（ws:// 或 wss://） */
  url: string;
  /** 认证令牌 */
  authToken?: string;
  /** 权限请求超时（毫秒，默认 60000） */
  permissionTimeoutMs?: number;
}

/**
 * Bridge 运行器 — 管理一个远程控制会话的完整生命周期。
 */
export class BridgeRunner {
  private core: BridgeCore;
  private deps: BridgeRunnerDeps;
  /** 串行消费远程消息：上一轮未结束时排队 */
  private queue: string[] = [];
  private processing = false;
  private stopped = false;

  constructor(deps: BridgeRunnerDeps, options: BridgeRunnerOptions) {
    this.deps = deps;

    const transport = createBridgeTransport(options.url, options.authToken);
    this.core = new BridgeCore({
      transport,
      permissionTimeoutMs: options.permissionTimeoutMs,
      onUserMessage: (text) => this.enqueue(text),
      onAbort: () => this.deps.abort(),
    });
  }

  /** 启动 Bridge 会话（建立连接 + 注入权限代理） */
  async start(): Promise<void> {
    // 把远程权限代理注入权限检查器
    const proxy = this.core.getPermissionProxy();
    this.deps.setPermissionDelegate((req) => proxy.requestPermission(req));

    await this.core.start();
    getLogger().info("BRIDGE", "Bridge 运行器已启动，等待远程消息");
  }

  /** 停止 Bridge 会话（卸载权限代理 + 关闭连接） */
  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.setPermissionDelegate(null);
    await this.core.stop();
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.core.isConnected();
  }

  // ─── 内部方法 ───

  /** 远程消息入队并触发串行处理 */
  private enqueue(text: string): void {
    if (this.stopped) return;
    this.queue.push(text);
    void this.processNext();
  }

  /** 串行消费队列：一次只跑一轮 submitMessage */
  private async processNext(): Promise<void> {
    if (this.processing || this.stopped) return;
    const text = this.queue.shift();
    if (text === undefined) return;

    this.processing = true;

    // 流式文本增量转发给远程
    this.deps.setStreamTextCallback((delta) => {
      void this.core.send(formatTextMessage(delta));
    });

    try {
      for await (const event of this.deps.submitMessage(text)) {
        if (this.stopped) break;
        this.forwardEvent(event);
        if (event.kind === "done") break;
        // §3.2：queryLoop 异常现封装为 fatal_error 事件（不再穿透）。已在 forwardEvent
        // 转发给远程，此处结束本轮（与 done 同等收尾）。
        if (event.kind === "fatal_error") break;
      }
      await this.core.send(formatStatusMessage("turn_complete"));
    } catch (err: any) {
      getLogger().error("BRIDGE", `处理远程消息异常: ${err?.message ?? err}`);
      await this.core.send(formatStatusMessage("error", { message: err?.message ?? String(err) }));
    } finally {
      this.deps.setStreamTextCallback(null);
      this.processing = false;
      // 继续消费队列中后续消息
      if (this.queue.length > 0 && !this.stopped) void this.processNext();
    }
  }

  /** 将内核事件转换为 Bridge 消息发送给远程客户端 */
  private forwardEvent(event: QueryEngineEvent): void {
    switch (event.kind) {
      case "tool_start":
        void this.core.send(formatToolUseMessage(event.toolName, event.toolInput));
        break;
      case "tool_end":
        void this.core.send(
          formatToolResultMessage(event.toolName, "", event.result?.isError),
        );
        break;
      case "system":
        if (event.level === "warning" || event.level === "error") {
          void this.core.send(formatStatusMessage(event.level, { text: event.text }));
        }
        break;
      case "fatal_error":
        // §3.2：把 queryLoop 致命错误作为 error 状态转发给远程，避免被 default 吞掉。
        void this.core.send(formatStatusMessage("error", { message: event.message }));
        break;
      // stream_text 已通过 setStreamTextCallback 转发，此处不重复发送
      default:
        break;
    }
  }
}
