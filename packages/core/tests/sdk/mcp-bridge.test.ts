/**
 * Phase 3 单测：SDK MCP 工具桥接
 *
 * 覆盖 SDK 缺陷 18（控制传输把 request-response 冒充双向流）与
 * 缺陷 19（同进程传输 close 是空实现）。
 */

import { describe, test, expect } from "bun:test";
import {
  SdkControlClientTransport,
  SdkControlServerTransport,
  createLinkedTransportPair,
  type JSONRPCMessage,
} from "@sid-code/core/sdk/mcp-bridge.ts";

/** 等所有已排队的微任务（queueMicrotask）执行完 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

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

  // 缺陷 18a：notification（有 method 无 id）只等控制层 ack，ack 不是 MCP 入站消息
  test("缺陷18a：notification 不把控制层 ack 投给 onmessage，但仍等待 ack", async () => {
    const sent: JSONRPCMessage[] = [];
    let ackResolve: ((m: JSONRPCMessage) => void) | undefined;
    let acked = false;
    const transport = new SdkControlClientTransport(
      "my-server",
      (name, msg) =>
        new Promise<JSONRPCMessage>((resolve) => {
          expect(name).toBe("my-server");
          sent.push(msg);
          ackResolve = resolve;
        }),
    );

    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    const notification: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    };
    const sendPromise = transport.send(notification).then(() => {
      acked = true;
    });

    // 消息确实被包装发往控制层
    expect(sent.length).toBe(1);
    expect(sent[0].method).toBe("notifications/cancelled");
    // 控制层还没回 ack，send 仍在等待（控制协议要求每个 control_request 有 control_response）
    expect(acked).toBe(false);

    ackResolve?.({ jsonrpc: "2.0", id: "ack-1", result: { ok: true } });
    await sendPromise;

    expect(acked).toBe(true);
    // ack 是控制层回执，不是 MCP 入站消息
    expect(received.length).toBe(0);
  });

  // 缺陷 18a：宿主主动推送（服务端通知）必须能进入 onmessage —— 真实通道是 receiveFromControl
  test("缺陷18a：receiveFromControl 把宿主主动推送的消息投给 onmessage", () => {
    const transport = new SdkControlClientTransport("my-server", async () => ({
      jsonrpc: "2.0",
      id: "ack",
      result: {},
    }));

    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    const push: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    };
    transport.receiveFromControl(push);
    transport.receiveFromControl({ jsonrpc: "2.0", id: 42, result: { done: true } });

    expect(received.length).toBe(2);
    expect(received[0].method).toBe("notifications/tools/list_changed");
    expect(received[1].id).toBe(42);
  });

  // 缺陷 18b：发送失败走 onerror，send 本身 resolve（不从 send 抛出）
  test("缺陷18b：sendMcpMessage reject 时走 onerror 且 send 不抛出", async () => {
    const boom = new Error("control channel broken");
    const transport = new SdkControlClientTransport("my-server", async () => {
      throw boom;
    });

    const errors: Error[] = [];
    const received: JSONRPCMessage[] = [];
    transport.onerror = (e) => errors.push(e);
    transport.onmessage = (m) => received.push(m);

    // 不 reject：用 resolves 断言 + 后续断言即可
    await expect(
      transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).resolves.toBeUndefined();

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe(boom);
    expect(received.length).toBe(0);
  });

  // 缺陷 18：close 后再 send 走 onerror，不投递、也不发往控制层
  test("缺陷18：closed 后 send 走 onerror 且不发送", async () => {
    let calls = 0;
    const transport = new SdkControlClientTransport("my-server", async (_name, msg) => {
      calls++;
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    });

    const errors: Error[] = [];
    const received: JSONRPCMessage[] = [];
    let closedCount = 0;
    transport.onerror = (e) => errors.push(e);
    transport.onmessage = (m) => received.push(m);
    transport.onclose = () => closedCount++;

    await transport.close();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(closedCount).toBe(1);
    expect(calls).toBe(0);
    expect(received.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("closed");
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

  // 缺陷 18：宿主侧回写失败与关闭后 send 同样走 onerror，不从 send 抛出
  test("缺陷18：sendResponse 抛错走 onerror；closed 后不再回写", async () => {
    const transport = new SdkControlServerTransport(() => {
      throw new Error("stdout closed");
    });
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);

    await expect(
      transport.send({ jsonrpc: "2.0", id: 1, result: "pong" }),
    ).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("stdout closed");

    let writes = 0;
    const closedTransport = new SdkControlServerTransport(() => {
      writes++;
    });
    const closedErrors: Error[] = [];
    closedTransport.onerror = (e) => closedErrors.push(e);
    await closedTransport.close();
    await closedTransport.send({ jsonrpc: "2.0", id: 2, result: "late" });

    expect(writes).toBe(0);
    expect(closedErrors.length).toBe(1);
    expect(closedErrors[0].message).toContain("closed");
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

  // 缺陷 19：close 后 send 不再投递给 peer，改走 onerror
  test("缺陷19：close 后 send 不投递到 peer，并走 onerror", async () => {
    const [a, b] = createLinkedTransportPair();
    const bReceived: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    b.onmessage = (m) => bReceived.push(m);
    a.onerror = (e) => errors.push(e);

    await a.close();
    await a.send({ jsonrpc: "2.0", id: 1, method: "hello" });
    await flushMicrotasks();

    expect(bReceived.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("closed");
  });

  // 缺陷 19 第 2 点：消息已入队后 close —— 微任务回调里必须二次检查 closed
  test("缺陷19：send 之后立刻 close，微任务执行时不投递", async () => {
    const [a, b] = createLinkedTransportPair();
    const bReceived: JSONRPCMessage[] = [];
    b.onmessage = (m) => bReceived.push(m);

    // 不 await：send 已把投递排进微任务队列，随后立刻关闭
    void a.send({ jsonrpc: "2.0", id: 1, method: "hello" });
    await a.close();
    await flushMicrotasks();

    expect(bReceived.length).toBe(0);
  });

  // 缺陷 19 第 3 点：close 解开双向 peer 引用；对端仍可用
  test("缺陷19：close 解引用两端 peer，对端不再收到消息", async () => {
    const [a, b] = createLinkedTransportPair();
    const bReceived: JSONRPCMessage[] = [];
    b.onmessage = (m) => bReceived.push(m);

    await a.close();

    // 内部 peer 已解除：通过反射确认没有残留强引用环
    const internals = a as unknown as { peer?: unknown };
    expect(internals.peer).toBeUndefined();
    const peerInternals = b as unknown as { peer?: unknown };
    expect(peerInternals.peer).toBeUndefined();

    // b 自己没关，但 peer 已被解引用，消息不会到达 a
    const aReceived: JSONRPCMessage[] = [];
    a.onmessage = (m) => aReceived.push(m);
    await b.send({ jsonrpc: "2.0", id: 3, method: "still-alive" });
    await flushMicrotasks();

    expect(aReceived.length).toBe(0);
    expect(bReceived.length).toBe(0);
  });
});
