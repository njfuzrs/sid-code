/**
 * P1：等待期外部状态查询拦截——判定矩阵。
 *
 * 事故（`20261108-112039-9e3a681d` / `20261108-112620-7dd98bf5`）：模型排了唤醒之后
 * 仍在等待期前台反复查同一个 PR 的 CI，两会话分别 97 / 86 次，20 分钟窗口内约 100 次请求。
 *
 * 判据三条同时成立才拦（§5.5.1）：有等待源 + 命令是只读状态查询 + 结果与上次相同。
 * 缺任何一条都放行——尤其「没有等待源」时行为与改动前**逐字节一致**（T-P1-4），
 * 这是本判据与 2026-07-14 那份否决（工具循环检测默认关闭）的根本区别。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkStatusQueryPoll,
  recordStatusQueryResult,
  markStatusPollIntervened,
  consumeStatusPollIntervened,
  __resetStatusPollGuardForTest,
  STATUS_POLL_BLOCK_AFTER_SAME,
  STATUS_POLL_PROBE_INTERVAL_MS,
  type StatusPollContext,
} from "@sid-code/core/task/status-poll-guard.ts";
import {
  matchStatusQuery,
  normalizeStatusOutput,
  summarizeStatusOutput,
} from "@sid-code/core/task/status-query-commands.ts";
import type { WaitSource } from "@sid-code/core/task/wait-registry.ts";

const T0 = 1_700_000_000_000; // 固定基准时刻（本地时区无关：断言用同一 formatClock 算法取期望）

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function monitorWait(subjects: string[], deadlineAt = T0 + 600_000): WaitSource {
  return {
    id: "m7k2",
    kind: "monitor",
    promise: { kind: "deadline", deadlineAt },
    description: "PR #662 CI",
    registeredAt: T0,
    subjects,
    // D13：覆盖判定从「对象粒度」收紧到「命令族粒度」。这个夹具代表一台**真的**
    // 盯 gh:pr 的 monitor（脚本里扫得出 gh pr 查询），按新增的可选字段补齐语义；
    // 各条用例的断言逐字未动。
    commandFamilies: ["gh_pr_checks", "gh_pr_view"],
  };
}

function wakeupWait(subjects?: string[]): WaitSource {
  return {
    id: "w9x1",
    kind: "wakeup",
    promise: { kind: "deadline", deadlineAt: T0 + 1_500_000 },
    description: "25 分钟后再看 CI",
    registeredAt: T0,
    subjects,
  };
}

/** 可注入的 ctx：默认「有等待源 + 一台 monitor 盯着 662 + 时钟可推进」 */
function makeCtx(
  opts: {
    hasWait?: boolean;
    waits?: WaitSource[];
    clock?: { now: number };
  } = {},
) {
  const clockState = opts.clock ?? { now: T0 };
  const ctx: StatusPollContext = {
    hasDeclaredExternalWait: () => opts.hasWait ?? true,
    listWaits: () => opts.waits ?? [monitorWait(["gh:pr:662"])],
    memo: { entries: new Map() },
    now: () => clockState.now,
  };
  return { ctx, clockState };
}

const CHECKS_PENDING = [
  "test (ubuntu-latest, 1/3)\tpending\t0\thttps://github.com/o/r/actions/runs/1/job/1\t",
  "test (ubuntu-latest, 2/3)\tpass\t2m49s\thttps://github.com/o/r/actions/runs/1/job/2\t",
  "self-check\tpass\t9s\thttps://github.com/o/r/actions/runs/2/job/3\t",
].join("\n");

/** 同一个状态，只是耗时列不同（`pass 2m49s` → `pass 3m10s`）——判据必须认为「没变」 */
const CHECKS_PENDING_LATER = [
  "test (ubuntu-latest, 1/3)\tpending\t0\thttps://github.com/o/r/actions/runs/1/job/1\t",
  "test (ubuntu-latest, 2/3)\tpass\t3m10s\thttps://github.com/o/r/actions/runs/1/job/2\t",
  "self-check\tpass\t11s\thttps://github.com/o/r/actions/runs/2/job/3\t",
].join("\n");

