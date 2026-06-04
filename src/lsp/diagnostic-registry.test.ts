/**
 * LSP 诊断注册表与被动反馈单测
 * 覆盖：批内去重 / 跨轮次去重 / 严重程度排序 / 体积限流 / 严重度映射 / 格式化
 */

import { describe, test, expect } from "bun:test";
import { DiagnosticRegistry } from "./diagnostic-registry.ts";
import { formatDiagnostics } from "./passive-feedback.ts";
import type { Diagnostic, DiagnosticSeverity } from "./types.ts";

/** 构造一个诊断 */
function diag(
  message: string,
  severity: DiagnosticSeverity = "Error",
  line = 0,
): Diagnostic {
  return {
    message,
    severity,
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
    source: "test",
  };
}

describe("DiagnosticRegistry", () => {
  test("collectDiagnostics 返回待投递诊断后清空 pending", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);

    const first = reg.collectDiagnostics();
    expect(first.length).toBe(1);
    expect(first[0]!.diagnostics.length).toBe(1);

    // 再次收集应为空（pending 已清空）
    expect(reg.collectDiagnostics()).toEqual([]);
  });

  test("批内去重：相同诊断只保留一条", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("dup"), diag("dup")] },
    ]);
    const files = reg.collectDiagnostics();
    expect(files[0]!.diagnostics.length).toBe(1);
  });

  test("跨轮次去重：已投递的诊断不再重复投递", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics().length).toBe(1);

    // 同样的诊断再次注册 → 被跨轮次去重过滤
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics()).toEqual([]);

    // 新诊断仍能投递
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err2")] }]);
    expect(reg.collectDiagnostics().length).toBe(1);
  });

  test("严重程度排序：Error 在 Warning/Hint 之前", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{
      uri: "file:///a.ts",
      diagnostics: [diag("hint", "Hint"), diag("error", "Error"), diag("warn", "Warning")],
    }]);
    const files = reg.collectDiagnostics();
    const severities = files[0]!.diagnostics.map((d) => d.severity);
    expect(severities).toEqual(["Error", "Warning", "Hint"]);
  });

  test("每文件最多 10 条诊断", () => {
    const reg = new DiagnosticRegistry();
    const many = Array.from({ length: 15 }, (_, i) => diag(`err${i}`, "Error", i));
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: many }]);
    const files = reg.collectDiagnostics();
    expect(files[0]!.diagnostics.length).toBe(10);
  });

  test("总计最多 30 条诊断", () => {
    const reg = new DiagnosticRegistry();
    // 5 个文件，每个 10 条 = 50 条，应被限制为 30
    const pendingFiles = Array.from({ length: 5 }, (_, f) => ({
      uri: `file:///f${f}.ts`,
      diagnostics: Array.from({ length: 10 }, (_, i) => diag(`f${f}-err${i}`, "Error", i)),
    }));
    reg.registerPending("ts", pendingFiles);
    const files = reg.collectDiagnostics();
    const total = files.reduce((sum, f) => sum + f.diagnostics.length, 0);
    expect(total).toBe(30);
  });

  test("clear 重置所有状态", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    reg.collectDiagnostics();
    reg.clear();
    // clear 后，之前投递过的诊断可再次投递（delivered 已清空）
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics().length).toBe(1);
  });
});

describe("formatDiagnostics", () => {
  test("格式化为人类可读文本（1-based 行号）", () => {
    const text = formatDiagnostics([{
      uri: "file:///project/a.ts",
      diagnostics: [diag("缺少分号", "Error", 4)],
    }]);
    expect(text).toContain("a.ts");
    expect(text).toContain("Error");
    expect(text).toContain("5:1"); // line 4 (0-based) → 5 (1-based)
    expect(text).toContain("缺少分号");
    expect(text).toContain("[test]"); // source
  });

  test("多文件多诊断", () => {
    const text = formatDiagnostics([
      { uri: "file:///a.ts", diagnostics: [diag("e1", "Error", 0)] },
      { uri: "file:///b.ts", diagnostics: [diag("w1", "Warning", 2)] },
    ]);
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).toContain("Error");
    expect(text).toContain("Warning");
  });
});
