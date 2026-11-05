/**
 * T4：远程接管进轨迹（BridgeSession / BridgeInbound / BridgePermission）
 *
 * 覆盖触发清单 A12 需要的全部事实：连上 / 断开、远程消息（去重后）、ping 不记、
 * 中断、权限请求的三种结果、坏 token 的永久失败，以及隐私边界
 * （token 与 query 不得出现在任何事件里）。
 *
 * 为什么 runner 的三个用例用真实 WebSocket 而不是 mock：要断言的是「连上之后
 * 才发 connected、坏 token 的 close_code 真的从传输层传上来了」，mock 掉传输
 * 等于把被测对象换成假设（同 `ws-transport-auth-frame.test.ts` 的理由）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { BridgeCore } from "@sid-code/core/bridge/bridge-core.ts";
import { PermissionProxy } from "@sid-code/core/bridge/permission-proxy.ts";
import { BridgeRunner, type BridgeRunnerDeps } from "@sid-code/core/bridge/bridge-runner.ts";
import {
  BRIDGE_INBOUND_EVENT_NAME,
  BRIDGE_PERMISSION_EVENT_NAME,
  BRIDGE_SESSION_EVENT_NAME,
  type BridgeTelemetrySink,
} from "@sid-code/core/bridge/bridge-telemetry.ts";
import type {
  BridgeOutMessage,
  BridgeTransport,
  BridgeTransportStats,
} from "@sid-code/core/bridge/types.ts";

interface Captured {
  name: string;
  data: Record<string, unknown>;
}

/** 收集埋点事件；`json()` 用于一次性断言「整份事件里没有敏感串」 */
function collector(): {
  sink: BridgeTelemetrySink;
  events: Captured[];
  json: () => string;
} {
  const events: Captured[] = [];
  return {
    sink: (name, data) => events.push({ name, data }),
    events,
    json: () => JSON.stringify(events),
  };
}

/** 可注入入站数据的 mock 传输（与 bridge-core.test.ts 同形态） */
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
  inject(obj: unknown): void {
    this.onDataCb?.(JSON.stringify(obj));
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers.length = 0;
});

/**
 * 本地 WS 中继替身：可保持连接，也可在收到客户端 auth 帧之后按给定关闭码断开。
 *
 * 为什么不在 open 里直接 close：服务端在握手回调里立刻关，客户端偶尔读到的是
 * 1006（异常关闭）而不是 4001，于是永久失败判定不触发、start() 反而成功——
 * 测试会间歇性变绿。真实中继也是**收到 auth 之后**才拒绝（首帧必鉴权），
 * 按那个时序来既确定又贴近生产。
 */
function startServer(opts: {
  closeOnAuth?: { code: number; reason: string };
  replyAuthOk?: boolean;
}) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        let type: string | undefined;
        try {
          type = (JSON.parse(String(message)) as { type?: string })?.type;
        } catch {
          return; // 非 JSON 帧忽略
        }
        if (type !== "auth") return;
        if (opts.closeOnAuth) {
          ws.close(opts.closeOnAuth.code, opts.closeOnAuth.reason);
          return;
        }
        if (opts.replyAuthOk) {
          ws.send(JSON.stringify({ type: "auth_ok", session_id: "br_test" }));
        }
      },
    },
  });
  servers.push(server);
  return server;
}

function runnerWith(
  url: string,
  capture: ReturnType<typeof collector>,
  over: Partial<BridgeRunnerDeps> = {},
): BridgeRunner {
  return new BridgeRunner(
    {
      submitMessage: async function* () {},
      setStreamTextCallback: () => {},
      abort: () => {},
      setPermissionDelegate: () => {},
      onTelemetry: capture.sink,
      ...over,
    },
    { url, authToken: "secret-token-abc", permissionTimeoutMs: 12_345 },
  );
}

describe("BridgeCore · BridgeInbound", () => {
  test("远程消息去重后只记 1 条，text_len 是长度而不是正文", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const received: string[] = [];
    const core = new BridgeCore({
      transport,
      onUserMessage: (t) => {
        received.push(t);
      },
      onTelemetry: capture.sink,
    });
    await core.start();

    const msg = { type: "user_message", id: "m-1", data: "修一下 README" };
    transport.inject(msg);
    transport.inject(msg); // 重复 id
    await tick();

    const inbound = capture.events.filter((e) => e.name === BRIDGE_INBOUND_EVENT_NAME);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.data).toEqual({ kind: "user_message", text_len: "修一下 README".length });
    expect(received).toEqual(["修一下 README"]);
  });

  test("ping 不记（心跳量大且无信息）", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const core = new BridgeCore({
      transport,
      onUserMessage: () => {},
      onTelemetry: capture.sink,
    });
    await core.start();

    transport.inject({ type: "control", id: "c-1", data: { command: "ping" } });
    await tick();
    expect(capture.events.filter((e) => e.name === BRIDGE_INBOUND_EVENT_NAME)).toHaveLength(0);
    // pong 仍要发出去：埋点不改变心跳行为
    expect(
      transport.written.some(
        (m) => m.type === "status" && (m.data as { status?: string })?.status === "pong",
      ),
    ).toBe(true);
  });

  test("abort 记 1 条并进会话计数", async () => {
    const capture = collector();
    const transport = new MockTransport();
    let aborted = 0;
    const core = new BridgeCore({
      transport,
      onUserMessage: () => {},
      onAbort: () => aborted++,
      onTelemetry: capture.sink,
    });
    await core.start();

    transport.inject({ type: "control", id: "c-2", data: { command: "abort" } });
    await tick();

    const inbound = capture.events.filter((e) => e.name === BRIDGE_INBOUND_EVENT_NAME);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.data).toEqual({ kind: "control:abort" });
    expect(aborted).toBe(1);
    expect(core.getSessionStats()).toEqual({ inboundMessages: 0, aborts: 1 });
  });

  test("permission_response 记 1 条 kind=permission_response", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const core = new BridgeCore({
      transport,
      onUserMessage: () => {},
      onTelemetry: capture.sink,
    });
    await core.start();

    transport.inject({ type: "permission_response", id: "p-1", data: { allowed: true } });
    await tick();

    const inbound = capture.events.filter((e) => e.name === BRIDGE_INBOUND_EVENT_NAME);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.data).toEqual({ kind: "permission_response" });
  });
});