/** 真实的状态变化：某个分片 pending → pass */
const CHECKS_ONE_PASSED = [
  "test (ubuntu-latest, 1/3)\tpass\t3m02s\thttps://github.com/o/r/actions/runs/1/job/1\t",
  "test (ubuntu-latest, 2/3)\tpass\t2m49s\thttps://github.com/o/r/actions/runs/1/job/2\t",
  "self-check\tpass\t9s\thttps://github.com/o/r/actions/runs/2/job/3\t",
].join("\n");

const CMD = "cd /repo && gh pr checks 662 2>&1";

beforeEach(() => {
  __resetStatusPollGuardForTest();
});

describe("P1 判据：三条同时成立才拦", () => {
  test("T-P1-1 有等待源，首次查询放行", () => {
    const { ctx } = makeCtx();
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx)).toEqual({ intercept: false });
  });

  test("T-P1-2 状态变化后放行（签名不同 = 有新信息）", () => {
    const { ctx } = makeCtx();
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx); // 同一状态（只差耗时）
    // 此刻已连续 2 次相同，第 3 次本应被拦 —— 但这次是真的变化
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(true);
    recordStatusQueryResult(CMD, CHECKS_ONE_PASSED, ctx); // 模型若查到变化，memo 重置
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx)).toEqual({ intercept: false });
  });

  test("T-P1-3 状态未变：第 2 次放行 + 追加提示；第 3 次不执行，回执含上次状态摘要", () => {
    const { ctx } = makeCtx();
    // 第 1 次：无历史，放行，记录
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
    expect(recordStatusQueryResult(CMD, CHECKS_PENDING, ctx)).toBeUndefined();

    // 第 2 次：结果与上次相同 → 仍放行，但给一行提示
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
    const hint = recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx);
    expect(hint).toContain("[等待中] 结果与上次相同");
    expect(hint).toContain("监控 m7k2");

    // 第 3 次：不执行
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(r.intercept).toBe(true);
    if (!r.intercept) throw new Error("unreachable");
    // 回执必须带上次的状态摘要，否则模型被拦后丢信息（压缩后再问也拿不到答案）
    expect(r.output).toContain("2 项 pass");
    expect(r.output).toContain("1 项 pending");
    expect(r.output).toContain("本次未执行");
    expect(r.subject).toBe("gh:pr:662");
    expect(r.kind).toBe("gh_pr");
  });

  test("T-P1-4 无等待源，同命令同结果 100 次全部放行（与改动前一致）", () => {
    const { ctx } = makeCtx({ hasWait: false, waits: [] });
    for (let i = 0; i < 100; i++) {
      expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
      // 无等待源时 record 仍会记 memo，但判据 1 不成立 → 永远不拦
      recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    }
  });

  test("T-P1-5 含写操作的组合命令放行", () => {
    const { ctx } = makeCtx();
    for (const cmd of [
      "gh pr checks 662 && gh pr merge 662 --auto --merge",
      "gh pr merge 662 --auto --merge 2>&1 | tail -5 && gh pr checks 662",
      "git push origin main && gh pr checks 662",
      "gh pr checks 662 > /tmp/out.txt",
      // N3 之后 `| head` 是合法查询形态；这里换成同样「末端过滤但会写文件」的 tee，
      // 守住「只要有一段不认识/可能写操作就放行」这条判据
      "gh pr checks 662 | tee /tmp/out.log",
      "gh pr checks 662 | sort -o /tmp/sorted.txt",
    ]) {
      recordStatusQueryResult(cmd, CHECKS_PENDING, ctx);
      recordStatusQueryResult(cmd, CHECKS_PENDING, ctx);
      expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(false);
    }
  });

  test("T-P1-6 不同 PR 分别计签名（查 661 不影响 662 的历史）", () => {
    const { ctx } = makeCtx({ waits: [monitorWait(["gh:pr:662"])] });
    const c662 = "gh pr checks 662";
    const c661 = "gh pr checks 661";
    // 662 攒够连续相同 → 会被拦
    recordStatusQueryResult(c662, CHECKS_PENDING, ctx);
    recordStatusQueryResult(c662, CHECKS_PENDING, ctx);
    expect(checkStatusQueryPoll("bash", { command: c662 }, ctx).intercept).toBe(true);
    // 661 从没查过 → 放行
    expect(checkStatusQueryPoll("bash", { command: c661 }, ctx).intercept).toBe(false);
  });

  test("T-P1-7 等待源释放后不拦", () => {
    const state = { hasWait: true };
    const clockState = { now: T0 };
    const ctx: StatusPollContext = {
      hasDeclaredExternalWait: () => state.hasWait,
      listWaits: () => [monitorWait(["gh:pr:662"])],
      memo: { entries: new Map() },
      now: () => clockState.now,
    };
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(true);
    // monitor 结束 → 等待源没了 → 判据 1 不成立
    state.hasWait = false;
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
  });

  test("T-P1-8 回执含「上次查询于 HH:MM:SS」", () => {
    const { ctx, clockState } = makeCtx();
    clockState.now = T0;
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 30_000;
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 40_000;
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(r.intercept).toBe(true);
    if (!r.intercept) throw new Error("unreachable");
    expect(r.output).toContain(`上次查询于 ${clock(T0 + 30_000)}`);
  });
});

