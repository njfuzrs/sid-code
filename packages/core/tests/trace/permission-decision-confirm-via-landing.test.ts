/**
 * T4 落盘：`PermissionDecision.confirm_via` 必须真的写进 events.jsonl。
 *
 * `permission-confirm-via.test.ts` 只断言到观察者入参（`confirmVia` 字段），
 * 守不到 collector 的字段映射——2026-11-08 G2 bridge 探针实测 events.jsonl 里恒无
 * `confirm_via`：生产端、消费端都对，断在 collector 这一行。本文件走真 collector 落盘。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setPermissionDecisionObserver,
  setConfirmVia,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionAllow, logPermissionDeny } from "@sid-code/core/analytics/events.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";

describe("collector 落盘 confirm_via", () => {
  let dir: string;
  const savedIndex = process.env.SID_CODE_SESSION_INDEX;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-confirm-via-"));
    process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  });
  afterEach(() => {
    setPermissionDecisionObserver(null);
    setConfirmVia(null);
    if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = savedIndex;
    rmSync(dir, { recursive: true, force: true });
  });

  test("人工确认的 allow / deny 带 confirm_via，规则放行的不带", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-cv");
    hooks.setCwd("/tmp/test");
    const trajDir = join(dir, "trajectories");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    // 空白会话会被清掉：补一轮模型调用（同 permission-decision-agent-id-s10.test.ts）
    await hooks.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    await hooks.fireAfterModelEvent(
      { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
      {
        content_blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      } as never,
    );

    setConfirmVia("bridge");
    logPermissionAllow("bash", { source: "user", needsPrompt: true, context: "main" });
    setConfirmVia("bridge");
    logPermissionDeny("bash", { source: "user", needsPrompt: true, context: "main" });
    logPermissionAllow("read", { source: "rule", needsPrompt: false, context: "main" });
    await hooks.fireSessionEndEvent("exit");

    const decisions = readFileSync(join(trajDir, "sessions", "sess-cv", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "PermissionDecision");
    expect(decisions.map((d) => [d.data.outcome, d.data.confirm_via])).toEqual([
      ["allow", "bridge"],
      ["deny", "bridge"],
      ["allow", undefined],
    ]);
    expect(Object.keys(decisions[2].data)).not.toContain("confirm_via");
  });
});
