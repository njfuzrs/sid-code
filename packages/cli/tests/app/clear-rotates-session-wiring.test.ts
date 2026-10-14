/**
 * 门禁 · /clear 换会话的 App 接线（与 side-call-stats-resume-wiring.test.ts 同一种静态门禁）
 *
 * clearConversation 是 10000+ 行 App 的私有路径、依赖整套运行时，没有行为层接缝；
 * core 侧契约（rotate / collector 换目录 / store 新文件）在
 * packages/core/tests/trace/clear-rotates-session.test.ts 覆盖。这里锁 App 侧的顺序与完整性：
 *
 *   - 两条命令入口都走 clearConversation（此前各写一份，重置项早已漂移）；
 *   - SessionEnd(clear) 与 finalizeSessionStore **先于** rotate —— 否则旧会话成本记成 0；
 *   - 新 id 下发到所有持有方；新 jsonl 带 parent；SessionStart(clear) 带 parentSessionId。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

function body(marker: string, len = 12_000): string {
  const i = appSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  return appSrc.slice(i, i + len);
}

describe("/clear 换会话接线", () => {
  test("两条命令入口都只调用 clearConversation", () => {
    const cases = appSrc.split('case "clear":').slice(1);
    expect(cases.length).toBe(2);
    for (const c of cases) {
      const head = c.slice(0, 400);
      expect(head).toContain("await this.clearConversation();");
      // 不允许入口里再各自散写重置项
      expect(head).not.toContain("this.ctxMgr.clear()");
      expect(head).not.toContain("resetCounters()");
    }
  });

  test("顺序：SessionEnd(clear) → finalizeSessionStore → 清状态 → rotate → startSession → SessionStart(clear)", () => {
    const b = body("private async clearConversation(");
    const idx = (s: string) => {
      const i = b.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const end = idx('fireSessionEndEvent("clear", this.buildSessionEndStats())');
    const fin = idx("this.finalizeSessionStore();");
    const clr = idx("this.ctxMgr.clear();");
    const rot = idx("this.sessionState.rotate(newSessionId);");
    const start = idx("this.sessionStore?.startSession(");
    const restart = idx(
      'fireSessionRestartEvent("clear", this.config.model, { parentSessionId: oldSessionId })',
    );
    expect(end).toBeLessThan(fin);
    expect(fin).toBeLessThan(clr);
    expect(clr).toBeLessThan(rot);
    expect(rot).toBeLessThan(start);
    expect(start).toBeLessThan(restart);
  });

  test("保留改动前的全部会话级重置项（一项不少）", () => {
    const b = body("private async clearConversation(");
    for (const s of [
      "resetSessionSideStats();",
      "this.sessionState.resetReminderDedupKeys();",
      "clearPromptCache();",
      "this.resetRecallState();",
      "this.quotaManager?.resetAlertLevel();",
      "this.fallback.reset();",
      "this.resetTodoTool();",
      "this.resetHypothesisLedger();",
      "this.permissionChecker?.resetDenialTracking?.();",
      "this.clearInactiveBackgroundTasks();",
      "this.rewindManager?.clear();",
      "this.goalState = null;",
      "this.jitContextMgr.reset();",
      "this.reportedJitFailures.clear();",
      "this.refreshMemoryTokenAccounting();",
      "resetCacheDetection();",
      "clearCacheBreaks();",
      "resetCircuitBreaker();",
      "resetTTLLatch();",
      "resetBetaHeaders();",
      "clearMessageQueue();",
      "this.announcedMcpServers.clear();",
    ]) {
      expect(b).toContain(s);
    }
  });

  test("新 id 下发到所有持有方", () => {
    const b = body("private rotateSessionIdentity(", 4000);
    for (const s of [
      "this.sessionIdForCompact = newSessionId;",
      "this.config.sessionId = newSessionId;",
      "this.ctxMgr.setSessionId(newSessionId);",
      "this.hookSystem.setSessionId(newSessionId);",
      "getSessionMetrics().setSessionId(newSessionId);",
      "this.wireSubAgentSessionId();",
      "applySessionContext",
      "PidManager.write(newSessionId);",
      "setSessionId(newSessionId);",
      "renameActiveSession(oldSessionId, newSessionId",
      "setCurrentSessionId(newSessionId);",
      "primeMetadata({ sessionId: newSessionId });",
      "b.setSessionId?.(newSessionId)",
    ]) {
      expect(b).toContain(s);
    }
  });

  test("clear 后不再续写被 resume / fork 的旧会话；Session Memory 与标题按新会话重建", () => {
    const b = body("private async clearConversation(");
    expect(b).toContain("this.resumedSessionId = null;");
    expect(b).toContain("this.forkedFromSessionId = null;");
    expect(b).toContain("await this.wireSessionMemory();");
    expect(b).toContain("this.resetSessionTitle?.();");
  });
});
