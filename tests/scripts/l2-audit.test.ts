/**
 * l2-audit 口径门禁：
 * - 只认 `StallEscalation{level:2}`，L1 不能混进来
 * - 影子字段（bgWaitTurns / deliveryTurns）在旧轨迹上缺失时必须落 null 而不是 0
 *   —— 按 0 读会把「该版本没有这个字段」误判成「命中时确实没等后台任务」
 * - 命中前后的工具轮按 `tool_use_id` 与 PostToolUse 配对，成功写入只看非报错的写类工具
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { auditL2, parseAuditArgs, renderAudit } from "../../scripts/l2-audit.ts";
import type { TraceEvent } from "../../scripts/defense-trigger-report.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const ev = (event: string, ts: string, data: Record<string, unknown> = {}): TraceEvent => ({
  event,
  timestamp: ts,
  data,
});

/** 命中点前 2 个工具轮（一个 bash 轮询、一个 read），命中后 3 轮（edit 成功、bash 失败、write 成功） */
const sessionHit: TraceEvent[] = [
  ev("SessionStart", "2026-11-07T00:00:00Z", { model: "m", session_id: "s1" }),
  ev("PreToolUse", "2026-11-07T00:00:01Z", {
    tool_name: "bash",
    tool_use_id: "t1",
    input_summary: { command: "gh pr view 1\n第二行不该被读到" },
  }),
  ev("PostToolUse", "2026-11-07T00:00:02Z", {
    tool_name: "bash",
    tool_use_id: "t1",
    is_error: false,
  }),
  ev("PreToolUse", "2026-11-07T00:00:03Z", {
    tool_name: "read",
    tool_use_id: "t2",
    input_summary: { file_path: "/w/a.ts" },
  }),
  ev("PostToolUse", "2026-11-07T00:00:04Z", {
    tool_name: "read",
    tool_use_id: "t2",
    is_error: false,
  }),
  ev("StallEscalation", "2026-11-07T00:00:05Z", {
    level: 2,
    acted: true,
    turn: 10,
    toolTurns: 10,
    bgWaitTurns: 2,
    deliveryTurns: 3,
    oscillations: 0,
    unchangedReports: 1,
    rollbacks: 2,
    greenRegressions: 0,
    l2Count: 1,
  }),
  ev("PreToolUse", "2026-11-07T00:00:06Z", {
    tool_name: "edit",
    tool_use_id: "t3",
    input_summary: { file_path: "/w/a.ts" },
  }),
  ev("PostToolUse", "2026-11-07T00:00:07Z", {
    tool_name: "edit",
    tool_use_id: "t3",
    is_error: false,
  }),
  ev("PreToolUse", "2026-11-07T00:00:08Z", {
    tool_name: "bash",
    tool_use_id: "t4",
    input_summary: { command: "bun test" },
  }),
  ev("PostToolUseFailure", "2026-11-07T00:00:09Z", { tool_name: "bash", tool_use_id: "t4" }),
  ev("PreToolUse", "2026-11-07T00:00:10Z", {
    tool_name: "write",
    tool_use_id: "t5",
    input_summary: { file_path: "/w/b.ts" },
  }),
  ev("PostToolUse", "2026-11-07T00:00:11Z", {
    tool_name: "write",
    tool_use_id: "t5",
    is_error: false,
  }),
  // L1 不该被当成命中点
  ev("StallEscalation", "2026-11-07T00:00:12Z", { level: 1, acted: true, toolTurns: 11 }),
];

/** 2026-10-30 之前的轨迹：没有影子字段 */
const sessionOld: TraceEvent[] = [
  ev("SessionStart", "2026-10-20T00:00:00Z", { model: "m", session_id: "s0" }),
  ev("StallEscalation", "2026-10-20T00:00:01Z", { level: 2, acted: false, turn: 5, toolTurns: 5 }),
];

