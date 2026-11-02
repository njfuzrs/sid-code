/**
 * 记忆横向剖析第五部分 T1–T3 落地测试
 *
 * - T1.1 读计数：旁路 `.read-stats.json`，只记条目不记索引 / team
 * - T1.2 byAgent：主循环不进表、resume 基线 + 本进程、账本行落字段
 * - T2 节流：interval=1 行为不变；interval=N 只在 seq%N==0 跑；收尾补跑积压
 * - T3 容量：截断态下后台代理只能更新已有 key（save_memory 与 write 两条路）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { recordMemoryRead, readMemoryReadStats } from "@sid-code/core/memory/read-stats.ts";
import { getAutoMemPath } from "@sid-code/core/memory/paths.ts";
import {
  recordAgentUsage,
  getSessionAgentUsage,
  hydrateAgentUsageBaseline,
  resetAgentUsageProcess,
  resetAgentUsageSession,
  setAgentUsageCostCalculator,
} from "@sid-code/core/telemetry/agent-usage.ts";
import {
  initExtractMemories,
  resolveMemoryExtractInterval,
  sortManifestHeaders,
} from "@sid-code/core/memory/extract/extractor.ts";
import { createExtractPermissions } from "@sid-code/core/memory/extract/permissions.ts";
import { buildExtractPrompt } from "@sid-code/core/memory/extract/prompts.ts";
import {
  readIndexCapacity,
  formatIndexCapacity,
  isExistingMemoryKey,
  listExistingMemoryKeys,
} from "@sid-code/core/memory/index-capacity.ts";
import { INDEX_TRUNCATION_NOTICE } from "@sid-code/core/memory/index-budget.ts";
import type { MemoryHeader } from "@sid-code/core/memory/types.ts";

let tmpHome: string;
let prevHome: string | undefined;
let prevInterval: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mq-"));
  prevHome = process.env.SID_CONFIG_DIR;
  prevInterval = process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL;
  process.env.SID_CONFIG_DIR = tmpHome;
  delete process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL;
  __resetAnalyticsForTest();
  resetAgentUsageSession();
  setAgentUsageCostCalculator(null);
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  __resetAnalyticsForTest();
  resetAgentUsageSession();
  setAgentUsageCostCalculator(null);
  if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevHome;
  if (prevInterval === undefined) delete process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL;
  else process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL = prevInterval;
  rmSync(tmpHome, { recursive: true, force: true });
});

function captureEvents(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

function mem(dir: string, file: string, name: string, type = "project"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nname: ${name}\ndescription: d\ntype: ${type}\n---\n\nbody\n`,
  );
}

// ─── T1.1 ───────────────────────────────────────────────────────

describe("T1.1 记忆读计数", () => {
  test("记条目、累加次数、键为相对路径；不改记忆文件 mtime", async () => {
    const cwd = join(tmpHome, "proj");
    const dir = getAutoMemPath(cwd);
    mem(dir, "feedback_a.md", "a", "feedback");
    mem(join(dir, "sub"), "b.md", "b");
    const before = statSync(join(dir, "feedback_a.md")).mtimeMs;

    const hit = { scope: "project", isIndex: false };
    await recordMemoryRead(join(dir, "feedback_a.md"), hit, { cwd, now: 1000 });
    await recordMemoryRead(join(dir, "feedback_a.md"), hit, { cwd, now: 2000 });
    await recordMemoryRead(join(dir, "sub", "b.md"), hit, { cwd, now: 3000 });

    const stats = readMemoryReadStats(dir);
    expect(stats["feedback_a.md"]).toEqual({ lastRead: 2000, readCount: 2 });
    expect(stats["sub/b.md"]).toEqual({ lastRead: 3000, readCount: 1 });
    // 旁路文件方案的核心理由：不碰记忆文件本身（freshness / FileReadTracker 不受影响）
    expect(statSync(join(dir, "feedback_a.md")).mtimeMs).toBe(before);
  });

  test("并发读不丢计数（进程内串行）", async () => {
    const cwd = join(tmpHome, "proj");
    const dir = getAutoMemPath(cwd);
    mem(dir, "x.md", "x");
    const hit = { scope: "project", isIndex: false };
    await Promise.all(
      Array.from({ length: 8 }, () => recordMemoryRead(join(dir, "x.md"), hit, { cwd })),
    );
    expect(readMemoryReadStats(dir)["x.md"]?.readCount).toBe(8);
  });

  test("索引本身与 team scope 不记", async () => {
    const cwd = join(tmpHome, "proj");
    const dir = getAutoMemPath(cwd);
    mem(dir, "x.md", "x");
    await recordMemoryRead(join(dir, "MEMORY.md"), { scope: "project", isIndex: true }, { cwd });
    await recordMemoryRead(join(dir, "x.md"), { scope: "team", isIndex: false }, { cwd });
    expect(existsSync(join(dir, ".read-stats.json"))).toBe(false);
  });

  test("旁路文件不会被当成记忆条目枚举", async () => {
    const cwd = join(tmpHome, "proj");
    const dir = getAutoMemPath(cwd);
    mem(dir, "x.md", "x");
    await recordMemoryRead(join(dir, "x.md"), { scope: "project", isIndex: false }, { cwd });
    const { enumerateMemoryFiles } = await import("@sid-code/core/memory/scan.ts");
    expect(await enumerateMemoryFiles(dir)).toEqual(["x.md"]);
  });
});

// ─── T1.2 ───────────────────────────────────────────────────────

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

describe("T1.2 按调用方聚合", () => {
  test("主循环（无 agentId）不进表；同 agent 累加；注入计价", () => {
    setAgentUsageCostCalculator((r) => (r.usage.inputTokens ?? 0) / 1000);
    recordAgentUsage({ model: "m", provider: "p", usage: usage(999, 1) });
    recordAgentUsage({
      agentId: "fork:memory-extract",
      model: "m",
      provider: "p",
      usage: usage(100, 10),
    });
    recordAgentUsage({
      agentId: "fork:memory-extract",
      model: "m",
      provider: "p",
      usage: usage(200, 20),
    });
    const m = getSessionAgentUsage()!;
    expect(Object.keys(m)).toEqual(["fork:memory-extract"]);
    expect(m["fork:memory-extract"]).toMatchObject({
      requests: 2,
      inputTokens: 300,
      outputTokens: 30,
    });
    expect(m["fork:memory-extract"]!.costUSD).toBeCloseTo(0.3, 10);
  });

  test("无记录时返回 undefined（账本不落空对象）", () => {
    expect(getSessionAgentUsage()).toBeUndefined();
  });

  test("resume：基线 + 本进程；SessionStart 只清本进程不清基线", () => {
    expect(
      hydrateAgentUsageBaseline({
        "fork:memory-extract": { requests: 5, inputTokens: 500, outputTokens: 50, costUSD: 1 },
      }),
    ).toBe(true);
    resetAgentUsageProcess(); // collector SessionStart 发生在回灌之后
    recordAgentUsage({
      agentId: "fork:memory-extract",
      model: "m",
      provider: "p",
      usage: usage(10, 1),
    });
    expect(getSessionAgentUsage()!["fork:memory-extract"]).toEqual({
      requests: 6,
      inputTokens: 510,
      outputTokens: 51,
      costUSD: 1,
    });
  });

  test("形态不合法的基线整条拒绝", () => {
    expect(
      hydrateAgentUsageBaseline({ a: { requests: -1, inputTokens: 0, outputTokens: 0 } }),
    ).toBe(false);
    expect(hydrateAgentUsageBaseline([1])).toBe(false);
    expect(getSessionAgentUsage()).toBeUndefined();
  });

  test("经 billing-sink 发生侧接线：去重后只记一次", async () => {
    const { recordBilledRequest, resetBillingSink } =
      await import("@sid-code/core/llm/billing-sink.ts");
    resetBillingSink();
    const req = {
      fetchId: "f-test-agent-usage",
      model: "m",
      provider: "p",
      usage: usage(7, 3),
      index: 1,
      agentId: "fork:memory-extract",
      callerLabel: "memory-extract",
      accounted: false,
    };
    recordBilledRequest(req);
    recordBilledRequest(req);
    expect(getSessionAgentUsage()!["fork:memory-extract"]?.requests).toBe(1);
    resetBillingSink();
  });
});

// ─── T2 ─────────────────────────────────────────────────────────

function fakeFork(calls: { n: number }, written: string[] = []) {
  return (async () => {
    calls.n++;
    return {
      messages: written.length
        ? [
            {
              role: "assistant" as const,
              content: written.map((k, i) => ({
                type: "tool_use" as const,
                id: `t${i}`,
                name: "save_memory",
                input: { key: k, value: "v", type: "feedback" },
              })),
            },
          ]
        : [],
      usage: usage(100, 5),
      turns: 1,
      deniedToolCalls: 0,
    };
  }) as any;
}

function handle(interval: number | undefined, calls: { n: number }, written: string[] = []) {
  const dir = join(tmpHome, "mem");
  mkdirSync(dir, { recursive: true });
  return initExtractMemories({
    getMainContext: () => ({ messages: [] }) as any,
    memoryDir: dir,
    canUseTool: () => ({ behavior: "allow" }),
    interval,
    runFork: fakeFork(calls, written),
  });
}

/**
 * 模拟 n 个 end_turn，每轮等在途 fork 跑完。
 * ⚠️ 不能用 drainPending 等：drain 就是「会话收尾」，会触发积压补跑。
 */
