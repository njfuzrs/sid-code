/**
 * HB-4：注册表外引导规则与边界检查补触发事件（`query/guidance-events.ts`）。
 *
 * 这批规则此前只写 logger，「触发了」和「不存在」在轨迹里长得一模一样。
 * 三层缺一不可：
 * - 行为侧：真实发射点触发时事件真的发出，字段是闭集标签、不带内容原文；
 * - 不触发时不发（分母从别处取，误发会污染触发率）；
 * - 接线侧：App 把 sink 接到 collector —— 不接则生产上恒 0（EditFailureReminder 曾经的形态）。
 *
 * loop 内的两条（ContextPressureReminder / GoalReminderInjected）走 deps.traceAppendEvent，
 * 登记由 defense-registry-complete.test.ts 守，这里只钉源码接线。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  setGuidanceEventSink,
  OMISSION_REJECTED_EVENT_NAME,
  TOOL_RESULT_CLEARED_EVENT_NAME,
  WEB_FETCH_MODEL_URL_EVENT_NAME,
  MEMORY_GUARD_EVENT_NAME,
  CREDENTIAL_IN_CONTEXT_EVENT_NAME,
  emitCredentialInContext,
} from "@sid-code/core/query/guidance-events.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { WebFetchTool } from "@sid-code/core/tool/web-fetch.ts";
import {
  __resetUrlProvenance,
  recordUserMentionedUrls,
} from "@sid-code/core/tool/url-provenance.ts";
import { applyToolResultBudget } from "@sid-code/core/query/compact/tool-result-budget.ts";
import { microcompactMessages } from "@sid-code/core/query/compact/microcompact.ts";
import { logMemoryGuard } from "@sid-code/core/analytics/events.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const TMP = join(os.tmpdir(), `sid-code-guidance-events-${process.pid}`);
let events: Array<{ event: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  events = [];
  setGuidanceEventSink((event, data) => events.push({ event, data }));
  __resetUrlProvenance();
});

afterEach(() => {
  setGuidanceEventSink(null);
  rmSync(TMP, { recursive: true, force: true });
});

const OMITTED_CODE = [
  "function a() {",
  "  return 1;",
  "}",
  "// ... existing code ...",
  "function b() {",
  "  return 2;",
  "}",
  "function c() {",
  "  return 3;",
  "}",
  "function d() {",
  "  return 4;",
  "}",
].join("\n");

describe("OmissionRejected（T8）", () => {
  test("write 被拒时发事件：只带文件名与规则名，不带命中行原文", async () => {
    const file = join(TMP, "a.ts");
    const r = await new WriteTool().execute({ file_path: file, content: OMITTED_CODE });
    expect(r.isError).toBe(true);
    const hits = events.filter((e) => e.event === OMISSION_REJECTED_EVENT_NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.data).toMatchObject({ tool_name: "write", file: "a.ts", match_count: 1 });
    expect((hits[0]!.data.patterns as string[]).length).toBe(1);
    expect(JSON.stringify(hits[0]!.data)).not.toContain("existing code");
    expect(JSON.stringify(hits[0]!.data)).not.toContain(TMP);
  });

  test("edit 被拒时发事件（new_string > 10 行）", async () => {
    const file = join(TMP, "b.ts");
    writeFileSync(file, "const x = 1;\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "const x = 1;",
      new_string: OMITTED_CODE,
    });
    expect(r.isError).toBe(true);
    const hits = events.filter((e) => e.event === OMISSION_REJECTED_EVENT_NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.data).toMatchObject({ tool_name: "edit", file: "b.ts" });
  });

  test("正常写入不发事件", async () => {
    const r = await new WriteTool().execute({
      file_path: join(TMP, "ok.ts"),
      content: "export const ok = 1;\n",
    });
    expect(r.isError).toBeFalsy();
    expect(events.filter((e) => e.event === OMISSION_REJECTED_EVENT_NAME)).toHaveLength(0);
  });
});

function toolPair(id: string, content: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "bash", input: { command: "ls" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ] as Message[];
}

describe("ToolResultCleared（C1/C2）", () => {
  test("tool_result_budget 截断时带被清的 tool_use_id", () => {
    const msgs = [...toolPair("t1", "x".repeat(200_000)), ...toolPair("t2", "small")];
    const r = applyToolResultBudget(msgs, { preserveRecentCount: 0 });
    expect(r.truncatedCount).toBe(1);
    const hits = events.filter((e) => e.event === TOOL_RESULT_CLEARED_EVENT_NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.data).toMatchObject({
      stage: "tool_result_budget",
      cleared: 1,
      tool_use_ids: ["t1"],
    });
    expect(hits[0]!.data.saved_chars as number).toBeGreaterThan(100_000);
  });

  test("没截断就不发", () => {
    applyToolResultBudget(toolPair("t1", "small"), { preserveRecentCount: 0 });
    expect(events.filter((e) => e.event === TOOL_RESULT_CLEARED_EVENT_NAME)).toHaveLength(0);
  });

  test("microcompact 清理时 stage=microcompact，ids 与清理数一致", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) msgs.push(...toolPair(`m${i}`, `out-${i}-` + "y".repeat(5_000)));
    const r = microcompactMessages(msgs);
    const hits = events.filter((e) => e.event === TOOL_RESULT_CLEARED_EVENT_NAME);
    // 只读 bash（ls）可丢弃，24 条消息超出保留窗口 6 条：必然有清理，不许用 if 包住断言
    expect(r.compactedCount).toBeGreaterThan(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.data.stage).toBe("microcompact");
    expect((hits[0]!.data.tool_use_ids as string[]).length).toBe(r.compactedCount);
    expect(hits[0]!.data.cleared).toBe(r.compactedCount);
  });
});

describe("WebFetchModelUrl（B18）", () => {
  test("模型自造 URL 发事件，只记 origin 不记路径与查询串", async () => {
    const tool = new WebFetchTool();
    const r = await tool.checkPermissions(
      { url: "https://evil.example.com/c?d=secret-payload" },
      {} as never,
    );
    expect(r.behavior).toBe("passthrough");
    const hits = events.filter((e) => e.event === WEB_FETCH_MODEL_URL_EVENT_NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.data.origin).toBe("https://evil.example.com");
    expect(JSON.stringify(hits[0]!.data)).not.toContain("secret-payload");
  });

  test("用户提及过的 URL 放行且不发事件", async () => {
    recordUserMentionedUrls("看下 https://docs.foo.com/guide");
    const r = await new WebFetchTool().checkPermissions(
      { url: "https://docs.foo.com/guide" },
      {} as never,
    );
    expect(r.behavior).toBe("allow");
    expect(events.filter((e) => e.event === WEB_FETCH_MODEL_URL_EVENT_NAME)).toHaveLength(0);
  });
});

describe("MemoryGuard（B18）", () => {
  test("logMemoryGuard 同时进本地轨迹，字段与 analytics 同名", () => {
    logMemoryGuard({ kind: "secret_rejected", via: "write_edit" });
    logMemoryGuard({ kind: "scope_denied", via: "save_memory", scope: "team" });
    const hits = events.filter((e) => e.event === MEMORY_GUARD_EVENT_NAME);
    expect(hits.map((h) => h.data)).toMatchObject([
      { guard_kind: "secret_rejected", guard_via: "write_edit" },
      { guard_kind: "scope_denied", guard_via: "save_memory", memory_scope: "team" },
    ]);
    expect("memory_scope" in hits[0]!.data).toBe(false);
  });
});

describe("CredentialInContext（B18）", () => {
  test("kinds 去重，不带命中片段", () => {
    emitCredentialInContext({
      tool_use_id: "c1",
      hit_count: 3,
      kinds: ["aws_key", "aws_key", "pem"],
    });
    const hits = events.filter((e) => e.event === CREDENTIAL_IN_CONTEXT_EVENT_NAME);
    expect(hits[0]!.data).toMatchObject({
      tool_use_id: "c1",
      hit_count: 3,
      kinds: ["aws_key", "pem"],
    });
  });

  test("发射点在 tool-executor 的凭证检测分支里（与 SECURITY warn 同处）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/tool-executor.ts"), "utf8");
    const warnAt = src.indexOf("已进入上下文。");
    const emitAt = src.indexOf("emitCredentialInContext({");
    expect(warnAt).toBeGreaterThan(0);
    expect(emitAt).toBeGreaterThan(warnAt);
    expect(emitAt - warnAt).toBeLessThan(600);
  });
});

describe("sink 是旁路", () => {
  test("未接 sink 不抛；sink 抛错不影响调用方", async () => {
    setGuidanceEventSink(null);
    expect(() => emitCredentialInContext({ hit_count: 1, kinds: ["x"] })).not.toThrow();
    setGuidanceEventSink(() => {
      throw new Error("boom");
    });
    const r = await new WriteTool().execute({
      file_path: join(TMP, "c.ts"),
      content: OMITTED_CODE,
    });
    expect(r.isError).toBe(true);
  });
});

describe("接线", () => {
  test("App 在 collector 就绪后把 sink 接到 recordCustomEvent(event, data)", () => {
    const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(app).toMatch(
      /setGuidanceEventSink\(\s*traceCollectorInstance\s*\?\s*\(event,\s*data\)\s*=>\s*traceCollectorInstance\.recordCustomEvent\(event,\s*data\)/,
    );
  });

  test("loop 的两条回注在 push 之后紧跟事件（P12 / P14）", () => {
    const loop = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf8");
    const p12 = loop.indexOf("reminderParts.push(pressureReminder);");
    expect(loop.indexOf('"ContextPressureReminder", {', p12) - p12).toBeLessThan(300);
    const p14 = loop.indexOf("reminderParts.push(buildGoalReminder(goal));");
    expect(loop.indexOf('"GoalReminderInjected", {', p14) - p14).toBeLessThan(500);
  });
});
