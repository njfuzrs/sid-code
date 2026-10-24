/**
 * LSP manager 单例逻辑单测
 * 覆盖：collectDiagnosticText 严重度过滤（仅 Error/Warning 注入）/
 *       clearDiagnosticsForFile / getLSPHealth / getLSPHealthWarning / waitForLSPReady
 *
 * 注：这些函数依赖模块级单例。通过 initializeLSP（无配置场景，立即 success）+
 * getDiagnosticRegistry 直接操作 registry 来构造测试场景，无需真实 LSP 服务器。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  initializeLSP,
  resetLSPForTest,
  getDiagnosticRegistry,
  collectDiagnosticText,
  clearDiagnosticsForFile,
  getLSPHealth,
  getLSPHealthWarning,
  waitForLSPReady,
  getLSPInitState,
  MAIN_DIAGNOSTIC_OWNER,
  setLspDiagnosticsTraceSink,
  syncFileToLSP,
  releaseDiagnosticOwner,
} from "@sid-code/core/lsp/manager.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticRegistry } from "@sid-code/core/lsp/diagnostic-registry.ts";
import { pathToFileURL } from "url";
import type { DiagnosticSeverity } from "@sid-code/core/lsp/types.ts";

function diag(message: string, severity: DiagnosticSeverity, line = 0) {
  return {
    message,
    severity,
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
    source: "test",
  };
}

/**
 * 模拟该文件被主循环编辑过一次（syncFileToLSP 的 beginEdit/endEdit）。
 * 没被编辑过的文件首次推送只记基线、不注入（见 DiagnosticRegistry.baselined），
 * 所以测注入路径前必须先建立归属。
 */
function ownByMain(reg: DiagnosticRegistry, uri: string): void {
  reg.endEdit(uri, reg.beginEdit(uri, MAIN_DIAGNOSTIC_OWNER));
}

/** 等待 initState 变为 success（无配置场景几乎立即完成） */
async function waitInitSuccess(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (getLSPInitState() === "success") return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  resetLSPForTest();
});

describe("collectDiagnosticText 严重度过滤", () => {
  test("仅含 Hint/Info 时不注入（返回 null）", async () => {
    // 用一个不存在的工作区触发"无配置 → success"路径
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    expect(reg).toBeDefined();
    ownByMain(reg!, "file:///a.ts");
    reg!.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("提示", "Hint"), diag("信息", "Info")] },
    ]);

    expect(collectDiagnosticText()).toBeNull();
  });

  test("含 Error 时注入（含格式化文本）", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    ownByMain(reg!, "file:///a.ts");
    reg!.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("类型错误", "Error", 3)] },
    ]);

    const text = collectDiagnosticText();
    expect(text).not.toBeNull();
    expect(text).toContain("类型错误");
    expect(text).toContain("4:1"); // 1-based
  });

  test("含 Warning 时注入", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    ownByMain(reg!, "file:///a.ts");
    reg!.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("未使用变量", "Warning")] },
    ]);

    expect(collectDiagnosticText()).not.toBeNull();
  });

  // 评估会话 ce7ea52e 发现 7：旧实现整批过关后把同文件 Hint 原样带出
  test("1 Error + 5 Hint ⇒ 只出 1 行诊断 + 省略说明", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    ownByMain(reg!, "file:///a.ts");
    reg!.registerPending("ts", [
      {
        uri: "file:///a.ts",
        diagnostics: [
          diag("类型错误", "Error", 1),
          ...[2, 3, 4, 5, 6].map((l) => diag(`已弃用-${l}`, "Hint", l)),
        ],
      },
    ]);

    const text = collectDiagnosticText()!;
    expect(text).toContain("类型错误");
    expect(text).not.toContain("已弃用");
    expect(text.split("\n").filter((l) => /^\s+(Error|Warning|Hint|Info) \(/.test(l))).toHaveLength(
      1,
    );
    expect(text).toContain("另有 5 条提示（Hint/Info）已省略");
  });

  test("跨文件：只含 Hint 的文件整段不出现", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    ownByMain(reg!, "file:///a.ts");
    ownByMain(reg!, "file:///b.ts");
    reg!.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("真错误", "Error")] },
      { uri: "file:///b.ts", diagnostics: [diag("b提示", "Hint")] },
    ]);

    const text = collectDiagnosticText()!;
    expect(text).toContain("/a.ts");
    expect(text).not.toContain("/b.ts");
    expect(text).toContain("另有 1 条提示");
  });

  test("没有被省略的条目时不附省略说明", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    ownByMain(getDiagnosticRegistry()!, "file:///a.ts");
    getDiagnosticRegistry()!.registerPending("ts", [
      { uri: "file:///a.ts", diagnostics: [diag("真错误", "Error")] },
    ]);
    expect(collectDiagnosticText()).not.toContain("已省略");
  });
});

describe("clearDiagnosticsForFile", () => {
  test("清除后同诊断可再次注入", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();

    const reg = getDiagnosticRegistry();
    const filePath = "/tmp/foo.ts";
    const uri = pathToFileURL(filePath).href;

    ownByMain(reg!, uri);
    reg!.registerPending("ts", [{ uri, diagnostics: [diag("err", "Error")] }]);
    expect(collectDiagnosticText()).not.toBeNull();

    // 未清除 → 去重过滤（不经编辑同步，直接再推一次同样的诊断）
    reg!.registerPending("ts", [{ uri, diagnostics: [diag("err", "Error")] }]);
    expect(collectDiagnosticText()).toBeNull();

    // 清除后 → 同诊断重新注入
    clearDiagnosticsForFile(filePath);
    reg!.registerPending("ts", [{ uri, diagnostics: [diag("err", "Error")] }]);
    expect(collectDiagnosticText()).not.toBeNull();
  });

  test("LSP 未初始化时静默无操作（不抛错）", () => {
    resetLSPForTest();
    expect(() => clearDiagnosticsForFile("/tmp/x.ts")).not.toThrow();
  });
});

