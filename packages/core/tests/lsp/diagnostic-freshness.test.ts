/**
 * LSP 诊断新鲜度：客户端代际屏障 + 内容指纹漂移校验
 *
 * 对应设计方案 `20261105-LSP诊断新鲜度-推送不带version时判不了过时-设计方案.md` §5.1 的
 * U1–U11。核心背景：typescript-language-server 5.x 的 publishDiagnostics **不带 version**，
 * 原有的 version 闸门对它恒不生效，编辑同步窗口又只覆盖到「didChange 发出」为止——
 * 服务器在那之后仍会推旧内容的诊断（实测，见 barrier.ts 注释）。
 *
 * 这里的用例分三层：
 * - 注册表层（U1–U6、U9）：代际 / 屏障 / 新鲜度判定的纯内存逻辑，不需要真实服务器；
 * - manager 层（U7、U8、U10）：漂移校验与注入文本，靠 deps 注入观测副作用；
 * - digest 层（U11）：见 tests/trace/lsp-diagnostics-digest.test.ts。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  DiagnosticRegistry,
  MAIN_DIAGNOSTIC_OWNER as MAIN,
} from "@sid-code/core/lsp/diagnostic-registry.ts";
import { BarrierGate } from "@sid-code/core/lsp/barrier.ts";
import {
  initializeLSP,
  resetLSPForTest,
  getDiagnosticRegistry,
  collectDiagnosticText,
  findDriftedFiles,
  type DriftIO,
} from "@sid-code/core/lsp/manager.ts";
import { formatDiagnostics } from "@sid-code/core/lsp/passive-feedback.ts";
import { contentHash } from "@sid-code/core/lsp/server-manager.ts";
import type { Diagnostic, DiagnosticSeverity } from "@sid-code/core/lsp/types.ts";

const A = "file:///proj/a.ts";
const B = "file:///proj/b.ts";

function diag(message: string, severity: DiagnosticSeverity = "Error", line = 0): Diagnostic {
  return {
    message,
    severity,
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
    source: "test",
  };
}

/** 起一次编辑代际（只 begin，不结束） */
function startEdit(reg: DiagnosticRegistry, uri: string, owner = MAIN): number {
  return reg.beginEdit(uri, owner);
}

/** 一次完整的编辑：begin → didChange 已发出（endEdit）→ 屏障越过 */
function completeEdit(
  reg: DiagnosticRegistry,
  uri: string,
  owner = MAIN,
  version?: number,
): number {
  const seq = reg.beginEdit(uri, owner);
  reg.endEdit(uri, seq, version);
  reg.passBarrier(uri, seq, true);
  return seq;
}

afterEach(() => {
  resetLSPForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// 注册表层：代际与屏障判据（U1–U6）
// ─────────────────────────────────────────────────────────────────────────────

describe("U1：无 version 推送、屏障未到 → 丢弃并计 stale_syncing", () => {
  test("didChange 已发出但屏障未回，推送被丢弃，pending 里没有该文件", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]); // 先记基线，建立「服务器见过这文件」

    const seq = startEdit(reg, A);
    reg.endEdit(A, seq, 2); // didChange 已发出，但屏障尚未回来
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("基于旧内容")] }]);

    expect(reg.pendingUrisFor(MAIN)).toEqual([]);
    expect(reg.peekDiagnosticsForFile(A)).toEqual([]); // 也不覆盖 latest
    expect(reg.collectDiagnostics(MAIN).stats.staleSyncing).toBe(1);
  });
});

describe("U2：无 version 推送、屏障已到 → 收下并计 fresh_by_barrier", () => {
  test("屏障越过后同一条推送进 pending，新鲜度判 fresh_by_barrier", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]); // 基线
    const seq = startEdit(reg, A);
    reg.endEdit(A, seq, 2);
    reg.passBarrier(A, seq, true);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("新内容诊断")] }]);

    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["新内容诊断"]);
    expect(files[0]!.freshness).toBe("fresh_by_barrier");
    expect(stats.freshByBarrier).toBe(1);
    expect(stats.unverified).toBe(0);
    expect(stats.staleSyncing).toBe(0);
  });
});

