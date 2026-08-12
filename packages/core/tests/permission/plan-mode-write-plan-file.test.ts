/**
 * W11.D4 单元测试 — Plan Mode 允许 write 计划文件路径
 *
 * 见 docs/specs/active/W11-plan-write-permission.md
 *
 * 覆盖：
 * - plan mode + write 到 plan 文件路径 → ALLOW
 * - plan mode + write 到非 plan 文件 → DENY (plan mode 行为不变)
 * - 非 plan mode + write 到 ~/.sid-code/plans/... → Step 4 路径验证仍生效
 * - plan mode + edit 到 plan 文件 → ALLOW
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

function buildChecker(opts: { planMode?: boolean; planActive?: boolean }): {
  checker: PermissionChecker;
  planManager: PlanModeManager;
  planFilePath: string | null;
} {
  const config = { ...defaultConfig() };
  if (opts.planMode) {
    config.permissionMode = "plan";
    config.print = true; // 触发非交互模式
  }

  const planManager = new PlanModeManager();
  if (opts.planActive) {
    planManager.enter("default");
  }

  const checker = new PermissionChecker(config);
  checker.setPlanManager(planManager);

  return {
    checker,
    planManager,
    planFilePath: planManager.getPlanFilePath(),
  };
}

describe("PermissionChecker — Plan Mode write to plan file (W11.D4)", () => {
  test("plan mode + write 到 plan 文件路径 → ALLOW", async () => {
    const { checker, planFilePath } = buildChecker({ planMode: true, planActive: true });
    expect(planFilePath).not.toBeNull();

    const result = await checker.check({
      toolName: "write",
      input: { file_path: planFilePath, content: "# plan content" },
    });

    expect(result.allowed).toBe(true);
    expect(result.decisionReason).toMatchObject({
      type: "mode",
      mode: "plan+plan-file",
    });
  });

  test("plan mode + edit 到 plan 文件路径 → ALLOW", async () => {
    const { checker, planFilePath } = buildChecker({ planMode: true, planActive: true });
    expect(planFilePath).not.toBeNull();

    const result = await checker.check({
      toolName: "edit",
      input: { file_path: planFilePath, old_string: "a", new_string: "b" },
    });

    expect(result.allowed).toBe(true);
    expect(result.decisionReason).toMatchObject({
      type: "mode",
      mode: "plan+plan-file",
    });
  });

  test("plan mode + write 到非 plan 文件 → DENY", async () => {
    const { checker } = buildChecker({ planMode: true, planActive: true });

    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/not-a-plan.txt", content: "data" },
    });

    expect(result.allowed).toBe(false);
    // 可能被 Step 4 路径验证拒(/tmp 在工作区外)，也可能被 Step 9 plan mode 拒，都是合法行为
    expect(result.reason).toBeDefined();
  });

  test("plan mode + write 到工作区内非 plan 文件 → DENY (plan mode 限制生效)", async () => {
    const { checker } = buildChecker({ planMode: true, planActive: true });

    // 工作区内的文件，能通过 Step 4 路径验证，但应被 Step 9 plan mode 拒
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "src/test-not-a-plan.ts", content: "data" },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("计划模式");
  });

  test("非 plan mode + write 到 ~/.sid-code/plans/ → 路径验证仍生效(DENY)", async () => {
    const config = { ...defaultConfig(), print: true }; // 非 plan mode 但启用非交互
    const planManager = new PlanModeManager();
    planManager.enter("default");
    const checker = new PermissionChecker(config);
    checker.setPlanManager(planManager);

    const result = await checker.check({
      toolName: "write",
      input: { file_path: planManager.getPlanFilePath()!, content: "x" },
    });

    // 非 plan mode 下，提前放行分支不触发，Step 4 路径验证应拒绝（工作区外）
    expect(result.allowed).toBe(false);
  });

  test("plan mode 但 planManager 未 active → 不放行(getPlanFilePath 为 null)", async () => {
    const { checker, planFilePath } = buildChecker({ planMode: true, planActive: false });

    expect(planFilePath).toBeNull();

    // 任意路径都不会匹配 plan 文件
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/whatever.md", content: "x" },
    });

    expect(result.allowed).toBe(false);
  });
});
