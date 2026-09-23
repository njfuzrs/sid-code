/**
 * M4 三类事件行为：门面字段闭集、无 reason 文本、护栏回填三态、policy 缺省不 emit。
 *
 * 隔离：内存 Sink + SID_CONFIG_DIR，不实例化 LocalEventBackend。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logPolicyEnforced,
  logGuardrailTriggered,
  logContextAssembled,
  logToolSuccess,
  finalizeGuardrailSession,
  __resetGuardrailBufferForTest,
  EVENT_NAMES,
} from "@sid-code/core/analytics/events.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import {
  applyLoadedPolicy,
  __resetRemotePolicyLoaderForTest,
} from "@sid-code/core/config/policy.ts";
import { recordDefenseTrigger } from "@sid-code/core/telemetry/metrics/defense-metrics.ts";
import {
  setPolicyLimits,
  isPolicyAllowed,
  resetPolicyLimits,
} from "@sid-code/core/config/policy-limits.ts";
import { initTelemetry, shutdownTelemetry } from "@sid-code/core/telemetry/index.ts";

function capture(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

let tmpDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-m4-ev-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetAnalyticsForTest();
  __resetGuardrailBufferForTest();
  __resetRemotePolicyLoaderForTest();
  resetPolicyLimits();
  initTelemetry({ enabled: true, exporters: [] });
});

afterEach(async () => {
  await shutdownTelemetry();
  __resetAnalyticsForTest();
  __resetGuardrailBufferForTest();
  resetPolicyLimits();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("policy_enforced", () => {
  test("门面只出条数与 feature 名，无 reason/rule/pattern", () => {
    const seen = capture();
    logPolicyEnforced({
      source: "remote",
      outcome: "applied",
      denyRuleCount: 2,
      allowRuleCount: 1,
      askRuleCount: 0,
      disabledFeatures: ["mcp", "sub_agent"],
      durationMs: 12,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe(EVENT_NAMES.POLICY_ENFORCED);
    const serialized = JSON.stringify(seen[0]!.meta);
    expect(serialized).not.toContain("reason");
    expect(serialized).not.toContain("Bash(curl");
    expect(seen[0]!.meta.deny_rule_count).toBe(2);
    expect(seen[0]!.meta.disabled_features).toBe("mcp,sub_agent" as any);
    expect(seen[0]!.meta.outcome).toBe("applied" as any);
  });

  test("applyLoadedPolicy 无 meta 不 emit（测试缺省不污染）", () => {
    const seen = capture();
    applyLoadedPolicy(null);
    applyLoadedPolicy({ source: "remote", permissions: { deny: ["Bash(curl *)"] } });
    expect(seen.filter((e) => e.name === EVENT_NAMES.POLICY_ENFORCED)).toHaveLength(0);
  });

  test("applyLoadedPolicy 带 meta 成功 / 失败路径都 emit", () => {
    const seen = capture();
    applyLoadedPolicy(
      {
        source: "remote",
        permissions: { deny: ["Bash(curl *)"] },
        policyLimits: { mcp: { allowed: false } },
      },
      { source: "remote", outcome: "applied", durationMs: 8 },
    );
    applyLoadedPolicy(null, { source: "none", outcome: "error", durationMs: 20 });
    const rows = seen.filter((e) => e.name === EVENT_NAMES.POLICY_ENFORCED);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.meta.outcome).toBe("applied" as any);
    expect(rows[0]!.meta.deny_rule_count).toBe(1);
    expect(rows[0]!.meta.disabled_features).toBe("mcp" as any);
    expect(rows[1]!.meta.outcome).toBe("error" as any);
    expect(rows[1]!.meta.deny_rule_count).toBe(0);
  });
});

describe("guardrail_triggered", () => {
  test("recordDefenseTrigger 瞬时 unknown，metadata 无 reason", () => {
    const seen = capture();
    setPolicyLimits({ mcp: { allowed: false, reason: "M4 验收" } });
    expect(isPolicyAllowed("mcp")).toBe(false);
    const rows = seen.filter((e) => e.name === EVENT_NAMES.GUARDRAIL_TRIGGERED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta.false_positive).toBe("unknown" as any);
    expect(rows[0]!.meta.layer).toBe("policy_limits" as any);
    expect(rows[0]!.meta.feature).toBe("mcp" as any);
    const serialized = JSON.stringify(rows[0]!.meta);
    expect(serialized).not.toContain("M4 验收");
    expect(serialized).not.toContain("reason");
  });

  test("60s 内同 tool 成功 → suspected_false_positive 修正条", () => {
    const seen = capture();
    logGuardrailTriggered({
      layer: "denial_tracking",
      outcome: "tripped",
      falsePositive: "unknown",
      tool: "bash",
    });
    logToolSuccess("bash", { durationMs: 10 });
    const fps = seen
      .filter((e) => e.name === EVENT_NAMES.GUARDRAIL_TRIGGERED)
      .map((e) => e.meta.false_positive);
    expect(fps).toEqual(["unknown", "suspected_false_positive"]);
  });

  test("SessionEnd exit → confirmed_true_positive；abort 不改写", () => {
    const seen = capture();
    logGuardrailTriggered({
      layer: "compact_breaker",
      outcome: "blocked",
      falsePositive: "unknown",
    });
    finalizeGuardrailSession("abort");
    expect(seen.filter((e) => e.meta.false_positive === "confirmed_true_positive")).toHaveLength(0);

    finalizeGuardrailSession("exit");
    const confirmed = seen.filter((e) => e.meta.false_positive === "confirmed_true_positive");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.meta.layer).toBe("compact_breaker" as any);
  });

  test("直接 recordDefenseTrigger 也不带 reason", () => {
    const seen = capture();
    recordDefenseTrigger("policy_limits", "blocked", { feature: "mcp", reason: "管理员随便填" });
    const row = seen.find((e) => e.name === EVENT_NAMES.GUARDRAIL_TRIGGERED);
    expect(row).toBeDefined();
    expect(JSON.stringify(row!.meta)).not.toContain("管理员随便填");
  });
});

describe("context_assembled", () => {
  test("只带计数，不带消息内容", () => {
    const seen = capture();
    logContextAssembled({
      turn: 2,
      messageCount: 4,
      estimatedTokens: 1200,
      maxTokens: 200_000,
      compactionLevel: "soft",
      blocking: false,
      calibrated: true,
      toolCount: 6,
    });
    expect(seen[0]!.name).toBe(EVENT_NAMES.CONTEXT_ASSEMBLED);
    expect(seen[0]!.meta.turn).toBe(2);
    expect(seen[0]!.meta.compaction_level).toBe("soft" as any);
    expect(seen[0]!.meta.calibrated).toBe(true);
    const serialized = JSON.stringify(seen[0]!.meta);
    expect(serialized).not.toContain("role");
    expect(serialized).not.toContain("content");
  });
});