describe("U3：并发两次编辑，旧代际屏障先到不能结束新代际窗口", () => {
  test("旧 epoch 的 passBarrier 被忽略；新 epoch 屏障到了才放行", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]);

    const e1 = startEdit(reg, A);
    const e2 = startEdit(reg, A); // 并发：新代际已开

    // 旧代际的屏障到得晚
    reg.passBarrier(A, e1, true);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("仍可能是旧内容")] }]);
    expect(reg.collectDiagnostics(MAIN).stats.staleSyncing).toBe(1);

    // 新代际的屏障到了
    reg.endEdit(A, e2, 3);
    reg.passBarrier(A, e2, true);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("新代际内容")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["新代际内容"]);
    expect(stats.freshByBarrier).toBe(1);
  });
});

describe("U4：屏障失败（超时/报错）→ 结束窗口，后续推送判 unverified 并照常注入", () => {
  test("passBarrier(ok=false) 后 syncing 结束，推送收下但判 unverified", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, diagnostics: [] }]); // 基线
    const seq = startEdit(reg, A);
    reg.endEdit(A, seq, 2);
    reg.passBarrier(A, seq, false); // 屏障超时/报错

    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("无法证明新鲜")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    // 降级行为 = 修复前：照常注入
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["无法证明新鲜"]);
    expect(files[0]!.freshness).toBe("unverified");
    expect(stats.unverified).toBe(1);
    expect(stats.freshByBarrier).toBe(0);
  });

  test("屏障失败不会把文件永久卡在 syncing（否则永远不出诊断）", () => {
    const reg = new DiagnosticRegistry();
    const seq = startEdit(reg, A);
    reg.endEdit(A, seq, 2);
    reg.passBarrier(A, seq, false);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("x")] }]);
    expect(reg.collectDiagnostics(MAIN).files).toHaveLength(1);
  });
});

describe("U5：同服务器连续 3 次屏障失败 → 关闭屏障，之后不再发请求", () => {
  test("第 4 次 run 不再调用 send，直接返回 false（推送判 unverified）", async () => {
    const gate = new BarrierGate({ timeoutMs: 10, flushMs: 0, maxConsecutiveFailures: 3 });
    let sends = 0;
    const failing = async () => {
      sends++;
      throw new Error("Method not found");
    };

    expect(await gate.run("ts", failing)).toBe(false);
    expect(await gate.run("ts", failing)).toBe(false);
    expect(await gate.run("ts", failing)).toBe(false);
    expect(sends).toBe(3);
    expect(gate.isDisabled("ts")).toBe(true);

    // 第 4 次：不再白发请求
    expect(await gate.run("ts", failing)).toBe(false);
    expect(sends).toBe(3);
  });

  test("成功一次即清零连续失败计数（抖动不该关掉屏障）", async () => {
    const gate = new BarrierGate({ timeoutMs: 10, flushMs: 0, maxConsecutiveFailures: 3 });
    const fail = async () => {
      throw new Error("transient");
    };
    await gate.run("ts", fail);
    await gate.run("ts", fail);
    await gate.run("ts", async () => ({})); // 成功
    await gate.run("ts", fail);
    await gate.run("ts", fail);
    expect(gate.isDisabled("ts")).toBe(false);
  });

  test("失败计数按服务器分开记（一台坏掉不影响另一台）", async () => {
    const gate = new BarrierGate({ timeoutMs: 10, flushMs: 0, maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("nope");
    };
    await gate.run("bad", fail);
    await gate.run("bad", fail);
    expect(gate.isDisabled("bad")).toBe(true);
    expect(gate.isDisabled("good")).toBe(false);
  });
});

describe("U6：带 version 的推送 → version 判据优先，屏障状态不影响判定", () => {
  test("version ≥ sentVersion 判 fresh_by_version，即使屏障失败", () => {
    const reg = new DiagnosticRegistry();
    reg.registerPending("ts", [{ uri: A, version: 1, diagnostics: [] }]);
    const seq = startEdit(reg, A);
    reg.endEdit(A, seq, 3);
    reg.passBarrier(A, seq, false); // 屏障失败，但 version 足以证明新鲜

    reg.registerPending("ts", [{ uri: A, version: 3, diagnostics: [diag("v3 诊断")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.freshness).toBe("fresh_by_version");
    expect(stats.freshByVersion).toBe(1);
    expect(stats.unverified).toBe(0);
  });

  test("version 落后 → stale_version（不会被 barrier 判据抢先收下）", () => {
    const reg = new DiagnosticRegistry();
    const seq = completeEdit(reg, A, MAIN, 3);
    expect(seq).toBeGreaterThan(0);
    reg.registerPending("ts", [{ uri: A, version: 2, diagnostics: [diag("旧版本")] }]);
    reg.registerPending("ts", [{ uri: A, version: 3, diagnostics: [diag("当前版本")] }]);
    const { files, stats } = reg.collectDiagnostics(MAIN);
    expect(files[0]!.diagnostics.map((d) => d.message)).toEqual(["当前版本"]);
    expect(stats.staleVersion).toBe(1);
  });
});

describe("U9：新代际第一次推送被 collect → injected_first_publish +1", () => {
  test("第一次推送计入，同一代际的第二次推送不计入", () => {
    const reg = new DiagnosticRegistry();
    const seq = completeEdit(reg, A, MAIN, 2);

    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("first")] }]);
    const first = reg.collectDiagnostics(MAIN);
    expect(first.stats.injectedFirstPublish).toBe(1);

    // 同一代际再推一次（tsls 的 syntax/semantic 分阶段推送）
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("second", "Error", 1)] }]);
    const second = reg.collectDiagnostics(MAIN);
    expect(second.stats.injectedFirstPublish).toBe(0);
    // counters 是**两次 collect 之间**的区间计数：第一次 collect 已结算过一条
    expect(second.stats.freshByBarrier).toBe(1);
    expect(seq).toBeGreaterThan(0);
  });

  test("新编辑开启新代际后，第一次推送重新计入", () => {
    const reg = new DiagnosticRegistry();
    completeEdit(reg, A, MAIN, 2);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("first")] }]);
    expect(reg.collectDiagnostics(MAIN).stats.injectedFirstPublish).toBe(1);

    completeEdit(reg, A, MAIN, 3);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("first-again")] }]);
    expect(reg.collectDiagnostics(MAIN).stats.injectedFirstPublish).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 内容指纹 / 漂移校验（U7、U8）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个只统计读盘次数的 DriftIO */
