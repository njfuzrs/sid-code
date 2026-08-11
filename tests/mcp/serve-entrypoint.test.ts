/**
 * entrypoints/mcp-serve.ts 测试（G5：sid-code 作为 MCP server）
 *
 * 验证请求处理器的协议正确性与安全默认：
 *   - initialize 返回正确 serverInfo/capabilities/protocolVersion。
 *   - tools/list 默认只暴露只读工具；--allow-write 才含写/执行类。
 *   - tools/call 调只读工具（ls）能拿到结果。
 *   - tools/call 写类工具（write）在默认模式下被拒（工具不存在于 map）。
 *   - initialize 之前的非 initialize 请求 → -32600。
 */

import { describe, test, expect } from "bun:test";
import { createMcpServeHandler } from "@sid-code/cli/entrypoints/mcp-serve.ts";
import { CLIENT_PROTOCOL_VERSION } from "@sid-code/core/mcp/client.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";
import type { JsonRpcRequest } from "@sid-code/core/mcp/types.ts";

let idSeq = 1;
function req(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: idSeq++, method, params };
}

describe("createMcpServeHandler — 默认只读模式", () => {
  test("initialize 返回正确 serverInfo/capabilities/protocolVersion", async () => {
    const { handler } = await createMcpServeHandler(false);
    const resp = await handler(req("initialize"));
    expect(resp.error).toBeUndefined();
    const r = resp.result as any;
    expect(r.protocolVersion).toBe(CLIENT_PROTOCOL_VERSION);
    expect(r.serverInfo.name).toBe("sid-code");
    expect(r.serverInfo.version).toBe(getRawVersion());
    expect(r.capabilities.tools).toBeDefined();
  });

  test("tools/list 只暴露只读工具（不含 bash/edit/write）", async () => {
    const { handler } = await createMcpServeHandler(false);
    await handler(req("initialize"));
    const resp = await handler(req("tools/list"));
    const names = (resp.result as any).tools.map((t: any) => t.name);
    // 只读工具在
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("ls");
    // 写/执行类不在
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    // 每个工具都标 readOnlyHint
    for (const t of (resp.result as any).tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.inputSchema).toBeDefined();
    }
  });

  test("tools/call 调只读工具 ls 拿到结果", async () => {
    const { handler } = await createMcpServeHandler(false);
    await handler(req("initialize"));
    const resp = await handler(
      req("tools/call", { name: "ls", arguments: { dir_path: process.cwd() } }),
    );
    const r = resp.result as any;
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.content)).toBe(true);
    expect(r.content[0].type).toBe("text");
    expect(typeof r.content[0].text).toBe("string");
  });

  test("tools/call 写类工具在默认模式被拒（未暴露）", async () => {
    const { handler } = await createMcpServeHandler(false);
    await handler(req("initialize"));
    const resp = await handler(
      req("tools/call", { name: "write", arguments: { file_path: "/tmp/x", content: "y" } }),
    );
    // 未暴露 → -32602
    expect(resp.error?.code).toBe(-32602);
  });

  test("tools/call 缺 name → -32602", async () => {
    const { handler } = await createMcpServeHandler(false);
    await handler(req("initialize"));
    const resp = await handler(req("tools/call", { arguments: {} }));
    expect(resp.error?.code).toBe(-32602);
  });

  test("initialize 之前的非 initialize 请求 → -32600", async () => {
    const { handler } = await createMcpServeHandler(false);
    const resp = await handler(req("tools/list"));
    expect(resp.error?.code).toBe(-32600);
  });

  test("未知方法 → -32601", async () => {
    const { handler } = await createMcpServeHandler(false);
    await handler(req("initialize"));
    const resp = await handler(req("nonsense/method"));
    expect(resp.error?.code).toBe(-32601);
  });
});

describe("createMcpServeHandler — --allow-write 模式", () => {
  test("tools/list 含写/执行类工具", async () => {
    const { handler } = await createMcpServeHandler(true);
    await handler(req("initialize"));
    const resp = await handler(req("tools/list"));
    const names = (resp.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("edit");
    expect(names).toContain("write");
    // 只读工具仍在
    expect(names).toContain("read");
  });

  test("写类工具的 readOnlyHint 为 false", async () => {
    const { handler } = await createMcpServeHandler(true);
    await handler(req("initialize"));
    const resp = await handler(req("tools/list"));
    const bash = (resp.result as any).tools.find((t: any) => t.name === "bash");
    expect(bash).toBeDefined();
    expect(bash.annotations?.readOnlyHint).toBe(false);
  });
});
