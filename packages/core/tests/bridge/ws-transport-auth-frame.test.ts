/**
 * S1：token 不进连接 URL，改走 Upgrade 之后的首帧 auth。
 *
 * 用真实本地 WebSocket，不用 mock。要锁的是「Bun 实际拿去握手的 URL」
 * 和「对端收到的第一帧」——mock 掉 WebSocket 构造函数等于把被测对象换成假设。
 *
 * 没有「URL 不含 token」这条，下一次重构把 token 拼回 query 会全绿。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { WebSocketBridgeTransport, stripTokenQuery } from "@sid-code/core/bridge/ws-transport.ts";

function startServer(opts: {
  closeWith?: { code: number; reason: string };
  /** 收到首帧 auth 后回 auth_ok；之前可以先推一条业务帧 */
  replyAuthOk?: boolean;
  pushBeforeAuth?: string;
  onRequestUrl?: (url: string) => void;
}) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      opts.onRequestUrl?.(req.url);
      if (srv.upgrade(req, { data: { pushBeforeAuth: opts.pushBeforeAuth ?? null } })) {
        return undefined;
      }
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        const data = ws.data as { pushBeforeAuth: string | null };
        if (data.pushBeforeAuth) ws.send(data.pushBeforeAuth);
        if (opts.closeWith) ws.close(opts.closeWith.code, opts.closeWith.reason);
      },
      message(ws, message) {
        const text = String(message);
        seen.push(text);
        if (opts.replyAuthOk) {
          let parsed: { type?: string } | null = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          if (parsed?.type === "auth") {
            ws.send(JSON.stringify({ type: "auth_ok", session_id: "br_test" }));
          }
        }
      },
    },
  });
  return { server, url: `ws://127.0.0.1:${server.port}/bridge/ws`, seen };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("stripTokenQuery", () => {
  test("剥掉 query 与 hash，路径原样保留", () => {
    expect(stripTokenQuery("wss://relay.example.com/traj/api/v1/bridge/ws?token=SECRET&x=1")).toBe(
      "wss://relay.example.com/traj/api/v1/bridge/ws",
    );
    expect(stripTokenQuery("wss://relay.example.com/ws/#token=SECRET")).toBe(
      "wss://relay.example.com/ws/",
    );
  });

  test("没有 query 时不改路径（尾斜杠不能被信任键归一化吃掉）", () => {
    expect(stripTokenQuery("wss://relay.example.com/bridge/ws/")).toBe(
      "wss://relay.example.com/bridge/ws/",
    );
  });
});

describe("S1 · 首帧 auth", () => {
  test("authToken 有值：握手 URL 不含 token=，onopen 后第一帧是 auth", async () => {
    const urls: string[] = [];
    const { server, url, seen } = startServer({
      replyAuthOk: true,
      onRequestUrl: (u) => urls.push(u),
    });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(
      `${url}?token=SHOULD_NOT_LEAK`,
      "session-secret",
    );
    const received: string[] = [];
    let connects = 0;
    transport.setOnData((d) => received.push(d));
    transport.setOnConnect(() => {
      connects++;
    });

    await transport.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).not.toContain("token=");
      expect(u).not.toContain("SHOULD_NOT_LEAK");
      expect(u).not.toContain("session-secret");
    }
    expect(seen.length).toBeGreaterThan(0);
    const first = JSON.parse(seen[0]!) as { type: string; token: string; role: string };
    expect(first.type).toBe("auth");
    expect(first.token).toBe("session-secret");
    expect(first.role).toBe("cli");
    // auth_ok 之前不算已连接：onConnect 在 auth_ok 之后才触发，isConnected 同样如此
    expect(connects).toBe(1);
    expect(transport.isConnected()).toBe(true);
    expect(transport.getStateLabel()).toBe("connected");
    expect(received.length).toBe(0);

    transport.close();
  });

  test("auth_ok 之前的 user_message 不进 onData", async () => {
    const early = JSON.stringify({ type: "user_message", id: "m1", data: "抢跑" });
    const { server, url } = startServer({
      replyAuthOk: true,
      pushBeforeAuth: early,
    });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url, "session-secret");
    const received: string[] = [];
    let connected = false;
    transport.setOnData((d) => received.push(d));
    transport.setOnConnect(() => {
      connected = true;
    });

    await transport.connect();
    await new Promise((r) => setTimeout(r, 80));

    expect(connected).toBe(true);
    expect(received.some((d) => d.includes("抢跑"))).toBe(false);
    expect(received.some((d) => d.includes("user_message"))).toBe(false);

    transport.close();
  });

  test("对端 4001 → 永久失败，不进重连", async () => {
    let opens = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        opens++;
        if (srv.upgrade(req)) return undefined;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.close(4001, "bad token");
        },
        message() {},
      },
    });
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(
      `ws://127.0.0.1:${server.port}/bridge/ws`,
      "wrong",
    );
    const closed = new Promise<void>((resolve) => transport.setOnClose(() => resolve()));
    await transport.connect();
    await closed;
    // 重连基础延迟约 1s。等到它之后仍只有一次握手，才算「不进重连」而不是「还没来得及重连」。
    await new Promise((r) => setTimeout(r, 1300));

    expect(transport.isPermanentlyFailed()).toBe(true);
    expect(opens).toBe(1);
    transport.close();
  });

  test("无 authToken：不发 auth 帧，onopen 即 onConnect（中继负责拒绝）", async () => {
    const { server, url, seen } = startServer({});
    cleanup.push(() => server.stop(true));

    const transport = new WebSocketBridgeTransport(url);
    let connects = 0;
    transport.setOnConnect(() => {
      connects++;
    });
    await transport.connect();
    await new Promise((r) => setTimeout(r, 30));

    expect(connects).toBe(1);
    expect(seen.length).toBe(0);
    transport.close();
  });
});
