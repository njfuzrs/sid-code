/**
 * policy-trigger-rate 口径门禁：分子分母字段名稳定，B 无数据不假装 0.0%。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeRateA,
  computePolicyTriggerRate,
  KNOWN_FLAGS,
} from "../../scripts/policy-trigger-rate.ts";

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
});

describe("computePolicyTriggerRate 落盘", () => {
  test("--json 字段名稳定，B 无数据 available=false", () => {
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      [
        JSON.stringify({
          timestamp: "2026-09-22T00:00:00.000Z",
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
    expect(r.b.available).toBe(false);
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
    writeFileSync(
      join(tmpDir, "logs", "permissions-audit.log"),
      JSON.stringify({
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
    expect(out.denies_by_rule).toBe(1);
  });

  test("KNOWN_FLAGS 覆盖脚本真实消费的 flag", () => {
    expect(KNOWN_FLAGS.has("--json")).toBe(true);
    expect(KNOWN_FLAGS.has("--limit")).toBe(true);
    expect(KNOWN_FLAGS.has("--all")).toBe(true);
  });
});
