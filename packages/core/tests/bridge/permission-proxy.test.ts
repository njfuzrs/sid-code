/**
 * PermissionProxy 远程权限代理单测（spec 16 §9.4）
 * 覆盖：超时自动拒绝、响应匹配、发送失败拒绝、cleanup 全部拒绝
 */

import { describe, test, expect } from "bun:test";
import { PermissionProxy } from "@sid-code/core/bridge/permission-proxy.ts";
import type {
  BridgeTransport,
  BridgeOutMessage,
  BridgeInMessage,
  BridgeTransportStats,
} from "@sid-code/core/bridge/types.ts";

/** 最小 mock 传输：记录写出的消息，可手动注入响应 */
class MockTransport implements BridgeTransport {
  written: BridgeOutMessage[] = [];
  shouldFailWrite = false;

  async write(message: BridgeOutMessage): Promise<void> {
    if (this.shouldFailWrite) throw new Error("写入失败");
    this.written.push(message);
  }
  async writeBatch(messages: BridgeOutMessage[]): Promise<void> {
    this.written.push(...messages);
  }
  close(): void {}
  isConnected(): boolean {
    return true;
  }
  getStateLabel(): string {
    return "connected";
  }
  setOnData(): void {}
  setOnClose(): void {}
  setOnConnect(): void {}
  async connect(): Promise<void> {}
  async flush(): Promise<boolean> {
    return true;
  }
  getStats(): BridgeTransportStats {
    return {
      droppedBatchCount: 0,
      droppedItemCount: 0,
      reconnectCount: 0,
      halfOpenDetectedCount: 0,
      permanentFailureCount: 0,
    };
  }

  /** 取出最近一条 permission_request 的 id */
  lastRequestId(): string | undefined {
    const last = [...this.written].reverse().find((m) => m.type === "permission_request");
    return last?.id;
  }
}

const REQ = {
  toolName: "bash",
  toolInput: { command: "rm -rf /" },
  description: "删除文件",
  dangerLevel: "high",
};

describe("PermissionProxy", () => {
  test("收到 allowed=true 响应 → resolve(true)", async () => {
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 5000);

    const promise = proxy.requestPermission(REQ);
    await new Promise((r) => setTimeout(r, 5));

    const id = transport.lastRequestId()!;
    expect(id).toBeDefined();
    expect(proxy.hasPending()).toBe(true);

    proxy.handleResponse({
      type: "permission_response",
      id,
      data: { allowed: true },
    } as BridgeInMessage);
    expect(await promise).toBe(true);
    expect(proxy.hasPending()).toBe(false);
  });

  test("收到 allowed=false 响应 → resolve(false)", async () => {
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 5000);

    const promise = proxy.requestPermission(REQ);
    await new Promise((r) => setTimeout(r, 5));
    const id = transport.lastRequestId()!;

    proxy.handleResponse({
      type: "permission_response",
      id,
      data: { allowed: false },
    } as BridgeInMessage);
    expect(await promise).toBe(false);
  });

  test("超时自动拒绝，并出站 permission_expired（不是 error）", async () => {
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 30); // 30ms 超时

    const result = await proxy.requestPermission(REQ);
    expect(result).toBe(false);
    expect(proxy.hasPending()).toBe(false);

    const request = transport.written.find((m) => m.type === "permission_request");
    const expired = transport.written.find((m) => m.type === "status");
    expect(request?.id).toBeDefined();
    expect(expired).toBeDefined();
    const data = expired!.data as { status: string; request_id: string };
    expect(data.status).toBe("permission_expired");
    expect(data.request_id).toBe(request!.id);
    // 管理台按 status 展示。装成 error 会让「没人批」看起来像 agent 崩了。
    expect(data.status).not.toBe("error");
  });

  test("超时后写出失败不把拒绝变成抛错", async () => {
    const transport = new MockTransport();
    let writes = 0;
    const original = transport.write.bind(transport);
    transport.write = async (message) => {
      writes++;
      if (writes > 1) throw new Error("连接已死");
      return original(message);
    };
    const proxy = new PermissionProxy(transport, 30);
    await expect(proxy.requestPermission(REQ)).resolves.toBe(false);
  });

  test("发送失败立即拒绝", async () => {
    const transport = new MockTransport();
    transport.shouldFailWrite = true;
    const proxy = new PermissionProxy(transport, 5000);

    const result = await proxy.requestPermission(REQ);
    expect(result).toBe(false);
  });

  test("未匹配的响应 id 被忽略", async () => {
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 50);

    const promise = proxy.requestPermission(REQ);
    await new Promise((r) => setTimeout(r, 5));

    // 错误 id 不应解除挂起
    proxy.handleResponse({
      type: "permission_response",
      id: "wrong-id",
      data: { allowed: true },
    } as BridgeInMessage);
    expect(proxy.hasPending()).toBe(true);

    // 最终超时拒绝
    expect(await promise).toBe(false);
  });

  test("cleanup 拒绝所有待处理请求", async () => {
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 60_000);

    const p1 = proxy.requestPermission(REQ);
    const p2 = proxy.requestPermission(REQ);
    await new Promise((r) => setTimeout(r, 5));
    expect(proxy.hasPending()).toBe(true);

    proxy.cleanup();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(proxy.hasPending()).toBe(false);
  });
});