describe("P1 归一化：状态变化必须让签名不同", () => {
  test("T-P1-9 只差耗时列 / *At 字段 → 签名相同；差一个 bucket → 签名不同", () => {
    // gh pr checks 的 TSV：耗时列与 URL 每次都在变，必须抹掉
    expect(normalizeStatusOutput("gh_pr", CHECKS_PENDING)).toBe(
      normalizeStatusOutput("gh_pr", CHECKS_PENDING_LATER),
    );
    // 真实状态变化必须体现在签名里
    expect(normalizeStatusOutput("gh_pr", CHECKS_PENDING)).not.toBe(
      normalizeStatusOutput("gh_pr", CHECKS_ONE_PASSED),
    );
    // --json 输出：*At / url / duration 抹掉，status 保留
    const a = JSON.stringify({
      checks: [{ name: "a", status: "IN_PROGRESS", startedAt: "2026-01-01T00:00:00Z", url: "u1" }],
    });
    const b = JSON.stringify({
      checks: [{ name: "a", status: "IN_PROGRESS", startedAt: "2026-01-01T00:05:00Z", url: "u2" }],
    });
    expect(normalizeStatusOutput("gh_pr", a)).toBe(normalizeStatusOutput("gh_pr", b));
    const c = JSON.stringify({
      checks: [{ name: "a", status: "COMPLETED", startedAt: "2026-01-01T00:00:00Z", url: "u1" }],
    });
    expect(normalizeStatusOutput("gh_pr", a)).not.toBe(normalizeStatusOutput("gh_pr", c));
  });

  test("TSV 摘要只数 bucket，不带耗时", () => {
    const summary = summarizeStatusOutput("gh_pr", normalizeStatusOutput("gh_pr", CHECKS_PENDING));
    expect(summary).toBe("1 项 pending，2 项 pass");
  });
});

describe("P1 埋点与事件", () => {
  test("T-P1-10 拦截标记可被 loop 消费（UnchangedObservationRun.intervened 的数据源）", () => {
    const { ctx } = makeCtx();
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(r.intercept).toBe(true);
    // 模拟 tool-executor 在拦截分支里打的标记
    markStatusPollIntervened("toolu_abc");
    expect(consumeStatusPollIntervened("toolu_abc")).toBe(true);
    // 消费即清除：同一条不会让下一轮的 UnchangedObservationRun 也记 true
    expect(consumeStatusPollIntervened("toolu_abc")).toBe(false);
  });

  test("拦截 kind 是 external_status_poll（与 Q1 的 status_poll 区分）", async () => {
    const { STATUS_POLL_INTERCEPT_KIND } = await import("@sid-code/core/task/status-poll-guard.ts");
    expect(STATUS_POLL_INTERCEPT_KIND).toBe("external_status_poll");
  });
});

