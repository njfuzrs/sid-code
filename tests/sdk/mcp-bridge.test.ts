/**
 * Phase 3 单测：SDK MCP 工具桥接
 */

import { describe, test, expect } from "bun:test";
import {
  SdkControlClientTransport,
  SdkControlServerTransport,
  createLinkedTransportPair,
  type JSONRPCMessage,
} from "../../src/sdk/mcp-bridge.ts";

describe("SdkControlClientTransport", () => {
  test("send 包装并把响应回投 onmessage", async () => {
    const sent: JSONRPCMessage[] = [];
    const transport = new SdkControlClientTransport("my-server", async (name, msg) => {
      expect(name).toBe("my-server");
      sent.push(msg);
      return { jsonrpc: "2.0", id: msg.id, result: { ok: true } };
    });

    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });

    expect(sent.length).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0].result).toEqual({ ok: true });
  });
});

describe("SdkControlServerTransport", () => {
  test("receiveFromControl 转发给 onmessage；send 回写", async () => {
    const written: JSONRPCMessage[] = [];
    const transport = new SdkControlServerTransport((m) => written.push(m));

    const got: JSONRPCMessage[] = [];
    transport.onmessage = (m) => got.push(m);

    transport.receiveFromControl({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(got.length).toBe(1);
    expect(got[0].method).toBe("ping");

    await transport.send({ jsonrpc: "2.0", id: 1, result: "pong" });
    expect(written.length).toBe(1);
    expect(written[0].result).toBe("pong");
  });
});

describe("createLinkedTransportPair", () => {
  test("a.send → b.onmessage（异步投递）", async () => {
    const [a, b] = createLinkedTransportPair();
    const bReceived: JSONRPCMessage[] = [];
    b.onmessage = (m) => bReceived.push(m);

    await a.send({ jsonrpc: "2.0", id: 1, method: "hello" });
    // queueMicrotask 投递，等一个微任务
    await Promise.resolve();
    expect(bReceived.length).toBe(1);
    expect(bReceived[0].method).toBe("hello");
  });

  test("双向：b.send → a.onmessage", async () => {
    const [a, b] = createLinkedTransportPair();
    const aReceived: JSONRPCMessage[] = [];
    a.onmessage = (m) => aReceived.push(m);

    await b.send({ jsonrpc: "2.0", id: 2, result: "back" });
    await Promise.resolve();
    expect(aReceived.length).toBe(1);
    expect(aReceived[0].result).toBe("back");
  });
});