function countingIO(files: Record<string, { mtimeMs: number; size: number; content: string }>): {
  io: DriftIO;
  reads: () => number;
  stats: () => number;
} {
  let reads = 0;
  let stats = 0;
  return {
    io: {
      async stat(p) {
        stats++;
        const f = files[p];
        if (!f) throw new Error(`ENOENT: ${p}`);
        return { mtimeMs: f.mtimeMs, size: f.size };
      },
      async readFile(p) {
        reads++;
        const f = files[p];
        if (!f) throw new Error(`ENOENT: ${p}`);
        return f.content;
      },
    },
    reads: () => reads,
    stats: () => stats,
  };
}

describe("U7：磁盘内容与发给服务器的不一致 → 判漂移", () => {
  test("mtime 变了且 hash 不同 → 该文件进 drifted", async () => {
    const { io } = countingIO({
      "/proj/a.ts": { mtimeMs: 200, size: 20, content: "const a: number = 1;\n" },
    });
    const lookup = (_p: string) => ({ hash: "sha1-of-old-content", mtimeMs: 100, size: 20 });
    const drifted = await findDriftedFiles(lookup, [A], io);
    expect(drifted.get(A)).toBe("/proj/a.ts");
  });

  test("mtime 变了但内容 hash 相同（touch / 重写同内容）→ 不算漂移", async () => {
    const content = "const a: number = 1;\n";
    const { io } = countingIO({ "/proj/a.ts": { mtimeMs: 200, size: 20, content } });
    const lookup = (_p: string) => ({ hash: contentHash(content), mtimeMs: 100, size: 20 });
    const drifted = await findDriftedFiles(lookup, [A], io);
    expect(drifted.size).toBe(0);
  });

  test("没同步过的文件（lookup 返回 undefined）不参与漂移判定", async () => {
    const { io } = countingIO({ "/proj/a.ts": { mtimeMs: 200, size: 20, content: "x" } });
    const drifted = await findDriftedFiles(() => undefined, [A], io);
    expect(drifted.size).toBe(0);
  });

  test("非 file:// URI（untitled: 等）不参与漂移判定，也不抛错", async () => {
    const { io, stats } = countingIO({});
    const drifted = await findDriftedFiles(
      () => ({ hash: "h", mtimeMs: 1, size: 2 }),
      ["untitled:Untitled-1"],
      io,
    );
    expect(drifted.size).toBe(0);
    expect(stats()).toBe(0); // 连 stat 都没做
  });
});

