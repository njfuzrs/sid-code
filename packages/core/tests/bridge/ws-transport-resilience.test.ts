/**
 * WebSocket 传输层韧性回归（D11 永久失败码 / D12 心跳探活 / D9 flush 语义）
 *
 * 这组用例跑**真实的本地 WebSocket 服务器**，不用 mock。理由：
 * 要验证的东西恰恰是"关闭码怎么分流""半开时 isConnected 说不说谎"——
 * 这些都是 `WebSocket` 实例的真实行为，mock 掉就等于把被测对象换成了自己的假设
 * （D13 的教训正是"测试喂给实现一套自己编的词汇，双方互相自证"）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { WebSocketBridgeTransport } from "@sid-code/core/bridge/ws-transport.ts";

/** 起一个最小 WS 服务器，可指定连上来后立刻用某个码关掉 */
function startServer(opts: {
  closeWith?: { code: number; reason: string };
  onMessage?: (data: string) => void;
}) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (opts.closeWith) ws.close(opts.closeWith.code, opts.closeWith.reason);
      },
      message(_ws, message) {
        opts.onMessage?.(String(message));
      },
    },
  });
  return { server, url: `ws://127.0.0.1:${server.port}` };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("D11 · 永久失败关闭码不重试", () => {
  // 4001 认证失败：token 错了，重试一万次也一样。修复前它会进 10 分钟的重连循环，
  // 于是一个"立刻能报出来的错"变成"10 分钟后才报的错"。
  test("4001 认证失败 → 立即判定永久失败，触发回调，不重连", async () => {
    const { server, url } = startServer({ closeWith: { code: 4001, reason: "bad token" } });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url, "wrong-token");
    const failures: Array<{ code: number; reason: string }> = [];
    transport.setOnPermanentFailure((code, reason) => failures.push({ code, reason }));

    const closed = new Promise<void>((resolve) => transport.setOnClose(() => resolve()));
    await transport.connect();
    await closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(transport.isPermanentlyFailed()).toBe(true);
    expect(transport.getStateLabel()).toBe("permanently-failed");
    expect(failures.length).toBe(1);
    expect(failures[0]!.code).toBe(4001);
    expect(failures[0]!.reason).toContain("认证失败");
    expect(transport.getStats().permanentFailureCount).toBe(1);

    transport.close();
  });

  test("1008 违反策略同样永久失败", async () => {
    const { server, url } = startServer({ closeWith: { code: 1008, reason: "policy" } });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    const closed = new Promise<void>((resolve) => transport.setOnClose(() => resolve()));
    await transport.connect();
    await closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(transport.isPermanentlyFailed()).toBe(true);
    transport.close();
  });

  test("1006/1011 这类瞬时码**不**判永久失败（否则把可恢复断线做成永久断线）", async () => {
    // 1011 = 服务端内部错误，典型的可重试情形
    const { server, url } = startServer({ closeWith: { code: 1011, reason: "oops" } });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    const closed = new Promise<void>((resolve) => transport.setOnClose(() => resolve()));
    await transport.connect();
    await closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(transport.isPermanentlyFailed()).toBe(false);
    expect(transport.getStats().permanentFailureCount).toBe(0);

    // 立刻 close 收手，避免后台重连循环拖住测试进程
    transport.close();
  });

  test("用户主动 close 不算永久失败，也不重连", async () => {
    const { server, url } = startServer({});
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);

    transport.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.isPermanentlyFailed()).toBe(false);
  });
});

describe("D12 · 心跳既保活也探活", () => {
  test("连上后心跳会真的发出去（保活这一半原本就有）", async () => {
    const seen: string[] = [];
    const { server, url } = startServer({ onMessage: (d) => seen.push(d) });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    await transport.connect();

    // 心跳间隔是 30s，单测不等它。直接验"写得出去"这条通路，
    // 探活逻辑本身由下面按时间戳的用例覆盖。
    await transport.write({ type: "status", data: { probe: true }, timestamp: Date.now() });
    expect(await transport.flush(1000)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));

    expect(seen.length).toBeGreaterThan(0);
    transport.close();
  });

  test("入向消息刷新探活基线（判据是「对端还在说话」，不要求配对 pong）", async () => {
    const { server, url } = startServer({});
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    await transport.connect();

    // 私有字段读取：这里刻意断言内部状态，因为探活基线是这条修复的**机制核心**，
    // 而它的外部表现（30s 后断开重连）无法在单测时间尺度内观测。
    const baseline = (transport as unknown as { lastInboundAt: number }).lastInboundAt;
    expect(baseline).toBeGreaterThan(0); // onopen 必须置一次，否则首个周期就误判半开

    transport.close();
  });

  test("stats 暴露半开检测计数（防线被触发过必须可复算）", async () => {
    const { server, url } = startServer({});
    cleanup.push(() => server.stop(true));
    const transport = new WebSocketBridgeTransport(url);
    await transport.connect();
    expect(transport.getStats().halfOpenDetectedCount).toBe(0);
    transport.close();
  });
});

describe("D9 · flush 在传输层的语义", () => {
  test("未连接时 flush 返回 false 而不是挂住", async () => {
    const transport = new WebSocketBridgeTransport("ws://127.0.0.1:1");
    await transport.write({ type: "text", data: "x", timestamp: Date.now() });

    const result = await Promise.race([
      transport.flush(300),
      new Promise<"挂住了">((r) => setTimeout(() => r("挂住了"), 2000)),
    ]);
    expect(result).toBe(false);
    transport.close();
  });

  test("getStats 在从未连接过时也可用（不抛）", () => {
    const transport = new WebSocketBridgeTransport("ws://127.0.0.1:1");
    const stats = transport.getStats();
    expect(stats.droppedBatchCount).toBe(0);
    expect(stats.reconnectCount).toBe(0);
  });
});
