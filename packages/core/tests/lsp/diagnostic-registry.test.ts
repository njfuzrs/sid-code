/**
 * LSP 诊断注册表与被动反馈单测
 * 覆盖：按 uri 覆盖 / 归属隔离 / 编辑同步窗口 / 版本闸门 / 未编辑文件基线 /
 *       严重度先于限流 / 超限补发 / 跨轮次去重 / collect 统计 / 格式化
 */

import { describe, test, expect } from "bun:test";
import {
  DiagnosticRegistry,
  MAIN_DIAGNOSTIC_OWNER as MAIN,
} from "@sid-code/core/lsp/diagnostic-registry.ts";
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

/** 模拟一次完整的编辑同步（beginEdit → didChange 已发出 → endEdit） */
function edited(reg: DiagnosticRegistry, uri: string, owner = MAIN, version?: number): void {
  const seq = reg.beginEdit(uri, owner);
  reg.endEdit(uri, seq, version);
}

const A = "file:///a.ts";
const B = "file:///b.ts";

describe("DiagnosticRegistry：基本投递", () => {
  test("collect 返回待投递诊断后清空 pending", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files).toHaveLength(1);
    expect(stats.outcome).toBe("injected");
    expect(stats.injected).toBe(1);
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]);
  });

  test("文件内去重：同一快照里的重复诊断只投一条", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("dup"), diag("dup")] }]);
    expect(reg.collectDiagnostics(MAIN).files[0]!.diagnostics).toHaveLength(1);
  });

  test("跨轮次去重：已投递的诊断不再重复投递，outcome=all_delivered", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    reg.collectDiagnostics(MAIN);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1"), diag("err2", "Error", 2)] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["err2"]);
    expect(stats.alreadyDelivered).toBe(1);

    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1"), diag("err2", "Error", 2)] }]);
    const again = reg.collectDiagnostics(MAIN);
    expect(again.files).toEqual([]);
    expect(again.stats.outcome).toBe("all_delivered");
  });

  test("Error 排在 Warning 之前；Hint/Info 不注入只计数", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [
      {
        uri: A,
        diagnostics: [diag("hint", "Hint"), diag("warn", "Warning", 1), diag("error", "Error", 2)],
      },
    ]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.severity)).toEqual(["Error", "Warning"]);
    expect(stats.omittedInfo).toBe(1);
  });

  test("只有 Hint/Info → outcome=info_only，不注入", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("h", "Hint"), diag("i", "Info")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files).toEqual([]);
    expect(stats.outcome).toBe("info_only");
    expect(stats.omittedInfo).toBe(2);
  });

  test("clear 重置所有状态", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    reg.collectDiagnostics(MAIN);
    reg.clear();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toHaveLength(1);
  });
});

describe("缺陷 3：publishDiagnostics 是全量快照，pending 必须按 uri 覆盖", () => {
  test("同一轮先报错后修好 → 不注入已修好的错误", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("E1")] }]);
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files).toEqual([]);
    expect(stats.outcome).toBe("clean");
    // 与 latest 一致：两条链路对同一文件给出同一状态
    expect(reg.peekDiagnosticsForFile(A)).toEqual([]);
    expect(stats.publishes).toBe(2);
  });

  test("同一轮两次推送内容不同 → 只投最后一次", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("old")] }]);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("new")] }]);
    expect(reg.collectDiagnostics(MAIN).files[0]!.diagnostics.map((d) => d.message)).toEqual([
      "new",
    ]);
  });
});

describe("缺陷 1：严重度过滤必须先于限流", () => {
  test("3 个纯 Hint 文件（30 条）+ 1 个 Error 文件 → Error 照样注入", () => {
    const reg = new DiagnosticRegistry();
    for (const f of ["h1", "h2", "h3"]) {
      const uri = `file:///${f}.ts`;
      edited(reg, uri);
      reg.registerPending("ts", [
        { uri, diagnostics: Array.from({ length: 10 }, (_, i) => diag(`${f}-${i}`, "Hint", i)) },
      ]);
    }
    edited(reg, "file:///d.ts");
    reg.registerPending("ts", [{ uri: "file:///d.ts", diagnostics: [diag("real-error")] }]);

    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files.map((f) => f.uri)).toEqual(["file:///d.ts"]);
    expect(stats.omittedInfo).toBe(30);
  });

  test("跨文件按严重度排序：总额满时 Error 先于其它文件的 Warning", () => {
    const reg = new DiagnosticRegistry();
    const uris = ["w1", "w2", "w3"].map((f) => `file:///${f}.ts`);
    for (const uri of uris) {
      edited(reg, uri);
      reg.registerPending("ts", [
        { uri, diagnostics: Array.from({ length: 10 }, (_, i) => diag(`w${i}`, "Warning", i)) },
      ]);
    }
    edited(reg, "file:///e.ts");
    reg.registerPending("ts", [{ uri: "file:///e.ts", diagnostics: [diag("err")] }]);
    const { files } = reg.collectDiagnostics(MAIN);
    expect(files.find((f) => f.uri === "file:///e.ts")?.diagnostics).toHaveLength(1);
    expect(files.reduce((n, f) => n + f.diagnostics.length, 0)).toBe(30);
  });
});

