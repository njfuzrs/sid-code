/**
 * N3：P1 等待期拦截的**匹配面**——循环、只读过滤管道、`gh api` 状态端点。
 *
 * 事故（`20261109-160803-fbb02831` / `20261109-191904-962011a6`）：
 * 排了等待源之后仍在等待期前台查 CI，但 P1 的命令表只认「最后一段简单命令」，
 * 于是最常见的三种写法全部漏掉：
 *
 * | 写法 | 修复前为什么 null | 真实量级 |
 * | --- | --- | --- |
 * | `for pr in …; do gh pr view $pr …; done` | 最后一段是 `done` | fbb02831 46 次 gh 调用里 25 次 |
 * | `gh … \| head/jq/grep` | 最后一段是过滤命令 | 全量 954 会话 530 次 |
 * | `gh api …/check-runs` | 表里没有 `gh api` | 175 次 / 29 会话 |
 *
 * 全量识别率（`gh (pr|run) (view|checks|status)` 口径）：修复前 1107/1995 = 55.5%。
 * 本文件守的是**形状与安全边界**；识别率与真实回放的数字在 Agent Note 第三段
 * （`20261110-等待期状态查询识别循环过滤管道与gh-api.md`），不在这里复制（避免两处漂移）。
 *
 * 方向性要求（原方案 §5.5.2，一步都不许放松）：
 * - 表外一律放行；
 * - 含写操作的复合命令一律放行（循环体里出现 `gh pr merge`、`git push`、`bun test` 都算）；
 * - 没有**声明的**等待源时一次都不拦（判据 1 在 `status-poll-guard.ts`，本文件不碰）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  extractStatusQueryFamilies,
  matchStatusQuery,
  normalizeStatusOutput,
  type StatusQueryFamily,
} from "@sid-code/core/task/status-query-commands.ts";
import {
  checkStatusQueryPoll,
  recordStatusQueryResult,
  __resetStatusPollGuardForTest,
  type StatusPollContext,
} from "@sid-code/core/task/status-poll-guard.ts";
import type { WaitSource } from "@sid-code/core/task/wait-registry.ts";

const T0 = 1_700_000_000_000;

function ctxWith(wait = true): { ctx: StatusPollContext; clock: { now: number } } {
  const clock = { now: T0 };
  const waits: WaitSource[] = [
    {
      id: "w1",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: T0 + 900_000 },
      description: "CI 跑完再看",
      registeredAt: T0,
    },
  ];
  return {
    clock,
    ctx: {
      hasDeclaredExternalWait: () => wait,
      listWaits: () => waits,
      memo: { entries: new Map() },
      now: () => clock.now,
    },
  };
}

/** `gh pr checks` 的真实 TSV（1 项 pending + 2 项 pass） */
const CHECKS_TSV = [
  "test (ubuntu-latest, 1/3)\tpending\t0\thttps://github.com/o/r/actions/runs/1/job/1\t",
  "test (ubuntu-latest, 2/3)\tpass\t2m49s\thttps://github.com/o/r/actions/runs/1/job/2\t",
  "self-check\tpass\t9s\thttps://github.com/o/r/actions/runs/2/job/3\t",
].join("\n");

beforeEach(() => {
  __resetStatusPollGuardForTest();
});

// ─────────────────────────────── 1. 循环体展开 ───────────────────────────────

