/**
 * BridgeCore 消息路由 + 去重集成单测（spec 16 §9.4）
 * 覆盖：user_message 转发、permission_response 路由、control(abort/ping)、去重、连接就绪状态
 */

import { describe, test, expect } from "bun:test";
import { BridgeCore } from "@sid-code/core/bridge/bridge-core.ts";
import type { BridgeTransport, BridgeOutMessage } from "@sid-code/core/bridge/types.ts";

/** 可注入入站数据的 mock 传输 */
class MockTransport implements BridgeTransport {
  written: BridgeOutMessage[] = [];
  private onDataCb?: (data: string) => void;
  private onCloseCb?: (code?: number) => void;
  private onConnectCb?: () => void;
  private connected = false;

  async write(message: BridgeOutMessage): Promise<void> {
    this.written.push(message);
  }
  async writeBatch(messages: BridgeOutMessage[]): Promise<void> {
    this.written.push(...messages);
  }
  close(): void {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  getStateLabel(): string {
    return this.connected ? "connected" : "disconnected";
  }
  setOnData(cb: (data: string) => void): void {
    this.onDataCb = cb;
  }
  setOnClose(cb: (code?: number) => void): void {
    this.onCloseCb = cb;
  }
  setOnConnect(cb: () => void): void {
    this.onConnectCb = cb;
  }
  async connect(): Promise<void> {
    this.connected = true;
    this.onConnectCb?.();
  }
  async flush(): Promise<void> {}

  /** 模拟从远程收到一条消息 */
  inject(obj: unknown): void {
    this.onDataCb?.(JSON.stringify(obj));
  }
  /** 模拟非法 JSON */
  injectRaw(raw: string): void {
    this.onDataCb?.(raw);
  }
  /** 模拟连接关闭 */
  triggerClose(code = 1006): void {
    this.onCloseCb?.(code);
  }

  hasStatus(status: string): boolean {
    return this.written.some(
      (m) => m.type === "status" && (m.data as { status?: string })?.status === status,
    );
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("BridgeCore", () => {
  test("启动后连接就绪，发送 ready 状态", async () => {
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
    });

    await core.start();
    expect(core.isConnected()).toBe(true);
    expect(transport.hasStatus("ready")).toBe(true);
  });

  test("user_message 转发给 onUserMessage（字符串与对象两种形态）", async () => {
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
    });
    await core.start();

    transport.inject({ type: "user_message", id: "m1", data: "你好" });
    transport.inject({ type: "user_message", id: "m2", data: { text: "世界" } });
    await tick();

    expect(received).toEqual(["你好", "世界"]);
  });

  test("消息去重：相同 id 只处理一次", async () => {
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
    });
    await core.start();

    transport.inject({ type: "user_message", id: "dup", data: "一次" });
    transport.inject({ type: "user_message", id: "dup", data: "重放" });
    await tick();

    expect(received).toEqual(["一次"]);
  });

  test("control: ping → pong, abort → onAbort + aborted 状态", async () => {
    const transport = new MockTransport();
    let aborted = false;
    const core = new BridgeCore({
      transport,
      onUserMessage: () => {},
      onAbort: () => {
        aborted = true;
      },
    });
    await core.start();

    transport.inject({ type: "control", id: "c1", data: { command: "ping" } });
    await tick();
    expect(transport.hasStatus("pong")).toBe(true);

    transport.inject({ type: "control", id: "c2", data: { command: "abort" } });
    await tick();
    expect(aborted).toBe(true);
    expect(transport.hasStatus("aborted")).toBe(true);
  });

  test("非法 JSON 被静默忽略，不崩溃", async () => {
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
    });
    await core.start();

    transport.injectRaw("{ 非法 json");
    transport.inject({ type: "user_message", id: "ok", data: "正常" });
    await tick();

    expect(received).toEqual(["正常"]);
  });

  test("send 仅在连接时发出", async () => {
    const transport = new MockTransport();
    const core = new BridgeCore({ transport, onUserMessage: () => {} });

    // 未连接时 send 应被丢弃
    await core.send({ type: "text", data: { text: "x" }, timestamp: 1 });
    expect(transport.written.length).toBe(0);

    await core.start();
    await core.send({ type: "text", data: { text: "y" }, timestamp: 2 });
    expect(transport.written.some((m) => m.type === "text")).toBe(true);
  });

  test("stop 后清理权限代理且不再标记 started", async () => {
    const transport = new MockTransport();
    const core = new BridgeCore({ transport, onUserMessage: () => {} });
    await core.start();
    await core.stop();
    expect(core.isConnected()).toBe(false);
  });

  test("无 id 的消息不参与去重但仍被处理", async () => {
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
    });
    await core.start();

    transport.inject({ type: "user_message", data: "a" });
    transport.inject({ type: "user_message", data: "a" });
    await tick();

    // 无 id → 不去重，两条都处理
    expect(received).toEqual(["a", "a"]);
  });
});