describe("缺陷 2：超出上限的部分留到后续轮次补发，并告知条数", () => {
  test("单文件 15 条 Error → 第一轮 10 条 + carried=5，第二轮补发 5 条", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [
      { uri: A, diagnostics: Array.from({ length: 15 }, (_, i) => diag(`e${i}`, "Error", i)) },
    ]);
    const first = reg.collectDiagnostics(MAIN);
    expect(first.files[0]!.diagnostics).toHaveLength(10);
    expect(first.stats.carried).toBe(5);

    const second = reg.collectDiagnostics(MAIN);
    expect(second.files[0]!.diagnostics.map((d) => d.message)).toEqual([
      "e10",
      "e11",
      "e12",
      "e13",
      "e14",
    ]);
    expect(second.stats.carried).toBe(0);
    // 补发完 pending 才清空
    expect(reg.collectDiagnostics(MAIN).stats.outcome).toBe("empty");
  });

  test("总额 30：5 个文件各 10 条 → 第一轮 30、carried=20", () => {
    const reg = new DiagnosticRegistry();
    for (let f = 0; f < 5; f++) {
      const uri = `file:///f${f}.ts`;
      edited(reg, uri);
      reg.registerPending("ts", [
        { uri, diagnostics: Array.from({ length: 10 }, (_, i) => diag(`f${f}-${i}`, "Error", i)) },
      ]);
    }
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files.reduce((n, f) => n + f.diagnostics.length, 0)).toBe(30);
    expect(stats.carried).toBe(20);
    expect(reg.collectDiagnostics(MAIN).stats.injected).toBe(20);
  });

  test("补发时 Hint 不重复计入「已省略」", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [
      {
        uri: A,
        diagnostics: [
          ...Array.from({ length: 12 }, (_, i) => diag(`e${i}`, "Error", i)),
          diag("h", "Hint", 99),
        ],
      },
    ]);
    expect(reg.collectDiagnostics(MAIN).stats.omittedInfo).toBe(1);
    expect(reg.collectDiagnostics(MAIN).stats.omittedInfo).toBe(0);
  });
});

describe("缺陷 4：归属隔离——主循环不能拿走子代理的诊断", () => {
  test("子代理编辑的文件，主循环 collect 拿不到；子代理自己拿得到", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, B, "agent-1");
    reg.registerPending("ts", [{ uri: B, diagnostics: [diag("sub-err")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]);
    expect(reg.collectDiagnostics("agent-1").files[0]!.uri).toBe(B);
  });

  test("两个子代理互不偷取", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A, "agent-1");
    edited(reg, B, "agent-2");
    reg.registerPending("ts", [
      { uri: A, diagnostics: [diag("a")] },
      { uri: B, diagnostics: [diag("b")] },
    ]);
    expect(reg.collectDiagnostics("agent-1").files.map((f) => f.uri)).toEqual([A]);
    expect(reg.collectDiagnostics("agent-2").files.map((f) => f.uri)).toEqual([B]);
  });

  test("最近编辑者取得归属", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A, "agent-1");
    edited(reg, A, MAIN);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("x")] }]);
    expect(reg.collectDiagnostics("agent-1").files).toEqual([]);
    expect(reg.collectDiagnostics(MAIN).files).toHaveLength(1);
  });

  test("子代理结束 releaseOwner → 未消费与后续诊断都转给主循环，已投递的不重复", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A, "agent-1");
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("seen")] }]);
    reg.collectDiagnostics("agent-1");
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("seen"), diag("later", "Error", 3)] }]);
    reg.releaseOwner("agent-1");
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["later"]);
    // 子代理名下未结算的推送计数一并转给主循环（第一次已在 agent-1 的 collect 里结算）
    expect(stats.publishes).toBe(1);
  });
});

describe("缺陷 6：编辑同步窗口与版本闸门——不注入基于旧内容的诊断", () => {
  test("beginEdit 之后、endEdit 之前到达的推送被丢弃（计 stale_syncing）", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]); // 基线
    const seq = reg.beginEdit(A, MAIN);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("stale")] }]);
    expect(reg.peekDiagnosticsForFile(A)).toEqual([]);
    reg.endEdit(A, seq, 2);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files).toEqual([]);
    expect(stats.staleSyncing).toBe(1);
  });

  test("beginEdit 同步清掉编辑前的 pending（不等异步读盘）", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("before-edit")] }]);
    reg.beginEdit(A, MAIN); // 下一次编辑开始，collect 抢在 didChange 之前
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]);
  });

  test("版本号落后于已发出版本的推送被丢弃（计 stale_version）", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A, MAIN, 3);
    reg.registerPending("ts", [{ uri: A, version: 2, diagnostics: [diag("old-version")] }]);
    reg.registerPending("ts", [{ uri: A, version: 3, diagnostics: [diag("current")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["current"]);
    expect(stats.staleVersion).toBe(1);
    expect(stats.publishesWithVersion).toBe(2);
  });

  test("并发编辑：只有最后一次 beginEdit 对应的 endEdit 能结束同步窗口", () => {
    const reg = new DiagnosticRegistry();
    const s1 = reg.beginEdit(A, MAIN);
    const s2 = reg.beginEdit(A, MAIN);
    reg.endEdit(A, s1, 2); // 先完成的旧编辑
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("between")] }]);
    expect(reg.collectDiagnostics(MAIN).stats.staleSyncing).toBe(1);
    reg.endEdit(A, s2, 3);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("after")] }]);
    expect(reg.collectDiagnostics(MAIN).files[0]!.diagnostics[0]!.message).toBe("after");
  });
});

