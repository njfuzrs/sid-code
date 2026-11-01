/**
 * 能力自愈的归因与保留（docs-research 20261101「学到的能力被目录覆盖与结构兜底误归因」）。
 *
 * 三组不变量：
 *   T1 结构兜底（只凭 HTTP 4xx）只重试、不立即记账；措辞点名才立即记账；同进程连续 3 次结构兜底才升级落盘。
 *   T2 有效期内的学习结果（healed / probe）不被目录同步覆盖，过期后目录重新说了算；跨进程 persist 同理。
 *   T3 每次自愈出一条 CapabilityHealed 轨迹事件，带 trigger / recorded。
 *
 * 落盘隔离：每个用例把 SID_CONFIG_DIR 指到 mkdtemp 目录，afterEach 存/恢复原值。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetCapabilityCacheForTest,
  __applyCatalogEntryForTest,
  __getCapabilityCacheForTest,
  __persistForTest,
  __SCHEMA_VERSION_FOR_TEST as SCHEMA_VERSION,
  learnFromError,
  lookupCapability,
  recordEffortRejected,
  recordHealOutcome,
} from "@sid-code/core/llm/model-capabilities.ts";
import {
  setCapabilityHealedObserver,
  type CapabilityHealedEvent,
} from "@sid-code/core/llm/capability-heal-telemetry.ts";

let tmpDir: string;
let prevConfigDir: string | undefined;
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "cap-heal-attr-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetCapabilityCacheForTest({});
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  setCapabilityHealedObserver(null);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetCapabilityCacheForTest({});
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

/** 带 effort → 400（errorText）；不带 → 200。返回请求体列表 */
function mockEffortRejecting(errorText: string): any[] {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning_effort !== undefined) {
      return new Response(JSON.stringify({ error: { message: errorText } }), { status: 400 });
    }
    return new Response(OK_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  return bodies;
}

async function sendNonStream(model: string): Promise<void> {
  const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
  const provider = new OpenAIProvider("k", model, "https://example.invalid/v1");
  await provider.sendMessageNonStreaming({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 16,
    reasoningEffort: "high",
  } as any);
}

// ─────────────────────────────────────────────────────────────
// T1
// ─────────────────────────────────────────────────────────────

