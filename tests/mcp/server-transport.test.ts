/**
 * mcp/server-transport.ts 测试（G5：sid-code 作为 MCP server 的服务端 stdio 传输）
 *
 * 用内存流模拟 stdin/stdout，验证 JSON-RPC 往返：
 *   - 含 id 的请求 → 走 onRequest → 响应写回 stdout（含 id 匹配）。
 *   - 无 id 的通知 → 走 onNotification，不写响应。
 *   - onRequest 抛错 → 回 -32603 内部错误。
 *   - 非 JSON 行 → 忽略，不崩溃。
 *   - 多条消息一次性到达（粘包）→ 按行正确切分。
 */

import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { StdioServerTransport } from "../../src/mcp/server-transport.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "../../src/mcp/types.ts";
import type { JsonRpcNotification } from "../../src/mcp/transport.ts";

/** 内存 stdin：EventEmitter + resume no-op。 */
function makeStdin(): NodeJS.ReadStream & { push: (s: string) => void; end: () => void } {
  const emitter: any = new EventEmitter();
  emitter.resume = () => {};
  emitter.push = (s: string) => emitter.emit("data", s);
  emitter.end = () => emitter.emit("end");
  return emitter;
}

/** 内存 stdout：收集写入的行。 */
function makeStdout(): NodeJS.WriteStream & { lines: () => JsonRpcResponse[] } {
  const chunks: string[] = [];
  const out: any = {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
  };
  return out;
}

describe("StdioServerTransport", () => {
  test("含 id 请求 → onRequest → 响应写回 stdout（id 匹配）", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    let received: JsonRpcRequest | null = null;

    const transport = new StdioServerTransport(
      {
        onRequest: async (req) => {
          received = req;
          return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
        },
      },
      { stdin, stdout },
    );

    const done = transport.start();
    stdin.push(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n");
    // 等微任务队列 flush 异步 onRequest → write
    await new Promise((r) => setTimeout(r, 10));
    stdin.end();
    await done;

    expect(received).not.toBeNull();
    expect(received!.method).toBe("tools/list");
    const lines = stdout.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(7);
    expect((lines[0].result as any).ok).toBe(true);
  });

  test("无 id 通知 → onNotification，不写响应", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    let note: JsonRpcNotification | null = null;

    const transport = new StdioServerTransport(
      {
        onRequest: async (req) => ({ jsonrpc: "2.0", id: req.id, result: {} }),
        onNotification: (n) => {
          note = n;
        },
      },
      { stdin, stdout },
    );

    const done = transport.start();
    stdin.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    stdin.end();
    await done;

    expect(note).not.toBeNull();
    expect(note!.method).toBe("notifications/initialized");
    expect(stdout.lines()).toHaveLength(0);
  });

  test("onRequest 抛错 → 回 -32603 内部错误", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    const transport = new StdioServerTransport(
      {
        onRequest: async () => {
          throw new Error("boom");
        },
      },
      { stdin, stdout },
    );

    const done = transport.start();
    stdin.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    stdin.end();
    await done;

    const lines = stdout.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].error?.code).toBe(-32603);
    expect(lines[0].error?.message).toContain("boom");
  });

  test("非 JSON 行忽略，不崩溃；后续合法消息仍处理", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    const transport = new StdioServerTransport(
      {
        onRequest: async (req) => ({ jsonrpc: "2.0", id: req.id, result: { pong: true } }),
      },
      { stdin, stdout },
    );

    const done = transport.start();
    stdin.push("这不是 JSON\n");
    stdin.push(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    stdin.end();
    await done;

    const lines = stdout.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(2);
  });

  test("粘包：多条消息一次性到达按行切分", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    const transport = new StdioServerTransport(
      {
        onRequest: async (req) => ({ jsonrpc: "2.0", id: req.id, result: {} }),
      },
      { stdin, stdout },
    );

    const done = transport.start();
    const msg1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const msg2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    stdin.push(msg1 + "\n" + msg2 + "\n");
    await new Promise((r) => setTimeout(r, 10));
    stdin.end();
    await done;

    const lines = stdout.lines();
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2]);
  });
});