async function turns(h: ReturnType<typeof handle>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.executeExtract();
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("T2 抽取节流", () => {
  test("interval 缺省 = 每个 end_turn 都跑，收尾不补跑（行为不变）", async () => {
    const calls = { n: 0 };
    const h = handle(undefined, calls);
    await turns(h, 4);
    expect(calls.n).toBe(4);
    await h.drainPending(1000);
    expect(calls.n).toBe(4);
  });

  test("interval=3：只有第 3、6 个 end_turn 跑；被跳过的记 skipped{interval}", async () => {
    const seen = captureEvents();
    const calls = { n: 0 };
    const h = handle(3, calls, ["k"]);
    await turns(h, 6);
    expect(calls.n).toBe(2);
    const ev = seen.filter((e) => e.name === "memory_extract").map((e) => e.meta);
    const skipped = ev.filter((m) => m.extract_outcome === "skipped");
    expect(skipped.map((m) => m.seq)).toEqual([1, 2, 4, 5]);
    expect(skipped.every((m) => m.skip_reason === "interval")).toBe(true);
    const ran = ev.filter((m) => m.extract_outcome === "ran");
    expect(ran.map((m) => m.seq)).toEqual([3, 6]);
    expect(ran[0]).toMatchObject({ written: 1, input_tokens: 100, output_tokens: 5, interval: 3 });
  });

  test("收尾有积压时补跑一次（catch_up），没有积压不补", async () => {
    const seen = captureEvents();
    const calls = { n: 0 };
    const h = handle(3, calls);
    await turns(h, 4); // 第 3 轮跑、第 4 轮积压
    expect(calls.n).toBe(1);
    await h.drainPending(1000);
    expect(calls.n).toBe(2);
    await h.drainPending(1000); // 积压已清
    expect(calls.n).toBe(2);
    const ran = seen.filter((e) => e.name === "memory_extract" && e.meta.extract_outcome === "ran");
    expect(ran.at(-1)?.meta.catch_up).toBe(true);
  });

  test("会话只有 1 个 end_turn、interval=5：收尾仍抽一次", async () => {
    const calls = { n: 0 };
    const h = handle(5, calls);
    await turns(h, 1);
    expect(calls.n).toBe(0);
    await h.drainPending(1000);
    expect(calls.n).toBe(1);
  });

  test("resolveMemoryExtractInterval：env > settings > 1，非法值回落", () => {
    expect(resolveMemoryExtractInterval()).toBe(1);
    expect(resolveMemoryExtractInterval(4)).toBe(4);
    expect(resolveMemoryExtractInterval(0)).toBe(1);
    expect(resolveMemoryExtractInterval(2.5)).toBe(1);
    process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL = "3";
    expect(resolveMemoryExtractInterval(4)).toBe(3);
    process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL = "abc";
    expect(resolveMemoryExtractInterval(4)).toBe(4);
  });
});

// ─── T3 ─────────────────────────────────────────────────────────

function writeIndex(dir: string, n: number, truncated: boolean): void {
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => `- [k${i}](k${i}.md) — d`);
  writeFileSync(
    join(dir, "MEMORY.md"),
    ["# Memory Index", "", ...lines].join("\n") + (truncated ? INDEX_TRUNCATION_NOTICE : "\n"),
  );
}

