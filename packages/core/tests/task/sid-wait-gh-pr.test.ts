/**
 * R7：内置等待原语 `sid-wait gh-pr <n>` 的解析与退出条件。
 *
 * 这一层的判据全是「给定 REST 快照序列，原语必须立刻退出」，不联网、不起进程：
 * `GhRestClient` 是注入的，sleep 是注入的（不会真等 30 秒）。
 *
 * 两个真实事故的直接回归：
 * - `head` 变化后必须查新 commit（b0aa0f1e：按本地 HEAD 查，PR head 被换掉后一直查旧 commit）；
 * - 任一检查 FAILURE 必须立刻退出（ca8d7e5c：macOS 分片红了还每 20 秒查一次，25 分钟后
 *   才以「期限到」送达）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseSidWaitCommand,
  runSidWaitGhPr,
  formatSidWaitResultSummary,
  isSidWaitCommand,
  formatManualLoopHint,
  __resetManualLoopHintForTest,
  DEFAULT_SID_WAIT_INTERVAL_MS,
  DEFAULT_SID_WAIT_DEADLINE_S,
  MIN_SID_WAIT_INTERVAL_S,
  MAX_SID_WAIT_INTERVAL_S,
  SID_WAIT_MAX_CONSECUTIVE_FAILURES,
  SID_WAIT_MAX_EMITTED_FAILED_CHECKS,
  SID_WAIT_EXIT,
  type GhRestClient,
  type GhPullSnapshot,
  type GhCheckRun,
  type GhCheckRunsSnapshot,
} from "../../src/task/sid-wait.ts";

const HEAD_A = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const HEAD_B = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

function openPull(headSha = HEAD_A, mergeableState: string | null = "blocked"): GhPullSnapshot {
  return { state: "open", merged: false, headSha, mergeableState };
}

function mergedPull(headSha = HEAD_A): GhPullSnapshot {
  return { state: "closed", merged: true, headSha, mergeableState: null };
}

function closedPull(headSha = HEAD_A): GhPullSnapshot {
  return { state: "closed", merged: false, headSha, mergeableState: null };
}

function check(name: string, conclusion: string | null, id = 1): GhCheckRun {
  return {
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    id,
  };
}

interface FakePlan {
  /** 按调用顺序返回；最后一项会被重复使用（模拟「状态一直没变」） */
  pulls: Array<GhPullSnapshot | Error>;
  /** 按 head sha 返回这一轮的检查集合 */
  checksBySha?: Record<string, GhCheckRunsSnapshot | Error>;
  /** 按第 n 次 getCheckRuns（从 0 开始）返回，优先于 checksBySha */
  checksByCall?: Array<GhCheckRunsSnapshot | Error>;
}

interface FakeStats {
  pullCalls: number;
  checkShas: string[];
}

