/**
 * check-external-anchor-due.ts 单测（B7-8 §15.4 蒸馏护栏 3）
 *
 * 覆盖：
 *  - evaluateStatus 三档判定（satisfied / partial / due）
 *  - 双轨独立计数：execution + report 都在窗口内才 satisfied
 *  - 窗口边界：cutoff 之前的记录应被排除
 *  - loadRuns 容错：非法 JSON 行跳过，合法行保留
 *  - recordRun 追加写：状态文件 append 一行
 *  - parseArgs：--record / --track / --subset / --window-days 解析
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateStatus,
  loadRuns,
  recordRun,
  parseArgs,
  type AnchorRunRecord,
} from "../../scripts/eval/check-external-anchor-due.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-anchor-due-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const NOW = "2026-05-31T00:00:00Z";

function rec(daysAgo: number, track: "execution" | "report", subset = "swe-bench-10"): AnchorRunRecord {
  const t = Date.parse(NOW) - daysAgo * 24 * 3600 * 1000;
  return {
    run_at: new Date(t).toISOString(),
    track,
    subset,
  };
}

describe("evaluateStatus - 三档判定", () => {
  test("空记录 → due（双轨都缺）", () => {
    const r = evaluateStatus([], 90, NOW);
    expect(r.status).toBe("due");
    expect(r.execution_count).toBe(0);
    expect(r.report_count).toBe(0);
    expect(r.missing_tracks).toEqual(["execution", "report"]);
  });

  test("仅 execution 轨命中 → partial（缺 report）", () => {
    const r = evaluateStatus([rec(30, "execution")], 90, NOW);
    expect(r.status).toBe("partial");
    expect(r.missing_tracks).toEqual(["report"]);
  });

  test("仅 report 轨命中 → partial（缺 execution）", () => {
    const r = evaluateStatus([rec(45, "report")], 90, NOW);
    expect(r.status).toBe("partial");
    expect(r.missing_tracks).toEqual(["execution"]);
  });

  test("双轨都命中 → satisfied", () => {
    const r = evaluateStatus([rec(10, "execution"), rec(20, "report")], 90, NOW);
    expect(r.status).toBe("satisfied");
    expect(r.missing_tracks).toEqual([]);
    expect(r.execution_count).toBe(1);
    expect(r.report_count).toBe(1);
  });
});

describe("evaluateStatus - 窗口边界", () => {
  test("窗口外的旧记录被排除", () => {
    // 91 天前 + 89 天前各一条 execution；窗口 90 天 → 只 89 天前那条命中
    const r = evaluateStatus(
      [rec(91, "execution"), rec(89, "execution"), rec(10, "report")],
      90,
      NOW,
    );
    expect(r.execution_count).toBe(1);
    expect(r.report_count).toBe(1);
    expect(r.status).toBe("satisfied");
  });

  test("窗口正好为 0 → 全部排除", () => {
    const r = evaluateStatus([rec(0, "execution"), rec(1, "report")], 0, NOW);
    expect(r.execution_count).toBe(1);
    expect(r.report_count).toBe(0);
    expect(r.status).toBe("partial");
  });

  test("most_recent_* 取窗口内最新一条", () => {
    const r = evaluateStatus(
      [rec(60, "execution", "old"), rec(10, "execution", "new"), rec(30, "report")],
      90,
      NOW,
    );
    expect(r.most_recent_execution?.subset).toBe("new");
  });

  test("nowIso 非法 → 抛错", () => {
    expect(() => evaluateStatus([], 90, "not-a-date")).toThrow(/invalid/);
  });
});

describe("loadRuns / recordRun - 状态文件 IO", () => {
  test("不存在的状态文件 → 空数组", () => {
    expect(loadRuns(join(tmpRoot, "nonexistent.jsonl"))).toEqual([]);
  });

  test("recordRun 追加写一行", () => {
    const path = join(tmpRoot, "append.jsonl");
    recordRun({ run_at: NOW, track: "execution", subset: "x" }, path);
    recordRun({ run_at: NOW, track: "report", subset: "y" }, path);
    const runs = loadRuns(path);
    expect(runs.length).toBe(2);
    expect(runs[0].track).toBe("execution");
    expect(runs[1].track).toBe("report");
  });

  test("非法 JSON 行 / 缺字段记录被跳过，合法行保留", () => {
    const path = join(tmpRoot, "mixed.jsonl");
    const content = [
      JSON.stringify({ run_at: NOW, track: "execution", subset: "ok" }),
      "not json",
      JSON.stringify({ run_at: NOW, track: "invalid_track", subset: "skip" }),
      "",
      JSON.stringify({ track: "report", subset: "no_run_at" }),
      JSON.stringify({ run_at: NOW, track: "report", subset: "ok2" }),
    ].join("\n");
    writeFileSync(path, content, "utf-8");
    const runs = loadRuns(path);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.subset).sort()).toEqual(["ok", "ok2"]);
  });

  test("recordRun 自动建父目录", () => {
    const deepPath = join(tmpRoot, "deep", "nested", "anchor.jsonl");
    recordRun({ run_at: NOW, track: "execution", subset: "z" }, deepPath);
    const text = readFileSync(deepPath, "utf-8");
    expect(text.includes('"subset":"z"')).toBe(true);
  });
});

describe("parseArgs - CLI 参数解析", () => {
  test("默认 check 模式 + 默认 90 天窗口", () => {
    const args = parseArgs([]);
    expect(args.mode).toBe("check");
    expect(args.windowDays).toBe(90);
  });

  test("--record 切到 record 模式", () => {
    const args = parseArgs(["--record", "--track", "execution", "--subset", "swe-bench-10"]);
    expect(args.mode).toBe("record");
    expect(args.track).toBe("execution");
    expect(args.subset).toBe("swe-bench-10");
  });

  test("--window-days 60 → windowDays=60", () => {
    const args = parseArgs(["--window-days", "60"]);
    expect(args.windowDays).toBe(60);
  });

  test("--summary --sprint 解析", () => {
    const args = parseArgs([
      "--record",
      "--track",
      "report",
      "--subset",
      "cr-20",
      "--summary",
      "_reports/external/cr.md",
      "--sprint",
      "S7",
    ]);
    expect(args.summary).toBe("_reports/external/cr.md");
    expect(args.sprint).toBe("S7");
  });

  test("--now 注入用于测试", () => {
    const args = parseArgs(["--now", NOW]);
    expect(args.now).toBe(NOW);
  });
});
