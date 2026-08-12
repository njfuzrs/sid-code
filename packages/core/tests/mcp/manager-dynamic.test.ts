/**
 * MCPManager 运行时动态增删单测（Phase 1 IDE 集成基础设施）
 * 覆盖：addServer / removeServer / isConnected / callServerTool / getClient
 *
 * 通过 stdio 传输连接一个最小 echo MCP server（内联脚本）验证真实连接路径。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

/** 写一个最小 MCP server 脚本（JSON-RPC over stdio）：支持 initialize/tools/list/tools/call */
function writeMockServer(dir: string): string {
  const script = `
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    if (!("id" in msg)) continue; // 通知忽略
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0.0.1" },
      }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ]}});
    } else if (msg.method === "tools/call") {
      const text = msg.params?.arguments?.text ?? "";
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + text }] }});
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;
  const file = join(dir, "mock-server.mjs");
  writeFileSync(file, script);
  return file;
}

describe("MCPManager 动态增删", () => {
  let dir: string;
  let mgr: MCPManager;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-dyn-"));
    mgr = new MCPManager();
    const serverScript = writeMockServer(dir);
    const config: MCPServerConfig = {
      transport: "stdio",
      command: process.execPath, // bun
      args: [serverScript],
      timeout: 10000,
    };
    return config;
  };

  afterEach(() => {
    try {
      mgr?.closeAll();
    } catch {}
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("addServer 连接并注册工具，isConnected 为 true", async () => {
    const config = setup();
    const tools = await mgr.addServer("mock", config);
    expect(tools.length).toBe(1);
    expect(tools[0]!.name()).toContain("echo");
    expect(mgr.isConnected("mock")).toBe(true);
    expect(mgr.getClient("mock")).toBeDefined();
  });

  test("callServerTool 直接调用工具返回输出", async () => {
    const config = setup();
    await mgr.addServer("mock", config);
    const result = await mgr.callServerTool("mock", "echo", { text: "hi" });
    expect(result).not.toBeNull();
    expect(result!.output).toBe("echo:hi");
  });

  test("callServerTool 对未连接 server 返回 null", async () => {
    setup();
    const result = await mgr.callServerTool("nonexistent", "echo", {});
    expect(result).toBeNull();
  });

  test("removeServer 后 isConnected 为 false", async () => {
    const config = setup();
    await mgr.addServer("mock", config);
    expect(mgr.isConnected("mock")).toBe(true);

    // 用对象持有而非裸 let：TS 的控制流分析看不进 onToolsRefresh 回调，
    // 只看到「声明为 null 后再没赋值」，于是把下面断言处的类型收窄成 null。
    const refreshed: { tools: number | null } = { tools: null };
    mgr.onToolsRefresh = (_name, tools) => {
      refreshed.tools = tools.length;
    };
    await mgr.removeServer("mock");

    expect(mgr.isConnected("mock")).toBe(false);
    expect(mgr.getClient("mock")).toBeUndefined();
    expect(refreshed.tools).toBe(0); // 通知外部清空工具
  });

  test("addServer 幂等：重复添加同名 server 先清理旧连接", async () => {
    const config = setup();
    await mgr.addServer("mock", config);
    const firstClient = mgr.getClient("mock");
    await mgr.addServer("mock", config);
    const secondClient = mgr.getClient("mock");
    expect(mgr.isConnected("mock")).toBe(true);
    // 重连后是新的 client 实例
    expect(secondClient).not.toBe(firstClient);
  });

  test("addServer 触发 onToolsRefresh 回调", async () => {
    const config = setup();
    let refreshed: { name: string; count: number } | null = null;
    mgr.onToolsRefresh = (name, tools) => {
      refreshed = { name, count: tools.length };
    };
    await mgr.addServer("mock", config);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.name).toBe("mock");
    expect(refreshed!.count).toBe(1);
  });
});