function fakeClient(plan: FakePlan): { client: GhRestClient; stats: FakeStats } {
  let pullCursor = 0;
  let checkCursor = 0;
  const stats: FakeStats = { pullCalls: 0, checkShas: [] };
  const client: GhRestClient = {
    async getPull(): Promise<GhPullSnapshot> {
      stats.pullCalls += 1;
      const item = plan.pulls[Math.min(pullCursor, plan.pulls.length - 1)]!;
      pullCursor += 1;
      if (item instanceof Error) throw item;
      return item;
    },
    async getCheckRuns(_pr: number, sha: string): Promise<GhCheckRunsSnapshot> {
      stats.checkShas.push(sha);
      const byCall = plan.checksByCall?.[checkCursor];
      checkCursor += 1;
      const item = byCall ?? plan.checksBySha?.[sha] ?? { checkRuns: [] };
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return { client, stats };
}

/** 收集输出行 */
function recorder(): { lines: string[]; emit: (line: string) => void } {
  const lines: string[] = [];
  return { lines, emit: (line: string) => lines.push(line) };
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

beforeEach(() => {
  __resetManualLoopHintForTest();
});

describe("R7 parseSidWaitCommand", () => {
  test("基本形态：默认 30s 间隔", () => {
    const spec = parseSidWaitCommand("sid-wait gh-pr 779");
    expect(spec).toEqual({
      kind: "gh-pr",
      pr: 779,
      intervalMs: DEFAULT_SID_WAIT_INTERVAL_MS,
      intervalConfigured: false,
    });
    expect(DEFAULT_SID_WAIT_INTERVAL_MS).toBe(30_000);
  });

  test("--interval 与 --interval= 两种写法", () => {
    expect(parseSidWaitCommand("sid-wait gh-pr 779 --interval 15")?.intervalMs).toBe(15_000);
    expect(parseSidWaitCommand("sid-wait gh-pr 779 --interval=5")?.intervalMs).toBe(5_000);
    expect(parseSidWaitCommand("sid-wait gh-pr 779 --interval 15")?.intervalConfigured).toBe(true);
  });

  test("多余空白与前置 cd 前缀都能归一化", () => {
    expect(parseSidWaitCommand("  sid-wait   gh-pr   779  ")?.pr).toBe(779);
    expect(parseSidWaitCommand("cd /repo && sid-wait gh-pr 12")?.pr).toBe(12);
    expect(parseSidWaitCommand('cd "/repo with space" && sid-wait gh-pr 12')?.pr).toBe(12);
  });

  test("间隔钳制到 [5, 300] 秒", () => {
    expect(parseSidWaitCommand("sid-wait gh-pr 1 --interval 1")?.intervalMs).toBe(
      MIN_SID_WAIT_INTERVAL_S * 1000,
    );
    expect(parseSidWaitCommand("sid-wait gh-pr 1 --interval 9999")?.intervalMs).toBe(
      MAX_SID_WAIT_INTERVAL_S * 1000,
    );
  });

  test("不是原语形态一律返回 null（不猜意图）", () => {
    for (const command of [
      "",
      "gh pr view 779",
      "echo sid-wait gh-pr 779",
      "sid-wait gh-pr",
      "sid-wait gh-pr abc",
      "sid-wait gh-pr 0",
      "sid-wait gh-pr 779 | cat",
      "sid-wait gh-pr 779 > /tmp/x",
      "sid-wait gh-pr 779 && echo done",
      "sid-wait gh-pr 779 --interval",
      "sid-wait gh-pr 779 --json state",
      "bash /tmp/wait-pr-779.sh",
    ]) {
      expect(parseSidWaitCommand(command)).toBeNull();
      expect(isSidWaitCommand(command)).toBe(false);
    }
  });

  test("默认期限 30 分钟（不带 wait_until_seconds 时用它，避免退化成普通后台任务）", () => {
    expect(DEFAULT_SID_WAIT_DEADLINE_S).toBe(1800);
  });
});

describe("R7 runSidWaitGhPr 退出条件", () => {
  test("已合并 → exit 0，输出 MERGED", async () => {
    const { client } = fakeClient({ pulls: [mergedPull()] });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.MERGED);
    expect(result.reason).toBe("merged");
    expect(out.lines).toContain(`MERGED ${HEAD_A}`);
  });

  test("已关闭但未合并 → exit 3（不是成功）", async () => {
    const { client } = fakeClient({ pulls: [closedPull()] });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CLOSED);
    expect(result.reason).toBe("closed");
  });

  test("mergeable_state=dirty → exit 4（冲突不该等到期限）", async () => {
    const { client } = fakeClient({ pulls: [openPull(HEAD_A, "dirty")] });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CONFLICT);
    expect(out.lines.some((l) => l.startsWith("CONFLICT "))).toBe(true);
  });

  test("任一检查 failure → exit 1，点出失败的那几条", async () => {
    const { client } = fakeClient({
      pulls: [openPull()],
      checksBySha: {
        [HEAD_A]: {
          checkRuns: [
            check("test (ubuntu-latest, 1/3)", "success", 101),
            check("test (macos-latest, 2/2)", "failure", 102),
            check("lint", "success", 103),
          ],
        },
      },
    });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 780, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CHECK_FAILED);
    expect(result.failedChecks.map((c) => c.name)).toEqual(["test (macos-latest, 2/2)"]);
    expect(out.lines).toContain("CHECK_FAILED test (macos-latest, 2/2) (failure) job=102");
    expect(formatSidWaitResultSummary(result, 780)).toContain("test (macos-latest, 2/2)(failure)");
  });

  test("cancelled / timed_out / action_required 也算失败；skipped / neutral 不算", async () => {
    const { client } = fakeClient({
      pulls: [openPull()],
      checksBySha: {
        [HEAD_A]: {
          checkRuns: [
            check("cancelled-job", "cancelled"),
            check("timeout-job", "timed_out"),
            check("needs-approval", "action_required"),
            check("skipped-job", "skipped"),
            check("neutral-job", "neutral"),
            check("ok", "success"),
          ],
        },
      },
    });
    const result = await runSidWaitGhPr({
      pr: 1,
      client,
      emit: () => {},
      sleep: boundedSleep(),
    });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CHECK_FAILED);
    expect(result.failedChecks.map((c) => c.name)).toEqual([
      "cancelled-job",
      "timeout-job",
      "needs-approval",
    ]);
  });

  test("head 变化后必须用新 head 查 check-runs（b0aa0f1e 的回归）", async () => {
    const { client, stats } = fakeClient({
      // 第一次 open@A 且全绿 → 第二轮 PR 被 update-branch 换成 B → 第三轮合并
      pulls: [openPull(HEAD_A), openPull(HEAD_B), mergedPull(HEAD_B)],
      checksBySha: {
        [HEAD_A]: { checkRuns: [check("test", "success")] },
        [HEAD_B]: { checkRuns: [check("test", "success")] },
      },
    });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.MERGED);
    // 关键断言：第二次查的是新 head，而不是继续查旧 commit
    expect(stats.checkShas).toEqual([HEAD_A, HEAD_B]);
    expect(out.lines.some((l) => l.startsWith(`HEAD_CHANGED ${HEAD_A}→${HEAD_B}`))).toBe(true);
  });

  test("新 head 上出现失败也立刻退出（不在旧 head 的结论上停住）", async () => {
    const { client, stats } = fakeClient({
      pulls: [openPull(HEAD_A), openPull(HEAD_B)],
      checksBySha: {
        [HEAD_A]: { checkRuns: [check("test", "success")] },
        [HEAD_B]: { checkRuns: [check("test", "failure")] },
      },
    });
    const result = await runSidWaitGhPr({ pr: 779, client, emit: () => {}, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CHECK_FAILED);
    expect(result.headSha).toBe(HEAD_B);
    expect(stats.checkShas).toEqual([HEAD_A, HEAD_B]);
  });

  test("REST 连续失败到阈值 → exit 5（抖动不算失败，一直失败必须退出）", async () => {
    const { client, stats } = fakeClient({
      pulls: [new Error("gh api 超时"), new Error("gh api 超时"), new Error("gh api 超时")],
    });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.REST_FAILED);
    expect(result.reason).toBe("rest-failed");
    expect(stats.pullCalls).toBe(SID_WAIT_MAX_CONSECUTIVE_FAILURES);
    expect(out.lines.filter((l) => l.startsWith("REST_ERROR ")).length).toBe(
      SID_WAIT_MAX_CONSECUTIVE_FAILURES,
    );
  });

  test("check-runs 端点持续失败也要退出（计数不能被上一轮 getPull 成功清零）", async () => {
    const { client, stats } = fakeClient({
      // pulls 一直成功（PR 正常可查），只有 check-runs 端点挂掉——对应 token 缺 Checks
      // 读权限 / GHE 未启用 checks API。回归点：failures 曾在 getPull 成功后就被清零，
      // 于是这条路径永远到不了阈值，只能跑满 30 分钟期限。
      pulls: [openPull()],
      checksByCall: [new Error("gh api 超时"), new Error("gh api 超时"), new Error("gh api 超时")],
    });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 779, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.REST_FAILED);
    expect(result.reason).toBe("rest-failed");
    expect(result.attempts).toBe(SID_WAIT_MAX_CONSECUTIVE_FAILURES);
    expect(stats.pullCalls).toBe(SID_WAIT_MAX_CONSECUTIVE_FAILURES);
    // 编号必须递增到 3/3；若计数被打回 0，这里会是三个 1/3 且 result.reason 变成 aborted
    expect(
      out.lines.filter((l) => l.startsWith("REST_ERROR ")).map((l) => /连续 (\d+)\//.exec(l)?.[1]),
    ).toEqual(["1", "2", "3"]);
  });

  test("check-runs 失败 2 次后恢复 → 计数清零，照常等到合并", async () => {
    const { client, stats } = fakeClient({
      pulls: [openPull(), openPull(), openPull(), mergedPull()],
      checksByCall: [
        new Error("网络抖动 1"),
        new Error("网络抖动 2"),
        { checkRuns: [check("test", "success")] },
      ],
    });
    const result = await runSidWaitGhPr({ pr: 779, client, emit: () => {}, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.MERGED);
    expect(stats.pullCalls).toBe(4);
  });

  test("4xx 是确定性拒绝 → 立即终态，不做 3 次退避", async () => {
    const notFound = new Error(
      "gh api repos/{owner}/{repo}/pulls/999999 失败（exit 1）：gh: Not Found (HTTP 404)",
    );
    const { client, stats } = fakeClient({ pulls: [notFound] });
    const out = recorder();
    const result = await runSidWaitGhPr({
      pr: 999999,
      client,
      emit: out.emit,
      sleep: boundedSleep(),
    });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.REST_FAILED);
    expect(result.reason).toBe("rest-fatal");
    expect(result.httpStatus).toBe(404);
    // 关键：只打一次 REST。重试 404 只会把「PR 号打错」推迟到 3 次退避（默认 60s+120s）之后
    expect(stats.pullCalls).toBe(1);
    expect(out.lines.some((l) => l.startsWith("REST_FATAL "))).toBe(true);
    expect(formatSidWaitResultSummary(result, 999999)).toContain("HTTP 404");
  });

  test("5xx 仍按连续失败阈值退避（暂时故障不能当确定性拒绝）", async () => {
    const serverError = () =>
      new Error(
        "gh api repos/{owner}/{repo}/pulls/779 失败（exit 1）：gh: Server Error (HTTP 502)",
      );
    const { client, stats } = fakeClient({
      pulls: [serverError(), serverError(), serverError()],
    });
    const result = await runSidWaitGhPr({ pr: 779, client, emit: () => {}, sleep: boundedSleep() });
    expect(result.reason).toBe("rest-failed");
    expect(stats.pullCalls).toBe(SID_WAIT_MAX_CONSECUTIVE_FAILURES);
  });

  test("几十个检查同时失败时事件有上限（monitor 每行一条，不能刷屏）", async () => {
    const many = Array.from({ length: 50 }, (_, i) => check(`job-${i}`, "failure", 1000 + i));
    const { client } = fakeClient({
      pulls: [openPull()],
      checksByCall: [{ checkRuns: many }],
    });
    const out = recorder();
    const result = await runSidWaitGhPr({ pr: 780, client, emit: out.emit, sleep: boundedSleep() });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.CHECK_FAILED);
    // 结果里仍保留全部失败项（供 summary / 后续排查），只是**事件**收敛
    expect(result.failedChecks.length).toBe(50);
    expect(out.lines.filter((l) => l.startsWith("CHECK_FAILED ")).length).toBe(
      SID_WAIT_MAX_EMITTED_FAILED_CHECKS,
    );
    expect(out.lines.filter((l) => l.startsWith("CHECK_FAILED_MORE "))).toEqual([
      "CHECK_FAILED_MORE 另有 40 项失败未列出（共 50 项）",
    ]);
  });

  test("失败后恢复：连续失败 2 次（未到阈值 3）不退出，恢复后照常等到合并", async () => {
    const { client, stats } = fakeClient({
      pulls: [
        new Error("网络抖动 1"),
        new Error("网络抖动 2"),
        openPull(HEAD_A),
        mergedPull(HEAD_A),
      ],
      checksBySha: { [HEAD_A]: { checkRuns: [check("test", "success")] } },
    });
    const result = await runSidWaitGhPr({
      pr: 779,
      client,
      emit: () => {},
      sleep: boundedSleep(),
    });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.MERGED);
    // 2 次失败 + 1 次 open + 1 次 merged：阈值内不退出，恢复后继续轮询
    expect(stats.pullCalls).toBe(4);
  });

  test("被取消 → 立即返回，不再打 REST", async () => {
    const controller = new AbortController();
    const { client, stats } = fakeClient({ pulls: [openPull()] });
    const result = await runSidWaitGhPr({
      pr: 779,
      client,
      emit: () => {},
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        return false;
      },
    });
    // 主动停止必须有独立退出码：与「REST 连续失败」共用 5 会让脚本把「我停的」
    // 误读成「网络挂了」（入口 kill 路径会短路掉这个码，但直接调用方拿得到）
    expect(result.exitCode).toBe(SID_WAIT_EXIT.ABORTED);
    expect(result.reason).toBe("aborted");
    expect(stats.pullCalls).toBe(1);
  });

  test("首轮打一行 WATCHING，之后状态不变不再刷（沉默不等于成功，但不能成噪声）", async () => {
    const { client } = fakeClient({
      pulls: [openPull()],
      checksBySha: {
        [HEAD_A]: { checkRuns: [check("test", null), check("lint", "success")] },
      },
    });
    const out = recorder();
    let sleeps = 0;
    await runSidWaitGhPr({
      pr: 779,
      client,
      emit: out.emit,
      sleep: async () => {
        sleeps += 1;
        return sleeps < 3;
      },
    });
    const watching = out.lines.filter((l) => l.startsWith("WATCHING "));
    expect(watching.length).toBe(1);
    expect(watching[0]).toContain(`gh:pr:779 head=${HEAD_A} checks=2 pending=1`);
  });
});

describe("R7 formatManualLoopHint（手写循环只提示一次）", () => {
  test("等 PR 的手写命令 → 提示一次 sid-wait 写法", () => {
    const first = formatManualLoopHint(
      ["gh:pr:779"],
      "for i in $(seq 1 90); do gh pr view 779; done",
    );
    expect(first).toContain("sid-wait gh-pr 779");
    // 同一个对象第二次不再提示
    expect(formatManualLoopHint(["gh:pr:779"], "gh pr view 779")).toBe("");
  });

  test("已经在用内置原语 / 没有 PR 对象 / 没有对象 → 不提示", () => {
    expect(formatManualLoopHint(["gh:pr:780"], "sid-wait gh-pr 780")).toBe("");
    expect(formatManualLoopHint(["gh:run:43203650726"], "gh run watch 43203650726")).toBe("");
    expect(formatManualLoopHint([], "curl http://x")).toBe("");
  });

  test("不同 PR 各自提示一次（按对象去重，不是全局一次性）", () => {
    expect(formatManualLoopHint(["gh:pr:781"], "gh pr view 781")).toContain("sid-wait gh-pr 781");
    expect(formatManualLoopHint(["gh:pr:782"], "gh pr view 782")).toContain("sid-wait gh-pr 782");
  });
});
