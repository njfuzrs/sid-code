/**
 * MCP 传输层健壮性回归（批次 B1：D6 / D7 / D8 / D9 / D10 / D11 / D12）
 *
 * 每条断言都跑在真实传输实例上（真 socket / 真子进程），不 mock 传输内部。
 * 变异自证方式写在各 describe 的注释里：把对应修复改回去，该组必须变红。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SSETransport,
  StdioTransport,
  WebSocketTransport,
  HTTPTransport,
  createLinkedTransportPair,
} from "@sid-code/core/mcp/transport.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "@sid-code/core/mcp/types.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
  cleanups = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await sleep(10);
  }
}

// ─── D6 ───
// 变异自证：把 parseSSEStream 的 eventType/eventData 声明挪进 while 循环内 → 本组超时变红。

describe("D6 SSE 事件跨 chunk 到达仍被完整派发", () => {
  test("event:/data: 在前一个 chunk、空行在后一个 chunk", async () => {
    const enc = new TextEncoder();
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "GET") {
          const body = new ReadableStream<Uint8Array>({
            start(ctl) {
              streams.add(ctl);
              ctl.enqueue(enc.encode("event: endpoint\ndata: /msg\n\n"));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        if (req.method === "POST" && url.pathname === "/msg") {
          const msg = await req.json();
          const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
          for (const ctl of streams) {
            // 第一个 chunk：完整的 event + data 行，但没有结束事件的空行
            ctl.enqueue(enc.encode(`event: message\ndata: ${resp}\n`));
            // 隔一段时间再发空行，确保落在另一次 reader.read() 里
            setTimeout(() => ctl.enqueue(enc.encode("\n")), 50);
          }
          return new Response(null, { status: 202 });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const t = new SSETransport(`http://127.0.0.1:${server.port}/sse`, undefined, 1500);
    cleanups.push(
      () => t.close(),
      () => server.stop(true),
    );
    const resp = await t.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect((resp.result as any)?.ok).toBe(true);
  });
});

// ─── D7 ───
// 变异自证：删掉构造函数里的 this.drainStderr() → 子进程卡在 writeSync(2) 上，请求超时变红。

describe("D7 stdio 子进程 stderr 持续排空", () => {
  test("Server 先同步写 256KB stderr 再回响应，请求仍能返回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-b1-d7-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // writeSync(2, ...) 在管道写满时会阻塞，正是「Server 守规矩写 stderr 日志」的最坏形态
    const script = `
const fs = require("fs");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\\n"); buf = lines.pop() || "";
  for (const l of lines) {
    let m; try { m = JSON.parse(l.trim()); } catch { continue; }
    const chunk = "x".repeat(4096) + "\\n";
    for (let i = 0; i < 64; i++) fs.writeSync(2, chunk);
    fs.writeSync(2, "STDERR-TAIL-MARKER\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\\n");
  }
});
`;
    const f = join(dir, "srv.cjs");
    writeFileSync(f, script);
    const t = new StdioTransport(process.execPath, [f], undefined, 4000);
    cleanups.push(() => t.close());
    const resp = await t.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect((resp.result as any)?.ok).toBe(true);
    // drain 有上限：只保留尾部，且尾部确实是最后写的内容
    await waitFor(() => t.stderrTail.includes("STDERR-TAIL-MARKER"));
    expect(t.stderrTail.length).toBeLessThanOrEqual(8192);
  }, 10000);
});

// ─── D8 ───
// 变异自证：去掉任一传输 send() 里 cleanup 中的 clearTimeout → 活跃 timer 数随调用线性增长，变红。

/** 在 globalThis 上包一层 setTimeout/clearTimeout，统计「已创建且未触发、未清除」的 timer */
/**
 * 只统计 delay === `onlyMs` 的 timer（即传输的请求超时 timer）。
 *
 * 不按 delay 过滤时，替换的是**进程级** setTimeout：全量 `bun test` 下其它测试文件遗留的
 * 异步尾巴（日志 flush、未关的 socket / 子进程回调……）在窗口内建的 timer 也会被计入，
 * macOS CI 上偶发 `Expected: 0, Received: 1`（main 上 stdio / ws 两条都红过）。
 * 传输超时用的是构造时传入的 30000，测试窗口内别处不会恰好建这个时长的 timer。
 */
const TRANSPORT_TIMEOUT_MS = 30000;