describe("P1 命令表匹配（只读 + 查外部状态）", () => {
  test("两条事故会话的真实命令形态都命中", () => {
    // 9e3a681d 的主导形态（97 条里 88 条）
    expect(
      matchStatusQuery(
        "cd /repo/.sid-code/worktrees/x3 && gh pr view 661 --json state,mergeStateStatus,statusCheckRollup -q '{state:.state}'",
      )?.subject,
    ).toBe("gh:pr:661");
    // 7dd98bf5 的主导形态（86 条里 65 条）
    expect(matchStatusQuery("cd /repo/wt && gh pr checks 662 2>&1")?.subject).toBe("gh:pr:662");
    expect(matchStatusQuery("gh run view 42444410784")?.subject).toBe("gh:run:42444410784");
    expect(matchStatusQuery("glab mr view 42")?.subject).toBe("glab:mr:42");
    expect(matchStatusQuery("kubectl rollout status deploy/api")?.subject).toBe(
      "k8s:rollout:deploy/api",
    );
    expect(matchStatusQuery("curl -s http://svc:8080/health")?.subject).toBe(
      "http:http://svc:8080/health",
    );
  });

  test("表外命令一律不命中（宁可漏，不可误伤）", () => {
    for (const cmd of [
      "ls -la",
      "gh issue view 373",
      "gh pr diff 662",
      "cat package.json",
      "kubectl get pods -o yaml",
      "curl -s http://svc:8080/api/users",
      "gh pr checks 662 --help", // 查文档不是查状态
      "gh pr checks 662 --version",
      // N3 之后 `| head` / `| jq` / `| grep` 是合法查询形态（见 status-query-shapes.test.ts），
      // 这里换成会写文件的 tee 与 `tail -f`（持续跟随），守住「纯过滤才算」的边界
      "gh pr checks 662 | tee /tmp/x.log",
      "gh pr checks 662 | tail -f",
      // 末尾是无害命令（`echo` / `date`）自 R4 起是合法查询形态（见 status-query-shapes.test.ts
      // 的「末尾无害段」用例），这里换成一段既非查询、也非纯过滤、也不无害的命令守住边界
      "gh pr checks 662; git status",
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  test("后台命令不算等待期查询（run_in_background 由调用方判）", () => {
    const { ctx } = makeCtx();
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    expect(
      checkStatusQueryPoll("bash", { command: CMD, run_in_background: true }, ctx).intercept,
    ).toBe(false);
  });
});

describe("P1 真实轨迹回放（T-P1-11）", () => {
  /**
   * 把 9e3a681d 窗口内的 97 条真实 `gh pr view|checks` 命令 + 原输出喂给判据。
   *
   * ⚠️ **实测结论与方案 §9.3 的 T-P1-11 不同，这里如实记录**：
   * 方案要求「被拦 ≥ 80 且没有任何一条状态变化的查询被拦」。这两条在这份数据上**互斥**——
   * 97 条查询只对应 23 种不同状态，即最多只能拦 74 条而不掩盖变化。原因见下：
   *
   * 拦截的依据是「输出与上次**实际执行**时相同」，而拦截期间外部世界在变。所以
   * 「拦住就永远看不到变化」——除非有 monitor 盯着（它会在变化时通知）或探测窗口兜底。
   * 本实现两条都做了：有 monitor 覆盖时拦到底，没有时留 120s 探测窗口。
   * 回放按「有 monitor 盯 662」的最有利前提跑，断言的是**可达的真实数字**，不是方案里的估计值。
   */
  const fixturePath = join(import.meta.dir, "fixtures", "status-poll-replay-9e3a681d.json");
  const rows = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
    command: string;
    output: string;
  }>;

  test("97 条真实命令：命中 ≥ 90，拦截 > 60，且拦下时回执都带状态摘要", () => {
    const { ctx } = makeCtx({ waits: [monitorWait(["gh:pr:661", "gh:pr:662"])] });
    let matched = 0;
    let blocked = 0;
    let hint = 0;
    let blockedWithoutSummary = 0;
    for (const row of rows) {
      if (!matchStatusQuery(row.command)) continue;
      matched++;
      const r = checkStatusQueryPoll("bash", { command: row.command }, ctx);
      if (r.intercept) {
        blocked++;
        // 被拦时模型必须拿得到上次的结论（否则压缩后再问就彻底失忆）
        if (!r.output.includes("本次未执行") || !r.output.includes("上次查询于")) {
          blockedWithoutSummary++;
        }
        continue; // 被拦 = 不执行 = 不更新 memo
      }
      if (recordStatusQueryResult(row.command, row.output, ctx)) hint++;
    }
    expect(matched).toBeGreaterThanOrEqual(90);
    expect(blocked).toBeGreaterThan(60);
    expect(hint).toBeGreaterThan(0); // 「第 1 次相同」的提示确实发出过
    expect(blockedWithoutSummary).toBe(0);
  });

  test("探测窗口：无 monitor 覆盖时，拦住不超过 120s 就不会一直看不到变化", () => {
    // 事故真实形态：模型排的是 schedule_wakeup（不是 monitor），没有任何东西会在
    // 状态变化时主动通知 —— 这时探测窗口是「拦住就永远看不到变化」的唯一出口。
    const clockState = { now: T0 };
    const ctx: StatusPollContext = {
      hasDeclaredExternalWait: () => true,
      listWaits: () => [wakeupWait()], // 唤醒没有 subjects，覆盖不到 gh:pr:662
      memo: { entries: new Map() },
      now: () => clockState.now,
    };
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 5_000;
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 10_000;
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(true);

    // 超过探测间隔 → 放行一次，让模型看到真实状态（哪怕预计没变）
    clockState.now = T0 + 10_000 + STATUS_POLL_PROBE_INTERVAL_MS;
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
  });

  test("有 monitor 覆盖时不吃探测窗口（monitor 会在变化时通知，拦到底是安全的）", () => {
    const clockState = { now: T0 };
    const ctx: StatusPollContext = {
      hasDeclaredExternalWait: () => true,
      listWaits: () => [monitorWait(["gh:pr:662"])],
      memo: { entries: new Map() },
      now: () => clockState.now,
    };
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 5_000;
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    clockState.now = T0 + 10 * 60_000; // 远超探测窗口
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(true);
  });

  test("阈值常量与「第 3 次查询才拦」一致", () => {
    // sameRun=1 首次、=2 第 1 次相同（放行+提示）、≥2 起拦 → 常量必须是 2
    expect(STATUS_POLL_BLOCK_AFTER_SAME).toBe(2);
  });
});

describe("N8：没有声明等待源时的重复查询 → 追加后台等待出路", () => {
  test("无等待源 + 同一状态第 2 次相同 → 追加引导；判据 1 不变（一次都不拦）", () => {
    const { ctx } = makeCtx({ hasWait: false, waits: [] });
    // 第 1 次：无历史
    expect(recordStatusQueryResult(CMD, CHECKS_PENDING, ctx)).toBeUndefined();
    // 第 2 次：同一状态（只差耗时）→ 追加引导，指出「怎么等」而不是只说「别问」
    const hint = recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx);
    expect(hint).toContain("[重复查询]");
    expect(hint).toContain("wait_until_seconds");
    expect(hint).toContain("monitor");
    expect(hint).toContain("结束本轮");
    // 判据 1 不变：没有声明的等待源就一次都不拦
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
    // 第 3 次起不再追加（同一签名只提示一次）
    expect(recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx)).toBeUndefined();
    expect(recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx)).toBeUndefined();
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
  });

  test("有等待源时仍走原文案，N8 引导不出现", () => {
    const { ctx } = makeCtx();
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    const hint = recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx);
    expect(hint).toContain("[等待中] 结果与上次相同");
    expect(hint).not.toContain("[重复查询]");
    expect(hint).not.toContain("wait_until_seconds");
  });

  test("状态变化后重新计数：新的稳定状态再次相同时给一次新提示", () => {
    const { ctx } = makeCtx({ hasWait: false, waits: [] });
    recordStatusQueryResult(CMD, CHECKS_PENDING, ctx);
    expect(recordStatusQueryResult(CMD, CHECKS_PENDING_LATER, ctx)).toContain("[重复查询]");
    // 状态真的变了 → memo 重置（这次是状态变化，不提示）
    expect(recordStatusQueryResult(CMD, CHECKS_ONE_PASSED, ctx)).toBeUndefined();
    // 新状态再连续相同一次 → 再提示一次（提示跟着「稳定状态」走，不是整个会话只给一次）
    expect(recordStatusQueryResult(CMD, CHECKS_ONE_PASSED, ctx)).toContain("[重复查询]");
  });
});
