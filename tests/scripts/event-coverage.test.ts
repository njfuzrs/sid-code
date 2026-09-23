/**
 * event-coverage 口径门禁：分母 0 不假装 100%；采样率进分母；window 字段稳定。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeEventCoverage,
  KNOWN_FLAGS,
  parseAuditLineMs,
  countPolicyAuditLines,
  sessionEnvelope,
  ENVELOPE_PAD_MS,
} from "../../scripts/event-coverage.ts";
import type { SessionRef } from "../../packages/core/src/trace/digest.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevFlag: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevFlag = process.env.SID_CODE_FLAG_EVENT_SAMPLING_CONFIG;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-event-cov-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  delete process.env.SID_CODE_FLAG_EVENT_SAMPLING_CONFIG;
  mkdirSync(join(tmpDir, "telemetry"), { recursive: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevFlag === undefined) delete process.env.SID_CODE_FLAG_EVENT_SAMPLING_CONFIG;
  else process.env.SID_CODE_FLAG_EVENT_SAMPLING_CONFIG = prevFlag;
  rmSync(tmpDir, { recursive: true, force: true });
});

function plantSession(id: string, mtimeSec: number, apiCalls: number): void {
  const dir = join(tmpDir, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = join(dir, "session.traj");
  writeFileSync(
    traj,
    JSON.stringify({ metadata: { session_id: id, total_api_calls: apiCalls }, trajectory: [] }) +
      "\n",
  );
  utimesSync(traj, mtimeSec, mtimeSec);
  utimesSync(dir, mtimeSec, mtimeSec);
}

function writeAnalytics(lines: object[]): void {
  writeFileSync(
    join(tmpDir, "telemetry", "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("parseAuditLineMs / countPolicyAuditLines", () => {
  test("匹配远程策略 200/204/304、回退缓存、加载本地策略，不匹配无关行", () => {
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    writeFileSync(
      join(tmpDir, "audit.log"),
      [
        "[12:00:01] ● [POLICY] 远程策略 200 etag=v1 deny=1 elapsed_ms=12",
        "[12:00:02] ● [POLICY] 远程策略 204 无策略 elapsed_ms=8 已清缓存",
        "[12:00:03] ● [POLICY] 远程策略 304 用缓存 fetched_at=… elapsed_ms=3",
        "[12:00:04] ● [POLICY] 远程策略 超时 elapsed_ms=15000 回退缓存 fetched_at=…",
        "[12:00:05] ● [POLICY] 远程策略 503 无可用 200 缓存 → 无远程策略",
        "[12:00:06] ● [POLICY] 远程策略 abort 缓存过期 fetched_at=… 已停用约束",
        "[12:00:07] ● [POLICY] 加载本地策略: /tmp/managed-settings.json",
        "[12:00:08] ● [INFO] 完全无关的一行",
        "[12:00:09] ● [AUDIT] 权限决策",
      ].join("\n") + "\n",
    );
    const { n } = countPolicyAuditLines();
    expect(n).toBe(7);
    expect(parseAuditLineMs("[12:00:01] ● [POLICY] 远程策略 200", now)).toBeDefined();
  });
});

describe("sessionEnvelope", () => {
  test("包络取最近 N 个会话 mtime 的 min..max", () => {
    const refs: SessionRef[] = [
      { id: "new", dir: "/n", trajPath: "/n/t", mtimeMs: 2000 },
      { id: "mid", dir: "/m", trajPath: "/m/t", mtimeMs: 1500 },
      { id: "old", dir: "/o", trajPath: "/o/t", mtimeMs: 1000 },
    ];
    const env = sessionEnvelope(refs, 2);
    expect(env?.picked.map((r) => r.id)).toEqual(["new", "mid"]);
    expect(env?.fromMs).toBe(1500 - ENVELOPE_PAD_MS);
    expect(env?.toMs).toBe(2000 + ENVELOPE_PAD_MS);
    expect(env?.all).toBe(false);
  });
});

describe("computeEventCoverage", () => {
  test("分母 0 时 coverage=null skipped=true，不是 100%", () => {
    const r = computeEventCoverage({ sessionLimit: 20 });
    expect(r.policy_enforced.skipped).toBe(true);
    expect(r.policy_enforced.coverage).toBeNull();
    expect(r.policy_enforced.expected).toBe(0);
    expect(r.guardrail_triggered.skipped).toBe(true);
    expect(r.context_assembled.skipped).toBe(true);
    expect(r.window.appliedTo).toBe("all");
    expect(r.window.all).toBe(false);
  });

  test("policy_enforced 分子/分母来自独立信号", () => {
    const ts = Date.parse("2026-09-22T12:00:00.000Z");
    plantSession("s1", ts / 1000, 2);
    writeFileSync(
      join(tmpDir, "audit.log"),
      "[12:00:01] ● [POLICY] 远程策略 200 etag=v1 deny=1 elapsed_ms=12\n",
    );
    utimesSync(join(tmpDir, "audit.log"), ts / 1000, ts / 1000);
    writeAnalytics([
      { eventName: "policy_enforced", timestamp: ts, metadata: { outcome: "applied" } },
    ]);
    const r = computeEventCoverage({ sessionLimit: 20 });
    expect(r.policy_enforced.emitted).toBe(1);
    expect(r.policy_enforced.expected).toBe(1);
    expect(r.policy_enforced.coverage).toBe(1);
    expect(r.policy_enforced.skipped).toBe(false);
  });

  test("context_assembled 分母 = total_api_calls × 采样率", () => {
    const ts = Date.parse("2026-09-22T12:00:00.000Z");
    plantSession("s1", ts / 1000, 10);
    writeAnalytics(
      Array.from({ length: 10 }, (_, i) => ({
        eventName: "context_assembled",
        timestamp: ts + i,
        metadata: { turn: i },
      })),
    );
    const full = computeEventCoverage({ sessionLimit: 20 });
    expect(full.context_assembled.expected).toBe(10);
    expect(full.context_assembled.emitted).toBe(10);
    expect(full.context_assembled.sample_rate).toBe(1);

    process.env.SID_CODE_FLAG_EVENT_SAMPLING_CONFIG = JSON.stringify({
      context_assembled: 0.1,
    });
    const sampled = computeEventCoverage({ sessionLimit: 20 });
    expect(sampled.context_assembled.sample_rate).toBe(0.1);
    expect(sampled.context_assembled.expected).toBe(1);
    expect(sampled.context_assembled.emitted).toBe(10);
    expect(sampled.context_assembled.coverage).toBe(10);
  });

  test("guardrail_triggered 分母来自 sidcode.defense.trigger，不是埋点自己", () => {
    const ts = Date.parse("2026-09-22T12:00:00.000Z");
    plantSession("s1", ts / 1000, 1);
    const evDir = join(tmpDir, "trajectories", "sessions", "s1");
    writeFileSync(
      join(evDir, "events.jsonl"),
      JSON.stringify({
        name: "sidcode.defense.trigger",
        attributes: { "sidcode.defense.layer": "policy_limits" },
      }) + "\n",
    );
    writeAnalytics([
      { eventName: "guardrail_triggered", timestamp: ts, metadata: { false_positive: "unknown" } },
    ]);
    const r = computeEventCoverage({ sessionLimit: 20 });
    expect(r.guardrail_triggered.expected).toBe(1);
    expect(r.guardrail_triggered.emitted).toBe(1);
    expect(r.guardrail_triggered.coverage).toBe(1);
  });
});

describe("脚本 CLI", () => {
  test("未知 flag 非 0 退出", () => {
    const proc = spawnSync("bun", ["scripts/event-coverage.ts", "--health"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: tmpDir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("未知参数");
  });

  test("--json 打出三类 + window.from/to/appliedTo/all", () => {
    const proc = spawnSync("bun", ["scripts/event-coverage.ts", "--json", "--limit", "20"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: tmpDir },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
    const out = JSON.parse(proc.stdout);
    expect(out).toHaveProperty("policy_enforced");
    expect(out).toHaveProperty("guardrail_triggered");
    expect(out).toHaveProperty("context_assembled");
    expect(out.window).toHaveProperty("from");
    expect(out.window).toHaveProperty("to");
    expect(out.window).toHaveProperty("appliedTo");
    expect(out.window.appliedTo).toBe("all");
    expect(out.window.all).toBe(false);
    expect(out.policy_enforced.skipped).toBe(true);
  });

  test("分母 0 的文本输出含「无数据，跳过」", () => {
    const proc = spawnSync("bun", ["scripts/event-coverage.ts", "--limit", "20"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: tmpDir },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("无数据，跳过");
    expect(proc.stdout).not.toMatch(/policy_enforced:.*100\.0%/);
  });

  test("KNOWN_FLAGS 覆盖脚本真实消费的 flag", () => {
    expect(KNOWN_FLAGS.has("--json")).toBe(true);
    expect(KNOWN_FLAGS.has("--limit")).toBe(true);
    expect(KNOWN_FLAGS.has("--all")).toBe(true);
  });
});
