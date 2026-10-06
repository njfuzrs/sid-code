/**
 * MCP 连接生命周期与工具调用语义回归（批次 2：D3 / D4 / D14 / D15 / D16 / D24 / D25 / D27 / D29 / D30）
 *
 * 断言跑在生产路径上：D4 / D14 走真实 stdio / HTTP 连接，D24 / D25 走 manager 的重连循环本身，
 * D29 / D30 是「接线顺序 / 单一事实源」类缺陷，只能对源码结构下断言。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MCPManager, pMap } from "@sid-code/core/mcp/manager.ts";
import { MCPClient } from "@sid-code/core/mcp/client.ts";
import {
  McpTransportError,
  parseRetryAfterHeader,
  type Transport,
} from "@sid-code/core/mcp/transport.ts";
import { mergeMcpConfigs, getMcpServerSignature } from "@sid-code/core/mcp/config.ts";
import { expandConfigEnvVars } from "@sid-code/core/mcp/env-expansion.ts";
import { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "@sid-code/core/mcp/types.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig, type MCPServerConfig } from "@sid-code/core/config/config.ts";

const ENV_KEYS = ["SID_MCP_T_URL", "SID_MCP_T_TOKEN", "SID_CODE_MCP_TOOL_TIMEOUT"];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** stdio mock server：tools/call name=hang 永不回应，其它回 echo */
function writeStdioServer(dir: string, annotations: Record<string, boolean> = {}): string {
  const script = `
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\\n"); buf = lines.pop() || "";
  for (const l of lines) {
    let m; try { m = JSON.parse(l.trim()); } catch { continue; }
    if (!("id" in m)) continue;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
      { name: "hang", inputSchema: { type: "object" }, annotations: ${JSON.stringify(annotations)} },
      { name: "env", inputSchema: { type: "object" } },
    ] } });
    else if (m.method === "tools/call" && m.params.name === "hang") { /* 不回应 */ }
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(process.env.SID_MCP_CHILD_TOKEN) }] } });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nf" } });
  }
});
`;
  const f = join(dir, "srv.mjs");
  writeFileSync(f, script);
  return f;
}

/** mock Transport：按顺序抛出 / 返回，记录发送次数 */
function scriptedTransport(
  script: Array<JsonRpcResponse | Error>,
): Transport & { sent: JsonRpcRequest[] } {
  const sent: JsonRpcRequest[] = [];
  let i = 0;
  return {
    sent,
    send: async (req) => {
      sent.push(req);
      const r = script[Math.min(i++, script.length - 1)];
      if (r instanceof Error) throw r;
      return { ...r, id: req.id };
    },
    sendNotification: () => {},
    close: () => {},
  };
}

const INIT_OK: JsonRpcResponse = {
  jsonrpc: "2.0",
  id: 0,
  result: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    serverInfo: { name: "s", version: "0" },
  },
};
const CALL_OK: JsonRpcResponse = { jsonrpc: "2.0", id: 0, result: { content: [] } };

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── D3 ───

describe("D3：签名去重比真值，且带 transport 维度", () => {
  test("同一 URL 用 ${VAR} 与字面值两种写法 → 只保留一个", () => {
    process.env.SID_MCP_T_URL = "https://mcp.example.com/sse";
    const merged = mergeMcpConfigs([
      { scope: "user", servers: { a: { transport: "sse", url: "${SID_MCP_T_URL}" } } },
      {
        scope: "project",
        servers: { b: { transport: "sse", url: "https://mcp.example.com/sse" } },
      },
    ]);
    expect(Object.keys(merged)).toEqual(["a"]);
  });

  test("http 与 sse 指向同一 URL 不是重复（协议语义不同）", () => {
    const merged = mergeMcpConfigs([
      { scope: "user", servers: { a: { transport: "http", url: "https://x.example/mcp" } } },
      { scope: "project", servers: { b: { transport: "sse", url: "https://x.example/mcp" } } },
    ]);
    expect(Object.keys(merged).sort()).toEqual(["a", "b"]);
    expect(getMcpServerSignature({ transport: "http", url: "u" })).not.toBe(
      getMcpServerSignature({ transport: "sse", url: "u" }),
    );
  });
});

// ─── D4 ───

