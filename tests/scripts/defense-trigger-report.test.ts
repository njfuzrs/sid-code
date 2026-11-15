/**
 * defense-trigger-report 口径门禁：
 * - continue 理由清单必须与 `ContinueReason` 联合类型逐项一致（漏一个 = 零触发行消失，「0 次」和「没统计」分不开）
 * - 事件跟着会话内的模型切换归组；总计里同一会话不因跨分组被算两次
 * - tmp cwd 会话整会话剔除；--since 按日过滤；字段覆盖期取最早出现日期
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  aggregateDefenseReport,
  CONTINUE_TYPES,
  isTmpCwd,
  parseArgs,
  type TraceEvent,
} from "../../scripts/defense-trigger-report.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const ev = (
  event: string,
  ts: string,
  data: Record<string, unknown> = {},
  cwd?: string,
): TraceEvent => ({
  event,
  timestamp: ts,
  data,
  ...(cwd ? { cwd } : {}),
});

/** 会话 A：deepseek 起手，中途切到 claude；两边各触发一次 todo_gate_retry */
const sessionA: TraceEvent[] = [
  ev("SessionStart", "2026-10-20T00:00:00Z", { model: "ds" }, "/work/a"),
  ev("UserPromptSubmit", "2026-10-20T00:00:01Z"),
  ev("BeforeModel", "2026-10-20T00:00:02Z", { model: "ds" }),
  ev("AfterModel", "2026-10-20T00:00:03Z", { stop_reason: "max_tokens" }),
  // 覆盖期探测的来源：tool_use_facts 平铺在 AfterModelRaw 上（不在 AfterModel 上）
  ev("AfterModelRaw", "2026-10-20T00:00:03Z", {
    stop_reason: "max_tokens",
    tool_use_total: 2,
    tool_use_truncated: 1,
  }),
  // 编辑失败提醒：此前「触发了没记」，补埋点后应能算出按失败形态拆的触发率
  ev("EditFailureReminder", "2026-10-20T00:00:03Z", { kind: "not_found", count: 3 }),
  ev("BilledRequest", "2026-10-20T00:00:03Z", { model: "ds", provider: "openai" }),
  ev("LoopTransition", "2026-10-20T00:00:04Z", { type: "todo_gate_retry" }),
  ev("LoopTransition", "2026-10-20T00:00:04Z", { type: "tool_use" }),
  ev("BeforeModel", "2026-10-25T00:00:00Z", { model: "claude" }),
  ev("BilledRequest", "2026-10-25T00:00:01Z", { model: "claude", provider: "anthropic" }),
  ev("LoopTransition", "2026-10-25T00:00:02Z", { type: "todo_gate_retry" }),
  ev("TurnComplete", "2026-10-25T00:00:03Z", {
    incomplete_reason: "stalled",
    continue_counts: { tool_use: 1 },
  }),
  ev("StallEscalation", "2026-10-25T00:00:04Z", { level: 2, acted: false }),
  ev("GateExhausted", "2026-10-25T00:00:05Z", { gate: "todo" }),
];

/** 会话 B：单测 spawn 的（cwd 在 tmp 下），必须整会话剔除 */
const sessionTmp: TraceEvent[] = [
  ev("SessionStart", "2026-10-20T00:00:00Z", { model: "ds" }, "/tmp/sid-test-x"),
  ev("LoopTransition", "2026-10-20T00:00:01Z", { type: "stop_hook_retry" }),
];

