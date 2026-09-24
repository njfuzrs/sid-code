/**
 * pricing-reconcile：--threshold 缺省仍 0.1；untrusted host 进排除段不进偏差。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEVIATION_THRESHOLD,
  parseArgs,
  bucketByModelHost,
  partitionTrusted,
} from "../../scripts/pricing-reconcile.ts";
import type { UsageLedgerEntry } from "../../packages/core/src/telemetry/usage-ledger.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevTrust: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevTrust = process.env.SID_CODE_CHANNEL_TRUST;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-reconcile-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_CHANNEL_TRUST = join(tmpDir, "channel-trust.json");
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevTrust === undefined) delete process.env.SID_CODE_CHANNEL_TRUST;
  else process.env.SID_CODE_CHANNEL_TRUST = prevTrust;
  rmSync(tmpDir, { recursive: true, force: true });
});

function row(over: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    ts: 1_700_000_000,
    sessionId: "s",
    model: "deepseek-v4-pro",
    provider: "openai",
    promptTotal: 1000,
    cacheHit: 0,
    cacheWrite: 0,
    uncachedInput: 1000,
    output: 10,
    costUSD: 1,
    savingsUSD: 0,
    durationMs: 1,
    ...over,
  };
}

describe("parseArgs --threshold", () => {
  test("缺省仍是 0.1", () => {
    expect(DEVIATION_THRESHOLD).toBe(0.1);
    expect(parseArgs([]).threshold).toBe(0.1);
  });
  test("验收可传 0.05", () => {
    expect(parseArgs(["--threshold", "0.05"]).threshold).toBe(0.05);
  });
});

describe("untrusted host 排除", () => {
  test("untrusted 进排除段，不进 countedCost", () => {
    writeFileSync(
      process.env.SID_CODE_CHANNEL_TRUST!,
      JSON.stringify({
        channels: {
          "evil.example": { host: "evil.example", verdict: "untrusted", probedAt: 1 },
        },
      }),
    );
    const buckets = bucketByModelHost([
      row({ sessionId: "a", endpointHost: "good.example", costUSD: 10 }),
      row({ sessionId: "b", endpointHost: "evil.example", costUSD: 90 }),
    ]);
    const p = partitionTrusted(buckets);
    expect(p.countedCost).toBeCloseTo(10, 10);
    expect(p.excludedCost).toBeCloseTo(90, 10);
    expect(p.excluded.map((b) => b.host)).toEqual(["evil.example"]);
  });

  test("unknown host 计入偏差（没探测过当可信）", () => {
    const buckets = bucketByModelHost([
      row({ sessionId: "a", endpointHost: "new.example", costUSD: 3 }),
    ]);
    const p = partitionTrusted(buckets);
    expect(p.countedCost).toBeCloseTo(3, 10);
    expect(p.excluded.length).toBe(0);
  });
});

describe("CLI --help 含 --threshold", () => {
  test("help 文本含 flag", () => {
    const r = spawnSync("bun", ["scripts/pricing-reconcile.ts", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--threshold");
    expect(r.stdout).toContain("0.05");
  });
});
