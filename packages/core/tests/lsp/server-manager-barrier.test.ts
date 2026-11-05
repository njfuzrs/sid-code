/**
 * 屏障接线（server-manager.changeFile）+ 白名单 —— 不依赖真实语言服务器。
 *
 * 为什么需要这一层：e2e（`tests/lsp/e2e/`）要求本机装有 typescript-language-server，
 * CI 没有该依赖 → 整个文件 skip。于是「didChange 挂屏障、didOpen 不挂」「未验证服务器
 * 默认不挂」这些主路径在 CI 上零覆盖，改坏了也只有本机手工跑才看得见。
 * 这里用 fake instance 把接线钉死；真实时序仍由 e2e 验证，两者分工不同。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LSPServerManager } from "@sid-code/core/lsp/server-manager.ts";
import { isBarrierVerifiedServer } from "@sid-code/core/lsp/barrier.ts";

interface FakeInstance {
  name: string;
  config: Record<string, unknown>;
  ensureStarted(): Promise<void>;
  sendNotification(method: string, params: unknown): void;
  sendRequest(method: string, params: unknown, timeout?: number): Promise<unknown>;
}

/** 造一个只记录调用的 manager；servers/extensionRoutes 是私有字段，测试用 as any 注入 */
function setup(opts: { command: string; barrier?: boolean; failRequest?: () => Error }) {
  const manager = new LSPServerManager();
  const calls: Array<{ kind: "notification" | "request"; method: string }> = [];
  const instance: FakeInstance = {
    name: "fake",
    config: {
      name: "fake",
      command: opts.command,
      workspaceFolder: "/tmp",
      extensionToLanguage: { ".ts": "typescript" },
      ...(opts.barrier === undefined ? {} : { barrier: opts.barrier }),
    },
    async ensureStarted() {},
    sendNotification(method) {
      calls.push({ kind: "notification", method });
    },
    async sendRequest(method) {
      calls.push({ kind: "request", method });
      if (opts.failRequest) throw opts.failRequest();
      return {};
    },
  };
  (manager as any).servers.set("fake", instance);
  (manager as any).extensionRoutes.set(".ts", "fake");
  return { manager, calls };
}

const dir = mkdtempSync(join(tmpdir(), "lsp-barrier-wiring-"));
const file = join(dir, "a.ts");
writeFileSync(file, "const a = 1;\n");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const barrierCount = (calls: Array<{ method: string }>) =>
  calls.filter((c) => c.method === "textDocument/documentSymbol").length;

describe("屏障接线：didOpen 不挂、didChange 挂", () => {
  test("首次 didOpen 无屏障（firstOpen=true）；第二次 didChange 挂 documentSymbol", async () => {
    const { manager, calls } = setup({ command: "typescript-language-server" });

    const first = await manager.changeFile(file, "const a = 1;\n");
    expect(first.version).toBe(1);
    expect(first.firstOpen).toBe(true);
    expect(first.barrier).toBeUndefined();
    expect(barrierCount(calls)).toBe(0);
    expect(calls.some((c) => c.method === "textDocument/didOpen")).toBe(true);

    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(second.version).toBe(2);
    expect(second.firstOpen).toBe(false);
    expect(second.barrier).toBeDefined();
    expect(barrierCount(calls)).toBe(1);
    expect(calls.some((c) => c.method === "textDocument/didChange")).toBe(true);
    // 屏障成功（fake 立即响应，flush 窗口照常等）
    expect(await second.barrier!).toBe(true);
  }, 5000);

  test("屏障请求失败 → barrier resolve false（调用方据此判 unverified）", async () => {
    const { manager, calls } = setup({
      command: "typescript-language-server",
      failRequest: () => new Error("LSP 请求超时: textDocument/documentSymbol"),
    });
    await manager.changeFile(file, "const a = 1;\n");
    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(await second.barrier!).toBe(false);
    expect(barrierCount(calls)).toBe(1);
  });

  test("MethodNotFound 一次即禁用，后续编辑不再白发屏障请求", async () => {
    const { manager, calls } = setup({
      command: "typescript-language-server",
      failRequest: () => new Error("LSP error -32601: Method not found"),
    });
    await manager.changeFile(file, "const a = 1;\n");
    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(await second.barrier!).toBe(false);
    expect((manager as any).barrierGate.isDisabled("fake")).toBe(true);

    const third = await manager.changeFile(file, "const a = 3;\n");
    expect(await third.barrier!).toBe(false);
    expect(barrierCount(calls)).toBe(1);
  });
});

describe("屏障白名单：未验证服务器默认不挂，配置可覆盖", () => {
  test("未验证服务器（gopls）默认不挂屏障", async () => {
    const { manager, calls } = setup({ command: "gopls" });
    await manager.changeFile(file, "const a = 1;\n");
    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(second.barrier).toBeUndefined();
    expect(barrierCount(calls)).toBe(0);
  });

  test("lsp.json 显式 barrier:true 可对未验证服务器启用（自担风险）", async () => {
    const { manager, calls } = setup({ command: "gopls", barrier: true });
    await manager.changeFile(file, "const a = 1;\n");
    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(second.barrier).toBeDefined();
    expect(await second.barrier!).toBe(true);
    expect(barrierCount(calls)).toBe(1);
  }, 5000);

  test("lsp.json 显式 barrier:false 可关闭已验证服务器的屏障", async () => {
    const { manager, calls } = setup({ command: "typescript-language-server", barrier: false });
    await manager.changeFile(file, "const a = 1;\n");
    const second = await manager.changeFile(file, "const a = 2;\n");
    expect(second.barrier).toBeUndefined();
    expect(barrierCount(calls)).toBe(0);
  });

  test("白名单按 command basename 匹配（兼容绝对路径）", () => {
    expect(isBarrierVerifiedServer("typescript-language-server")).toBe(true);
    expect(isBarrierVerifiedServer("/opt/homebrew/bin/typescript-language-server")).toBe(true);
    expect(isBarrierVerifiedServer("gopls")).toBe(false);
    expect(isBarrierVerifiedServer("")).toBe(false);
  });
});
