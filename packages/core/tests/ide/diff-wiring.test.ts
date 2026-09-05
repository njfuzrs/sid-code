/**
 * IDE diff 接线回归（D1 —— 整条 diff 功能曾是死代码）
 *
 * ## 为什么这组用例刻意不去断言"函数被调到了"
 *
 * 缺陷清单对 D1 写了一条明确的验收要求：
 *
 * > ⚠️ 验收判据必须是「IDE 里真的弹出了 diff 且用户手改能被拾取」，
 * > 不能是「函数被调到了」—— 因为 `error` 分支是静默的。
 *
 * 真实 IDE 弹窗无法在单测里验（需要装 `anthropic.claude-code` 扩展的环境），
 * 但那条要求的**实质**是可以验的：**用户手改的内容有没有真的落到磁盘上**。
 * 所以下面用一个假的 IDE MCP server 回放 `openDiff` 的响应，
 * 然后去**读真实文件**断言内容 —— 而不是断言某个 mock 被调用了几次。
 *
 * 这也正好覆盖那个"上游死接线掩盖下游协议不兼容"的坑：
 * 假 server 按 **CC 扩展的真实 wire 协议**（snake_case 参数 + 内容块数组响应）
 * 校验入参，参数名错了用例就红 —— 而不是"函数被调到了就算过"。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { EditTool } from "@sid-code/core/tool/edit.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { setIDEDiffRuntime, resetIDEDiffRuntimeForTest } from "@sid-code/core/ide/runtime.ts";
import { negotiateContentViaIDE } from "@sid-code/core/ide/tool-hooks.ts";
import { DIFF_STATUS, IDE_RPC } from "@sid-code/core/ide/protocol.ts";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";

let dir: string;

/** 记录下来的 openDiff 调用（用于校验 wire 协议，不用于"调到了就算过"） */
interface RpcCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 假 IDE MCP server。`respond` 决定 openDiff 回什么 ——
 * 回的是 **CC 扩展的真实形态**：内容块数组的 JSON。
 */
function fakeIDEManager(opts: {
  respond: (args: Record<string, unknown>) => string | null;
  connected?: boolean;
  calls?: RpcCall[];
}): MCPManager {
  return {
    isConnected: (name: string) => (opts.connected ?? true) && name === "ide",
    callServerTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
      opts.calls?.push({ tool, args });
      if (tool !== IDE_RPC.openDiff) return { output: "" };
      const out = opts.respond(args);
      return out === null ? null : { output: out };
    },
  } as unknown as MCPManager;
}

/** CC 扩展的响应形态：内容块数组 */
function ccResponse(status: string, content?: string): string {
  const blocks: Array<{ type: string; text: string }> = [{ type: "text", text: status }];
  if (content !== undefined) blocks.push({ type: "text", text: content });
  return JSON.stringify(blocks);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-diff-wiring-"));
  resetIDEDiffRuntimeForTest();
});

afterEach(() => {
  resetIDEDiffRuntimeForTest();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────── 核心：用户手改能被拾取并真的落盘 ──────────────────

describe("D1 · 用户在 IDE 里手改的内容会落到磁盘", () => {
  test("write：用户改后保存 → 磁盘上是用户的版本，不是模型的", async () => {
    const file = join(dir, "a.ts");
    const calls: RpcCall[] = [];
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({
        calls,
        respond: () => ccResponse(DIFF_STATUS.saved, "// 用户手改的版本\nexport const x = 42;\n"),
      }),
      enabled: true,
    });

    const result = await new WriteTool().execute({
      file_path: file,
      content: "// 模型生成的版本\nexport const x = 1;\n",
    });

    expect(result.isError).toBeFalsy();
    // 这才是真正的验收判据：读磁盘
    const onDisk = readFileSync(file, "utf-8");
    expect(onDisk).toBe("// 用户手改的版本\nexport const x = 42;\n");
    expect(onDisk).not.toContain("模型生成的版本");
    // 也要让模型知道内容被人改过，否则它会以为磁盘上是自己写的那版
    expect(result.output).toContain("采用了你在 IDE 中修改后的内容");

    // wire 协议校验：参数名必须是 CC 扩展的 snake_case（D3）
    const openDiff = calls.find((c) => c.tool === IDE_RPC.openDiff);
    expect(openDiff).toBeDefined();
    expect(Object.keys(openDiff!.args).sort()).toEqual([
      "new_file_contents",
      "new_file_path",
      "old_file_path",
      "tab_name",
    ]);
  });

  test("edit：用户改后保存 → 磁盘上是用户的版本", async () => {
    const file = join(dir, "b.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");

    // edit 要求先读过文件：用不带 tracker 的实例绕过新鲜度校验
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({
        respond: () => ccResponse(DIFF_STATUS.saved, "const a = 1;\nconst b = 999;\n"),
      }),
      enabled: true,
    });

    const result = await new EditTool().execute({
      file_path: file,
      old_string: "const b = 2;",
      new_string: "const b = 3;",
    });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("const a = 1;\nconst b = 999;\n");
  });

  test("用户接受但未手改（响应只有状态块）→ 写模型的版本，不回退成旧内容", async () => {
    const file = join(dir, "c.ts");
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({ respond: () => ccResponse(DIFF_STATUS.saved) }),
      enabled: true,
    });

    await new WriteTool().execute({ file_path: file, content: "新内容\n" });

    // 这条容易写错成"content 缺失就用 oldContent"，那会静默丢掉本次编辑
    expect(readFileSync(file, "utf-8")).toBe("新内容\n");
  });
});

