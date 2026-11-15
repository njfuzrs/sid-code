/**
 * 计划审批决策串解析（M5）回归。
 *
 * 这个文件锁的是「用户点了哪一项 → 批准后进哪个模式」这条链路的**判定**部分。
 * 它值一个独立测试文件，因为其中四条不变量单靠集成测试会被别的东西掩盖：
 *
 * 1. **`approve` 裸串必须仍然兼容**（无头路径 / 旧宿主 / 已有测试都用它）；
 * 2. **非法模式必须降级而不是报错**（审批不能因为一个不认识的字符串就失败）；
 * 3. **企业策略优先于用户选择**（`disabledModes` 禁掉的档位选了也不能生效，
 *    否则对话框成了绕过策略的后门）；
 * 4. **`plan` 不是合法执行模式**（批准完留在 plan 里语义自相矛盾）。
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  parsePlanApprovalDecision,
  isApprovableExecMode,
} from "@sid-code/core/plan/approval-decision.ts";
import { setModePolicy, __resetModePolicy } from "@sid-code/core/permission/mode-policy.ts";

afterEach(() => {
  __resetModePolicy();
});

describe("parsePlanApprovalDecision · 批准", () => {
  test("裸 approve → 批准但不指定模式（沿用进入前的），向后兼容无头路径", () => {
    const d = parsePlanApprovalDecision("approve");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBeUndefined();
  });

  test("approve:previous → 批准并沿用进入前的模式", () => {
    const d = parsePlanApprovalDecision("approve:previous");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
  });

  test("approve:acceptEdits → 批准并切到 acceptEdits", () => {
    const d = parsePlanApprovalDecision("approve:acceptEdits");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBe("acceptEdits");
  });

  test("approve:auto → 批准并切到 auto", () => {
    const d = parsePlanApprovalDecision("approve:auto");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBe("auto");
  });

  test("空后缀 approve: → 当作「沿用进入前」，不当作非法", () => {
    const d = parsePlanApprovalDecision("approve:");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBeUndefined();
  });
});

describe("parsePlanApprovalDecision · 非法与策略（降级，不报错）", () => {
  test("未知模式 → 批准但降级为「沿用进入前」，并留下 rejectedMode 供日志归因", () => {
    const d = parsePlanApprovalDecision("approve:bypassPermissions");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBe("bypassPermissions");
  });

  test("approve:plan → 降级（批准后不能继续待在 plan 里）", () => {
    const d = parsePlanApprovalDecision("approve:plan");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBe("plan");
  });

  test("企业策略禁用 auto → 选了也降级，不能拿对话框绕过 disabledModes", () => {
    setModePolicy(["auto"]);
    expect(isApprovableExecMode("auto")).toBe(false);
    const d = parsePlanApprovalDecision("approve:auto");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBe("auto");
  });

  test("策略禁用 acceptEdits 时同样降级", () => {
    setModePolicy(["acceptEdits"]);
    const d = parsePlanApprovalDecision("approve:acceptEdits");
    expect(d.kind).toBe("approve");
    expect(d.execMode).toBeNull();
    expect(d.rejectedMode).toBe("acceptEdits");
  });

  test("降级不影响 kind：非法模式仍然是「批准」，不是拒绝", () => {
    expect(parsePlanApprovalDecision("approve:nonsense").kind).toBe("approve");
  });
});

describe("parsePlanApprovalDecision · 拒绝 / 取消 / 未知", () => {
  test("reject:feedback → 拒绝并带修改意见（去首尾空白）", () => {
    const d = parsePlanApprovalDecision("reject:  先补第三步的失败处理  ");
    expect(d.kind).toBe("reject");
    expect(d.feedback).toBe("先补第三步的失败处理");
  });

  test("裸 reject → 拒绝且无意见", () => {
    const d = parsePlanApprovalDecision("reject");
    expect(d.kind).toBe("reject");
    expect(d.feedback).toBe("");
  });

  test("cancel → 取消", () => {
    expect(parsePlanApprovalDecision("cancel").kind).toBe("cancel");
  });

  test("完全未知的值 → 按拒绝处理（与抽函数之前的 else 分支同口径）", () => {
    const d = parsePlanApprovalDecision("something-else");
    expect(d.kind).toBe("reject");
    expect(d.feedback).toBe("");
  });
});

describe("isApprovableExecMode · 白名单", () => {
  test("acceptEdits / auto 可批准；plan / default / always-allow 不可", () => {
    expect(isApprovableExecMode("acceptEdits")).toBe(true);
    expect(isApprovableExecMode("auto")).toBe(true);
    expect(isApprovableExecMode("plan")).toBe(false);
    expect(isApprovableExecMode("default")).toBe(false);
    expect(isApprovableExecMode("always-allow")).toBe(false);
    expect(isApprovableExecMode("dangerously-skip-permissions")).toBe(false);
  });
});