describe("未编辑文件（只被 lsp 工具打开）：首次推送记基线不注入", () => {
  test("首次推送不注入；之后新出现的诊断注入给主循环", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("pre-existing")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]);
    // codeAction 照样能读到
    expect(reg.peekDiagnosticsForFile(A)).toHaveLength(1);

    reg.registerPending("ts", [
      { uri: A, diagnostics: [diag("pre-existing"), diag("new-break", "Error", 4)] },
    ]);
    expect(reg.collectDiagnostics(MAIN).files[0]!.diagnostics.map((d) => d.message)).toEqual([
      "new-break",
    ]);
  });

  test("缺陷 5：没有消费者时 pending 有界（按 uri 覆盖）", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A, "agent-never-collects");
    for (let i = 0; i < 1000; i++) {
      reg.registerPending("ts", [{ uri: A, diagnostics: [diag(`x${i}`)] }]);
    }
    expect((reg as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  });
});

describe("clearForFile", () => {
  test("清除后同诊断可再投递", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    reg.collectDiagnostics(MAIN);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]);
    reg.clearForFile(A);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("err1")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toHaveLength(1);
  });

  test("只清目标文件，其它文件不受影响", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, A);
    edited(reg, B);
    reg.registerPending("ts", [
      { uri: A, diagnostics: [diag("erra")] },
      { uri: B, diagnostics: [diag("errb")] },
    ]);
    reg.clearForFile(A);
    expect(reg.collectDiagnostics(MAIN).files.map((f) => f.uri)).toEqual([B]);
  });
});

describe("peekDiagnosticsForFile（非消费式只读快照）", () => {
  test("返回该文件当前全量诊断，且不消费 pending（不破坏 G1 注入链）", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, "file:///a.ts");
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("err1"), diag("err2", "Warning", 3)] },
    ]);

    // peek 多次结果稳定
    const peeked = reg.peekDiagnosticsForFile("file:///a.ts");
    expect(peeked.length).toBe(2);
    expect(reg.peekDiagnosticsForFile("file:///a.ts").length).toBe(2);

    // 关键不变量：peek 之后 collect 仍能拿到诊断（peek 没偷走 pending）
    const collected = reg.collectDiagnostics(MAIN).files;
    expect(collected.length).toBe(1);
    expect(collected[0]!.diagnostics.length).toBe(2);
  });

  test("collect 消费 pending 后，peek 仍返回快照（两条链互不影响）", () => {
    const reg = new DiagnosticRegistry();
    edited(reg, "file:///a.ts");
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("err1")] }]);

    // 先 collect 消费掉 pending
    expect(reg.collectDiagnostics(MAIN).files.length).toBe(1);
    expect(reg.collectDiagnostics(MAIN).files).toEqual([]); // pending 已空

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

  // ─── clearForFile 必须让 latest 快照失效（编辑后旧诊断不能冒充新诊断）───
  // 旧实现只清 delivered/pending、漏清 latest：编辑后 waitForDiagnostics 因 latest.has(uri)
  // 立即返回 true，codeAction 随即把编辑前的诊断塞进 context.diagnostics。

  test("clearForFile 后 peek 返回空，不残留编辑前快照", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("old")] }]);
    reg.clearForFile("file:///a.ts");
    expect(reg.peekDiagnosticsForFile("file:///a.ts")).toEqual([]);
    expect(reg.hasPublishedFor("file:///a.ts")).toBe(false);
  });

  test("clearForFile 后 waitForDiagnostics 不因旧快照立即成功", async () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("old")] }]);
    reg.clearForFile("file:///a.ts");
    expect(await reg.waitForDiagnostics("file:///a.ts", 20)).toBe(false);
  });

  test("clearForFile 后新诊断到达 → 唤醒等待者且 peek 到新诊断", async () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("old")] }]);
    reg.clearForFile("file:///a.ts");
    const waiting = reg.waitForDiagnostics("file:///a.ts", 1000);
    setTimeout(() => {
      reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("new")] }]);
    }, 10);
    expect(await waiting).toBe(true);
    expect(reg.peekDiagnosticsForFile("file:///a.ts").map((d) => d.message)).toEqual(["new"]);
  });

  test("clearForFile 只清目标文件快照，其它文件快照不受影响", async () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("erra")] },
      { uri: "file:///b.ts", diagnostics: [diag("errb")] },
    ]);
    reg.clearForFile("file:///a.ts");
    expect(reg.peekDiagnosticsForFile("file:///b.ts").map((d) => d.message)).toEqual(["errb"]);
    expect(await reg.waitForDiagnostics("file:///b.ts", 5)).toBe(true);
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
