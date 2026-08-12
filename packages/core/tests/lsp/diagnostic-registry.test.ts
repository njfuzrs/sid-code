/**
 * LSP 诊断注册表与被动反馈单测
 * 覆盖：批内去重 / 跨轮次去重 / 严重程度排序 / 体积限流 / 严重度映射 / 格式化
 */

import { describe, test, expect } from "bun:test";
import { DiagnosticRegistry } from "@sid-code/core/lsp/diagnostic-registry.ts";
import { formatDiagnostics } from "@sid-code/core/lsp/passive-feedback.ts";
import type { Diagnostic, DiagnosticSeverity } from "@sid-code/core/lsp/types.ts";

/** 构造一个诊断 */
function diag(message: string, severity: DiagnosticSeverity = "Error", line = 0): Diagnostic {
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
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("dup"), diag("dup")] }]);
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
    reg.registerPending("ts", [
      {
        uri: "file:///a.ts",
        diagnostics: [diag("hint", "Hint"), diag("error", "Error"), diag("warn", "Warning")],
      },
    ]);
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

describe("peekDiagnosticsForFile（非消费式只读快照）", () => {
  test("返回该文件当前全量诊断，且不消费 pending（不破坏 G1 注入链）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("err1"), diag("err2", "Warning", 3)] },
    ]);

    // peek 多次结果稳定
    const peeked = reg.peekDiagnosticsForFile("file:///a.ts");
    expect(peeked.length).toBe(2);
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(2);

    // 关键不变量：peek 之后 collect 仍能拿到诊断（peek 没偷走 pending）
    const collected = reg.collectDiagnostics();
    expect(collected.length).toBe(1);
    expect(collected[0]!.diagnostics.length).toBe(2);
  });

  test("collect 消费 pending 后，peek 仍返回快照（两条链互不影响）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);

    // 先 collect 消费掉 pending
    expect(reg.collectDiagnostics().length).toBe(1);
    expect(reg.collectDiagnostics()).toEqual([]); // pending 已空

    // peek 仍能拿到最新快照（codeAction 需要它填 context.diagnostics）
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(1);
  });

  test("publishDiagnostics 语义=全量覆盖：再次注册替换快照", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("old")] }]);
    expect(reg.peekDiagnosticsForFile("file:///a.ts")[0]!.message).toBe("old");

    // 服务器重推该文件的全量诊断（错误已修，只剩一条新的）
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("new")] }]);
    const peeked = reg.peekDiagnosticsForFile("file:///a.ts");
    expect(peeked.length).toBe(1);
    expect(peeked[0]!.message).toBe("new");
  });

  test("空数组覆盖：错误清空后 peek 返回空（不残留过时诊断）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(1);

    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [] }]);
    expect(reg.peekDiagnosticsForFile("file:///a.ts")).toEqual([]);
  });

  test("无该文件诊断时返回空数组", () => {
    const reg = new DiagnosticRegistry();
    expect(reg.peekDiagnosticsForFile("file:///nonexistent.ts")).toEqual([]);
  });

  test("clear() 同时清空快照", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    reg.clear();
    expect(reg.peekDiagnosticsForFile("file:///a.ts")).toEqual([]);
  });

  test("返回浅拷贝：调用方改动不影响内部快照", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    const peeked = reg.peekDiagnosticsForFile("file:///a.ts");
    peeked.push(diag("injected"));
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(1);
  });
});

/**
 * waitForDiagnostics —— 治 codeAction 的**时序**竞态
 *
 * 病根：诊断是服务器主动推的（publishDiagnostics），而 openFile 走 fire-and-forget 通知
 * （server-manager didOpen 用 sendNotification，不等响应）。文件此前未打开时，工具刚发出
 * didOpen 就 peek，服务器根本还没分析完 → 恒空 → codeAction 的 context.diagnostics 为空
 * → 多数语言服务器回空 quickfix 列表 → 用户看到「无可用的代码修复建议」，而文件里明明有错。
 * （docs/_template/执行lsp过程空白.txt 截图里连续两次都是这个结果。）
 */