describe("D1 · 用户拒绝时不写盘", () => {
  test("write：DIFF_REJECTED → 文件不被创建，且返回 isError 让模型知道", async () => {
    const file = join(dir, "rejected.ts");
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({ respond: () => ccResponse(DIFF_STATUS.rejected) }),
      enabled: true,
    });

    const result = await new WriteTool().execute({ file_path: file, content: "不该被写入\n" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已取消");
    expect(() => readFileSync(file, "utf-8")).toThrow(); // 文件不存在
  });

  test("edit：DIFF_REJECTED → 磁盘内容保持原样", async () => {
    const file = join(dir, "keep.ts");
    writeFileSync(file, "原样\n");
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({ respond: () => ccResponse(DIFF_STATUS.rejected) }),
      enabled: true,
    });

    const result = await new EditTool().execute({
      file_path: file,
      old_string: "原样",
      new_string: "被改了",
    });

    expect(result.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("原样\n");
  });
});

describe("D1 · 降级路径必须完全不阻断编辑（IDE 是可选增强）", () => {
  test("未注入 runtime（没有 IDE）→ 照原样写", async () => {
    const file = join(dir, "no-ide.ts");
    resetIDEDiffRuntimeForTest();
    await new WriteTool().execute({ file_path: file, content: "照原样\n" });
    expect(readFileSync(file, "utf-8")).toBe("照原样\n");
  });

  test("enabled=false（开关没开）→ 照原样写，且不发任何 RPC", async () => {
    const file = join(dir, "disabled.ts");
    const calls: RpcCall[] = [];
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({ calls, respond: () => ccResponse(DIFF_STATUS.rejected) }),
      enabled: false,
    });

    await new WriteTool().execute({ file_path: file, content: "照原样\n" });

    expect(readFileSync(file, "utf-8")).toBe("照原样\n");
    // 关掉时必须一个 RPC 都不发 —— 否则"默认关"就名不副实
    expect(calls).toEqual([]);
  });

  test("IDE 已断开 → 照原样写", async () => {
    const file = join(dir, "disconnected.ts");
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({
        connected: false,
        respond: () => ccResponse(DIFF_STATUS.rejected),
      }),
      enabled: true,
    });

    await new WriteTool().execute({ file_path: file, content: "照原样\n" });
    expect(readFileSync(file, "utf-8")).toBe("照原样\n");
  });

  test("RPC 抛异常 → 照原样写（预览失败不该有能力阻断编辑）", async () => {
    const file = join(dir, "throws.ts");
    setIDEDiffRuntime({
      mcpManager: {
        isConnected: () => true,
        callServerTool: async () => {
          throw new Error("IDE 炸了");
        },
      } as unknown as MCPManager,
      enabled: true,
    });

    await new WriteTool().execute({ file_path: file, content: "照原样\n" });
    expect(readFileSync(file, "utf-8")).toBe("照原样\n");
  });

  test("响应是未知状态（协议漂移）→ 照原样写，不是丢弃编辑", async () => {
    const file = join(dir, "unknown.ts");
    setIDEDiffRuntime({
      mcpManager: fakeIDEManager({ respond: () => ccResponse("SOMETHING_NEW") }),
      enabled: true,
    });

    await new WriteTool().execute({ file_path: file, content: "照原样\n" });
    expect(readFileSync(file, "utf-8")).toBe("照原样\n");
  });

  test("关闭标签页（TAB_CLOSED）视为未表态 → 照原样写，不当作拒绝", async () => {
    // 把"关掉预览窗"当成拒绝会让编辑莫名消失，那是最容易被误判的一条
    const r = await (async () => {
      setIDEDiffRuntime({
        mcpManager: fakeIDEManager({ respond: () => ccResponse(DIFF_STATUS.tabClosed) }),
        enabled: true,
      });
      return negotiateContentViaIDE("/tmp/x.ts", "旧", "新");
    })();

    expect(r.proceed).toBe(true);
    expect(r.proceed && r.content).toBe("新");
  });
});

describe("D1 · 死接线门禁：编辑工具必须真的 import 这条链", () => {
  test("edit.ts / write.ts 里存在 negotiateContentViaIDE 的真实调用", () => {
    // D1 的实证命令曾是 `grep -rn "tool-hooks" packages` → 0 命中。
    // 这条断言就是那条命令的固化版（剥注释后再查，避免注释骗过门禁）。
    for (const f of ["packages/core/src/tool/edit.ts", "packages/core/src/tool/write.ts"]) {
      const raw = readFileSync(join(import.meta.dir, "..", "..", "..", "..", f), "utf-8");
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).toContain("negotiateContentViaIDE");
      expect(code).toContain("ide/tool-hooks.ts");
    }
  });

  test("协商调用必须排在 Bun.write 之前（接在写盘之后就失去了协商的意义）", () => {
    for (const f of ["packages/core/src/tool/edit.ts", "packages/core/src/tool/write.ts"]) {
      const raw = readFileSync(join(import.meta.dir, "..", "..", "..", "..", f), "utf-8");
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const negotiateIdx = code.indexOf("await negotiateContentViaIDE");
      const writeIdx = code.indexOf("await Bun.write");
      expect(negotiateIdx).toBeGreaterThan(-1);
      expect(writeIdx).toBeGreaterThan(-1);
      expect(negotiateIdx).toBeLessThan(writeIdx);
    }
  });

  test("IDE server 注册时给了长超时（否则 diff 等人必然 30s 超时失败）", () => {
    const raw = readFileSync(
      join(import.meta.dir, "..", "..", "src", "ide", "integration.ts"),
      "utf-8",
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("timeout: IDE_RPC_TIMEOUT_MS");
    // 必须显著大于 getMcpTimeout 的 30s 默认值
    expect(code).toMatch(/IDE_RPC_TIMEOUT_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  });
});
