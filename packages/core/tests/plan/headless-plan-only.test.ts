/**
 * 无头会话的 plan 语义回归（2026-10-26）：**没有审批人就不假装批准**。
 *
 * 背景：以 `--permission-mode plan` 启动的无头会话从前走「自动批准」这条路，
 * 而这条入口没有「进入之前的模式」，退出时恢复成 default；`-p` 下 default 的 ask
 * 全部被 `isNonInteractive()` 落成 deny。净效果是 harness 先自动批准、紧接着拒绝
 * 每一个写类调用——一次真实无头实跑里，计划第 1 步 `edit math.js` 直接被拒，
 * 模型只好把改动写成文字交付，整个执行阶段报废。
 *
 * 现在的语义：默认不批准（`plan_only`），显式传 `--plan-exec-mode <mode>` 才批准并切模式。
 * 本文件锁住状态机与消息两侧；app 层的「选哪条路」由端到端实跑验证（见 Agent Note）。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { PlanModeManager, type PlanModeEvent } from "../../src/plan/state.ts";
import { buildHeadlessPlanOnlyMessage } from "../../src/plan/prompt.ts";
import { ExitPlanModeTool } from "../../src/tool/exit-plan-mode.ts";
import { validateConfig } from "../../src/config/schema.ts";
import { defaultConfig } from "../../src/config/config.ts";

const managers: PlanModeManager[] = [];
function mgr(): PlanModeManager {
  const m = new PlanModeManager();
  managers.push(m);
  return m;
}
afterEach(() => {
  // 收尾所有未结束的计划，让占位文件被回收（测试 SID 主目录由 preload 隔离）
  for (const m of managers.splice(0)) m.forceExit();
});

/** 走到「计划已提交、等待审批」 */
function awaiting(m: PlanModeManager): void {
  m.enter("default");
  m.submitForApproval();
}

describe("endWithoutApproval：无审批人时的收尾出口", () => {
  test("待审批态生效，进入 plan_only 结局且不进执行阶段", () => {
    const m = mgr();
    awaiting(m);
    expect(m.endWithoutApproval()).toBe(true);
    expect(m.getState()).toBe("inactive");
    expect(m.isExecuting()).toBe(false);
    expect(m.getLastOutcome()).toBe("plan_only");
    // 路径随计划一起清空（与其它退出路径同一不变量）
    expect(m.getPlanFilePath()).toBeNull();
  });

  test("规划中 / 无计划时不生效（不能把「还没提交」当成已产出）", () => {
    const planning = mgr();
    planning.enter("default");
    expect(planning.endWithoutApproval()).toBe(false);
    expect(planning.getState()).toBe("planning");

    const idle = mgr();
    expect(idle.endWithoutApproval()).toBe(false);
  });

  test("已批准后再调不生效（幂等，不覆盖已批准结局）", () => {
    const m = mgr();
    awaiting(m);
    m.approve({ source: "tui" });
    expect(m.endWithoutApproval()).toBe(false);
    expect(m.getLastOutcome()).toBe("approved");
    expect(m.isExecuting()).toBe(true);
  });

  test("跃迁事件带 reason=no_approver，且 executingAfter=false", () => {
    const m = mgr();
    const events: PlanModeEvent[] = [];
    m.onStateChange((e) => events.push(e));
    awaiting(m);
    m.endWithoutApproval({ source: "headless" });
    const last = events[events.length - 1]!;
    expect(last.reason).toBe("no_approver");
    expect(last.executingAfter).toBe(false);
    expect(last.meta?.source).toBe("headless");
  });

  test("对照：approve() 仍进执行阶段（新出口没有把批准路径挤掉）", () => {
    const m = mgr();
    awaiting(m);
    expect(m.approve({ source: "headless" })).toBe(true);
    expect(m.isExecuting()).toBe(true);
    expect(m.getLastOutcome()).toBe("approved");
  });
});

describe("exit_plan_mode 在 plan_only 结局下的答复", () => {
  test("如实说「没有被批准过、不要执行」，不出现「已审批通过」", async () => {
    const m = mgr();
    const tool = new ExitPlanModeTool(m);
    awaiting(m);
    m.endWithoutApproval();
    const r = await tool.execute({});
    expect(r.output).toContain("没有被批准过");
    expect(r.output).toContain("不要执行");
    expect(r.output).not.toContain("已审批通过");
  });
});

describe("buildHeadlessPlanOnlyMessage", () => {
  test("带计划路径与步数，明确禁止执行类工具", () => {
    const msg = buildHeadlessPlanOnlyMessage("/p/x.md", 3);
    expect(msg).toContain("/p/x.md");
    expect(msg).toContain("3 个步骤");
    expect(msg).toContain("不要执行");
    expect(msg).toContain("todo_write");
  });

  test("指出显式执行入口 --plan-exec-mode", () => {
    expect(buildHeadlessPlanOnlyMessage("/p/x.md")).toContain("--plan-exec-mode");
  });

  test("步数为 0 时不出现「0 个步骤」这种废话", () => {
    expect(buildHeadlessPlanOnlyMessage("/p/x.md", 0)).not.toContain("0 个步骤");
  });
});

describe("--plan-exec-mode 配置校验", () => {
  function withExecMode(mode: string | undefined) {
    const cfg = defaultConfig();
    cfg.planExecMode = mode;
    return validateConfig(cfg);
  }

  test("合法值通过（acceptEdits / default / always-allow）", () => {
    for (const mode of ["acceptEdits", "default", "always-allow"]) {
      const r = withExecMode(mode);
      expect(r.errors.some((e) => e.path === "planExecMode")).toBe(false);
    }
  });

  test("plan 被拒：批准后切回 plan 会让下一轮重新规划，无头下是死循环", () => {
    const r = withExecMode("plan");
    const err = r.errors.find((e) => e.path === "planExecMode");
    expect(err).toBeDefined();
    expect(err!.message).toContain("不含 plan");
  });

  test("不存在的模式被拒", () => {
    const r = withExecMode("whatever");
    expect(r.errors.some((e) => e.path === "planExecMode")).toBe(true);
  });

  test("不传（undefined）不报错、不影响既有校验", () => {
    const r = withExecMode(undefined);
    expect(r.errors.some((e) => e.path === "planExecMode")).toBe(false);
  });
});
