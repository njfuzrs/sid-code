/**
 * 发现 14（20261020-110542-ce7ea52e 会话评估）：`prefix_break` 落盘时带本地改写来源 `cause`。
 *
 * 291 次前缀断裂里 129 次之前没有任何注入事件，只能做弱相关统计。主循环现在把
 * ContextManager 自报的来源（compact / masking / cleaned）随 BeforeModel 交给采集器，
 * 只在 broken 时落；未上报时字段缺失（「没采集」≠「本地没改」）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;
let hs: HookSystem;

async function round(messages: unknown[], causes?: Array<"compact" | "masking" | "cleaned">) {
  await hs.fireBeforeModelEvent({
    model: "m",
    messages: [],
    raw_messages: messages,
    system: "sys",
    tools: [],
    ...(causes !== undefined ? { send_mutation_causes: causes } : {}),
  });
  await hs.fireAfterModelEvent(
    { model: "m", messages: [], raw_messages: messages, system: "sys" },
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 1 },
    } as any,
  );
}

function prefixBreaks(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(testDir, "sessions", "sess-pb", "events.jsonl"), "utf-8");
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "prefix_break")
    .map((e) => e.data);
}

const u = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

beforeEach(async () => {
  testDir = join(tmpdir(), `pb-cause-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  hs = new HookSystem();
  hs.setSessionId("sess-pb");
  hs.setCwd("/tmp/test");
  new TraceCollector({ outputDir: testDir }).registerHooks(hs);
  await hs.fireSessionStartEvent("startup", { model: "m" });
});

describe("发现 14 — prefix_break.cause", () => {
  test("中部被改写 + 上报 masking ⇒ cause=[masking]", async () => {
    await round([u("q1"), a("长输出原文"), u("q2")], []);
    await round([u("q1"), a("[tool_output_masked]"), u("q2"), a("x"), u("q3")], ["masking"]);
    const rows = prefixBreaks();
    const broken = rows.filter((r) => r.broken === true);
    expect(broken).toHaveLength(1);
    expect(broken[0].cause).toEqual(["masking"]);
  });

  test("断裂但本地未改写 ⇒ cause=[none_local]（断裂来自 reminder / 服务端等别处）", async () => {
    await round([u("q1"), a("r1"), u("q2")], []);
    await round([u("q1-带注入"), a("r1"), u("q2")], []);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken[0].cause).toEqual(["none_local"]);
  });

  test("未上报（子代理 / 老版本路径）⇒ 不落 cause 字段", async () => {
    await round([u("q1"), a("r1"), u("q2")]);
    await round([u("q1改"), a("r1"), u("q2")]);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken[0]).not.toHaveProperty("cause");
  });

  test("未断裂 ⇒ 不落 cause（与其他 broken-only 字段同口径）", async () => {
    await round([u("q1")], ["compact"]);
    await round([u("q1"), a("r1"), u("q2")], ["cleaned"]);
    const rows = prefixBreaks();
    expect(rows.every((r) => r.broken === false)).toBe(true);
    expect(rows[0]).not.toHaveProperty("cause");
  });
});