describe("T3 写入对齐容量", () => {
  test("readIndexCapacity 认得写侧的截断文案", () => {
    const dir = join(tmpHome, "mem");
    writeIndex(dir, 3, true);
    const c = readIndexCapacity(dir);
    expect(c).toMatchObject({ entries: 3, truncated: true });
    expect(formatIndexCapacity(c)).toContain("索引已用 3 / 200 条");
    expect(formatIndexCapacity(c)).toContain("已截断");
    writeIndex(dir, 3, false);
    expect(readIndexCapacity(dir).truncated).toBe(false);
  });

  test("截断态：save_memory 新 key 拒绝并计数，已有 key（含文件名形态）放行", async () => {
    const seen = captureEvents();
    const dir = join(tmpHome, "mem");
    mem(dir, "feedback_old.md", "old", "feedback");
    writeIndex(dir, 1, true);
    const can = createExtractPermissions(dir);

    const deny = await can("save_memory", { key: "brand_new", value: "v", type: "feedback" });
    expect(deny.behavior).toBe("deny");
    expect((deny as any).denyKind).toBe("index_full");
    expect((await can("save_memory", { key: "old", value: "v" })).behavior).toBe("allow");
    expect((await can("save_memory", { key: "feedback_old", value: "v" })).behavior).toBe("allow");

    const guards = seen
      .filter((e) => e.name === "memory_guard")
      .map((e) => String(e.meta.guard_kind));
    expect(guards).toEqual(["index_full"]);
  });

  test("截断态：write 新建记忆文件同样拒绝（不能绕过 save_memory），改已有文件放行", async () => {
    const dir = join(tmpHome, "mem");
    mem(dir, "feedback_old.md", "old", "feedback");
    writeIndex(dir, 1, true);
    const can = createExtractPermissions(dir);
    expect((await can("write", { file_path: join(dir, "new.md") })).behavior).toBe("deny");
    expect((await can("write", { file_path: join(dir, "feedback_old.md") })).behavior).toBe(
      "allow",
    );
    expect((await can("edit", { file_path: join(dir, "feedback_old.md") })).behavior).toBe("allow");
  });

  test("未截断：新 key 照常放行（行为不变）", async () => {
    const dir = join(tmpHome, "mem");
    writeIndex(dir, 1, false);
    const can = createExtractPermissions(dir);
    expect((await can("save_memory", { key: "brand_new", value: "v" })).behavior).toBe("allow");
    expect((await can("write", { file_path: join(dir, "new.md") })).behavior).toBe("allow");
  });

  test("isExistingMemoryKey 与 save_memory 同口径归一 key", () => {
    const dir = join(tmpHome, "mem");
    mem(dir, "project_x.md", "x");
    const ex = listExistingMemoryKeys(dir);
    expect(isExistingMemoryKey(" x ", ex)).toBe(true);
    expect(isExistingMemoryKey("project_x.md", ex)).toBe(true);
    expect(isExistingMemoryKey("y", ex)).toBe(false);
  });

  test("清单按索引优先级排序，组内 mtime 倒序", () => {
    const h = (name: string, type: any, mtimeMs: number): MemoryHeader => ({
      filename: `${name}.md`,
      filePath: name,
      mtimeMs,
      description: null,
      name,
      type,
    });
    const sorted = sortManifestHeaders([
      h("r", "reference", 9),
      h("p", "project", 8),
      h("f1", "feedback", 1),
      h("u", "user", 0),
      h("f2", "feedback", 5),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(["u", "f2", "f1", "p", "r"]);
  });

  test("提示词：给出容量行；截断时说明不能新建", () => {
    const ok = buildExtractPrompt("m", "索引已用 3 / 200 条、1KB / 25KB");
    expect(ok).toContain("索引已用 3 / 200 条");
    expect(ok).not.toContain("不允许新建 key");
    const full = buildExtractPrompt("m", "索引已用 83 / 200 条、25KB / 25KB；已截断");
    expect(full).toContain("不允许新建 key");
  });
});