describe("N3 循环展开（for / while / until）", () => {
  test("for 数字列表：subject 是排序去重的 PR 列表，family 取循环体的查询", () => {
    const m = matchStatusQuery(
      `cd /repo && for pr in 697 694 696; do echo "=== PR $pr ==="; gh pr view $pr --json statusCheckRollup; done`,
    );
    expect(m?.subject).toBe("gh:pr:694,696,697");
    expect(m?.family).toBe("gh_pr_view");
    expect(m?.kind).toBe("gh_pr");
  });

  test("循环签名稳定：同一条两次 / 列表顺序不同 / 前置 cd 不同 → 同一 signature", () => {
    const a = matchStatusQuery(
      "for pr in 694 696 697; do gh pr view $pr --json statusCheckRollup; done",
    );
    const b = matchStatusQuery(
      "for pr in 694 696 697; do gh pr view $pr --json statusCheckRollup; done",
    );
    const c = matchStatusQuery(
      "for pr in 697 694 696; do gh pr view $pr --json statusCheckRollup; done",
    );
    const d = matchStatusQuery(
      "cd /tmp && for pr in 694 696 697; do gh pr view $pr --json statusCheckRollup; done",
    );
    expect(a).not.toBeNull();
    expect(a?.signature).toBe(b?.signature);
    expect(a?.signature).toBe(c?.signature);
    // 前置 `cd` 不参与签名：轮询时工作目录可能变，查询语义没变
    expect(a?.signature).toBe(d?.signature);
  });

  test("循环签名区分查询字段：--json statusCheckRollup 与 --json state 不同签名", () => {
    const a = matchStatusQuery(
      "for pr in 694 696; do gh pr view $pr --json statusCheckRollup; done",
    );
    const b = matchStatusQuery("for pr in 694 696; do gh pr view $pr --json state; done");
    expect(a?.signature).not.toBe(b?.signature);
  });

  test("循环列表不是字面量 → subject 退化为 multi（不是 current）", () => {
    const m = matchStatusQuery(
      "for pr in $(gh pr list -q '.[].number'); do gh pr view $pr --json state; done",
    );
    expect(m?.subject).toBe("gh:pr:multi");
  });

  test("while 循环体里的查询命中（循环头视为无害，不取查询）", () => {
    const m = matchStatusQuery("while true; do gh pr checks 701 2>&1; sleep 30; done");
    expect(m?.subject).toBe("gh:pr:701");
    expect(m?.family).toBe("gh_pr_checks");
  });

  test("until 的循环头是一条查询，但它表达「等它成功」而不是轮询 → 不放行成查询", () => {
    // 循环体只有 sleep（无害），没有可拦的查询段
    expect(matchStatusQuery("until gh pr checks 1; do sleep 30; done")).toBeNull();
  });

  test("循环体里的查询带 2>&1 与 --jq（真实 fbb02831 形态）", () => {
    const m = matchStatusQuery(
      `cd /repo && for pr in 694 696 697; do echo "=== PR $pr ==="; gh pr view $pr --json statusCheckRollup --jq '[.statusCheckRollup[] | {name, status}]'; done`,
    );
    expect(m?.subject).toBe("gh:pr:694,696,697");
    expect(m?.signature).toContain("gh pr view 694 --json statusCheckRollup");
  });

  test("循环体里的只读过滤管道也命中（真实 7dd98bf5 系形态）", () => {
    const m = matchStatusQuery(
      `for n in 579 578 577; do echo "=== PR #$n ==="; gh pr checks $n 2>&1 | head -40; echo; done`,
    );
    expect(m?.subject).toBe("gh:pr:577,578,579");
    expect(m?.family).toBe("gh_pr_checks");
    // 过滤段不进签名：它只截断输出，不改变「查的是哪个对象」
    expect(m?.signature).toContain("gh pr checks 577");
    expect(m?.signature).not.toContain("head");
  });

  test("循环体含写操作 → null（安全边界不许放松）", () => {
    for (const cmd of [
      "for pr in 1 2; do gh pr checks $pr; gh pr merge $pr --auto; done",
      "for pr in 1 2; do gh pr checks $pr; git push origin main; done",
      "for pr in 1 2; do gh pr checks $pr; done && gh pr merge 1",
      // fbb02831 里真实出现过的非查询循环（跑测试 + grep）
      `for i in 1 2 3 4 5 6; do bun test packages/core/tests/task/monitor-task.test.ts -t "突发阀停止" 2>&1 | grep -E "^\\(fail"; done`,
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  test("嵌套循环 / 多条循环 → null（段列表判不出边界，宁漏不误）", () => {
    expect(
      matchStatusQuery("for a in 1 2; do for b in 3 4; do gh pr view $a; done; done"),
    ).toBeNull();
    expect(
      matchStatusQuery(
        "for a in 1 2; do gh pr checks $a; done; for b in 3; do gh pr checks $b; done",
      ),
    ).toBeNull();
  });

  // R4：`flattenCommand` 不再「见换行就放弃」——引号外的换行仍按分隔符切给 parser，
  // 于是多行写法的循环和后置 `; do …; done` 走的是同一条展开路径。
  test("多行循环同样识别（换行是分隔符，不是放弃理由）", () => {
    expect(matchStatusQuery("for pr in 1 2\ndo\n  gh pr checks $pr\ndone")?.subject).toBe(
      "gh:pr:1,2",
    );
  });
});

// ─────────────────────────────── 2. 只读过滤管道 ───────────────────────────────

describe("N3 只读过滤管道", () => {
  test("head / tail / jq / grep / wc / sort / cut / awk 都能向前找到查询段", () => {
    const cases: Array<[string, string]> = [
      ["gh pr checks 701 2>&1 | head -20", "gh:pr:701"],
      ["gh pr checks 701 2>&1 | tail -20", "gh:pr:701"],
      ["gh pr view 701 --json statusCheckRollup | jq '.data'", "gh:pr:701"],
      ["gh pr view 701 --json statusCheckRollup | grep -i pending", "gh:pr:701"],
      ["gh pr checks 701 | wc -l", "gh:pr:701"],
      ["gh pr checks 701 | sort", "gh:pr:701"],
      ["gh pr checks 701 | cut -f1", "gh:pr:701"],
      ["gh pr checks 701 | awk '{print $1}'", "gh:pr:701"],
      ["gh pr checks 701 2>&1 | grep pending | head -5", "gh:pr:701"],
    ];
    for (const [cmd, subject] of cases) {
      expect(matchStatusQuery(cmd)?.subject).toBe(subject);
    }
  });

  test("过滤段进入签名：| head -10 与 | jq 各自独立计数（输出形态不同）", () => {
    const a = matchStatusQuery("gh pr checks 701 2>&1 | head -10");
    const b = matchStatusQuery("gh pr checks 701 2>&1 | jq '.x'");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.signature).not.toBe(b?.signature);
    // 同一形态重复 → 同签名（拦得住的前提）
    expect(a?.signature).toBe(matchStatusQuery("gh pr checks 701 2>&1 | head -10")?.signature);
  });

  test("会写 / 会持续等的末端命令不算纯过滤 → null", () => {
    for (const cmd of [
      "gh pr checks 1 2>&1 | tee /tmp/x.log",
      "gh pr checks 1 2>&1 | tail -f",
      "gh pr checks 1 2>&1 | tail --follow",
      "gh pr checks 1 2>&1 | sort -o /tmp/sorted.txt",
      "gh pr checks 1 2>&1 | sort --output=/tmp/sorted.txt",
      `gh pr checks 1 2>&1 | awk '{print > "/tmp/x"}'`,
      "gh pr checks 1 2>&1 | sed -i 's/a/b/' /tmp/f",
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  test("查询段之后的未知段（非纯过滤）→ null", () => {
    expect(matchStatusQuery("gh pr checks 1 | head -5 && git push origin main")).toBeNull();
    expect(matchStatusQuery("gh pr checks 1 | xargs rm -rf")).toBeNull();
  });

  test("962011a6 的主流写法：过滤段在查询段之前 + 复合两条查询", () => {
    // 该会话 27/34 条 gh api 都长这样：前半段是 `gh pr checks … | head`，中间 echo 分隔，
    // 后半段才是真正的 `gh api … | head`。只允许「查询段之后才是过滤」会把它们全漏掉。
    const a = matchStatusQuery(
      `gh pr checks 701 2>&1 | head -20; echo '---'; gh api repos/o/r/commits/abc123/check-runs -q '.check_runs[] | {name,status,conclusion}' 2>&1 | head -20`,
    );
    expect(a?.subject).toBe("gh:commit:abc123");
    expect(a?.family).toBe("gh_api_checks");
    // 签名含两条查询（形态不同 → 不共享 memo），但不含 echo
    expect(a?.signature).toContain("gh pr checks 701");
    expect(a?.signature).toContain("gh api repos/o/r/commits/abc123/check-runs");
    expect(a?.signature).not.toContain("echo");

    const b = matchStatusQuery(
      `gh api repos/o/r/commits/abc123/check-runs -q '.check_runs[]' 2>&1 | head -10; echo '=== PR ==='; gh pr view 701 --json state,mergeStateStatus --jq '{state,mergeStateStatus}'`,
    );
    expect(b?.subject).toBe("gh:pr:701");
    expect(b?.family).toBe("gh_pr_view");
  });
});

// ─────────────────────────────── 3. gh api 状态端点 ───────────────────────────────

describe("N3 gh api 状态端点", () => {
  test("commits/<ref> 的 check-runs / check-suites / status / statuses 命中", () => {
    const cases: Array<[string, string, StatusQueryFamily]> = [
      [
        "gh api repos/njfuzrs/sid-code/commits/e2f8c170/check-runs -q '.check_runs[]'",
        "gh:commit:e2f8c170",
        "gh_api_checks",
      ],
      ["gh api repos/o/r/commits/abc123/check-suites", "gh:commit:abc123", "gh_api_checks"],
      ["gh api repos/o/r/commits/abc123/status", "gh:commit:abc123", "gh_api_checks"],
      [
        "gh api repos/o/r/commits/abc123/statuses?per_page=100",
        "gh:commit:abc123",
        "gh_api_checks",
      ],
      // 分支名带 `/` 也是合法 ref
      ["gh api repos/o/r/commits/feature/x/check-runs", "gh:commit:feature/x", "gh_api_checks"],
    ];
    for (const [cmd, subject, family] of cases) {
      const m = matchStatusQuery(cmd);
      expect(m?.subject).toBe(subject);
      expect(m?.family).toBe(family);
      expect(m?.kind).toBe("gh_pr");
    }
  });

  test("actions/runs[/<id>][/jobs] 命中", () => {
    const cases: Array<[string, string]> = [
      ["gh api repos/o/r/actions/runs", "gh:run:list"],
      ["gh api repos/o/r/actions/runs/12345", "gh:run:12345"],
      ["gh api repos/o/r/actions/runs/12345/jobs", "gh:run:12345"],
    ];
    for (const [cmd, subject] of cases) {
      const m = matchStatusQuery(cmd);
      expect(m?.subject).toBe(subject);
      expect(m?.family).toBe("gh_api_runs");
      expect(m?.kind).toBe("gh_run");
    }
  });

  test("带写标志 → null（gh 会按 -f/-F/--input/非 GET 推导成写请求）", () => {
    for (const cmd of [
      "gh api repos/o/r/commits/abc123/check-runs -X POST",
      "gh api repos/o/r/commits/abc123/check-runs --method POST",
      "gh api --method=DELETE repos/o/r/actions/runs/1",
      "gh api -XDELETE repos/o/r/actions/runs/1",
      "gh api repos/o/r/actions/runs/1 -f status=completed",
      "gh api repos/o/r/actions/runs/1 --field status=completed",
      "gh api repos/o/r/actions/runs/1 --raw-field status=completed",
      "gh api repos/o/r/actions/runs/1 --input body.json",
      "gh api repos/o/r/actions/runs/1 --input=body.json",
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  test("非状态端点 → null（宁漏不误）", () => {
    for (const cmd of [
      "gh api repos/o/r/issues/1/comments",
      "gh api repos/o/r/actions/runs/1/logs",
      "gh api repos/o/r/actions/runs/1/rerun",
      "gh api user",
      "gh api /repos/o/r/commits/abc/check-runs", // 前导 `/` 不是 gh 的路径形态
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  // R4：`gh api …/pulls/<n>` 从「表外」改成命中——两条事故会话把 `gh pr view` 换成了
  // `gh api repos/…/pulls/780 -q .state`，同一个 PR、同一批字段，不该因为换了取数入口就漏拦。
  test("pulls/<n>（含 reviews/commits/files 子端点）命中，subject 与 gh pr view 同族", () => {
    expect(matchStatusQuery("gh api repos/o/r/pulls/779")?.subject).toBe("gh:pr:779");
    expect(matchStatusQuery("gh api repos/o/r/pulls/779 -q .state")?.family).toBe("gh_api_pulls");
    for (const sub of ["reviews", "commits", "files"]) {
      expect(matchStatusQuery(`gh api repos/o/r/pulls/779/${sub}`)?.subject).toBe("gh:pr:779");
    }
    // 写标志仍然拒绝
    expect(matchStatusQuery("gh api -X PATCH repos/o/r/pulls/779 -f state=closed")).toBeNull();
  });

  test("GET 显式写出仍然命中（-X GET 与 --method=GET）", () => {
    expect(matchStatusQuery("gh api -X GET repos/o/r/commits/abc123/check-runs")?.subject).toBe(
      "gh:commit:abc123",
    );
    expect(
      matchStatusQuery("gh api --method=GET repos/o/r/commits/abc123/check-runs")?.subject,
    ).toBe("gh:commit:abc123");
  });

  test("monitor 脚本里的 gh api 查询能扫出命令族（D13 覆盖判定）", () => {
    const script = `while true; do
  gh api repos/o/r/commits/abc123/check-runs -q '.check_runs[]'
  sleep 30
done`;
    expect(extractStatusQueryFamilies(script)).toContain("gh_api_checks");
  });
});

// ─────────────────────────────── 4. 无害命令补 date ───────────────────────────────

describe("N3 无害命令表补 date", () => {
  test("sleep + date + 查询 命中（打时间戳的轮询写法）", () => {
    expect(matchStatusQuery("sleep 30; date '+%H:%M:%S'; gh pr view 662")?.subject).toBe(
      "gh:pr:662",
    );
  });
});

// ─────────────────────────────── 5. gh api 归一化 ───────────────────────────────

describe("N3 gh api 输出的归一化（REST 的 snake_case 易变键）", () => {
  /** 真实 `gh api …/check-runs` 的响应骨架（只留与签名相关的字段） */
  function checkRuns(startedAt: string, detailsUrl: string, conclusion: string): string {
    return JSON.stringify({
      total_count: 1,
      check_runs: [
        {
          id: 123,
          name: "test (ubuntu-latest)",
          status: "completed",
          conclusion,
          started_at: startedAt,
          completed_at: startedAt,
          html_url: detailsUrl,
          details_url: detailsUrl,
          check_suite: { id: 9 },
        },
      ],
    });
  }

  test("只差 started_at / completed_at / html_url / details_url → 签名相同", () => {
    const a = checkRuns("2026-11-10T08:00:00Z", "https://github.com/o/r/actions/1", "success");
    const b = checkRuns("2026-11-10T08:05:00Z", "https://github.com/o/r/actions/2", "success");
    expect(normalizeStatusOutput("gh_pr", a)).toBe(normalizeStatusOutput("gh_pr", b));
  });

  test("conclusion 变化 → 签名不同（真实状态变化永远放行）", () => {
    const a = checkRuns("2026-11-10T08:00:00Z", "https://github.com/o/r/actions/1", "success");
    const b = checkRuns("2026-11-10T08:00:00Z", "https://github.com/o/r/actions/1", "failure");
    expect(normalizeStatusOutput("gh_pr", a)).not.toBe(normalizeStatusOutput("gh_pr", b));
  });
});

// ─────────────────────────────── 6. 拦截语义（判据不变） ───────────────────────────────

describe("N3 扩匹配面之后，三条判据一条都没放松", () => {
  /** 种 n 次相同结果，然后问下一次要不要拦 */
  function seed(cmd: string, output: string, times: number): StatusPollContext {
    const { ctx } = ctxWith();
    for (let i = 0; i < times; i++) recordStatusQueryResult(cmd, output, ctx);
    return ctx;
  }

  test("循环查询：连续 2 次相同后第 3 次被拦，回执带上次摘要", () => {
    const cmd = "for pr in 694 696; do gh pr checks $pr 2>&1; done";
    const ctx = seed(cmd, CHECKS_TSV, 2);
    const r = checkStatusQueryPoll("bash", { command: cmd }, ctx);
    expect(r.intercept).toBe(true);
    if (!r.intercept) throw new Error("unreachable");
    expect(r.subject).toBe("gh:pr:694,696");
    expect(r.output).toContain("本次未执行");
    expect(r.output).toContain("1 项 pending");
  });

  test("过滤管道查询：同样能拦", () => {
    const cmd = "gh pr checks 701 2>&1 | head -10";
    const ctx = seed(cmd, CHECKS_TSV, 2);
    expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(true);
  });

  test("gh api 查询：同样能拦", () => {
    const cmd = "gh api repos/o/r/commits/abc123/check-runs -q '.check_runs[]'";
    const ctx = seed(cmd, '{"total_count":0,"check_runs":[]}', 2);
    expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(true);
  });

  test("没有声明的等待源 → 新形态也一次都不拦（判据 1 不变）", () => {
    const { ctx } = ctxWith(false);
    const cmd = "for pr in 694 696; do gh pr view $pr --json statusCheckRollup; done";
    for (let i = 0; i < 10; i++) {
      recordStatusQueryResult(cmd, CHECKS_TSV, ctx);
      expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(false);
    }
  });

  test("探测间隔仍生效：超过 120s 放行一次", () => {
    const cmd = "gh pr checks 701 2>&1 | head -10";
    const { ctx, clock } = ctxWith();
    recordStatusQueryResult(cmd, CHECKS_TSV, ctx);
    clock.now += 5_000;
    recordStatusQueryResult(cmd, CHECKS_TSV, ctx);
    clock.now += 5_000;
    expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(true);
    clock.now = T0 + 5_000 + 5_000 + 120_000;
    expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(false);
  });
});