describe("T1 结构兜底只重试，不记账", () => {
  test("结构兜底触发 + 重试成功 → 缓存无 healed 条目（但重试确实发生）", async () => {
    const bodies = mockEffortRejecting("Invalid request body");
    await sendNonStream("gw-structural");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(lookupCapability("gw-structural")).toBeNull();
  });

  test("措辞点名 + 重试成功 → 缓存有 healed、effortValues: []", async () => {
    mockEffortRejecting("Unrecognized request argument supplied: reasoning_effort");
    await sendNonStream("gw-wording");
    const entry = lookupCapability("gw-wording");
    expect(entry?.source).toBe("healed");
    expect(entry?.effortValues).toEqual([]);
  });

  test("结构兜底同进程连续 3 次 → 第 3 次落盘", async () => {
    mockEffortRejecting("Invalid request body");
    await sendNonStream("gw-repeat");
    await sendNonStream("gw-repeat");
    expect(lookupCapability("gw-repeat")).toBeNull();
    await sendNonStream("gw-repeat");
    expect(lookupCapability("gw-repeat")?.effortValues).toEqual([]);
    // 确实写到了磁盘（隔离目录）
    const disk = JSON.parse(readFileSync(sidPaths.modelCapabilities(), "utf8"));
    expect(disk.models["gw-repeat"]?.source).toBe("healed");
  });

  test("重试失败打断连续计数：2 次成功 + 1 次失败 + 1 次成功 → 仍不记账", () => {
    expect(recordHealOutcome("m", "structural", true)).toBe(false);
    expect(recordHealOutcome("m", "structural", true)).toBe(false);
    expect(recordHealOutcome("m", "structural", false)).toBe(false);
    expect(recordHealOutcome("m", "structural", true)).toBe(false);
    expect(lookupCapability("m")).toBeNull();
  });

  test("流式路径同口径：结构兜底 + 重试成功 → 不记账", async () => {
    const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
    let calls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++;
      const body = JSON.parse(init.body);
      if (body.reasoning_effort !== undefined) {
        return new Response(JSON.stringify({ error: { message: "Invalid request body" } }), {
          status: 400,
        });
      }
      const sse =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as any;
    const healed: CapabilityHealedEvent[] = [];
    setCapabilityHealedObserver((e) => healed.push(e));

    const provider = new OpenAIProvider("k", "gw-stream", "https://example.invalid/v1");
    const events: any[] = [];
    for await (const ev of provider.sendMessageStream({
      model: "gw-stream",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 16,
      reasoningEffort: "high",
    } as any)) {
      events.push(ev);
    }
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(lookupCapability("gw-stream")).toBeNull();
    expect(healed).toEqual([
      {
        model: "gw-stream",
        trigger: "structural",
        statusCode: 400,
        stripped: ["reasoning_effort"],
        recorded: false,
        retryOk: true,
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// T2
// ─────────────────────────────────────────────────────────────

describe("T2 有效期内学到的能力压过目录", () => {
  test("场景 C：学到的 [] 不被目录 [low,high] 覆盖", () => {
    __resetCapabilityCacheForTest({ "foo-model": { source: "catalog", contextWindow: 128000 } });
    recordEffortRejected("foo-model");
    __applyCatalogEntryForTest("foo-model", {
      source: "catalog",
      effortValues: ["low", "high"],
      supportsReasoning: true,
      contextWindow: 200000,
      fetchedAt: 3,
    });
    const e = __getCapabilityCacheForTest()["foo-model"]!;
    expect(e.source).toBe("healed");
    expect(e.effortValues).toEqual([]);
    expect(e.supportsReasoning).toBe(false);
    // 学习路径不写的字段照常随目录更新
    expect(e.contextWindow).toBe(200000);
  });

  test("场景 E：服务端自报的更严档位不被目录并集覆盖", () => {
    __resetCapabilityCacheForTest({
      "luna-x": { source: "catalog", effortValues: ["minimal", "low", "medium", "high"] },
    });
    learnFromError(
      "luna-x",
      "Invalid value for 'reasoning_effort': supported values are 'low', 'medium', and 'high'.",
    );
    __applyCatalogEntryForTest("luna-x", {
      source: "catalog",
      effortValues: ["minimal", "low", "medium", "high"],
      fetchedAt: 9,
    });
    const e = __getCapabilityCacheForTest()["luna-x"]!;
    expect(e.source).toBe("healed");
    expect(e.effortValues).toEqual(["low", "medium", "high"]);
  });

  test("目录只补学习结果没有的字段", () => {
    __resetCapabilityCacheForTest({
      p: { source: "probe", effortValues: ["low"], fetchedAt: Date.now() },
    });
    __applyCatalogEntryForTest("p", {
      source: "catalog",
      effortValues: ["low", "high"],
      maxOutputTokens: 8192,
    });
    const e = __getCapabilityCacheForTest()["p"]!;
    expect(e.source).toBe("probe");
    expect(e.effortValues).toEqual(["low"]);
    expect(e.maxOutputTokens).toBe(8192);
  });

  test("healed 条目超出 7 天有效期 → 目录 patch 覆盖", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    __resetCapabilityCacheForTest({
      old: {
        source: "healed",
        effortValues: [],
        supportsReasoning: false,
        fetchedAt: eightDaysAgo,
      },
    });
    __applyCatalogEntryForTest("old", {
      source: "catalog",
      effortValues: ["low", "high"],
      supportsReasoning: true,
    });
    const e = __getCapabilityCacheForTest()["old"]!;
    expect(e.source).toBe("catalog");
    expect(e.effortValues).toEqual(["low", "high"]);
    expect(e.supportsReasoning).toBe(true);
  });

  test("跨进程 persist：磁盘是 healed、内存是 catalog → 落盘不覆盖学习字段", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.modelCapabilities(),
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        models: {
          shared: {
            source: "healed",
            effortValues: [],
            supportsReasoning: false,
            fetchedAt: Date.now(),
          },
        },
      }),
      "utf8",
    );
    // 本进程载入时还是目录值（载入早于另一进程的自愈）
    __resetCapabilityCacheForTest({
      shared: {
        source: "catalog",
        effortValues: ["low", "high"],
        supportsReasoning: true,
        contextWindow: 64000,
        fetchedAt: 1,
      },
    });
    __persistForTest();
    const disk = JSON.parse(readFileSync(sidPaths.modelCapabilities(), "utf8"));
    expect(disk.models.shared.source).toBe("healed");
    expect(disk.models.shared.effortValues).toEqual([]);
    expect(disk.models.shared.supportsReasoning).toBe(false);
    expect(disk.models.shared.contextWindow).toBe(64000);
  });
});

// ─────────────────────────────────────────────────────────────
// T3
// ─────────────────────────────────────────────────────────────

describe("T3 自愈出轨迹事件", () => {
  test("结构兜底重放 → 轨迹 events.jsonl 出现一条 CapabilityHealed，recorded: false", async () => {
    const { TraceCollector } = await import("@sid-code/core/trace/collector.ts");
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const outDir = join(tmpDir, "trace");
    mkdirSync(outDir, { recursive: true });
    const hs = new HookSystem();
    hs.setSessionId("sess-heal");
    hs.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: outDir });
    collector.registerHooks(hs);
    await hs.fireSessionStartEvent("startup", { model: "claude-test" });
    hs.setSessionId("sess-heal");

    mockEffortRejecting("400 Bad Request");
    await sendNonStream("gw-traj");

    const lines = readFileSync(join(outDir, "sessions", "sess-heal", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "CapabilityHealed");
    expect(lines.map((e) => e.data)).toEqual([
      {
        model: "gw-traj",
        trigger: "structural",
        status_code: 400,
        stripped: ["reasoning_effort"],
        recorded: false,
        retry_ok: true,
      },
    ]);
  });

  test("剥字段重试仍失败 → 事件 retryOk: false、recorded: false", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid request body" } }), {
        status: 400,
      })) as any;
    const healed: CapabilityHealedEvent[] = [];
    setCapabilityHealedObserver((e) => healed.push(e));
    await expect(sendNonStream("gw-fail")).rejects.toThrow();
    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({ trigger: "structural", retryOk: false, recorded: false });
  });
});
