/**
 * pr-auto-update 的判定逻辑测试（纯函数，不碰网络）。
 *
 * 钉住三条「出错也不会报红」的性质：
 *   ① 严格串行：已有 PR 在飞时绝不 update 第二个（否则 strict 下白跑 N-1 轮 CI）
 *   ② 检查红了的 PR 不占槽位、也不被反复 update（否则一个红 PR 卡死全仓）
 *   ③ 检查结论走白名单：没见过的 conclusion 算失败（与 ci.yml 汇聚门同一判据）
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { pickNext, summarizeChecks, type PrSnapshot } from "../../scripts/pr-auto-update.ts";

function pr(n: number, over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: n,
    isDraft: false,
    mergeStateStatus: "BEHIND",
    autoMergeEnabledAt: `2026-11-03T08:${String(n).padStart(2, "0")}:00Z`,
    checks: "success",
    ...over,
  };
}

describe("pickNext：队列判定", () => {
  test("没挂 auto-merge 的不入队", () => {
    expect(pickNext([pr(1, { autoMergeEnabledAt: null })]).action).toBe("idle");
  });

  test("draft 不入队", () => {
    expect(pickNext([pr(1, { isDraft: true })]).action).toBe("idle");
  });

  test("按 auto-merge 挂上的时间排队，不按 PR 编号", () => {
    const d = pickNext([
      pr(9, { autoMergeEnabledAt: "2026-11-03T09:00:00Z" }),
      pr(20, { autoMergeEnabledAt: "2026-11-03T08:00:00Z" }),
    ]);
    expect(d).toEqual({ action: "update", pr: 20 });
  });

  test("① 有 PR 已同步 main 且 CI 在跑 → 等待，不 update 别人", () => {
    const d = pickNext([pr(1), pr(2, { mergeStateStatus: "BLOCKED", checks: "pending" })]);
    expect(d.action).toBe("wait");
    expect(d.action === "wait" && d.pr).toBe(2);
  });

  test("① 有 PR 已可合（CLEAN）待 auto-merge 动手 → 等待", () => {
    expect(pickNext([pr(1), pr(2, { mergeStateStatus: "CLEAN" })]).action).toBe("wait");
  });

  test("② 检查已失败的 BLOCKED 不占槽位，队列继续前进", () => {
    const d = pickNext([pr(1, { mergeStateStatus: "BLOCKED", checks: "failure" }), pr(2)]);
    expect(d).toEqual({ action: "update", pr: 2 });
  });

  test("② 检查已失败的 BEHIND 不被 update（再跑一轮也是红）", () => {
    const d = pickNext([pr(1, { checks: "failure" }), pr(2)]);
    expect(d).toEqual({ action: "update", pr: 2 });
  });

  test("冲突（DIRTY）跳过", () => {
    const d = pickNext([pr(1, { mergeStateStatus: "DIRTY" }), pr(2)]);
    expect(d).toEqual({ action: "update", pr: 2 });
  });

  test("UNKNOWN 先要求重取，不猜", () => {
    expect(pickNext([pr(1, { mergeStateStatus: "UNKNOWN" }), pr(2)]).action).toBe("retry");
  });

  test("UNKNOWN 重取用尽后排除它继续排队（一个算不出的 PR 不卡死全仓）", () => {
    const d = pickNext([pr(1, { mergeStateStatus: "UNKNOWN" }), pr(2)], { ignoreUnknown: true });
    expect(d).toEqual({ action: "update", pr: 2 });
  });

  test("一次只返回一个 update", () => {
    const d = pickNext([pr(1), pr(2), pr(3)]);
    expect(d).toEqual({ action: "update", pr: 1 });
  });
});

describe("summarizeChecks：三态压缩", () => {
  test("没有任何检查 = pending（刚 update 完、run 还没建）", () => {
    expect(summarizeChecks([])).toBe("pending");
    expect(summarizeChecks(null)).toBe("pending");
  });

  test("有未完成的 = pending", () => {
    expect(
      summarizeChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
      ]),
    ).toBe("pending");
  });

  test("失败优先于未完成", () => {
    expect(
      summarizeChecks([
        { __typename: "CheckRun", status: "IN_PROGRESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failure");
  });

  test("③ 白名单：没见过的 conclusion（如 STARTUP_FAILURE / CANCELLED）算失败", () => {
    for (const c of ["CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "WHATEVER"]) {
      expect(
        summarizeChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: c }]),
      ).toBe("failure");
    }
  });

  test("SUCCESS / SKIPPED / NEUTRAL 算通过；StatusContext 走 state", () => {
    expect(
      summarizeChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", state: "SUCCESS" },
      ]),
    ).toBe("success");
    expect(summarizeChecks([{ __typename: "StatusContext", state: "ERROR" }])).toBe("failure");
  });
});

describe("pr-auto-update.yml 安全边界", () => {
  const src = readFileSync(
    join(import.meta.dir, "../../.github/workflows/pr-auto-update.yml"),
    "utf8",
  );
  const doc = parseYaml(src) as Record<string, any>;

  test("只 checkout main（PAT 有写权限，绝不能跑 PR 分支上的代码）", () => {
    const steps = doc.jobs.update.steps as Array<Record<string, any>>;
    const checkout = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("main");
  });

  test("全局串行 concurrency，且不取消在跑实例", () => {
    expect(doc.concurrency.group).toBe("pr-auto-update");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("写操作走 PAT 而不是 GITHUB_TOKEN（后者触发的 CI 需要人批准，队列照样卡）", () => {
    expect(src).toContain("secrets.PR_AUTO_UPDATE_TOKEN");
    expect(doc.permissions).toEqual({ contents: "read" });
  });
});
