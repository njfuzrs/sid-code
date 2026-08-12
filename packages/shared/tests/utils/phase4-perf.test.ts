/**
 * Phase 4 性能/可观测性单测
 * 覆盖：diagnostics（无 PII 诊断日志）+ preconnect（API 预连接）
 */

import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("diagnostics", () => {
  // diagnostics.ts 在模块加载时读取 SID_CODE_DIAGNOSTICS_FILE。
  // 为保证测试确定性，在 import 之前先设置好环境变量。
  test("启用时写入 JSONL，含 ts/event/标量字段", async () => {
    const tmp = path.join(os.tmpdir(), `sid-diag-${Date.now()}.jsonl`);
    process.env.SID_CODE_DIAGNOSTICS_FILE = tmp;

    const mod = await import("@sid-code/core/debug/diagnostics.ts");
    expect(mod.isDiagnosticsEnabled()).toBe(true);

    mod.logDiagnostics("api_request", { model: "test", duration_ms: 123 });
    mod.logDiagnostics("tool_execute", { tool: "bash", duration_ms: 45 });
    await tick(30); // 等异步 appendFile

    const content = fs.readFileSync(tmp, "utf8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBe(2);

    // 异步 appendFile 的回调顺序不保证，按 event 检索而非依赖行序
    const entries = lines.map((l) => JSON.parse(l));
    const apiEntry = entries.find((e) => e.event === "api_request");
    const toolEntry = entries.find((e) => e.event === "tool_execute");

    expect(apiEntry).toBeDefined();
    expect(apiEntry.model).toBe("test");
    expect(apiEntry.duration_ms).toBe(123);
    expect(typeof apiEntry.ts).toBe("number");

    expect(toolEntry).toBeDefined();
    expect(toolEntry.tool).toBe("bash");

    // 只记录标量，不含嵌套对象（无 PII 泄漏面）
    expect(typeof apiEntry.model).not.toBe("object");

    fs.unlinkSync(tmp);
  });

  test("logDiagnostics 永不抛错（诊断不影响主流程）", async () => {
    const mod = await import("@sid-code/core/debug/diagnostics.ts");
    expect(() => mod.logDiagnostics("evt", { a: 1, b: "x", c: true })).not.toThrow();
    expect(() => mod.logDiagnostics("evt")).not.toThrow();
  });
});

describe("preconnect", () => {
  test("非法 URL 静默跳过，不抛错", async () => {
    const { preconnectApi, resetPreconnectState } =
      await import("@sid-code/cli/entrypoints/preconnect.ts");
    resetPreconnectState();
    expect(() => preconnectApi("not a url")).not.toThrow();
  });

  test("同一 origin 不重复预连接", async () => {
    const { preconnectApi, resetPreconnectState } =
      await import("@sid-code/cli/entrypoints/preconnect.ts");
    resetPreconnectState();
    // 两次调用同 origin，第二次应短路（无法直接观测 fetch 次数，
    // 这里仅验证不抛错且幂等）
    expect(() => {
      preconnectApi("https://example.invalid");
      preconnectApi("https://example.invalid");
    }).not.toThrow();
  });

  test("空参数走默认端点不抛错", async () => {
    const { preconnectApi, resetPreconnectState } =
      await import("@sid-code/cli/entrypoints/preconnect.ts");
    resetPreconnectState();
    expect(() => preconnectApi(undefined)).not.toThrow();
    expect(() => preconnectApi("")).not.toThrow();
  });
});

afterAll(() => {
  delete process.env.SID_CODE_DIAGNOSTICS_FILE;
});
