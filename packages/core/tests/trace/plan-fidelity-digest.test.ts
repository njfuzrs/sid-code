/**
 * B17：计划对齐度（fidelity）进 digest / `/insights` 的闭环单测。
 *
 * 背景：`PlanModeManager.getFidelityReport()` 曾经生产零调用，官网却写「能看到对齐度」。
 * 现在 app 在执行阶段每批工具调用后落一条 `PlanFidelity` **累计快照**事件，
 * digest 每份计划取末条、渲染成一行 L0 事实。
 *
 * 断言重点：
 *  1. 快照语义 —— 同一份计划多条事件只取末条（累加会得到 N 倍调用数）
 *  2. 多份计划各自一行，按首次出现排序
 *  3. 无事件 → 不出这一行（老会话不能凭空多一条「计划 0 步」）
 *  4. renderHuman 的 L0 事实层里真的能看到这行（/insights 就是 renderHuman）
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  aggregatePlanFidelity,
  buildDigest,
  listSessions,
  renderHuman,
  resolvePaths,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

type Ev = { event?: string; data?: Record<string, unknown> };

function snap(planFile: string, steps: number, actual: number, off: number): Ev {
  return {
    event: "PlanFidelity",
    data: {
      plan_file: planFile,
      plan_step_count: steps,
      actual_tool_call_count: actual,
      off_plan_count: off,
    },
  };
}

describe("aggregatePlanFidelity", () => {
  it("无 PlanFidelity 事件 → 空数组", () => {
    expect(aggregatePlanFidelity([])).toEqual([]);
    expect(aggregatePlanFidelity([{ event: "PreToolUse", data: {} }])).toEqual([]);
  });

  it("同一份计划多条快照只取末条，不累加", () => {
    const r = aggregatePlanFidelity([
      snap("/p/a.md", 3, 0, 0),
      snap("/p/a.md", 3, 2, 1),
      snap("/p/a.md", 3, 5, 2),
    ]);
    expect(r).toEqual([
      { planFile: "/p/a.md", planStepCount: 3, actualToolCallCount: 5, offPlanCount: 2 },
    ]);
  });

  it("多份计划各一条，按首次出现排序（后续快照不挪位置）", () => {
    const r = aggregatePlanFidelity([
      snap("/p/a.md", 2, 1, 0),
      snap("/p/b.md", 4, 1, 1),
      snap("/p/a.md", 2, 3, 1),
    ]);
    expect(r.map((x) => x.planFile)).toEqual(["/p/a.md", "/p/b.md"]);
    expect(r[0]!.actualToolCallCount).toBe(3);
  });

  it("字段缺失 / 非数字按 0 计，不产出 NaN", () => {
    const r = aggregatePlanFidelity([{ event: "PlanFidelity", data: { plan_step_count: "x" } }]);
    expect(r).toEqual([
      { planFile: "", planStepCount: 0, actualToolCallCount: 0, offPlanCount: 0 },
    ]);
  });
});

describe("buildDigest + renderHuman：/insights 能看到这一行", () => {
  let root: string;
  let paths: DigestPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-fidelity-digest-"));
    mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
    paths = resolvePaths(root);
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function writeSession(id: string, events: Ev[]) {
    const dir = join(root, "trajectories", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({
        trajectory: [],
        info: { exit_status: "end_turn" },
        metadata: { session_id: id, model: "m", exit_status: "end_turn", total_steps: 0 },
      }),
    );
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  it("有快照 → L0 事实层渲染「计划 N 步 / 实际 M 次调用 / 偏离 K 次」", () => {
    writeSession("fid00001", [snap("/p/a.md", 3, 0, 0), snap("/p/a.md", 3, 4, 1)]);
    const d = buildDigest(listSessions(paths)[0]!, false, paths)!;
    const hits = d.anomalies.filter((a) => a.kind === "plan_fidelity");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.layer).toBe("L0");
    const out = renderHuman(d, { noColor: true, invocation: "/insights" });
    expect(out).toContain("plan_fidelity: 计划 3 步 / 实际 4 次调用 / 偏离 1 次");
  });

  it("无快照 → 不出 plan_fidelity", () => {
    writeSession("fid00002", [{ event: "PreToolUse", data: { tool_name: "read" } }]);
    const d = buildDigest(listSessions(paths)[0]!, false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "plan_fidelity")).toBe(false);
  });
});

describe("PlanModeManager：fidelity 按一份计划计", () => {
  it("第二次 enter 清掉上一份计划的步骤与调用", () => {
    const m = new PlanModeManager();
    m.enter("default");
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 src/cli.ts\n");
    m.submitForApproval();
    m.approve();
    m.recordActualToolCall("read", { file_path: "package.json" });
    expect(m.getFidelityReport().actualToolCallCount).toBe(1);

    m.endExecution();
    m.enter("default");
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(0);
    expect(r.actualToolCallCount).toBe(0);
  });
});

describe("PlanModeManager：加粗的步骤描述也能锚定", () => {
  // 回归：真实会话里计划写成 `1. **读取 package.json**`，2 次严格按计划的 read 全记成偏离。
  it("**读取 package.json** 命中 read package.json", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(
      "## 步骤\n\n1. **读取 package.json**\n   - 使用 read 工具\n\n2. **读取 notes.txt**\n",
    );
    expect(
      m.recordActualToolCall("read", { file_path: "/tmp/x/package.json" }).matchedPlanStepIndex,
    ).toBe(1);
    expect(
      m.recordActualToolCall("read", { file_path: "/tmp/x/notes.txt" }).matchedPlanStepIndex,
    ).toBe(2);
    expect(m.getFidelityReport().offPlanCount).toBe(0);
  });
});
