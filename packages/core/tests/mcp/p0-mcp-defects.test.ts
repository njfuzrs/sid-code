/**
 * MCP 接入层 P0 缺陷回归（D1 / D2 / D5 / D13 / D23）
 *
 * 每条断言都跑在「真实在用的那条路径」上，而不是旁边那个正确的实现：
 * - D1：断线必须真的让 manager 状态流转，只断言 onClose !== undefined 测不到 manager 侧
 * - D5：形态矩阵跑在 SSETransport 上，不是 parseSSEStream 上
 * - D13：逐路径断言 denylist 命中的 server 不产生连接
 * - D23：断言「最终恢复到 CONNECTED」，而不是「进入了重连」
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { MCPClient } from "@sid-code/core/mcp/client.ts";
import { SSETransport, StreamableHTTPTransport } from "@sid-code/core/mcp/transport.ts";
import { isMcpServerAllowed } from "@sid-code/core/mcp/policy.ts";
import { mergeMcpConfigs } from "@sid-code/core/mcp/config.ts";
import { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

/** 最小 stdio MCP server：tools/call name=die 时进程直接退出（模拟子进程崩溃） */
function writeStdioServer(dir: string): string {
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
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "die", inputSchema: { type: "object" } }] } });
    else if (m.method === "tools/call") process.exit(3);
    else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nf" } });
  }
});
`;
  const f = join(dir, "srv.mjs");
  writeFileSync(f, script);
  return f;
}

type SSEFormat = { eol: "\n" | "\r\n"; space: boolean; multiline: boolean };

/**
 * 旧式 SSE MCP server：GET 返回事件流（先发 endpoint），POST 的响应经事件流回推。
 * format 控制事件的线上形态；up=false 时 GET 返回 503、并切断全部现存流。
 */
function startSSEServer(format: SSEFormat = { eol: "\n", space: true, multiline: false }) {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const state = { up: true, gets: 0 };
  const sep = format.space ? ": " : ":";
  const emit = (ctl: ReadableStreamDefaultController<Uint8Array>, event: string, data: string) => {
    const { eol } = format;
    let dataLines: string;
    if (format.multiline && data.startsWith("{")) {
      // 把 JSON 拆成两行 data：按规范应以 \n 重新拼接（JSON 里换行是合法空白）
      const mid = data.indexOf(",");
      dataLines = `data${sep}${data.slice(0, mid + 1)}${eol}data${sep}${data.slice(mid + 1)}${eol}`;
    } else {
      dataLines = `data${sep}${data}${eol}`;
    }
    ctl.enqueue(enc.encode(`event${sep}${event}${eol}${dataLines}${eol}`));
  };
  const handle = (msg: any) => {
    if (!("id" in msg)) return null;
    if (msg.method === "initialize")
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sse", version: "0" },
      };
    if (msg.method === "tools/list")
      return { tools: [{ name: "t", inputSchema: { type: "object" } }] };
    if (msg.method === "ping") return {};
    return undefined;
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/sse") {
        state.gets++;
        if (!state.up) return new Response("down", { status: 503 });
        let me: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(ctl) {
            me = ctl;
            streams.add(ctl);
            emit(ctl, "endpoint", "/msg");
          },
          cancel() {
            streams.delete(me);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (req.method === "POST" && url.pathname === "/msg") {
        const msg = await req.json();
        const result = handle(msg);
        if (result !== null) {
          const resp =
            result === undefined
              ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nf" } }
              : { jsonrpc: "2.0", id: msg.id, result };
          for (const ctl of streams) emit(ctl, "message", JSON.stringify(resp));
        }
        return new Response(null, { status: 202 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/sse`,
    state,
    /** 服务端下线：拒绝新连接并切断现存流 */
    goDown() {
      state.up = false;
      for (const ctl of streams) {
        try {
          ctl.close();
        } catch {}
      }
      streams.clear();
    },
    goUp() {
      state.up = true;
    },
    stop() {
      server.stop(true);
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusOf = (m: MCPManager, name: string) =>
  m.getStatus().find((s) => s.name === name)?.status;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
  cleanups = [];
});

// ─── D1 ───