describe("waitForDiagnostics（codeAction 的诊断沉降等待）", () => {
  test("诊断已在快照里 → 立即返回 true（不白等）", async () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    // 给一个极短超时：若实现没走"已有则立即返回"的快路径，这里会超时返回 false
    expect(await reg.waitForDiagnostics("file:///a.ts", 5)).toBe(true);
  });

  test("诊断稍后到达 → 被唤醒返回 true，且醒来即可 peek 到内容", async () => {
    const reg = new DiagnosticRegistry();
    const waiting = reg.waitForDiagnostics("file:///a.ts", 1000);
    // 模拟服务器在 didOpen 之后才推诊断
    setTimeout(() => {
      reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    }, 20);

    expect(await waiting).toBe(true);
    // 关键：唤醒必须发生在 latest 覆盖**之后**，否则调用方醒来 peek 仍是空，
    // 等待就白做了（这正是原 bug 的形状，只是换了个地方复现）。
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(1);
  });

  test("空数组也算「服务器已表态」→ 唤醒返回 true（干净文件的正常路径）", async () => {
    const reg = new DiagnosticRegistry();
    const waiting = reg.waitForDiagnostics("file:///clean.ts", 1000);
    setTimeout(() => {
      reg.registerPending("ts", [{ uri: "file:///clean.ts", diagnostics: [] }]);
    }, 10);
    expect(await waiting).toBe(true);
    expect(reg.peekDiagnosticsForFile("file:///clean.ts")).toEqual([]);
  });

  test("超时 → 返回 false（调用方应照常继续，不当故障处理）", async () => {
    const reg = new DiagnosticRegistry();
    expect(await reg.waitForDiagnostics("file:///never.ts", 30)).toBe(false);
  });

  test("只被自己那个 uri 的诊断唤醒，不被别的文件串味", async () => {
    const reg = new DiagnosticRegistry();
    const waiting = reg.waitForDiagnostics("file:///a.ts", 60);
    // 推的是**另一个**文件的诊断，不该唤醒 a.ts 的等待者
    reg.registerPending("ts", [{ uri: "file:///b.ts", diagnostics: [diag("err-b")] }]);
    expect(await waiting).toBe(false);
  });

  test("clear() 唤醒所有等待者，不把它们挂到超时", async () => {
    const reg = new DiagnosticRegistry();
    // 超时给得很长：如果 clear 不唤醒，这个测试会跑满 5s（远超单测耐心）而不是立刻结束
    const waiting = reg.waitForDiagnostics("file:///a.ts", 5000);
    reg.clear();
    // registry 已重置，等下去也等不到东西了；唤醒后调用方 peek 到空、照常继续
    expect(await waiting).toBe(true);
    expect(reg.peekDiagnosticsForFile("file:///a.ts")).toEqual([]);
  });

  test("多个等待者等同一 uri → 一次推送全部唤醒", async () => {
    const reg = new DiagnosticRegistry();
    const a = reg.waitForDiagnostics("file:///a.ts", 1000);
    const b = reg.waitForDiagnostics("file:///a.ts", 1000);
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });

  test("hasPublishedFor 区分「服务器说没问题」与「服务器还没表态」", () => {
    const reg = new DiagnosticRegistry();
    expect(reg.hasPublishedFor("file:///a.ts")).toBe(false);
    // 空数组＝已表态（文件确实没错），与"从未推送"必须可区分——
    // 二者 peek 都返回 []，只靠 peek 无法分辨。
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [] }]);
    expect(reg.hasPublishedFor("file:///a.ts")).toBe(true);
  });
});

describe("formatDiagnostics", () => {
  test("格式化为人类可读文本（1-based 行号）", () => {
    const text = formatDiagnostics([
      {
        uri: "file:///project/a.ts",
        diagnostics: [diag("缺少分号", "Error", 4)],
      },
    ]);
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
    const text = formatDiagnostics([
      {
        uri: "file:///a.ts",
        diagnostics: [
          {
            message: "Cannot find name 'fooBar'.",
            severity: "Error",
            range: { start: { line: 41, character: 4 }, end: { line: 41, character: 10 } },
            source: "typescript",
            code: 2304,
          },
        ],
      },
    ]);
    // 期望形如：Error (42:5) [typescript] 2304: Cannot find name 'fooBar'.
    expect(text).toContain("[typescript]");
    expect(text).toContain("2304");
    expect(text).toContain("Cannot find name 'fooBar'.");
    // code 紧跟在 source 之后、message 冒号之前
    expect(text).toMatch(/\[typescript\] 2304: Cannot find name/);
  });

  test("无 code 时不产生多余空格或占位符", () => {
    const text = formatDiagnostics([
      {
        uri: "file:///a.ts",
        diagnostics: [diag("缺少分号", "Error", 4)], // diag helper 不带 code
      },
    ]);
    // 无 code：source 后直接跟冒号，中间不能有孤立空格/括号残留
    expect(text).toMatch(/\[test\]: 缺少分号/);
    expect(text).not.toContain("()"); // 不能留空 code 括号
  });
});
