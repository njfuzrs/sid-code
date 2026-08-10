/**
 * MCPClient 测试
 * 测试重试机制、通知处理、initialized 通知格式
 */

import { describe, test, expect } from "bun:test";
import { MCPClient } from "../../src/mcp/client.ts";
import type { Transport, JsonRpcNotification } from "../../src/mcp/transport.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "../../src/mcp/types.ts";

/** 创建 mock Transport */
function createMockTransport(responses: Array<JsonRpcResponse | Error>): Transport & {
  sentRequests: JsonRpcRequest[];
  sentNotifications: JsonRpcNotification[];
} {
  let callIndex = 0;
  const sentRequests: JsonRpcRequest[] = [];
  const sentNotifications: JsonRpcNotification[] = [];

  return {
    sentRequests,
    sentNotifications,
    onNotification: undefined,
    send: async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
      sentRequests.push(request);
      const resp = responses[callIndex++];
      if (!resp) throw new Error("没有更多的 mock 响应");
      if (resp instanceof Error) throw resp;
      return resp;
    },
    sendNotification: (notification: JsonRpcNotification) => {
      sentNotifications.push(notification);
    },
    close: () => {},
  };
}

describe("MCPClient", () => {
  test("initialize 发送正确的协议版本和客户端信息", async () => {
    const transport = createMockTransport([
      // initialize 响应
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "test-server", version: "1.0" },
        },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });
    const result = await client.initialize();

    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("test-server");

    // 验证 initialize 请求
    const initReq = transport.sentRequests[0];
    expect(initReq.method).toBe("initialize");
    expect((initReq.params as any).clientInfo.name).toBe("sid-code");
  });

  test("initialized 通知使用 sendNotification（无 id）", async () => {
    const transport = createMockTransport([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "test", version: "1.0" },
        },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });
    await client.initialize();

    // 应该通过 sendNotification 发送，而不是 send
    expect(transport.sentNotifications.length).toBe(1);
    expect(transport.sentNotifications[0].method).toBe("notifications/initialized");
    expect("id" in transport.sentNotifications[0]).toBe(false);
  });

  test("重试机制：首次失败后重试成功", async () => {
    let callCount = 0;
    const transport: Transport & { sentNotifications: JsonRpcNotification[] } = {
      sentNotifications: [],
      onNotification: undefined,
      send: async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
        callCount++;
        if (callCount === 1) {
          throw new Error("连接超时");
        }
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "test", version: "1.0" },
          },
        };
      },
      sendNotification: (n) => { transport.sentNotifications.push(n); },
      close: () => {},
    };

    const client = new MCPClient(transport, { retries: 2 });
    const result = await client.initialize();

    expect(callCount).toBe(2); // 第一次失败 + 第二次成功
    expect(result.serverInfo.name).toBe("test");
  });

  test("重试机制：超过最大重试次数后抛出错误", async () => {
    const transport = createMockTransport([
      new Error("超时1"),
      new Error("超时2"),
      new Error("超时3"),
    ]);

    const client = new MCPClient(transport, { retries: 2 });

    await expect(client.initialize()).rejects.toThrow("超时3");
  }, 15000); // 指数退避 1s/2s + jitter，最坏约 8s，Bun 默认 5s 不够

  test("listTools 返回工具列表", async () => {
    const transport = createMockTransport([
      // initialize
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "test", version: "1.0" },
        },
      },
      // tools/list
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          tools: [
            { name: "read_file", description: "读取文件", inputSchema: { type: "object" } },
            { name: "write_file", description: "写入文件", inputSchema: { type: "object" } },
          ],
        },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });
    const tools = await client.listTools();

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("read_file");
    expect(tools[1].name).toBe("write_file");
  });

  test("callTool 发送正确的参数", async () => {
    const transport = createMockTransport([
      // initialize
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "test", version: "1.0" },
        },
      },
      // tools/call
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: "文件内容" }],
          isError: false,
        },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });
    const result = await client.callTool("read_file", { path: "/tmp/test.txt" });

    expect(result.content[0].text).toBe("文件内容");
    expect(result.isError).toBe(false);

    // 验证 tools/call 请求参数
    const callReq = transport.sentRequests.find(r => r.method === "tools/call");
    expect(callReq).toBeDefined();
    expect((callReq!.params as any).name).toBe("read_file");
    expect((callReq!.params as any).arguments.path).toBe("/tmp/test.txt");
  });

  test("onToolsChanged 回调在收到通知时触发", async () => {
    const transport = createMockTransport([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "test", version: "1.0" },
        },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });

    let toolsChangedCalled = false;
    client.onToolsChanged = () => {
      toolsChangedCalled = true;
    };

    await client.initialize();

    // 模拟服务器发送 tools/list_changed 通知
    transport.onNotification?.({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });

    expect(toolsChangedCalled).toBe(true);
  });

  test("initialize 错误响应抛出异常", async () => {
    const transport = createMockTransport([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "协议版本不支持" },
      },
    ]);

    const client = new MCPClient(transport, { retries: 0 });
    await expect(client.initialize()).rejects.toThrow("MCP 初始化失败: 协议版本不支持");
  });

  test("默认重试次数为 2", async () => {
    let callCount = 0;
    const transport: Transport = {
      send: async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
        callCount++;
        throw new Error("失败");
      },
      close: () => {},
    };

    const client = new MCPClient(transport); // 不传 options，使用默认值
    await expect(client.initialize()).rejects.toThrow("失败");
    expect(callCount).toBe(3); // 1 次初始 + 2 次重试
  });
});