describe("getLSPHealth / getLSPHealthWarning", () => {
  test("无实例时返回当前 initState + 空服务器列表", () => {
    resetLSPForTest();
    const health = getLSPHealth();
    expect(health.servers).toEqual([]);
    expect(health.initState).toBe("not-started");
  });

  test("初始化成功 + 服务器未崩溃时无健康告警", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();
    // 无论是否检测到 typescript-language-server（取决于测试机环境），
    // 只要初始化成功且无服务器崩溃，就不应有健康告警。
    expect(getLSPHealthWarning()).toBeNull();
    const health = getLSPHealth();
    expect(health.initState).toBe("success");
    // 服务器若存在（懒启动）应为 stopped/running，均非异常态
    for (const s of health.servers) {
      expect(s.restartsExhausted).toBe(false);
      expect(s.state).not.toBe("error");
    }
  });
});

describe("waitForLSPReady", () => {
  test("success 立即返回 true", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();
    expect(await waitForLSPReady()).toBe(true);
  });

  test("not-started 立即返回 false", async () => {
    resetLSPForTest();
    expect(await waitForLSPReady()).toBe(false);
  });
});

describe("collectDiagnosticText：截断告知 + 归属 + 埋点", () => {
  afterEach(() => setLspDiagnosticsTraceSink(null));

  test("超出单次上限 → 文本告知补发条数，下一轮补发", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();
    const reg = getDiagnosticRegistry()!;
    ownByMain(reg, "file:///a.ts");
    reg.registerPending("ts", [
      {
        uri: "file:///a.ts",
        diagnostics: Array.from({ length: 12 }, (_, i) => diag(`e${i}`, "Error", i)),
      },
    ]);
    const first = collectDiagnosticText()!;
    expect(first).toContain("另有 2 条 Error/Warning 超出单次上限，将在后续轮次补发");
    const second = collectDiagnosticText()!;
    expect(second).toContain("e10");
    expect(second).not.toContain("超出单次上限");
  });

  test("子代理名下的诊断主循环拿不到；releaseDiagnosticOwner 后转给主循环", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();
    const reg = getDiagnosticRegistry()!;
    reg.endEdit("file:///s.ts", reg.beginEdit("file:///s.ts", "agent-x"));
    reg.registerPending("ts", [{ uri: "file:///s.ts", diagnostics: [diag("sub", "Error")] }]);
    expect(collectDiagnosticText()).toBeNull();
    releaseDiagnosticOwner("agent-x");
    expect(collectDiagnosticText()).toContain("sub");
  });

  test("每次 collect 写一条 LspDiagnostics：注入、被过滤为空都有记录，子代理带 agent_id", async () => {
    initializeLSP("/nonexistent-workspace-xyz");
    await waitInitSuccess();
    const got: Record<string, unknown>[] = [];
    setLspDiagnosticsTraceSink((d) => got.push(d));
    const reg = getDiagnosticRegistry()!;

    ownByMain(reg, "file:///a.ts");
    reg.registerPending("ts", [{ uri: "file:///a.ts", diagnostics: [diag("only-hint", "Hint")] }]);
    expect(collectDiagnosticText()).toBeNull();

    reg.endEdit("file:///s.ts", reg.beginEdit("file:///s.ts", "agent-y"));
    reg.registerPending("ts", [{ uri: "file:///s.ts", diagnostics: [diag("e", "Error")] }]);
    expect(collectDiagnosticText("agent-y")).not.toBeNull();

    // 什么都没发生的轮次不写
    collectDiagnosticText();

    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ outcome: "info_only", omitted_info: 1, injected: 0 });
    expect(got[0]).not.toHaveProperty("agent_id");
    expect(got[1]).toMatchObject({ outcome: "injected", injected: 1, agent_id: "agent-y" });
  });
});

describe("syncFileToLSP：旧诊断必须在第一个 await 之前清掉", () => {
  test("fire-and-forget 调用后立即 collect，拿不到编辑前的诊断", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-sync-"));
    try {
      const file = join(dir, "x.ts");
      writeFileSync(file, "const a = 1;\n");
      initializeLSP("/nonexistent-workspace-xyz");
      await waitInitSuccess();
      const reg = getDiagnosticRegistry()!;
      const uri = pathToFileURL(file).href;
      ownByMain(reg, uri);
      reg.registerPending("ts", [{ uri, diagnostics: [diag("before-edit", "Error")] }]);

      // 与 query/tool-executor 一样不 await：下一轮 collect 可能跑在读盘之前
      const pending = syncFileToLSP(file);
      expect(collectDiagnosticText()).toBeNull();
      // 同步窗口内到达的推送基于旧内容，丢弃
      reg.registerPending("ts", [{ uri, diagnostics: [diag("during-sync", "Error")] }]);
      await pending;
      expect(collectDiagnosticText()).toBeNull();
      // 窗口结束后的推送正常投递
      reg.registerPending("ts", [{ uri, diagnostics: [diag("after-sync", "Error")] }]);
      expect(collectDiagnosticText()).toContain("after-sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
