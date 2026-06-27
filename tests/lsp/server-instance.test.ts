/**
 * LSP Client + ServerInstance 集成单测
 * 通过最小 mock LSP server（Content-Length 帧协议）验证真实通信路径：
 * 握手 / 请求-响应 / 通知接收 / 懒启动 / 停止
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LSPServerInstance } from "../../src/lsp/server-instance.ts";
import type { LSPServerConfig } from "../../src/lsp/types.ts";

/** 写一个最小 mock LSP server（Content-Length 帧 JSON-RPC） */
function writeMockLSP(dir: string): string {
  const script = `
let buffer = "";
let contentLength = -1;
function send(msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json, "utf-8");
  process.stdout.write("Content-Length: " + len + "\\r\\n\\r\\n" + json);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (true) {
    if (contentLength < 0) {
      const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd === -1) return;
      const m = buffer.slice(0, headerEnd).match(/Content-Length:\\s*(\\d+)/i);
      contentLength = m ? parseInt(m[1], 10) : 0;
      buffer = buffer.slice(headerEnd + 4);
    }
    const bytes = Buffer.from(buffer, "utf-8");
    if (bytes.length < contentLength) return;
    const body = bytes.slice(0, contentLength).toString("utf-8");
    buffer = bytes.slice(contentLength).toString("utf-8");
    contentLength = -1;
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "textDocument/didOpen") {
      // 收到 didOpen 后主动推一条诊断通知
      const uri = msg.params?.textDocument?.uri;
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
        uri, diagnostics: [{ message: "mock diag", severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      }});
    } else if (msg.method === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.params } });
    } else if (msg.method === "askConfig") {
      // 测试 G8：mock server 主动向客户端发 workspace/configuration 请求，
      // 把客户端的响应回传给测试（通过 echoBack 通知）。
      send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "foo" }, { section: "bar" }] } });
    } else if (msg.method === "askUnknown") {
      // 测试 G8：未知的服务器→客户端请求，应收到 MethodNotFound 错误响应。
      send({ jsonrpc: "2.0", id: 9002, method: "some/unknownServerRequest", params: {} });
    } else if (msg.id === 9001) {
      // 收到客户端对 workspace/configuration 的响应，回传给测试
      send({ jsonrpc: "2.0", method: "echoBack", params: { kind: "config", response: msg.result, error: msg.error } });
    } else if (msg.id === 9002) {
      // 收到客户端对未知请求的响应
      send({ jsonrpc: "2.0", method: "echoBack", params: { kind: "unknown", response: msg.result, error: msg.error } });
    }
    // 通知（initialized/exit）无需响应
  }
});
`;
  const file = join(dir, "mock-lsp.mjs");
  writeFileSync(file, script);
  return file;
}

describe("LSPServerInstance", () => {
  let dir: string;
  let inst: LSPServerInstance;

  const makeInstance = (overrides?: Partial<LSPServerConfig>): LSPServerInstance => {
    dir = mkdtempSync(join(tmpdir(), "lsp-test-"));
    const script = writeMockLSP(dir);
    const config: LSPServerConfig = {
      name: "mock",
      command: process.execPath, // bun
      args: [script],
      workspaceFolder: dir,
      extensionToLanguage: { ".ts": "typescript" },
      startupTimeout: 10000,
      ...overrides,
    };
    inst = new LSPServerInstance(config);
    return inst;
  };

  afterEach(async () => {
    try { await inst?.stop(); } catch {}
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("start 完成 LSP 握手，状态变为 running", async () => {
    makeInstance();
    await inst.start();
    expect(inst.state).toBe("running");
  });

  test("ensureStarted 懒启动只启动一次", async () => {
    makeInstance();
    await Promise.all([inst.ensureStarted(), inst.ensureStarted()]);
    expect(inst.state).toBe("running");
  });

  test("sendRequest 收到响应", async () => {
    makeInstance();
    await inst.start();
    const result = await inst.sendRequest<{ echoed: unknown }>("echo", { hello: "world" });
    expect(result.echoed).toEqual({ hello: "world" });
  });

  test("onNotification 接收 publishDiagnostics", async () => {
    makeInstance();
    await inst.start();

    const received: any[] = [];
    inst.onNotification("textDocument/publishDiagnostics", (p) => received.push(p));

    // didOpen 触发 mock server 推送诊断
    inst.sendNotification("textDocument/didOpen", {
      textDocument: { uri: "file:///a.ts", languageId: "typescript", version: 1, text: "x" },
    });

    // 等待通知到达
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].diagnostics[0].message).toBe("mock diag");
  });

  test("stop 后状态变为 stopped", async () => {
    makeInstance();
    await inst.start();
    await inst.stop();
    expect(inst.state).toBe("stopped");
  });

  test("G8：响应服务器的 workspace/configuration 请求（按项数返回等长数组）", async () => {
    makeInstance();
    await inst.start();

    const echoes: any[] = [];
    inst.onNotification("echoBack", (p) => echoes.push(p));

    // 触发 mock server 发起 workspace/configuration 请求
    inst.sendNotification("askConfig", {});
    await new Promise((r) => setTimeout(r, 400));

    const configEcho = echoes.find((e) => e.kind === "config");
    expect(configEcho).toBeDefined();
    expect(configEcho.error).toBeUndefined();
    // 请求 2 个 items，应返回长度 2 的数组
    expect(Array.isArray(configEcho.response)).toBe(true);
    expect(configEcho.response.length).toBe(2);
  });

  test("G8：未知服务器请求返回 MethodNotFound 错误", async () => {
    makeInstance();
    await inst.start();

    const echoes: any[] = [];
    inst.onNotification("echoBack", (p) => echoes.push(p));

    inst.sendNotification("askUnknown", {});
    await new Promise((r) => setTimeout(r, 400));

    const unknownEcho = echoes.find((e) => e.kind === "unknown");
    expect(unknownEcho).toBeDefined();
    expect(unknownEcho.error).toBeDefined();
    expect(unknownEcho.error.code).toBe(-32601); // MethodNotFound
  });

  test("G4：crashCount 与 restartsExhausted 健康字段", async () => {
    makeInstance();
    await inst.start();
    // 正常运行时无崩溃、未耗尽
    expect(inst.crashCount).toBe(0);
    expect(inst.restartsExhausted).toBe(false);
  });
});