describe("defense-trigger-report", () => {
  test("CONTINUE_TYPES 与 ContinueReason 联合类型逐项一致", () => {
    const src = readFileSync(join(REPO_ROOT, "packages/core/src/query/types.ts"), "utf8");
    const start = src.indexOf("export type ContinueReason =");
    const end = src.indexOf(";", src.indexOf('{ type: "context_window_recovery" }', start));
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    const fromSrc = [...body.matchAll(/\{\s*type:\s*"([a-z_]+)"\s*\}/g)].map((m) => m[1]).sort();
    expect(fromSrc.length).toBeGreaterThan(10);
    expect([...CONTINUE_TYPES].sort() as string[]).toEqual(fromSrc as string[]);
  });

  test("零触发理由也出现在报告里，计数为 0", () => {
    const r = aggregateDefenseReport([sessionA], { tmpRoots: ["/tmp"] });
    for (const t of CONTINUE_TYPES) expect(r.total.continue[t]).toBeDefined();
    expect(r.total.continue.promise_nudge).toEqual({ count: 0, sessions: 0 });
  });

  test("按模型归组跟随会话内切换，总计会话去重", () => {
    const r = aggregateDefenseReport([sessionA, sessionTmp], { tmpRoots: ["/tmp"] });
    const ds = r.groups.find((g) => g.key === "ds")!;
    const claude = r.groups.find((g) => g.key === "claude")!;
    expect(ds.continue.todo_gate_retry).toEqual({ count: 1, sessions: 1 });
    expect(claude.continue.todo_gate_retry).toEqual({ count: 1, sessions: 1 });
    // 跨两个分组命中的同一会话，总计里只算 1 个会话
    expect(r.total.continue.todo_gate_retry).toEqual({ count: 2, sessions: 1 });
    expect(ds.stop_max_tokens.count).toBe(1);
    expect(ds.truncated.with_tool_use.count).toBe(1);
    expect(ds.truncated.params_truncated.count).toBe(1);
    expect(ds.edit_failure_reminder.not_found).toEqual({ count: 1, sessions: 1 });
    expect(claude.incomplete_reason.stalled!.count).toBe(1);
    expect(claude.stall.L2_shadow!.count).toBe(1);
    expect(claude.gates_exhausted.todo!.count).toBe(1);
    expect(r.denominators).toEqual({ sessions: 1, prompts: 1, excluded_tmp_sessions: 1 });
    // tmp 会话的 stop_hook_retry 不得混进来
    expect(r.total.continue.stop_hook_retry.count).toBe(0);
  });

  test("--by provider 用 BilledRequest 的 provider 归组", () => {
    const r = aggregateDefenseReport([sessionA], { tmpRoots: ["/tmp"], groupBy: "provider" });
    expect(r.groups.map((g) => g.key).sort()).toEqual(["anthropic", "openai"]);
  });

  test("--since 按日过滤，覆盖期取最早出现日期", () => {
    const all = aggregateDefenseReport([sessionA], { tmpRoots: [] });
    expect(all.coverage["TurnComplete.continue_counts"]).toBe("2026-10-25");
    expect(all.coverage["LoopTransition"]).toBe("2026-10-20");
    // 键名必须是 AfterModelRaw —— 初版探测写成 `AfterModel.tool_use_facts`（该事件上根本没有
    // 这个字段），于是恒报「窗口内从未出现」。断言「探得到」而不是「探不到」，
    // 否则测试会把 bug 状态锁成预期。
    expect(all.coverage["AfterModelRaw.tool_use_total"]).toBe("2026-10-20");
    expect(all.coverage["EditFailureReminder"]).toBe("2026-10-20");
    const r = aggregateDefenseReport([sessionA], { tmpRoots: [], since: "2026-10-24" });
    expect(r.total.continue.todo_gate_retry.count).toBe(1);
    expect(r.total.stop_max_tokens.count).toBe(0);
  });

  test("截断分项：纯文本 / 带工具调用 / 参数被截断各自独立，非截断不计", () => {
    const s: TraceEvent[] = [
      ev("SessionStart", "2026-11-01T00:00:00Z", { model: "m" }),
      ev("AfterModelRaw", "2026-11-01T00:00:01Z", {
        stop_reason: "max_tokens",
        tool_use_total: 0,
        tool_use_truncated: 0,
      }),
      ev("AfterModelRaw", "2026-11-01T00:00:02Z", {
        stop_reason: "length",
        tool_use_total: 3,
        tool_use_truncated: 0,
      }),
      ev("AfterModelRaw", "2026-11-01T00:00:03Z", {
        stop_reason: "max_tokens",
        tool_use_total: 1,
        tool_use_truncated: 2,
      }),
      ev("AfterModelRaw", "2026-11-01T00:00:04Z", { stop_reason: "end_turn", tool_use_total: 5 }),
      ev("AfterModel", "2026-11-01T00:00:05Z", { stop_reason: "max_tokens" }),
    ];
    const r = aggregateDefenseReport([s], { tmpRoots: [] });
    expect(r.total.truncated.text_only.count).toBe(1); // max_tokens 且 tool_use_total=0
    expect(r.total.truncated.with_tool_use.count).toBe(2); // max_tokens + length 各一次
    expect(r.total.truncated.params_truncated.count).toBe(1); // 只有第三条参数被截断
    // 旧口径（AfterModel.stop_reason）不受影响，两个来源分别计数
    expect(r.total.stop_max_tokens.count).toBe(1);
  });

  test("编辑失败提醒按 kind 归组：同 kind 累计、跨会话去重", () => {
    const mk = (ts: string, kind: string, cwd: string): TraceEvent[] => [
      ev("SessionStart", ts, { model: "m" }, cwd),
      ev("EditFailureReminder", ts, { kind }),
      ev("EditFailureReminder", ts, { kind }),
    ];
    const r = aggregateDefenseReport(
      [mk("2026-11-01T00:00:00Z", "noop", "/w/1"), mk("2026-11-02T00:00:00Z", "noop", "/w/2")],
      { tmpRoots: [] },
    );
    // 4 次命中、2 个会话
    expect(r.total.edit_failure_reminder.noop).toEqual({ count: 4, sessions: 2 });
    expect(r.total.edit_failure_reminder.not_found).toBeUndefined();
  });

  test("isTmpCwd 只认目录前缀，不误伤同名前缀", () => {
    expect(isTmpCwd("/tmp/x", ["/tmp"])).toBe(true);
    expect(isTmpCwd("/tmp", ["/tmp"])).toBe(true);
    expect(isTmpCwd("/tmpfoo/x", ["/tmp"])).toBe(false);
    expect(isTmpCwd(undefined, ["/tmp"])).toBe(false);
  });

  test("参数校验：未知参数与非法取值抛错", () => {
    expect(() => parseArgs(["--limit", "3"])).toThrow();
    expect(() => parseArgs(["--since", "10-24"])).toThrow();
    expect(() => parseArgs(["--by", "vendor"])).toThrow();
    expect(parseArgs(["--since", "2026-10-24", "--by", "provider", "--json"])).toEqual({
      json: true,
      since: "2026-10-24",
      by: "provider",
    });
  });

  test("CLI 端到端：读 SID_CONFIG_DIR 下的轨迹，未知参数退出 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-defense-report-"));
    try {
      const s = join(dir, "trajectories", "sessions", "20261025-000000-aaaaaaaa");
      mkdirSync(s, { recursive: true });
      writeFileSync(
        join(s, "events.jsonl"),
        sessionA.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      const env = { ...process.env, SID_CONFIG_DIR: dir };
      const script = join(REPO_ROOT, "scripts/defense-trigger-report.ts");
      const ok = spawnSync("bun", [script, "--json"], { env, encoding: "utf8" });
      expect(ok.status).toBe(0);
      const r = JSON.parse(ok.stdout);
      expect(r.denominators.sessions).toBe(1);
      expect(r.total.continue.todo_gate_retry.count).toBe(2);
      expect(r.total.truncated.params_truncated.count).toBe(1);
      expect(r.total.edit_failure_reminder.not_found.count).toBe(1);
      const text = spawnSync("bun", [script], { env, encoding: "utf8" });
      expect(text.stdout).toContain("promise_nudge");
      expect(text.stdout).toContain("零触发");
      expect(text.stdout).toContain("参数被截断");
      expect(text.stdout).toContain("编辑失败提醒");
      const bad = spawnSync("bun", [script, "--nope"], { env, encoding: "utf8" });
      expect(bad.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