function trackTimers(onlyMs: number = TRANSPORT_TIMEOUT_MS) {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  const active = new Set<unknown>();
  (globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    if (ms !== onlyMs) return origSet(fn, ms, ...rest);
    const h = origSet(
      (...a: any[]) => {
        active.delete(h);
        fn(...a);
      },
      ms,
      ...rest,
    );
    active.add(h);
    return h;
  };
  (globalThis as any).clearTimeout = (h: any) => {
    active.delete(h);
    return origClear(h);
  };
  const restore = () => {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  };
  return { active, restore };
}

describe("D8 超时 timer 在响应后被清理", () => {
  test("stdio：N 次成功调用后活跃 timer 不增长", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-b1-d8-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "echo.cjs");
    writeFileSync(
      f,
      `let b="";process.stdin.on("data",c=>{b+=c;const ls=b.split("\\n");b=ls.pop()||"";for(const l of ls){let m;try{m=JSON.parse(l)}catch{continue}process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n")}})`,
    );
    const t = new StdioTransport(process.execPath, [f], undefined, TRANSPORT_TIMEOUT_MS);
    cleanups.push(() => t.close());
    await t.send({ jsonrpc: "2.0", id: 0, method: "ping" }); // 预热，排除启动期噪声

    const tracker = trackTimers();
    cleanups.push(tracker.restore);
    for (let i = 1; i <= 20; i++) {
      await t.send({ jsonrpc: "2.0", id: i, method: "ping" });
    }
    tracker.restore();
    expect(tracker.active.size).toBe(0);
  });

  test("ws：N 次成功调用后活跃 timer 不增长", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("nf", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
        },
      },
    });
    const t = new WebSocketTransport(
      `ws://127.0.0.1:${server.port}`,
      undefined,
      TRANSPORT_TIMEOUT_MS,
    );
    cleanups.push(
      () => t.close(),
      () => server.stop(true),
    );
    await t.send({ jsonrpc: "2.0", id: 0, method: "ping" });

    const tracker = trackTimers();
    cleanups.push(tracker.restore);
    for (let i = 1; i <= 20; i++) {
      await t.send({ jsonrpc: "2.0", id: i, method: "ping" });
    }
    tracker.restore();
    expect(tracker.active.size).toBe(0);
  });

  test("close() 时在途请求的 timer 也被清掉", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-b1-d8c-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "mute.cjs");
    writeFileSync(f, `process.stdin.on("data",()=>{});setInterval(()=>{},1000)`);
    const t = new StdioTransport(process.execPath, [f], undefined, TRANSPORT_TIMEOUT_MS);
    const tracker = trackTimers();
    cleanups.push(tracker.restore);
    const p = t.send({ jsonrpc: "2.0", id: 1, method: "ping" }).catch((e) => e);
    expect(tracker.active.size).toBe(1);
    t.close();
    tracker.restore();
    expect(((await p) as Error).message).toBe("传输已关闭");
    expect(tracker.active.size).toBe(0);
  });
});

// ─── D9 ───
// 变异自证：删掉构造函数里的 this.connectPromise.catch(() => {}) → 捕获到 unhandledRejection，变红。

describe("D9 只构造不 send 的连接失败不产生 unhandledRejection", () => {
  const capture = () => {
    const seen: unknown[] = [];
    const h = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", h);
    cleanups.push(() => process.off("unhandledRejection", h));
    return seen;
  };

  test("SSE：构造后直接 close", async () => {
    const seen = capture();
    const t = new SSETransport("http://127.0.0.1:1/sse");
    t.close();
    await sleep(200);
    expect(seen).toEqual([]);
  });

  test("SSE：连接被拒且从不 send", async () => {
    const seen = capture();
    const t = new SSETransport("http://127.0.0.1:1/sse");
    cleanups.push(() => t.close());
    await sleep(300);
    expect(seen).toEqual([]);
  });

  test("WS：连接失败且从不 send", async () => {
    const seen = capture();
    const t = new WebSocketTransport("ws://127.0.0.1:1");
    cleanups.push(() => t.close());
    await sleep(300);
    expect(seen).toEqual([]);
  });

  test("错误仍由 send() 抛出（兜底 catch 没吞掉真实错误）", async () => {
    const t = new SSETransport("http://127.0.0.1:1/sse");
    cleanups.push(() => t.close());
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
  });
});

// ─── D10 ───
// 变异自证：删掉 WebSocketTransport message 监听里「id + method」那一支 → 服务端收不到应答，变红。

