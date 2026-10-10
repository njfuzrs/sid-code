/**
 * 轨迹目录淘汰（trace/retention.ts + collector.pruneOldSessions）。
 *
 * 核心门禁：默认**不得按数量删**（此前默认 100，一天几十个会话只够两三周，
 * 开发者回头调试时 raw.jsonl / events.jsonl 已经没了）。防盘满只靠体积上限。
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { selectTraceDirsToPrune, type TraceDirEntry } from "@sid-code/core/trace/retention.ts";

const e = (id: string, mtimeMs: number, opts: Partial<TraceDirEntry> = {}): TraceDirEntry => ({
  id,
  dir: `/x/${id}`,
  mtimeMs,
  uploaded: false,
  bytes: 10,
  ...opts,
});

describe("selectTraceDirsToPrune（纯函数）", () => {
  test("无数量、无体积上限 → 一个都不删", () => {
    const entries = Array.from({ length: 500 }, (_, i) => e(`s${i}`, i));
    expect(selectTraceDirsToPrune(entries, {})).toHaveLength(0);
  });

  test("体积超限 → 已上传优先、最旧优先，删到不超为止", () => {
    const entries = [
      e("pending-oldest", 1, { bytes: 40 }),
      e("up-old", 2, { uploaded: true, bytes: 40 }),
      e("up-new", 3, { uploaded: true, bytes: 40 }),
      e("pending-new", 4, { bytes: 40 }),
    ];
    // 合计 160，上限 100 → 需删 2 个，先删两个已上传的
    const ids = selectTraceDirsToPrune(entries, { maxTotalBytes: 100 }).map((x) => x.id);
    expect(ids).toEqual(["up-old", "up-new"]);
  });

  test("受保护的（活跃进程 / minRetention 窗口内）宁可超限也不删", () => {
    const entries = [
      e("active", 1, { bytes: 100 }),
      e("fresh", 1000, { bytes: 100 }),
      e("old", 2, { bytes: 100 }),
    ];
    const ids = selectTraceDirsToPrune(entries, {
      maxTotalBytes: 50,
      protectAfterMs: 500,
      protectedIds: new Set(["active"]),
    }).map((x) => x.id);
    expect(ids).toEqual(["old"]);
  });

  test("显式数量上限仍生效，且与体积上限叠加不重复计", () => {
    const entries = [e("a", 1, { bytes: 50 }), e("b", 2, { bytes: 50 }), e("c", 3, { bytes: 50 })];
    const ids = selectTraceDirsToPrune(entries, { maxCount: 2, maxTotalBytes: 60 }).map(
      (x) => x.id,
    );
    expect(ids).toEqual(["a", "b"]);
  });

  test("非法数量（0 / 负数 / NaN）视为不限，绝不解读成「保留 0 个」", () => {
    const entries = [e("a", 1), e("b", 2)];
    for (const maxCount of [0, -1, Number.NaN]) {
      expect(selectTraceDirsToPrune(entries, { maxCount })).toHaveLength(0);
    }
  });
});

describe("TraceCollector 启动清理", () => {
  function freshDir(): string {
    const d = join(tmpdir(), `trace-retention-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(d, "sessions"), { recursive: true });
    return d;
  }
  function makeSession(root: string, id: string, bytes: number, mtimeSec: number) {
    const dir = join(root, "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "x".repeat(bytes));
    const t = new Date(mtimeSec * 1000);
    utimesSync(dir, t, t);
    return dir;
  }

  test("反向门禁：默认不按数量删 —— 150 个旧目录全部保留（旧默认会删 50 个）", () => {
    const root = freshDir();
    for (let i = 0; i < 150; i++) makeSession(root, `s${String(i).padStart(3, "0")}`, 10, 1000 + i);
    new TraceCollector({ outputDir: root });
    expect(readdirSync(join(root, "sessions"))).toHaveLength(150);
    rmSync(root, { recursive: true, force: true });
  });

  test("体积超限 → 从最旧的删", () => {
    const root = freshDir();
    const oldest = makeSession(root, "a", 1000, 100);
    const mid = makeSession(root, "b", 1000, 200);
    const newest = makeSession(root, "c", 1000, 300);
    new TraceCollector({ outputDir: root, maxTotalBytes: 2500, minRetentionMs: 0 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(mid)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("maxTotalBytes=0（sessionRetention.enabled:false）→ 不按体积删", () => {
    const root = freshDir();
    const a = makeSession(root, "a", 1000, 100);
    new TraceCollector({ outputDir: root, maxTotalBytes: 0, minRetentionMs: 0 });
    expect(existsSync(a)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("默认 1 天保护窗口：刚写过的目录即使超限也不删", () => {
    const root = freshDir();
    const dir = join(root, "sessions", "fresh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "x".repeat(1000));
    new TraceCollector({ outputDir: root, maxTotalBytes: 10 });
    expect(existsSync(dir)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