describe("D4：headers / env 接上变量展开", () => {
  test("expandConfigEnvVars 展开 headers 与 env，且不改原配置", () => {
    process.env.SID_MCP_T_TOKEN = "tok-123";
    const raw: MCPServerConfig = {
      transport: "http",
      url: "https://x",
      headers: { Authorization: "Bearer ${SID_MCP_T_TOKEN}" },
      env: { API_KEY: "${SID_MCP_T_TOKEN}" },
    };
    const { config, missing } = expandConfigEnvVars(raw);
    expect(config.headers!.Authorization).toBe("Bearer tok-123");
    expect(config.env!.API_KEY).toBe("tok-123");
    expect(missing).toEqual([]);
    expect(raw.headers!.Authorization).toBe("Bearer ${SID_MCP_T_TOKEN}");
  });

  test("HTTP 建连时 headers 里的 ${TOKEN} 被展开后发出", async () => {
    process.env.SID_MCP_T_TOKEN = "tok-http";
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        const msg = (await req.json()) as any;
        if (!("id" in msg)) return new Response(null, { status: 202 });
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "h", version: "0" },
              }
            : msg.method === "tools/list"
              ? { tools: [{ name: "t", inputSchema: { type: "object" } }] }
              : {};
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      },
    });
    const mgr = new MCPManager();
    try {
      const tools = await mgr.addServer("h", {
        transport: "http-json",
        url: `http://localhost:${server.port}/`,
        headers: { Authorization: "Bearer ${SID_MCP_T_TOKEN}" },
      });
      expect(tools.length).toBe(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === "Bearer tok-http")).toBe(true);
    } finally {
      mgr.closeAll();
      server.stop(true);
    }
  });

  test("stdio env 里的 ${VAR} 被展开后传给子进程", async () => {
    process.env.SID_MCP_T_TOKEN = "tok-child";
    const dir = mkdtempSync(join(tmpdir(), "sid-mcp-b2-"));
    const mgr = new MCPManager();
    try {
      const tools = await mgr.addServer("e", {
        transport: "stdio",
        command: process.execPath,
        args: [writeStdioServer(dir)],
        env: { SID_MCP_CHILD_TOKEN: "${SID_MCP_T_TOKEN}" },
      });
      const envTool = tools.find((t) => t.name().endsWith("__env"))!;
      const r = await envTool.execute({});
      expect(r.output).toBe("tok-child");
    } finally {
      mgr.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── D14 ───

describe("D14：getMcpToolTimeout 接到工具调用路径（外层总超时）", () => {
  test("SID_CODE_MCP_TOOL_TIMEOUT 生效：挂死的工具在上限内返回错误", async () => {
    process.env.SID_CODE_MCP_TOOL_TIMEOUT = "300";
    const dir = mkdtempSync(join(tmpdir(), "sid-mcp-b2-"));
    const mgr = new MCPManager();
    try {
      const tools = await mgr.addServer("t", {
        transport: "stdio",
        command: process.execPath,
        args: [writeStdioServer(dir)],
      });
      const hang = tools.find((t) => t.name().endsWith("__hang"))!;
      const start = Date.now();
      const r = await hang.execute({});
      expect(Date.now() - start).toBeLessThan(3000);
      expect(r.isError).toBe(true);
      expect(r.output).toContain("工具调用超时 (300ms)");
    } finally {
      mgr.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("生产代码里 getMcpToolTimeout 有调用方", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/mcp/manager.ts"), "utf8");
    expect(src).toMatch(/getMcpToolTimeout\(\)/);
  });
});

// ─── D15 ───

describe("D15：tools/call 只在确定未送达或工具幂等时重试", () => {
  test("超时（可能已执行）→ 非幂等工具恰好发送 1 次", async () => {
    const t = scriptedTransport([INIT_OK, new Error("MCP 请求超时: tools/call")]);
    const client = new MCPClient(t, { retries: 2 });
    await client.initialize();
    await expect(client.callTool("create_issue", {})).rejects.toThrow("超时");
    expect(t.sent.filter((r) => r.method === "tools/call").length).toBe(1);
  });

  test("确定未送达（429）→ 非幂等工具也允许重发", async () => {
    const t = scriptedTransport([
      INIT_OK,
      new McpTransportError("MCP HTTP 错误: 429", { notDelivered: true, status: 429 }),
      CALL_OK,
    ]);
    const client = new MCPClient(t, { retries: 1 });
    await client.initialize();
    await client.callTool("create_issue", {});
    expect(t.sent.filter((r) => r.method === "tools/call").length).toBe(2);
  });

  test("idempotent 声明 → 超时后重试", async () => {
    const t = scriptedTransport([INIT_OK, new Error("MCP 请求超时: tools/call"), CALL_OK]);
    const client = new MCPClient(t, { retries: 1 });
    await client.initialize();
    await client.callTool("get_thing", {}, undefined, { idempotent: true });
    expect(t.sent.filter((r) => r.method === "tools/call").length).toBe(2);
  });

  test("传输已关闭 → 不白等退避，直接失败", async () => {
    const t = scriptedTransport([
      INIT_OK,
      new McpTransportError("传输已关闭", { notDelivered: true, terminal: true }),
    ]);
    const client = new MCPClient(t, { retries: 2 });
    await client.initialize();
    const start = Date.now();
    await expect(client.callTool("x", {}, undefined, { idempotent: true })).rejects.toThrow(
      "传输已关闭",
    );
    expect(Date.now() - start).toBeLessThan(500);
    expect(t.sent.filter((r) => r.method === "tools/call").length).toBe(1);
  });
});

// ─── D16 ───

describe("D16：destructive / idempotent / openWorld 三个 hint 有消费者", () => {
  test("adapter 透出三个 hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-mcp-b2-"));
    const mgr = new MCPManager();
    try {
      const tools = await mgr.addServer("d", {
        transport: "stdio",
        command: process.execPath,
        args: [
          writeStdioServer(dir, {
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          }),
        ],
      });
      const hang = tools.find((t) => t.name().endsWith("__hang"))! as any;
      const plain = tools.find((t) => t.name().endsWith("__env"))! as any;
      expect(hang.isDestructive()).toBe(true);
      expect(hang.isIdempotent()).toBe(true);
      expect(hang.isOpenWorld()).toBe(true);
      expect(plain.isDestructive()).toBe(false);
      expect(plain.isIdempotent()).toBe(false);
    } finally {
      mgr.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("destructive 工具在 yesMode 下不被静默放行；非 destructive 照常自动批准", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), yesMode: true });
    const req = { toolName: "mcp__s__delete_repo", input: {} };
    const destructive = await checker.check(req, {
      isDestructive: () => true,
      isOpenWorld: () => true,
    } as any);
    expect(destructive.allowed).toBe(false);
    expect(destructive.decisionReason?.type).toBe("destructiveTool");

    const plain = await checker.check({ toolName: "mcp__s__list_repos", input: {} }, {
      isDestructive: () => false,
    } as any);
    expect(plain.allowed).toBe(true);
  });

  test("用户显式 allow 规则仍然生效（hint 只收紧默认路径）", async () => {
    const checker = new PermissionChecker(defaultConfig(), { allow: ["mcp__s__delete_repo"] });
    const d = await checker.check({ toolName: "mcp__s__delete_repo", input: {} }, {
      isDestructive: () => true,
    } as any);
    expect(d.allowed).toBe(true);
  });
});

// ─── D24 / D25 ───

/** 把一个 server 摆成「已连接」状态，并把 connect 换成可控实现，直接驱动重连循环 */
function primeConnected(mgr: MCPManager, name: string, config: MCPServerConfig) {
  const m = mgr as any;
  m.serverConfigs.set(name, config);
  m.setStatus(name, MCPConnectionStatus.CONNECTED);
}

describe("D24：重连路径有连接总超时", () => {
  test("挂死的 connect 不会冻结重连链：超时后进入下一次尝试，最终 FAILED", async () => {
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    mgr.halfOpenProbeIntervalMs = 60_000;
    let attempts = 0;
    (mgr as any).connect = (_n: string, _c: MCPServerConfig, signal?: AbortSignal) => {
      attempts++;
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    };
    const config: MCPServerConfig = {
      transport: "sse",
      url: "http://127.0.0.1:1/sse",
      timeout: 50,
    };
    primeConnected(mgr, "r", config);
    const p = (mgr as any).handleDisconnect("r");
    await waitFor(
      () => mgr.getStatus().find((s) => s.name === "r")?.status === MCPConnectionStatus.FAILED,
      8000,
    );
    await p;
    expect(attempts).toBe(5);
    mgr.closeAll();
  });
});

describe("D25：断线期间旧工具从 registry 摘掉，重连成功再注册", () => {
  test("进入 RECONNECTING 时先 onToolsRefresh(name, [])", async () => {
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    const refreshes: Array<{ name: string; n: number; status: string | undefined }> = [];
    mgr.onToolsRefresh = (name, tools) =>
      refreshes.push({
        name,
        n: tools.length,
        status: mgr.getStatus().find((s) => s.name === name)?.status,
      });
    const fakeTool = { name: () => "mcp__r__t" } as any;
    (mgr as any).connect = async () => [fakeTool];
    primeConnected(mgr, "r", { transport: "sse", url: "http://127.0.0.1:1/sse" });
    await (mgr as any).handleDisconnect("r");
    expect(refreshes[0]).toEqual({ name: "r", n: 0, status: MCPConnectionStatus.CONNECTED });
    expect(refreshes.at(-1)!.n).toBe(1);
    expect(mgr.getStatus().find((s) => s.name === "r")?.status).toBe(MCPConnectionStatus.CONNECTED);
    mgr.closeAll();
  });

  test("stdio 断线直接 FAILED 时工具同样被摘掉", async () => {
    const mgr = new MCPManager();
    const refreshes: number[] = [];
    mgr.onToolsRefresh = (_n, tools) => refreshes.push(tools.length);
    primeConnected(mgr, "s", { transport: "stdio", command: "x" });
    await (mgr as any).handleDisconnect("s");
    expect(refreshes).toEqual([0]);
    mgr.closeAll();
  });
});

// ─── D27 ───

describe("D27：退避有上限、尊重 Retry-After；pMap 单点失败不吞整批", () => {
  test("第 10 次重连退避不超过 30s 上限（抖动 +15%）", () => {
    const mgr = new MCPManager();
    for (let i = 0; i < 20; i++)
      expect(mgr.reconnectDelayMs(10)).toBeLessThanOrEqual(30_000 * 1.15);
    expect(mgr.reconnectDelayMs(5)).toBeLessThanOrEqual(30_000 * 1.15);
  });

  test("Retry-After 优先于更短的退避", () => {
    const mgr = new MCPManager();
    expect(mgr.reconnectDelayMs(1, 20_000)).toBeGreaterThanOrEqual(20_000);
  });

  test("parseRetryAfterHeader：秒数 / HTTP-date / 异常值", () => {
    expect(parseRetryAfterHeader("120")).toBe(120_000);
    const now = Date.parse("2026-10-06T00:00:00Z");
    expect(parseRetryAfterHeader("Tue, 06 Oct 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterHeader("99999")).toBeUndefined();
    expect(parseRetryAfterHeader("soon")).toBeUndefined();
    expect(parseRetryAfterHeader(null)).toBeUndefined();
  });

  test("client 重试等待不短于 429 的 Retry-After", async () => {
    const t = scriptedTransport([
      INIT_OK,
      new McpTransportError("429", { notDelivered: true, status: 429, retryAfterMs: 1500 }),
      CALL_OK,
    ]);
    const client = new MCPClient(t, { retries: 1 });
    await client.initialize();
    const start = Date.now();
    await client.callTool("x", {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
  });

  test("pMap：一项抛错不影响同批其他项", async () => {
    const out = await pMap(
      [1, 2, 3, 4, 5],
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n * 10;
      },
      2,
      () => -1,
    );
    expect(out).toEqual([10, -1, 30, 40, 50]);
  });
});

// ─── D29 / D30：接线类缺陷，对源码结构下断言 ───

describe("D29：instructions 截断上限只剩一个事实源", () => {
  test("loop.ts 不再有第二道 instructions 截断", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf8");
    expect(src).not.toContain("MAX_MCP_INSTRUCTION_BLOCK_LENGTH");
  });
});

describe("D30：onPromptsChanged 在 connectAll 之前挂上", () => {
  test("cli.ts 里赋值点先于 connectAll 调用点", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/cli.ts"), "utf8");
    const assign = src.indexOf("mcpManager.onPromptsChanged =");
    const connect = src.indexOf(".connectAll(allMcpServers)");
    expect(assign).toBeGreaterThan(0);
    expect(connect).toBeGreaterThan(0);
    expect(assign).toBeLessThan(connect);
  });
});
