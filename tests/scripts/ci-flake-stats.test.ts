/**
 * ci-flake-stats 的测试 —— **全部数据都是造的**
 *
 * 为什么不采真实 CI 数据：
 *
 * 1. 判据依赖「重跑转绿的 run」这种样本，而它出现的频率低且不可控。等它自然出现
 *    等于把结论押在一个不会按时发生的事件上（用户 2026-11-15 的原话：
 *    「如果是缺少样本数据……永远都等不到数据，我们可以考虑自己造数据」）。
 * 2. 拉 `gh api` 需要网络与仓库权限，而 `bun test` 必须在离线环境可跑。
 *
 * 造数据覆盖的是**计算层的全部分支**，不是「三种 run 都见过」这种平均值：
 * 当前失败 / 重跑转绿 / cancelled 不进分母 / 一 run 多平台失败 / attempt1 数据缺失。
 */

import { describe, expect, test } from "bun:test";
import { computeFlakeStats, shardsFromJobs, type RunRecord } from "../../scripts/ci-flake-stats.ts";

/** 造一个 run。默认是「ubuntu 3 片 + macOS 2 片全绿」的干净形态。 */
function run(over: Partial<RunRecord> = {}): RunRecord {
  const clean = [
    { os: "ubuntu-latest", failed: false },
    { os: "ubuntu-latest", failed: false },
    { os: "ubuntu-latest", failed: false },
    { os: "macos-latest", failed: false },
    { os: "macos-latest", failed: false },
  ];
  return {
    id: 1,
    conclusion: "success",
    run_attempt: 1,
    created_at: "2026-11-15T00:00:00Z",
    event: "pull_request",
    shards: clean,
    ...over,
  };
}

/** 把某个分片标成失败（按出现顺序把第 n 个该平台分片置红）。 */
function failShard(shards: RunRecord["shards"], os: string, nth = 0) {
  let seen = 0;
  return shards.map((s) => {
    if (s.os !== os) return s;
    const hit = seen === nth;
    seen++;
    return hit ? { ...s, failed: true } : s;
  });
}

