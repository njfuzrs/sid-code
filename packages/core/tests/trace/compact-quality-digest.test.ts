/**
 * T3：`CompactQuality` 轨迹事件 → digest 会话级指标 → `/trace` 报告。
 *
 * 背景（2026-11-02）：覆盖率原先写在 `<sessionDir>/compact-quality.jsonl`，而 sessionDir
 * 是 `/tmp/sid-code-<uid>/sessions/<id>/compact/`，四个会话写过的 23 次文件全部被清掉。
 * 改落 events.jsonl 后事件有了，但**没有消费方** —— 仍然是「采了不看」，本文件是它的验收。
 *
 * 断言重点不是「函数能跑」，而是三个口径不出错：
 *  1. `compact_quality_n` 与 `compactions` 是**两个分母**（无配对的压缩不落质量事件）
 *  2. 无锚点样本（totalAnchors=0，coverage 恒 1）**不能**拉高最低覆盖率
 *  3. 没有可测样本时 `compact_coverage_min` 是 undefined 而不是 0
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  aggregateSessionMetrics,
  buildDigest,
  listSessions,
  renderHuman,
  resolvePaths,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";

const ev = (event: string, data: Record<string, unknown>) => ({ event, data });

/** 一条 CompactQuality 事件。字段名与 `post-compact.ts` 的落盘处逐字对齐。 */
function qualityEvt(opts: {
  totalAnchors: number;
  coverage: number;
  coveredAnchors?: number;
  trigger?: string;
}) {
  return ev("CompactQuality", {
    trigger: opts.trigger ?? "auto",
    usedLLM: true,
    totalAnchors: opts.totalAnchors,
    coveredAnchors: opts.coveredAnchors ?? Math.round(opts.totalAnchors * opts.coverage),
    coverage: opts.coverage,
    matchedBy: { exact: 0, relative: 0, basename: opts.coveredAnchors ?? 0 },
    missedSamples: [],
  });
}

describe("aggregateSessionMetrics：压缩摘要质量", () => {
  test("最低覆盖率取可测样本里的最小值", () => {
    const m = aggregateSessionMetrics(
      [
        ev("PreCompact", {}),
        qualityEvt({ totalAnchors: 4, coverage: 1 }),
        ev("PreCompact", {}),
        qualityEvt({ totalAnchors: 3, coverage: 0.33 }),
        ev("PreCompact", {}),
        qualityEvt({ totalAnchors: 2, coverage: 0.5 }),
      ],
      { trajCorrupt: false },
    );
    expect(m.compactions).toBe(3);
    expect(m.compact_quality_n).toBe(3);
    expect(m.compact_coverage_min).toBe(0.33);
  });

  test("无锚点样本不计入质量分母，也不参与最低覆盖率", () => {
    // 无锚点时 checkCompactQuality 约定 coverage=1。若被算进来，
    // 一个真正塌陷的 0.1 会被「洗」成看起来还行 —— 这是本测试要钉住的。
    const m = aggregateSessionMetrics(
      [
        qualityEvt({ totalAnchors: 0, coverage: 1, coveredAnchors: 0 }),
        qualityEvt({ totalAnchors: 5, coverage: 0.1, coveredAnchors: 0 }),
      ],
      { trajCorrupt: false },
    );
    expect(m.compact_quality_n).toBe(1);
    expect(m.compact_coverage_min).toBe(0.1);
  });

  test("没有可测样本时是 undefined，不是 0", () => {
    // 0 会被读成「摘要全是垃圾」，与「压根没测」是两件事
    const m = aggregateSessionMetrics([ev("PreCompact", {})], { trajCorrupt: false });
    expect(m.compactions).toBe(1);
    expect(m.compact_quality_n).toBe(0);
    expect(m.compact_coverage_min).toBeUndefined();
  });

  test("完全没压缩过的会话：两个分母都是 0", () => {
    const m = aggregateSessionMetrics([], { trajCorrupt: false });
    expect(m.compactions).toBe(0);
    expect(m.compact_quality_n).toBe(0);
    expect(m.compact_coverage_min).toBeUndefined();
  });
});

describe("renderHuman：压缩质量段落", () => {
  let root: string;
  let paths: DigestPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-compact-quality-"));
    mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
    paths = resolvePaths(root);
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** 写一个最小可用会话：session.traj + events.jsonl */
  function writeSession(id: string, events: unknown[]) {
    const dir = join(root, "trajectories", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({
        trajectory: [],
        info: { exit_status: "end_turn" },
        metadata: { session_id: id, model: "m", exit_status: "end_turn" },
      }),
    );
    if (events.length > 0) {
      writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    }
    return dir;
  }

  test("渲染压缩次数、可测样本数与最低覆盖率", () => {
    writeSession("cq000001", [
      ev("PreCompact", {}),
      qualityEvt({ totalAnchors: 4, coverage: 1 }),
      ev("PreCompact", {}),
      qualityEvt({ totalAnchors: 4, coverage: 0.25 }),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("上下文压缩: 2 次");
    expect(out).toContain("可测质量 2 次");
    expect(out).toContain("最低覆盖率 25%");
  });

  test("低于告警阈值时给出证据指针，高于阈值时不打", () => {
    writeSession("cq000002", [
      ev("PreCompact", {}),
      qualityEvt({ totalAnchors: 4, coverage: 0.25 }),
    ]);
    const low = renderHuman(buildDigest(listSessions(paths)[0], false, paths)!, { noColor: true });
    expect(low).toContain("低于告警阈值 50%");
    expect(low).toContain("CompactQuality.missedSamples");

    writeSession("cq000003", [ev("PreCompact", {}), qualityEvt({ totalAnchors: 4, coverage: 1 })]);
    const high = renderHuman(
      buildDigest(
        listSessions(paths).find((s) => s.id === "cq000003")!,
        false,
        paths,
      )!,
      { noColor: true },
    );
    expect(high).toContain("最低覆盖率 100%");
    expect(high).not.toContain("低于告警阈值");
  });

  test("压缩过但无可测样本时说清楚，不留空", () => {
    // 无原文+摘要配对的 reactive/collapse 压缩就落在这里 —— 读者要能分辨
    // 「量了但都很好」与「一次都没量到」
    writeSession("cq000004", [ev("PreCompact", {}), ev("PreCompact", {})]);
    const out = renderHuman(buildDigest(listSessions(paths)[0], false, paths)!, { noColor: true });
    expect(out).toContain("上下文压缩: 2 次");
    expect(out).toContain("可测质量 0 次");
    expect(out).toContain("无可测样本");
  });

  test("没压缩过的会话整段不出现", () => {
    writeSession("cq000005", []);
    const out = renderHuman(buildDigest(listSessions(paths)[0], false, paths)!, { noColor: true });
    expect(out).not.toContain("上下文压缩");
  });
});
