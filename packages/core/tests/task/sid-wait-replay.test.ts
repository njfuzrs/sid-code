/**
 * R7 回放：ca8d7e5c 里观测到的 PR #780 check-runs 序列。
 *
 * 该会话 10:55 UTC 看到的是「ubuntu 2/3 还在跑、macos 2/2 排队」，11:04 UTC 看到
 * `test (macos-latest, 2/2) -> FAILURE`——但脚本的 `case` 只认 MERGED / CLOSED，
 * 于是继续每 20 秒查一次，直到 25 分钟后期限到才把「一直没合并」告诉模型。
 *
 * 本用例把这两帧落成 fixture，断言原语在**第一次出现 FAILURE 的那一刻**就退出，
 * 而不是继续轮询到期限。job 名与结论取自该会话的 `gh pr checks` 输出（见 fixture 的
 * `source` 字段），check-runs 的 JSON 字段形态按 GitHub REST schema 构造。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runSidWaitGhPr,
  SID_WAIT_EXIT,
  type GhRestClient,
  type GhPullSnapshot,
  type GhCheckRun,
  type GhCheckRunsSnapshot,
} from "../../src/task/sid-wait.ts";

interface FixtureTick {
  observedAt: string;
  pull: { state: string; merged: boolean; mergeable_state: string | null };
  checkRuns: GhCheckRun[];
}

interface Fixture {
  pr: number;
  headSha: string;
  ticks: FixtureTick[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "sid-wait-pr780-check-runs.json"), "utf8"),
) as Fixture;

function tickPull(tick: FixtureTick): GhPullSnapshot {
  return {
    state: tick.pull.state === "closed" ? "closed" : "open",
    merged: tick.pull.merged,
    headSha: fixture.headSha,
    mergeableState: tick.pull.mergeable_state,
  };
}

function tickChecks(tick: FixtureTick): GhCheckRunsSnapshot {
  return { checkRuns: tick.checkRuns };
}

function replayClient(): {
  client: GhRestClient;
  stats: { pullCalls: number; checkCalls: number };
} {
  const stats = { pullCalls: 0, checkCalls: 0 };
  const client: GhRestClient = {
    async getPull(): Promise<GhPullSnapshot> {
      const tick = fixture.ticks[Math.min(stats.pullCalls, fixture.ticks.length - 1)]!;
      stats.pullCalls += 1;
      return tickPull(tick);
    },
    async getCheckRuns(): Promise<GhCheckRunsSnapshot> {
      const tick = fixture.ticks[Math.min(stats.checkCalls, fixture.ticks.length - 1)]!;
      stats.checkCalls += 1;
      return tickChecks(tick);
    },
  };
  return { client, stats };
}

/**
 * 立即返回的 sleep，但最多放行 8 轮。
 *
 * 为什么要有界：变异自证要把实现改坏（比如去掉「failure 退出」），若 sleep 无界，
 * 用例会永远轮询而不是变红——那看到的是超时，不是「断言失败」。有界之后，任何
 * 「本该退出却没退出」的实现错误都会以 aborted 收场，断言直接指出问题。
 */
function boundedSleep(maxRounds = 8): (ms: number) => Promise<boolean> {
  let rounds = 0;
  return async () => {
    rounds += 1;
    return rounds <= maxRounds;
  };
}

describe("R7 回放：ca8d7e5c 的 PR #780 check-runs 序列", () => {
  test("第一次出现 macOS 分片 FAILURE 就退出（不再等 25 分钟期限）", async () => {
    const { client, stats } = replayClient();
    const lines: string[] = [];
    const result = await runSidWaitGhPr({
      pr: fixture.pr,
      client,
      emit: (line) => lines.push(line),
      intervalMs: 20_000,
      sleep: boundedSleep(),
    });

    expect(result.exitCode).toBe(SID_WAIT_EXIT.CHECK_FAILED);
    expect(result.reason).toBe("check-failed");
    expect(result.failedChecks.map((c) => c.name)).toEqual(["test (macos-latest, 2/2)"]);
    expect(result.headSha).toBe(fixture.headSha);
    // 第一帧只是「在跑」，不该被误判成失败；第二帧才失败
    expect(stats.checkCalls).toBe(2);
    // 失败后不再多打 REST：第三帧起是「期限前继续轮询」才会发生的事
    expect(stats.pullCalls).toBe(2);
    expect(lines).toContain("CHECK_FAILED test (macos-latest, 2/2) (failure) job=51000005");
  });

  test("只有 10:55 那一帧（仍有 pending）时沉默等待，不误报失败", async () => {
    const firstTick = fixture.ticks[0]!;
    const client: GhRestClient = {
      async getPull(): Promise<GhPullSnapshot> {
        return tickPull(firstTick);
      },
      async getCheckRuns(): Promise<GhCheckRunsSnapshot> {
        return tickChecks(firstTick);
      },
    };
    const lines: string[] = [];
    let sleeps = 0;
    const result = await runSidWaitGhPr({
      pr: fixture.pr,
      client,
      emit: (line) => lines.push(line),
      sleep: async () => {
        sleeps += 1;
        // 三轮之后取消：证明「没有失败就会一直等」，而不是自己退出
        return sleeps < 3;
      },
    });
    expect(result.reason).toBe("aborted");
    expect(lines.some((l) => l.startsWith("CHECK_FAILED "))).toBe(false);
    expect(lines.filter((l) => l.startsWith("WATCHING ")).length).toBe(1);
    expect(lines[0]).toContain("pending=2");
  });
});