describe("computeFlakeStats：两种口径", () => {
  test("当前失败按 run 计、按分片归一（1 红 / 2 个 run × 2 片 = 25%）", () => {
    const runs = [
      run({ id: 1, conclusion: "failure", shards: failShard(run().shards, "macos-latest") }),
      run({ id: 2 }),
    ];
    const s = computeFlakeStats(runs);
    const mac = s.current.find((r) => r.os === "macos-latest")!;
    expect({
      failedRuns: mac.failedRuns,
      runCount: mac.runCount,
      shardCount: mac.shardCount,
    }).toEqual({
      failedRuns: 1,
      runCount: 2,
      shardCount: 2,
    });
    expect(mac.density).toBe(0.25);
    // ubuntu 侧同两次 run 一片没红
    expect(s.current.find((r) => r.os === "ubuntu-latest")!.failedRuns).toBe(0);
  });

  // 这是本文件最重要的一条：**只看当前结论会把改善量算大**。
  // 重跑转绿的 run 在列表里是 success，但它确实红过一次。
  test("重跑转绿：current 不计、incl-rescued 计入，并单独列出是哪一次 run", () => {
    const rescuedRun = run({
      id: 42,
      run_attempt: 2,
      conclusion: "success", // 最终绿
      firstAttemptShards: failShard(run().shards, "macos-latest"), // 首跑 macOS 红过
    });
    const cleanRun = run({ id: 43 });

    const s = computeFlakeStats([rescuedRun, cleanRun]);
    expect(s.current.find((r) => r.os === "macos-latest")!.failedRuns).toBe(0);
    expect(s.inclRescued.find((r) => r.os === "macos-latest")!.failedRuns).toBe(1);
    expect(s.rescued).toEqual([
      { runId: 42, platforms: ["macos-latest"], createdAt: "2026-11-15T00:00:00Z" },
    ]);
    // ubuntu 首跑没红，两个口径都是 0
    expect(s.inclRescued.find((r) => r.os === "ubuntu-latest")!.failedRuns).toBe(0);
  });

  test("cancelled 与进行中不进分母（否则密度被稀释成假改善）", () => {
    const runs = [
      run({ id: 1, conclusion: "failure", shards: failShard(run().shards, "macos-latest") }),
      run({ id: 2, conclusion: "cancelled", shards: [] }),
      run({ id: 3, conclusion: null, shards: [] }),
    ];
    const s = computeFlakeStats(runs);
    expect(s.window.runCount).toBe(1);
    expect(s.window.skipped).toBe(2);
    // 1 红 / (1 个有结论 run × 2 片) = 50%，而不是 1/(3×2)=16.7%
    expect(s.current.find((r) => r.os === "macos-latest")!.density).toBe(0.5);
  });

  test("一次 run 两个平台都红：各自计 1（按 run 不按 job）", () => {
    const shards = failShard(failShard(run().shards, "macos-latest"), "ubuntu-latest");
    const s = computeFlakeStats([run({ id: 1, conclusion: "failure", shards })]);
    expect(s.current.find((r) => r.os === "macos-latest")!.failedRuns).toBe(1);
    expect(s.current.find((r) => r.os === "ubuntu-latest")!.failedRuns).toBe(1);
  });

  // 「没拉 attempt 1 数据」≠「没红过」。这条防的是把它静默读成 0。
  test("重跑过但缺 attempt1 数据：rescuedUnknown 计数，不臆断为没红过", () => {
    const s = computeFlakeStats([
      run({ id: 7, run_attempt: 2, conclusion: "success", firstAttemptShards: undefined }),
    ]);
    expect(s.rescuedUnknown).toBe(1);
    expect(s.rescued).toEqual([]);
    expect(s.inclRescued.find((r) => r.os === "macos-latest")!.failedRuns).toBe(0);
  });

  test("分片数从数据里发现（某次 run 缺片时不把该平台误判成 1 片）", () => {
    const partial = run({ id: 2, shards: [{ os: "macos-latest", failed: false }] });
    const s = computeFlakeStats([run({ id: 1 }), partial]);
    expect(s.current.find((r) => r.os === "macos-latest")!.shardCount).toBe(2);
  });

  test("窗口取有结论 run 的最早/最晚 created_at", () => {
    const s = computeFlakeStats([
      run({ id: 1, created_at: "2026-11-14T05:10:00Z" }),
      run({ id: 2, created_at: "2026-11-15T15:45:51Z" }),
    ]);
    expect(s.window.from).toBe("2026-11-14T05:10:00Z");
    expect(s.window.to).toBe("2026-11-15T15:45:51Z");
  });

  test("空输入不炸（窗口为空、两张表都是空）", () => {
    const s = computeFlakeStats([]);
    expect(s.window.runCount).toBe(0);
    expect(s.current).toEqual([]);
    expect(s.rescued).toEqual([]);
  });
});

describe("shardsFromJobs：从 job 名解析分片", () => {
  test("只认 `test (<os>, n/m)`，lint / website 等其它 job 不算分片", () => {
    const shards = shardsFromJobs([
      { name: "test (macos-latest, 1/2)", conclusion: "failure" },
      { name: "test (macos-latest, 2/2)", conclusion: "success" },
      { name: "test (ubuntu-latest, 1/3)", conclusion: "null" },
      { name: "lint", conclusion: "failure" },
      { name: "website", conclusion: "success" },
      { name: "all-checks-passed", conclusion: "failure" },
    ]);
    expect(shards).toEqual([
      { os: "macos-latest", failed: true },
      { os: "macos-latest", failed: false },
      { os: "ubuntu-latest", failed: false }, // null（进行中/被取消）不算失败
    ]);
  });
});