describe("D1 transport.onClose 接线", () => {
  test("MCPClient 构造后传输层 onClose 已被接上，触发即上报断线", () => {
    const t = new StreamableHTTPTransport("http://127.0.0.1:1/mcp");
    const c = new MCPClient(t, { retries: 0 });
    let fired = 0;
    c.onDisconnected = () => fired++;
    expect(typeof t.onClose).toBe("function");
    t.onClose!();
    expect(fired).toBe(1);
  });

  test("主动 close() 不被当成断线（不会把用户断开变成自动重连）", () => {
    const t = new StreamableHTTPTransport("http://127.0.0.1:1/mcp");
    const c = new MCPClient(t, { retries: 0 });
    let fired = 0;
    c.onDisconnected = () => fired++;
    c.close();
    // 即便某个传输在 close 后仍回调 onClose，也不应上报
    t.onClose?.();
    expect(fired).toBe(0);
  });

  test("stdio 子进程崩溃 → manager 状态流转为 FAILED（不再停在 CONNECTED）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-p0-d1-"));
    const mgr = new MCPManager();
    cleanups.push(
      () => mgr.closeAll(),
      () => rmSync(dir, { recursive: true, force: true }),
    );
    const config: MCPServerConfig = {
      transport: "stdio",
      command: process.execPath,
      args: [writeStdioServer(dir)],
      timeout: 5000,
      retries: 0,
    };
    await mgr.addServer("s", config);
    expect(statusOf(mgr, "s")).toBe(MCPConnectionStatus.CONNECTED);

    await mgr.callServerTool("s", "die", {}).catch(() => {});
    await waitFor(() => statusOf(mgr, "s") === MCPConnectionStatus.FAILED);
    expect(mgr.getStatus().find((s) => s.name === "s")?.error).toBe("子进程退出");
    expect(mgr.isConnected("s")).toBe(false);
  });

  test("SSE 流被服务端切断 → 立即进入重连（不必等 30s 心跳）", async () => {
    const srv = startSSEServer();
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    cleanups.push(
      () => mgr.closeAll(),
      () => srv.stop(),
    );
    await mgr.addServer("r", { transport: "sse", url: srv.url, timeout: 3000, retries: 0 });
    expect(statusOf(mgr, "r")).toBe(MCPConnectionStatus.CONNECTED);
    const getsBefore = srv.state.gets;

    srv.goDown();
    srv.goUp();
    await waitFor(() => srv.state.gets > getsBefore, 2000);
    await waitFor(
      () => statusOf(mgr, "r") === MCPConnectionStatus.CONNECTED && mgr.isConnected("r"),
    );
  });

  test("manager.disconnect 主动断开后不会自动重连", async () => {
    const srv = startSSEServer();
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    cleanups.push(
      () => mgr.closeAll(),
      () => srv.stop(),
    );
    await mgr.addServer("r", { transport: "sse", url: srv.url, timeout: 3000, retries: 0 });
    const getsBefore = srv.state.gets;
    mgr.disconnect("r");
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.state.gets).toBe(getsBefore);
    expect(statusOf(mgr, "r")).toBeUndefined();
  });
});

// ─── D2 ───

