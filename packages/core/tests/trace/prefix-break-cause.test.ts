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

/**
 * 带 transient 块的消息 —— 复刻 `query/reminder-inject.ts` 的注入形态：
 * 用户原文 + 一个 `transient: true` 的 reminder 块（只进发送副本，不写回历史）。
 */
const uTransient = (t: string, reminder = "<system-reminder>召回记忆</system-reminder>") => ({
  role: "user",
  content: [
    { type: "text", text: t },
    { type: "text", text: reminder, transient: true },
  ],
});

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

/**
 * CP-9（P2）：transient 块被丢弃时不再记 `none_local`。
 *
 * 修前：`reminderParts` 注入的块只进发送副本（`query/reminder-inject.ts` 打
 * `transient: true`），下一轮自然消失 → 字节检测器报断裂，而主循环如实上报的
 * `send_mutation_causes` 是空数组（ContextManager 确实没改写），于是落成
 * `none_local`——把 harness 自己的已知行为记成「本地没有原因」。
 *
 * 修后：探针自己从相邻两轮的指纹里看到「这条消息上轮带 transient 块、这轮没了」，
 * 归因 `transient_dropped`。它不依赖主循环上报，所以子代理路径同样生效。
 */
describe("CP-9 — transient 块被丢弃的归因", () => {
  test("上轮第 0 条消息带 transient 块、本轮没有 ⇒ cause=[transient_dropped]", async () => {
    await round([uTransient("q1"), a("r1"), u("q2")], []);
    await round([u("q1"), a("r1"), u("q2")], []);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken).toHaveLength(1);
    expect(broken[0].cause).toEqual(["transient_dropped"]);
    // 断点确实落在那条消息上（否则这条归因就没有依据）
    expect(broken[0].first_changed_message_index).toBe(0);
  });

  test("两侧都带 transient 块（只是内容变了）⇒ 不算丢弃，回到 none_local", async () => {
    await round([uTransient("q1", "<system-reminder>A</system-reminder>"), a("r1"), u("q2")], []);
    await round([uTransient("q1", "<system-reminder>B</system-reminder>"), a("r1"), u("q2")], []);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken[0].cause).toEqual(["none_local"]);
  });

  test("主循环上报了具体原因 ⇒ 以主循环为准（transient 丢弃只兜底 none_local）", async () => {
    await round([uTransient("q1"), a("r1"), u("q2")], []);
    await round([u("q1"), a("r1"), u("q2")], ["masking"]);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken[0].cause).toEqual(["masking"]);
  });

  test("未上报（子代理路径）但探针看到 transient 丢弃 ⇒ 仍落 transient_dropped", async () => {
    await round([uTransient("q1"), a("r1"), u("q2")]);
    await round([u("q1"), a("r1"), u("q2")]);
    const broken = prefixBreaks().filter((r) => r.broken === true);
    expect(broken[0].cause).toEqual(["transient_dropped"]);
  });
});
