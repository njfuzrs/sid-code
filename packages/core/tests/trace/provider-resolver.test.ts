/**
 * 缺陷 37：provider 归因收口为一个共享 resolver，digest 与 provider-health 两个入口共用。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProviderResolver,
  inferProviderFromModel,
} from "@sid-code/core/trace/provider-resolver.ts";
import { aggregateProviderStats } from "@sid-code/core/trace/digest.ts";
import { aggregateProviderHealth } from "@sid-code/core/telemetry/provider-health.ts";

const SRC = join(import.meta.dir, "../../src");

describe("缺陷 37：provider 推断单一事实源", () => {
  test("六模型判定表：非 claude 的一律不落 unknown", () => {
    const table: Array<[string, string]> = [
      ["claude-opus-5", "anthropic"],
      ["deepseek-v4-pro", "openai"],
      ["origin-deepseek-v4-pro", "openai"],
      ["glm-5.3", "openai"],
      ["qwen3-max", "openai"],
      ["kimi-k2", "openai"],
    ];
    for (const [m, want] of table) expect(inferProviderFromModel(m), m).toBe(want);
    expect(inferProviderFromModel("")).toBe("unknown");
  });

  test("真值映射优先于启发式", () => {
    const r = createProviderResolver([
      { event: "AfterModelRaw", data: { model: "gw-claude-x", provider: "openai" } },
    ]);
    expect(r("gw-claude-x")).toBe("openai");
    expect(r("claude-other")).toBe("anthropic");
  });

  const events = [
    { event: "AfterModelRaw", data: { provider: "openai", model: "glm-5.3", elapsed_ms: 100 } },
    { event: "AfterModelRaw", data: { provider: "openai", model: "glm-5.3", elapsed_ms: 100 } },
    { event: "TimeoutFired", data: { model: "glm-5.3", layer: "idle" } },
  ];

  test("digest：glm 的超时记进有分母的 openai 桶，不再进无分母的 unknown", () => {
    const stats = aggregateProviderStats(events);
    expect(stats.find((s) => s.provider === "unknown")).toBeUndefined();
    const openai = stats.find((s) => s.provider === "openai")!;
    expect(openai.requests).toBe(2);
    expect(openai.timedOut).toBe(1);
  });

  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("provider-health：glm 超时计入 openai 桶，successRate 不再兜底为 1", () => {
    tmp = mkdtempSync(join(tmpdir(), "sid-prov-res-"));
    const dir = join(tmp, "s1");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify({ ...e, timestamp: now })).join("\n") + "\n",
    );
    const rep = aggregateProviderHealth({ sessionsDir: tmp });
    expect(rep.providers.find((p) => p.provider === "unknown")).toBeUndefined();
    const openai = rep.providers.find((p) => p.provider === "openai")!;
    expect(openai.requests.timedOut).toBe(1);
    expect(openai.requests.succeeded).toBe(1);
  });

  test("结构约束：两个入口不得再内联按 model 名推断 provider 的启发式", () => {
    // 回归形态是 `model.includes("deepseek") ? "openai" : …` 这类内联三元；
    // 推断只许出现在 provider-resolver.ts 一处。
    for (const f of ["trace/digest.ts", "telemetry/provider-health.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, f).not.toMatch(/model\.includes\("(deepseek|claude)"\)/);
      expect(src, f).toContain("createProviderResolver(events)");
    }
  });
});