describe("D2 策略拿展开后的真值过闸", () => {
  const ENV = "SID_TEST_MCP_P0_EVIL_URL";
  const prev = process.env[ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  test("模板写法与直接写法在 denylist 下结论相同", () => {
    process.env[ENV] = "https://evil.com/mcp";
    const policy = { deniedServers: [{ url: "https://evil.com/*" }] };
    const direct = isMcpServerAllowed(
      "evil",
      { transport: "sse", url: "https://evil.com/mcp" },
      policy,
    );
    const templ = isMcpServerAllowed("evil", { transport: "sse", url: `\${${ENV}}` }, policy);
    expect(direct).toBe(false);
    expect(templ).toBe(direct);
  });

  test("allowlist 下合法站点写成模板不被误拦", () => {
    process.env[ENV] = "https://good.com/mcp";
    const policy = { allowedServers: [{ url: "https://good.com/*" }] };
    expect(isMcpServerAllowed("g", { transport: "sse", url: `\${${ENV}}` }, policy)).toBe(true);
  });

  test("command / args 模板同样按展开值匹配", () => {
    process.env[ENV] = "evil-bin";
    const policy = { deniedServers: [{ command: ["evil-bin", "--x"] }] };
    expect(
      isMcpServerAllowed("c", { transport: "stdio", command: `\${${ENV}}`, args: ["--x"] }, policy),
    ).toBe(false);
  });

  test("mergeMcpConfigs 不再放行模板形态的 denylist 命中项，且不改写原配置", () => {
    process.env[ENV] = "https://evil.com/mcp";
    const cfg: MCPServerConfig = { transport: "sse", url: `\${${ENV}}` };
    const merged = mergeMcpConfigs([{ scope: "project", servers: { evil: cfg } }], {
      deniedServers: [{ url: "https://evil.com/*" }],
    });
    expect(Object.keys(merged)).toEqual([]);
    expect(cfg.url).toBe(`\${${ENV}}`);
  });
});

// ─── D5 ───

describe("D5 SSETransport 使用规范解析器（形态矩阵）", () => {
  const matrix: SSEFormat[] = [];
  for (const eol of ["\n", "\r\n"] as const)
    for (const space of [true, false])
      for (const multiline of [false, true]) matrix.push({ eol, space, multiline });

  for (const fmt of matrix) {
    const label = `${fmt.eol === "\n" ? "LF" : "CRLF"} × ${fmt.space ? "有空格" : "无空格"} × ${fmt.multiline ? "多行data" : "单行data"}`;
    test(label, async () => {
      const srv = startSSEServer(fmt);
      const t = new SSETransport(srv.url, undefined, 2000);
      cleanups.push(
        () => t.close(),
        () => srv.stop(),
      );
      const resp = await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect((resp.result as any)?.serverInfo?.name).toBe("sse");
    });
  }
});

// ─── D13 ───

describe("D13 policy 在 manager 连接入口生效（逐路径）", () => {
  const deny = { deniedServers: [{ name: "blocked" }] };
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-p0-d13-"));
    const mgr = new MCPManager();
    mgr.policy = deny;
    cleanups.push(
      () => mgr.closeAll(),
      () => rmSync(dir, { recursive: true, force: true }),
    );
    const config: MCPServerConfig = {
      transport: "stdio",
      command: process.execPath,
      args: [writeStdioServer(dir)],
      timeout: 5000,
    };
    return { mgr, config };
  };

  test("connectAll（插件 / --mcp-config / strict 模式合并后的最终集合）", async () => {
    const { mgr, config } = mk();
    const tools = await mgr.connectAll({ blocked: config, ok: config });
    expect(mgr.getClient("blocked")).toBeUndefined();
    expect(statusOf(mgr, "blocked")).toBeUndefined();
    expect(mgr.isConnected("ok")).toBe(true);
    expect(tools.every((t) => !t.name().includes("blocked"))).toBe(true);
  });

  test("addServer（IDE 动态注册 / 手动添加）", async () => {
    const { mgr, config } = mk();
    expect(await mgr.addServer("blocked", config)).toEqual([]);
    expect(mgr.getClient("blocked")).toBeUndefined();
  });

  test("connect（重连循环 / half-open 探测的共同入口）", async () => {
    const { mgr, config } = mk();
    await expect(mgr.connect("blocked", config)).rejects.toThrow(/mcpPolicy/);
    expect(mgr.getClient("blocked")).toBeUndefined();
  });

  test("reconnectPluginServers（插件热重载）", async () => {
    const { mgr, config } = mk();
    await mgr.reconnectPluginServers({ blocked: config });
    expect(mgr.getClient("blocked")).toBeUndefined();
  });

  test("cli 启动时把 config.mcpPolicy 注入 manager", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/cli.ts"), "utf8");
    expect(src).toMatch(/mcpManager\.policy\s*=\s*config\.mcpPolicy/);
  });
});

// ─── D23 ───

describe("D23 FAILED 之后可自愈（half-open）", () => {
  test("耗尽重连 → FAILED → 服务恢复后最终回到 CONNECTED；再次断线仍能重连", async () => {
    const srv = startSSEServer();
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    mgr.halfOpenProbeIntervalMs = 50;
    cleanups.push(
      () => mgr.closeAll(),
      () => srv.stop(),
    );
    await mgr.addServer("r", { transport: "sse", url: srv.url, timeout: 2000, retries: 0 });
    expect(statusOf(mgr, "r")).toBe(MCPConnectionStatus.CONNECTED);

    // 第一轮：持续下线直到耗尽 5 次重连
    srv.goDown();
    await waitFor(() => statusOf(mgr, "r") === MCPConnectionStatus.FAILED);

    // 恢复网络 → half-open 探测把它拉回来，计数清零
    srv.goUp();
    await waitFor(
      () => statusOf(mgr, "r") === MCPConnectionStatus.CONNECTED && mgr.isConnected("r"),
    );
    expect(mgr.getStatus().find((s) => s.name === "r")?.reconnectAttempts).toBeUndefined();

    // 第二轮：再耗尽一次，仍能进入重连并最终恢复（计数锁不复存在）
    srv.goDown();
    await waitFor(() => statusOf(mgr, "r") === MCPConnectionStatus.FAILED);
    srv.goUp();
    await waitFor(
      () => statusOf(mgr, "r") === MCPConnectionStatus.CONNECTED && mgr.isConnected("r"),
    );
  }, 20000);

  test("FAILED 期间主动 disconnect 会停止探测", async () => {
    const srv = startSSEServer();
    const mgr = new MCPManager();
    mgr.reconnectBaseDelayMs = 1;
    mgr.halfOpenProbeIntervalMs = 30;
    cleanups.push(
      () => mgr.closeAll(),
      () => srv.stop(),
    );
    await mgr.addServer("r", { transport: "sse", url: srv.url, timeout: 2000, retries: 0 });
    srv.goDown();
    await waitFor(() => statusOf(mgr, "r") === MCPConnectionStatus.FAILED);
    mgr.disconnect("r");
    const gets = srv.state.gets;
    srv.goUp();
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.state.gets).toBe(gets);
    expect(mgr.isConnected("r")).toBe(false);
  });
});
