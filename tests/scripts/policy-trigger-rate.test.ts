/**
 * policy-trigger-rate 口径门禁：分子分母字段名稳定，B 无数据不假装 0.0%。
 * A 与 B 必须共用 --limit 时间窗；探针行不得刷 A。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeRateA,
  computePolicyTriggerRate,
  KNOWN_FLAGS,
  rowInWindow,
  sessionEnvelope,
  ENVELOPE_PAD_MS,
} from "../../scripts/policy-trigger-rate.ts";
import type { SessionRef } from "../../packages/core/src/trace/digest.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let tmpDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-policy-rate-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  mkdirSync(join(tmpDir, "logs"), { recursive: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function plantSession(id: string, mtimeSec: number): void {
  const dir = join(tmpDir, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = join(dir, "session.traj");
  writeFileSync(traj, JSON.stringify({ metadata: { session_id: id }, trajectory: [] }) + "\n");
  utimesSync(traj, mtimeSec, mtimeSec);
  utimesSync(dir, mtimeSec, mtimeSec);
}

describe("computeRateA", () => {
  test("分子只计 deny ∧ reason.type=rule，分母是同 tool 的全部决策", () => {
    const a = computeRateA([
      { tool: "bash", decision: "deny", decisionReason: { type: "rule" } },
      { tool: "bash", decision: "deny", decisionReason: { type: "rule" } },
      { tool: "bash", decision: "allow", decisionReason: { type: "mode" } },
      { tool: "read", decision: "deny", decisionReason: { type: "other" } },
    ]);
    expect(a.denies_by_rule).toBe(2);
    expect(a.decisions_same_tools).toBe(3);
    expect(a.rate_a).toBeCloseTo(2 / 3);
    expect(a.tools).toEqual(["bash"]);
  });

  test("没有任何 rule deny 时分母收窄到 bash，不拿全量工具行", () => {
    const a = computeRateA([
      { tool: "read", decision: "allow" },
      { tool: "bash", decision: "allow" },
      { tool: "bash", decision: "deny", decisionReason: { type: "other" } },
    ]);
    expect(a.denies_by_rule).toBe(0);
    expect(a.decisions_same_tools).toBe(2);
    expect(a.tools).toEqual(["bash"]);
  });

  test("policy-probe 行不计入 A 的分子分母", () => {
    const a = computeRateA([
      {
        tool: "bash",
        decision: "deny",
        decisionReason: { type: "rule" },
        source: "policy-probe",
      },
      { tool: "bash", decision: "allow" },
    ]);
    expect(a.denies_by_rule).toBe(0);
    expect(a.decisions_same_tools).toBe(1);
    expect(a.probe_denies).toBe(1);
  });
});

describe("rowInWindow / sessionEnvelope", () => {
  test("无 timestamp 的行进不了 limit 窗", () => {
    expect(rowInWindow({ tool: "bash", decision: "deny" }, 0, Date.now())).toBe(false);
  });

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

describe("computePolicyTriggerRate 落盘", () => {
  test("--json 字段名稳定，B 无数据 available=false", () => {
    const ts = "2026-09-22T00:00:00.000Z";
    const tsMs = Date.parse(ts) / 1000;
    plantSession("s1", tsMs);
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      [
        JSON.stringify({
          timestamp: ts,
          type: "tool_use",
          tool: "bash",
          decision: "deny",
          decisionReason: { type: "rule", rule: "Bash(curl *)", behavior: "deny" },
        }),
        JSON.stringify({
          timestamp: "2026-09-22T00:00:01.000Z",
          type: "tool_use",
          tool: "bash",
          decision: "allow",
        }),
      ].join("\n") + "\n",
    );
    const r = computePolicyTriggerRate({ sessionLimit: 20 });
    expect(r.denies_by_rule).toBe(1);
    expect(r.decisions_same_tools).toBe(2);
    expect(r.rate_a).toBeCloseTo(0.5);
    expect(r.window.source).toBe("permissions-audit.log");
    expect(r.window.appliedTo).toBe("both");
    expect(r.window.all).toBe(false);
    expect(r.window.from).toBeDefined();
    expect(r.window.to).toBeDefined();
    expect(r.b.available).toBe(false);
  });

  test("--limit 只覆盖新段时旧 .env deny 不进窗", () => {
    // 旧段 2026-09-19 Read(.env) deny + 同期 bash allow；新段 09-22 bash deny。
    const oldTs = "2026-09-19T00:00:00.000Z";
    const newTs = "2026-09-22T07:44:12.970Z";
    plantSession("old-session", Date.parse(oldTs) / 1000);
    plantSession("new-session", Date.parse(newTs) / 1000);
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      [
        JSON.stringify({
          timestamp: oldTs,
          tool: "read",
          decision: "deny",
          decisionReason: { type: "rule" },
        }),
        JSON.stringify({
          timestamp: oldTs,
          tool: "bash",
          decision: "allow",
        }),
        JSON.stringify({
          timestamp: newTs,
          tool: "bash",
          decision: "deny",
          decisionReason: { type: "rule" },
        }),
        JSON.stringify({
          timestamp: newTs,
          tool: "bash",
          decision: "allow",
        }),
      ].join("\n") + "\n",
    );

    const limited = computePolicyTriggerRate({ sessionLimit: 1 });
    expect(limited.denies_by_rule).toBe(1);
    expect(limited.decisions_same_tools).toBe(2);
    expect(limited.window.appliedTo).toBe("both");
    expect(limited.window.all).toBe(false);
    expect(limited.window.sessionsScanned).toBe(1);
    // 旧 bash allow 不在新会话包络里
    expect(limited.rate_a).toBeCloseTo(0.5);

    const all = computePolicyTriggerRate({ sessionLimit: "all" });
    expect(all.denies_by_rule).toBe(2);
    expect(all.window.all).toBe(true);
    expect(all.window.appliedTo).toBe("both");
  });

  test("--limit 但没有会话时 A 不得退回全文件", () => {
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      JSON.stringify({
        timestamp: "2026-09-22T00:00:00.000Z",
        tool: "bash",
        decision: "deny",
        decisionReason: { type: "rule" },
      }) + "\n",
    );
    const r = computePolicyTriggerRate({ sessionLimit: 20 });
    expect(r.denies_by_rule).toBe(0);
    expect(r.decisions_same_tools).toBe(0);
    expect(r.window.all).toBe(false);
    expect(r.window.sessionsScanned).toBe(0);
  });

  test("探针 deny 不把 A 刷成 100%", () => {
    const ts = "2026-09-22T08:00:00.000Z";
    plantSession("s", Date.parse(ts) / 1000);
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      [
        JSON.stringify({
          timestamp: ts,
          tool: "bash",
          decision: "deny",
          decisionReason: { type: "rule" },
          source: "policy-probe",
        }),
        JSON.stringify({
          timestamp: ts,
          tool: "bash",
          decision: "allow",
        }),
      ].join("\n") + "\n",
    );
    const r = computePolicyTriggerRate({ sessionLimit: 20 });
    expect(r.denies_by_rule).toBe(0);
    expect(r.decisions_same_tools).toBe(1);
    expect(r.window.probe_denies).toBe(1);
    expect(r.rate_a).toBe(0);
  });
});

describe("脚本 CLI", () => {
  test("未知 flag 非 0 退出（不静默忽略）", () => {
    const proc = spawnSync("bun", ["scripts/policy-trigger-rate.ts", "--health"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: tmpDir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("未知参数");
  });

  test("--json 打出 denies_by_rule / decisions_same_tools / rate_a / window", () => {
    const ts = "2026-09-22T00:00:00.000Z";
    plantSession("cli-s", Date.parse(ts) / 1000);
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      JSON.stringify({
        timestamp: ts,
        tool: "bash",
        decision: "deny",
        decisionReason: { type: "rule" },
      }) + "\n",
    );
    const proc = spawnSync("bun", ["scripts/policy-trigger-rate.ts", "--json", "--limit", "20"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: tmpDir },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
    const out = JSON.parse(proc.stdout);
    expect(out).toHaveProperty("denies_by_rule");
    expect(out).toHaveProperty("decisions_same_tools");
    expect(out).toHaveProperty("rate_a");
    expect(out).toHaveProperty("window");
    expect(out.window).toHaveProperty("from");
    expect(out.window).toHaveProperty("to");
    expect(out.window).toHaveProperty("appliedTo");
    expect(out.window.appliedTo).toBe("both");
    expect(out.window.all).toBe(false);
    expect(out.denies_by_rule).toBe(1);
  });

  test("KNOWN_FLAGS 覆盖脚本真实消费的 flag", () => {
    expect(KNOWN_FLAGS.has("--json")).toBe(true);
    expect(KNOWN_FLAGS.has("--limit")).toBe(true);
    expect(KNOWN_FLAGS.has("--all")).toBe(true);
  });
});
