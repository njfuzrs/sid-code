/**
 * LSP 诊断注册表与被动反馈单测
 * 覆盖：批内去重 / 跨轮次去重 / 严重程度排序 / 体积限流 / 严重度映射 / 格式化
 */

import { describe, test, expect } from "bun:test";
import { DiagnosticRegistry } from "../../src/lsp/diagnostic-registry.ts";
import { formatDiagnostics } from "../../src/lsp/passive-feedback.ts";
import type { Diagnostic, DiagnosticSeverity } from "../../src/lsp/types.ts";

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

  test("clearForFile：清除指定文件 delivered 记录后同诊断可再投递（G3）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics().length).toBe(1);

    // 未清除时，同诊断被跨轮次去重过滤
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics()).toEqual([]);

    // 清除该文件 delivered 记录后，同诊断重新作为新诊断投递
    reg.clearForFile("file:///a.ts");
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics().length).toBe(1);
  });

  test("clearForFile：只清目标文件，其它文件 delivered 记录不受影响", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);
    expect(reg.collectDiagnostics().length).toBe(2);

    reg.clearForFile("file:///a.ts");
    // a.ts 同诊断可再投递；b.ts 仍被去重
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);
    const files = reg.collectDiagnostics();
    expect(files.length).toBe(1);
    expect(files[0]!.uri).toBe("file:///a.ts");
  });

  test("clearForFile：清除 pending 中该文件的待投递诊断，保留其它文件", () => {
    const reg = new DiagnosticRegistry();
    // 注册两个文件的 pending（尚未 collect）
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);
    // 编辑 a.ts → 清除其 pending（基于旧内容的诊断已失效）
    reg.clearForFile("file:///a.ts");
    const files = reg.collectDiagnostics();
    expect(files.length).toBe(1);
    expect(files[0]!.uri).toBe("file:///b.ts");
  });

  // ─── 作用域消费（并发子代理隔离，修复全局单例 collect 串味）───

  test("作用域 collect：只收集作用域内文件，作用域外原样保留", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);

    // 只消费 a.ts
    const filesA = reg.collectDiagnostics(["file:///a.ts"]);
    expect(filesA.length).toBe(1);
    expect(filesA[0]!.uri).toBe("file:///a.ts");

    // b.ts 的 pending 未被清空，另一消费者仍能拿到（不被 a.ts 的消费偷走）
    const filesB = reg.collectDiagnostics(["file:///b.ts"]);
    expect(filesB.length).toBe(1);
    expect(filesB[0]!.uri).toBe("file:///b.ts");
  });

  test("作用域 collect：只清空作用域内文件的 pending", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);

    // 消费 a.ts 后，a.ts pending 清空、b.ts 保留
    reg.collectDiagnostics(["file:///a.ts"]);
    // 无作用域的全量 collect 只应剩 b.ts（a.ts 已被消费清空）
    const rest = reg.collectDiagnostics();
    expect(rest.length).toBe(1);
    expect(rest[0]!.uri).toBe("file:///b.ts");
  });

  test("作用域 collect：作用域内无诊断返回空，不误消费其它文件", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("erra")] }]);

    // 作用域是一个没有 pending 诊断的文件
    expect(reg.collectDiagnostics(["file:///other.ts"])).toEqual([]);
    // a.ts 的 pending 未被误清空
    expect(reg.collectDiagnostics().length).toBe(1);
  });

  test("作用域 collect：跨轮次去重按内容生效（同作用域同诊断不重复）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics(["file:///a.ts"]).length).toBe(1);

    // 同诊断再注册 → 作用域消费同样被跨轮次去重过滤
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics(["file:///a.ts"])).toEqual([]);
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

  test("输出诊断 code（如 TS2304），帮助模型判断错误类别", () => {
    const text = formatDiagnostics([{
      uri: "file:///a.ts",
      diagnostics: [{
        message: "Cannot find name 'fooBar'.",
        severity: "Error",
        range: { start: { line: 41, character: 4 }, end: { line: 41, character: 10 } },
        source: "typescript",
        code: 2304,
      }],
    }]);
    // 期望形如：Error (42:5) [typescript] 2304: Cannot find name 'fooBar'.
    expect(text).toContain("[typescript]");
    expect(text).toContain("2304");
    expect(text).toContain("Cannot find name 'fooBar'.");
    // code 紧跟在 source 之后、message 冒号之前
    expect(text).toMatch(/\[typescript\] 2304: Cannot find name/);
  });

  test("无 code 时不产生多余空格或占位符", () => {
    const text = formatDiagnostics([{
      uri: "file:///a.ts",
      diagnostics: [diag("缺少分号", "Error", 4)], // diag helper 不带 code
    }]);
    // 无 code：source 后直接跟冒号，中间不能有孤立空格/括号残留
    expect(text).toMatch(/\[test\]: 缺少分号/);
    expect(text).not.toContain("()"); // 不能留空 code 括号
  });
});