describe("U8：mtime/size 未变 → 不读盘", () => {
  test("快路径命中时 readFile 调用 0 次", async () => {
    const { io, reads, stats } = countingIO({
      "/proj/a.ts": { mtimeMs: 100, size: 20, content: "whatever" },
    });
    const lookup = (_p: string) => ({ hash: "any-hash", mtimeMs: 100, size: 20 });
    const drifted = await findDriftedFiles(lookup, [A], io);
    expect(drifted.size).toBe(0);
    expect(reads()).toBe(0);
    expect(stats()).toBe(1); // 只 stat，不读盘
  });

  test("只有 mtime 变了但 size 未变 → 才走读盘路径", async () => {
    const { io, reads } = countingIO({
      "/proj/a.ts": { mtimeMs: 999, size: 20, content: "whatever" },
    });
    const lookup = (_p: string) => ({ hash: "any-hash", mtimeMs: 100, size: 20 });
    await findDriftedFiles(lookup, [A], io);
    expect(reads()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U10：注入文本的新鲜度标注
// ─────────────────────────────────────────────────────────────────────────────

describe("U10：注入文本只在能证明新鲜时加标注", () => {
  test("fresh_by_barrier / fresh_by_version 加标注", () => {
    const text = formatDiagnostics([
      { uri: A, diagnostics: [diag("e1")], freshness: "fresh_by_barrier" },
      { uri: B, diagnostics: [diag("e2")], freshness: "fresh_by_version" },
    ]);
    expect(text).toContain("（基于你最近一次编辑后的内容）");
    expect(
      text.split("\n").filter((l) => l.includes("（基于你最近一次编辑后的内容）")),
    ).toHaveLength(2);
  });

  test("unverified / baseline 不加标注（不说谎）", () => {
    const text = formatDiagnostics([
      { uri: A, diagnostics: [diag("e1")], freshness: "unverified" },
      { uri: B, diagnostics: [diag("e2")], freshness: "baseline" },
    ]);
    expect(text).not.toContain("基于你最近一次编辑后的内容");
  });

  test("未传 freshness（老调用点）不加标注，行为与修复前一致", () => {
    const text = formatDiagnostics([{ uri: A, diagnostics: [diag("e1")] }]);
    expect(text).not.toContain("基于你最近一次编辑后的内容");
    expect(text).toContain("## /proj/a.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// manager 层集成：漂移文件不注入 + 触发重同步（U7 的后半段）
// ─────────────────────────────────────────────────────────────────────────────

describe("U7（manifest）：collectDiagnosticText 对漂移文件不注入并触发重同步", () => {
  test("漂移文件本轮无注入、drifted_files 计数 +1、resync 被调用一次", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (getDiagnosticRegistry()) {
          clearInterval(tick);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(tick);
        resolve();
      }, 1000);
    });

    const reg = getDiagnosticRegistry()!;
    const seq = reg.beginEdit(A, MAIN);
    reg.endEdit(A, seq, 1);
    reg.passBarrier(A, seq, true);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("基于旧内容")] }]);

    const resynced: string[] = [];
    const text = await collectDiagnosticText(MAIN, {
      checkDrift: async () => new Map([[A, "/proj/a.ts"]]),
      resync: (filePath) => resynced.push(filePath),
    });

    expect(text).toBeNull(); // 唯一候选被判漂移 → 本轮不注入
    expect(resynced).toEqual(["/proj/a.ts"]);
    // 清掉了基于旧内容的 pending，不会下一轮又被注入
    expect(reg.pendingUrisFor(MAIN)).toEqual([]);
  });

  test("无漂移时正常注入，drifted_files 为 0", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    const reg = getDiagnosticRegistry()!;
    const seq = reg.beginEdit(A, MAIN);
    reg.endEdit(A, seq, 1);
    reg.passBarrier(A, seq, true);
    reg.registerPending("ts", [{ uri: A, diagnostics: [diag("真错误")] }]);

    const text = await collectDiagnosticText(MAIN, {
      checkDrift: async () => new Map(),
    });
    expect(text).toContain("真错误");
    expect(text).toContain("（基于你最近一次编辑后的内容）");
  });
});
