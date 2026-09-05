/**
 * Bridge 传输层 + 消息协议单测（spec 16 §9.4，对应 ws-transport.test）
 *
 * WebSocket 真实连接依赖中继服务器，难以纯单测；此处覆盖可独立测试的表面：
 * - 传输工厂的协议选择与非法协议拒绝
 * - WebSocketBridgeTransport 的初始状态与回调装配（不实际连接）
 * - 消息协议格式化与 Bridge 资格过滤
 */

import { describe, test, expect } from "bun:test";
import { createBridgeTransport } from "@sid-code/core/bridge/transport.ts";
import { WebSocketBridgeTransport } from "@sid-code/core/bridge/ws-transport.ts";
import {
  nextMessageId,
  formatTextMessage,
  formatToolUseMessage,
  formatToolResultMessage,
  formatStatusMessage,
  isEligibleForBridge,
} from "@sid-code/core/bridge/bridge-messaging.ts";

describe("createBridgeTransport", () => {
  test("ws:// 创建 WebSocketBridgeTransport", () => {
    const t = createBridgeTransport("ws://127.0.0.1:8765");
    expect(t).toBeInstanceOf(WebSocketBridgeTransport);
  });

  test("wss:// 创建 WebSocketBridgeTransport", () => {
    const t = createBridgeTransport("wss://example.com/bridge", "token123");
    expect(t).toBeInstanceOf(WebSocketBridgeTransport);
  });

  test("非 ws 协议抛错", () => {
    expect(() => createBridgeTransport("http://x")).toThrow();
    expect(() => createBridgeTransport("sse://x")).toThrow();
  });
});

describe("WebSocketBridgeTransport 初始状态", () => {
  test("未连接时 isConnected=false, 状态标签 disconnected", () => {
    const t = new WebSocketBridgeTransport("ws://127.0.0.1:9999");
    expect(t.isConnected()).toBe(false);
    expect(t.getStateLabel()).toBe("disconnected");
  });

  test("close 在未连接时不抛错", () => {
    const t = new WebSocketBridgeTransport("ws://127.0.0.1:9999");
    expect(() => t.close()).not.toThrow();
  });

  test("回调装配不抛错", () => {
    const t = new WebSocketBridgeTransport("ws://127.0.0.1:9999");
    expect(() => {
      t.setOnData(() => {});
      t.setOnClose(() => {});
      t.setOnConnect(() => {});
    }).not.toThrow();
  });
});

describe("消息协议格式化", () => {
  test("nextMessageId 单调递增且唯一", () => {
    const a = nextMessageId();
    const b = nextMessageId();
    expect(a).not.toBe(b);
    expect(a.startsWith("msg-")).toBe(true);
  });

  test("nextMessageId 支持自定义前缀", () => {
    expect(nextMessageId("perm").startsWith("perm-")).toBe(true);
  });

  test("formatTextMessage 结构正确", () => {
    const m = formatTextMessage("你好");
    expect(m.type).toBe("text");
    expect((m.data as { text: string }).text).toBe("你好");
    expect(typeof m.timestamp).toBe("number");
    expect(m.id).toBeDefined();
  });

  test("formatToolUseMessage 携带 toolName 与 input", () => {
    const m = formatToolUseMessage("bash", { command: "ls" });
    expect(m.type).toBe("tool_use");
    expect((m.data as { toolName: string }).toolName).toBe("bash");
    expect((m.data as { input: unknown }).input).toEqual({ command: "ls" });
  });

  test("formatToolResultMessage 携带 isError 标记", () => {
    const ok = formatToolResultMessage("read", "内容");
    expect(ok.type).toBe("tool_result");
    expect((ok.data as { isError: boolean }).isError).toBe(false);

    const err = formatToolResultMessage("read", "失败", true);
    expect((err.data as { isError: boolean }).isError).toBe(true);
  });

  test("formatStatusMessage 合并 extra", () => {
    const m = formatStatusMessage("error", { message: "boom" });
    expect(m.type).toBe("status");
    expect((m.data as { status: string }).status).toBe("error");
    expect((m.data as { message: string }).message).toBe("boom");
  });
});

describe("isEligibleForBridge", () => {
  // ⚠️ 这组用例原本喂的是 text / text_delta / tool_use / tool_result / turn_complete /
  // error —— **六个全都不是真实的 QueryEngineEvent.kind**（那是 BridgeOutMessage.type
  // 与状态字符串），却全绿。这就是 D13 能漂到完全脱离现实还没人发现的原因之一：
  // 测试和实现说的是同一套不存在的方言，互相自证（与 D4 同型）。
  // 词汇正确性的门禁在 eligibility-single-source.test.ts（从 query/types.ts 抽真值比对）。
  test("用户可见事件通过", () => {
    for (const k of ["stream_text", "tool_start", "tool_end", "done", "system", "fatal_error"]) {
      expect(isEligibleForBridge(k)).toBe(true);
    }
  });

  test("内部事件被过滤", () => {
    for (const k of [
      "compact",
      "context_warning",
      "loop_detected",
      "tombstone",
      "user_message_added",
    ]) {
      expect(isEligibleForBridge(k)).toBe(false);
    }
  });
});