describe("D10 WebSocketTransport 应答服务器发起的请求", () => {
  const startServer = () => {
    const received: any[] = [];
    let sock: any;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("nf", { status: 404 });
      },
      websocket: {
        open(ws) {
          sock = ws;
        },
        message(_ws, raw) {
          received.push(JSON.parse(String(raw)));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    return {
      url: `ws://127.0.0.1:${server.port}`,
      received,
      push: (o: unknown) => sock.send(JSON.stringify(o)),
      ready: () => sock !== undefined,
    };
  };

  test("有 onRequest：elicitation/create 收到 handler 的结果", async () => {
    const srv = startServer();
    const t = new WebSocketTransport(srv.url);
    cleanups.push(() => t.close());
    t.onRequest = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: { action: "accept", content: { name: "x" } },
    });
    await waitFor(srv.ready);
    srv.push({ jsonrpc: "2.0", id: "s1", method: "elicitation/create", params: {} });
    await waitFor(() => srv.received.length > 0);
    expect(srv.received[0]).toEqual({
      jsonrpc: "2.0",
      id: "s1",
      result: { action: "accept", content: { name: "x" } },
    });
  });

  test("无 onRequest：回 -32601", async () => {
    const srv = startServer();
    const t = new WebSocketTransport(srv.url);
    cleanups.push(() => t.close());
    await waitFor(srv.ready);
    srv.push({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    await waitFor(() => srv.received.length > 0);
    expect(srv.received[0].id).toBe(7);
    expect(srv.received[0].error?.code).toBe(-32601);
  });

  test("onRequest 抛错：回 -32603", async () => {
    const srv = startServer();
    const t = new WebSocketTransport(srv.url);
    cleanups.push(() => t.close());
    t.onRequest = async () => {
      throw new Error("boom");
    };
    await waitFor(srv.ready);
    srv.push({ jsonrpc: "2.0", id: 8, method: "elicitation/create" });
    await waitFor(() => srv.received.length > 0);
    expect(srv.received[0].error?.code).toBe(-32603);
  });
});

// ─── D11 ───
// 变异自证：把 HTTPTransport.close() 改回空实现 → 两条都变红。

describe("D11 HTTPTransport close() 语义", () => {
  test("close 之后 send 立即 reject，且不发出请求", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        hits++;
        const m = await req.json();
        return Response.json({ jsonrpc: "2.0", id: m.id, result: {} });
      },
    });
    cleanups.push(() => server.stop(true));
    const t = new HTTPTransport(`http://127.0.0.1:${server.port}/`);
    await t.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(hits).toBe(1);
    t.close();
    await expect(t.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow("传输已关闭");
    expect(hits).toBe(1);
  });

  test("close 中止在途请求", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await sleep(3000);
        return Response.json({});
      },
    });
    cleanups.push(() => server.stop(true));
    const t = new HTTPTransport(`http://127.0.0.1:${server.port}/`, undefined, 10000);
    const p = t.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await sleep(50);
    const started = Date.now();
    t.close();
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ─── D12 ───
// 变异自证：删掉 handleIncoming 末尾的 dispatchServerRequest 分支 → 前两条超时变红；
// 把 sendNotification 改回直接调 peer.onNotification → 第三条变红。

describe("D12 进程内传输的请求路由与通知路由", () => {
  test("对端有 onRequest：请求收到应答", async () => {
    const [a, b] = createLinkedTransportPair();
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    b.onRequest = async (req) => ({ jsonrpc: "2.0", id: req.id, result: { echo: req.method } });
    const resp = await a.send({ jsonrpc: "2.0", id: 1, method: "elicitation/create" });
    expect(resp.result).toEqual({ echo: "elicitation/create" });
  });

  test("对端无 onRequest：回 -32601", async () => {
    const [a, b] = createLinkedTransportPair();
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const resp = await a.send({ jsonrpc: "2.0", id: 2, method: "roots/list" });
    expect(resp.error?.code).toBe(-32601);
  });

  test("sendNotification 经对端 handleIncoming 路由", async () => {
    const [a, b] = createLinkedTransportPair();
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const routed: unknown[] = [];
    const orig = (b as any).handleIncoming.bind(b);
    (b as any).handleIncoming = (msg: unknown) => {
      routed.push(msg);
      orig(msg);
    };
    const got: unknown[] = [];
    b.onNotification = (n) => got.push(n);
    a.sendNotification?.({ jsonrpc: "2.0", method: "notifications/x" });
    await sleep(10);
    expect(routed.length).toBe(1);
    expect(got).toEqual([{ jsonrpc: "2.0", method: "notifications/x" }]);
  });
});
