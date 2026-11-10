/**
 * aftereffect-report 口径门禁（HB-3）：
 * - nag 后第一个工具按工具名分桶；之后无工具单列，不进分母
 * - ReadHint 后同文件下一次 read：整读=followed，传 limit/offset=still_narrow，没再读=no_reread；
 *   suggest_full_read≠true 进 not_applicable
 * - ToolResultCleared 被清调用在窗口内同签名重跑才算；窗口外 / 无签名不算；无事件时 clear_events=0
 * - 子代理 PreToolUse 不进统计；事件按最近一条 BeforeModel.model 归组；tmp 会话剔除
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  aggregateAftereffects,
  parseArgs,
  toolSignature,
  RERUN_WINDOW_TOOLS,
} from "../../scripts/aftereffect-report.ts";
import type { TraceEvent } from "../../scripts/defense-trigger-report.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let t = 0;
const ev = (event: string, data: Record<string, unknown> = {}, cwd?: string): TraceEvent => ({
  event,
  timestamp: new Date(Date.UTC(2026, 10, 5, 0, 0, t++)).toISOString(),
  data,
  ...(cwd ? { cwd } : {}),
});
const tool = (name: string, id: string, summary?: Record<string, unknown>, extra = {}) =>
  ev("PreToolUse", {
    tool_name: name,
    tool_use_id: id,
    ...(summary ? { input_summary: summary } : {}),
    ...extra,
  });

describe("nag 后第一个工具", () => {
  test("按工具名分桶；之后无工具单列；按模型归组", () => {
    const s: TraceEvent[] = [
      ev("SessionStart", { model: "ds" }, "/work"),
      ev("BeforeModel", { model: "ds" }),
      ev("NoProgressNagInjected", { kind: "todo" }),
      tool("todo_write", "a"),
      ev("NoProgressNagInjected", { kind: "todo" }),
      tool("bash", "b", { command: "ls" }),
      ev("BeforeModel", { model: "opus" }),
      ev("NoProgressNagInjected", { kind: "work-log" }),
    ];
    const r = aggregateAftereffects([s], { tmpRoots: [] });
    expect(r.total.nag.todo).toEqual({
      with_tool_after: 2,
      no_tool_after: 0,
      first_tool: { todo_write: 1, bash: 1 },
    });
    expect(r.total.nag["work-log"]).toEqual({
      with_tool_after: 0,
      no_tool_after: 1,
      first_tool: {},
    });
    expect(r.groups.find((g) => g.key === "opus")!.nag["work-log"]!.no_tool_after).toBe(1);
    expect(r.groups.find((g) => g.key === "ds")!.nag.todo!.with_tool_after).toBe(2);
  });

  test("子代理的工具调用不算 nag 之后的第一个工具", () => {
    const s: TraceEvent[] = [
      ev("SessionStart", { model: "ds" }, "/work"),
      ev("NoProgressNagInjected", { kind: "todo" }),
      tool("read", "sub1", { file_path: "/x" }, { agent_id: "sub" }),
      tool("edit", "main1", { file_path: "/x" }),
    ];
    const r = aggregateAftereffects([s], { tmpRoots: [] });
    expect(r.total.nag.todo!.first_tool).toEqual({ edit: 1 });
  });
});

describe("ReadHint 后效", () => {
  const base = (after: TraceEvent[], suggest = true): TraceEvent[] => [
    ev("SessionStart", { model: "ds" }, "/work"),
    tool("read", "r0", { file_path: "/f.ts", offset: 1, limit: 50 }),
    ev("ReadHint", { kind: "narrow_first", hint_file_path: "/f.ts", suggest_full_read: suggest }),
    ...after,
  ];

  test("下一次同文件 read 不传 limit/offset → followed", () => {
    const r = aggregateAftereffects([base([tool("read", "r1", { file_path: "/f.ts" })])], {
      tmpRoots: [],
    });
    expect(r.total.read_hint.narrow_first).toMatchObject({ hints: 1, followed: 1 });
  });

  test("仍传 offset → still_narrow；别的文件的 read 不算", () => {
    const r = aggregateAftereffects(
      [
        base([
          tool("read", "r1", { file_path: "/other.ts" }),
          tool("read", "r2", { file_path: "/f.ts", offset: 60, limit: 50 }),
        ]),
      ],
      { tmpRoots: [] },
    );
    expect(r.total.read_hint.narrow_first).toMatchObject({ followed: 0, still_narrow: 1 });
  });

  test("still_narrow 拆出同段重叠：起始行落在提示窗口内才算重叠", () => {
    const hint = (after: TraceEvent[]): TraceEvent[] => [
      ev("SessionStart", { model: "ds" }, "/work"),
      ev("ReadHint", {
        kind: "narrow_first",
        hint_file_path: "/g.ts",
        suggest_full_read: true,
        start_line: 100,
        end_line: 149,
      }),
      ...after,
    ];
    const r = aggregateAftereffects(
      [
        hint([tool("read", "a", { file_path: "/g.ts", offset: 120, limit: 50 })]), // 重叠
        hint([tool("read", "b", { file_path: "/g.ts", offset: 150, limit: 50 })]), // 往后换段
        hint([tool("read", "c", { file_path: "/g.ts", limit: 40 })]), // offset 缺省=1，往前
      ],
      { tmpRoots: [] },
    );
    expect(r.total.read_hint.narrow_first).toMatchObject({
      still_narrow: 3,
      still_narrow_overlap: 1,
    });
  });

  test("没再读 → no_reread；suggest_full_read=false → not_applicable", () => {
    const r = aggregateAftereffects([base([]), base([], false)], { tmpRoots: [] });
    expect(r.total.read_hint.narrow_first).toMatchObject({
      hints: 2,
      no_reread: 1,
      not_applicable: 1,
    });
  });

  test("触发提示的那次 read 本身不算「下一次」", () => {
    // PreToolUse 在 ReadHint 之前写；若误把它算成下一次，结果会是 still_narrow
    const r = aggregateAftereffects([base([])], { tmpRoots: [] });
    expect(r.total.read_hint.narrow_first!.still_narrow).toBe(0);
  });
});

describe("清理后同签名重跑", () => {
  test("窗口内同签名重跑才算；无签名不进分母", () => {
    const fill = Array.from({ length: RERUN_WINDOW_TOOLS }, (_, i) =>
      tool("bash", `f${i}`, { command: `echo ${i}` }),
    );
    const s: TraceEvent[] = [
      ev("SessionStart", { model: "ds" }, "/work"),
      tool("read", "c1", { file_path: "/a.ts" }),
      tool("grep", "c2", { pattern: "x" }),
      tool("ls", "c3"), // 无 input_summary → 无签名
      ev("ToolResultCleared", {
        stage: "microcompact",
        cleared: 3,
        tool_use_ids: ["c1", "c2", "c3"],
      }),
      tool("read", "c1b", { file_path: "/a.ts" }), // 窗口内重跑 c1
      ...fill, // 把 c2 的重跑推到窗口外
      tool("grep", "c2b", { pattern: "x" }),
    ];
    const r = aggregateAftereffects([s], { tmpRoots: [] });
    expect(r.total.cleared).toEqual({
      clear_events: 1,
      cleared_with_signature: 2,
      rerun_within_window: 1,
      by_stage: { microcompact: { cleared_with_signature: 2, rerun_within_window: 1 } },
    });
  });

  test("没有 ToolResultCleared 时 clear_events=0（渲染为「没有这一项」而不是 0%）", () => {
    const r = aggregateAftereffects([[ev("SessionStart", { model: "ds" }, "/work")]], {
      tmpRoots: [],
    });
    expect(r.total.cleared.clear_events).toBe(0);
    expect(r.coverage.ToolResultCleared).toBeNull();
  });

  test("签名与键顺序无关", () => {
    expect(toolSignature("read", { a: 1, b: 2 })).toBe(toolSignature("read", { b: 2, a: 1 }));
    expect(toolSignature("read", undefined)).toBeNull();
  });
});

describe("会话过滤与参数", () => {
  test("tmp cwd 会话整会话剔除", () => {
    const s = [
      ev("SessionStart", { model: "ds" }, "/tmp/x"),
      ev("NoProgressNagInjected", { kind: "todo" }),
    ];
    const r = aggregateAftereffects([s], { tmpRoots: ["/tmp"] });
    expect(r.denominators).toEqual({ sessions: 0, excluded_tmp_sessions: 1 });
  });

  test("未知参数是硬错误", () => {
    expect(() => parseArgs(["--model"])).toThrow(/未知参数/);
    expect(parseArgs(["--since", "2026-11-01", "--json"])).toEqual({
      json: true,
      since: "2026-11-01",
    });
  });

  test("CLI 在空的 SID_CONFIG_DIR 上能跑完", () => {
    const dir = mkdtempSync(join(tmpdir(), "aftereffect-empty-"));
    const r = spawnSync("bun", ["scripts/aftereffect-report.ts", "--json"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SID_CONFIG_DIR: dir },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).denominators.sessions).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