describe("l2-audit", () => {
  test("只收 level:2，且前后工具轮按顺序与配对错误位取到", () => {
    const r = auditL2([sessionHit], { before: 2, after: 3 });
    expect(r.hits.length).toBe(1);
    const h = r.hits[0]!;
    expect(h.before.map((b) => b.tool)).toEqual(["bash", "read"]);
    // detail 只取命令首行，不能把 heredoc 正文带进来
    expect(h.before[0]!.detail).toBe("gh pr view 1");
    expect(h.before[1]!.detail).toBe("/w/a.ts");
    expect(h.after.map((a) => a.tool)).toEqual(["edit", "bash", "write"]);
    expect(h.after.map((a) => a.isError)).toEqual([false, true, false]);
    // edit + write 成功 = 2；失败的 bash 不算写入
    expect(h.successfulWritesAfter).toBe(2);
  });

  test("影子字段缺失落 null 而不是 0（旧轨迹不能按 0 读）", () => {
    const r = auditL2([sessionOld]);
    const h = r.hits[0]!;
    expect(h.bgWaitTurns).toBeNull();
    expect(h.deliveryTurns).toBeNull();
    expect(renderAudit(r)).toContain("影子字段缺失");
  });

  test("影子字段有值时照实落盘，并提示「已扣掉仍触发」", () => {
    // 用默认窗口（before 4 / after 8）：后续 3 轮里有 2 次成功写入，误伤提示才会出现
    const r = auditL2([sessionHit]);
    const h = r.hits[0]!;
    expect(h.bgWaitTurns).toBe(2);
    expect(h.deliveryTurns).toBe(3);
    const text = renderAudit(r);
    expect(text).toContain("已扣掉等待轮仍触发");
    expect(text).toContain("已扣掉交付轮仍触发");
    expect(text).toContain("疑似误伤");
  });

  test("--since 按日过滤命中点", () => {
    const r = auditL2([sessionHit, sessionOld], { since: "2026-11-01" });
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]!.session).toBe("s1");
  });

  test("after=0 时不导出后续轮，成功写入为 0", () => {
    const r = auditL2([sessionHit], { before: 1, after: 0 });
    expect(r.hits[0]!.after).toEqual([]);
    expect(r.hits[0]!.successfulWritesAfter).toBe(0);
  });

  test("参数校验：未知参数、非法数字、非法日期都抛错", () => {
    expect(() => parseAuditArgs(["--nope"])).toThrow();
    expect(() => parseAuditArgs(["--before", "-1"])).toThrow();
    expect(() => parseAuditArgs(["--after", "x"])).toThrow();
    expect(() => parseAuditArgs(["--since", "11-01"])).toThrow();
    expect(
      parseAuditArgs(["--json", "--since", "2026-11-01", "--before", "2", "--after", "6"]),
    ).toEqual({ json: true, since: "2026-11-01", before: 2, after: 6 });
  });

  test("CLI 端到端：读 SID_CONFIG_DIR 下的轨迹，未知参数退出 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-l2-audit-"));
    try {
      const s = join(dir, "trajectories", "sessions", "20261107-000000-aaaaaaaa");
      mkdirSync(s, { recursive: true });
      writeFileSync(
        join(s, "events.jsonl"),
        sessionHit.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      const env = { ...process.env, SID_CONFIG_DIR: dir };
      const script = join(REPO_ROOT, "scripts/l2-audit.ts");
      const ok = spawnSync("bun", [script, "--json"], { env, encoding: "utf8" });
      expect(ok.status).toBe(0);
      const r = JSON.parse(ok.stdout);
      expect(r.hits.length).toBe(1);
      expect(r.hits[0].successfulWritesAfter).toBe(2);
      const text = spawnSync("bun", [script], { env, encoding: "utf8" });
      expect(text.stdout).toContain("停滞 L2 命中点抽检");
      const bad = spawnSync("bun", [script, "--nope"], { env, encoding: "utf8" });
      expect(bad.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