describe("PermissionProxy · BridgePermission", () => {
  const REQ = {
    toolName: "bash",
    toolInput: { command: "ls" },
    description: "列目录",
    dangerLevel: "unknown",
  };

  test("远程批准 → decision=allow，wait_ms 是真实等待", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 5_000, capture.sink);

    const promise = proxy.requestPermission(REQ);
    await tick();
    const requestId = transport.written.find((m) => m.type === "permission_request")?.id;
    expect(requestId).toBeDefined();
    proxy.handleResponse({ type: "permission_response", id: requestId, data: { allowed: true } });

    expect(await promise).toBe(true);
    const ev = capture.events.filter((e) => e.name === BRIDGE_PERMISSION_EVENT_NAME);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.decision).toBe("allow");
    expect(ev[0]!.data.tool_name).toBe("bash");
    expect(ev[0]!.data.wait_ms as number).toBeGreaterThanOrEqual(0);
  });

  test("远程拒绝 → decision=deny", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 5_000, capture.sink);

    const promise = proxy.requestPermission(REQ);
    await tick();
    const requestId = transport.written.find((m) => m.type === "permission_request")?.id;
    proxy.handleResponse({ type: "permission_response", id: requestId, data: { allowed: false } });

    expect(await promise).toBe(false);
    const ev = capture.events.filter((e) => e.name === BRIDGE_PERMISSION_EVENT_NAME);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.decision).toBe("deny");
  });

  test("超时 → decision=timeout，与远程拒绝分开", async () => {
    const capture = collector();
    const transport = new MockTransport();
    const proxy = new PermissionProxy(transport, 30, capture.sink);

    expect(await proxy.requestPermission(REQ)).toBe(false);
    const ev = capture.events.filter((e) => e.name === BRIDGE_PERMISSION_EVENT_NAME);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.decision).toBe("timeout");
    expect(ev[0]!.data.wait_ms as number).toBeGreaterThanOrEqual(20);
  });
});

describe("BridgeRunner · BridgeSession", () => {
  test("连上 → connected（relay_host 剥掉 query，超时档位进事件）；stop → stopped", async () => {
    const capture = collector();
    const server = startServer({ replyAuthOk: true });
    // token 故意放在 query 里：事件里出现它就是把凭证传上了企业后端
    const url = `ws://127.0.0.1:${server.port}/bridge/ws?token=SECRET-TOKEN-XYZ&org=acme`;
    const runner = runnerWith(url, capture);

    await runner.start();
    await runner.stop();

    const sessions = capture.events.filter((e) => e.name === BRIDGE_SESSION_EVENT_NAME);
    const connected = sessions.find((e) => e.data.phase === "connected");
    expect(connected).toBeDefined();
    expect(connected!.data.relay_host).toBe(`ws://127.0.0.1:${server.port}/bridge/ws`);
    expect(connected!.data.permission_timeout_ms).toBe(12_345);

    const stopped = sessions.find((e) => e.data.phase === "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.data.inbound_messages).toBe(0);
    expect(stopped!.data.aborts).toBe(0);
    expect(stopped!.data.duration_ms as number).toBeGreaterThanOrEqual(0);

    // 隐私硬约束：任何事件序列化后都不能出现 token 或 query
    expect(capture.json()).not.toContain("SECRET-TOKEN-XYZ");
    expect(capture.json()).not.toContain("token=");
    expect(capture.json()).not.toContain("org=acme");
  });

  test("stop 调两次只发一条 stopped（否则一次远程会话会被数成两个）", async () => {
    const capture = collector();
    const server = startServer({ replyAuthOk: true });
    const runner = runnerWith(`ws://127.0.0.1:${server.port}/bridge/ws`, capture);

    await runner.start();
    await runner.stop();
    await runner.stop();

    const stopped = capture.events.filter(
      (e) => e.name === BRIDGE_SESSION_EVENT_NAME && e.data.phase === "stopped",
    );
    expect(stopped).toHaveLength(1);
  });

  test("坏 token（4001）→ start_failed，close_code 与 reason 都在", async () => {
    const capture = collector();
    // 收到 auth 帧之后再拒（真实中继的首帧必鉴权时序），避免 open 即关退化成 1006
    const server = startServer({ closeOnAuth: { code: 4001, reason: "token 无效" } });
    const runner = runnerWith(`ws://127.0.0.1:${server.port}/bridge/ws`, capture);

    await expect(runner.start()).rejects.toThrow(/认证失败/);
    await runner.stop();

    const failed = capture.events.filter(
      (e) => e.name === BRIDGE_SESSION_EVENT_NAME && e.data.phase === "start_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data.close_code).toBe(4001);
    // reason 是传输层归一化后的文案（describeCloseCode），原始原因含在里面
    expect(String(failed[0]!.data.reason)).toContain("token 无效");
    // 从未连上 → 不该有 stopped（那会把「启动即被拒」记成一次正常会话）
    expect(
      capture.events.some(
        (e) => e.name === BRIDGE_SESSION_EVENT_NAME && e.data.phase === "stopped",
      ),
    ).toBe(false);
  });
});
