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
 *
 * P1-1 追加（执行阶段）：
 * - approve() 后的执行阶段 + write/edit 计划文件 → ALLOW（无头模式也不被转成拒绝）
 * - 执行阶段 + 写非计划文件 → 不因这条放行而放宽
 * - 执行阶段收尾（endExecution / forceExit）后 → 不再放行
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

function buildChecker(opts: {
  planMode?: boolean;
  planActive?: boolean;
  /** P1-1：构造「计划已批准、正在执行」的阶段（state=inactive 但 isExecuting()=true） */
  executing?: boolean;
  /** 强制非交互模式（print=true），用于复现无头模式把「需确认」转成拒绝的链路 */
  nonInteractive?: boolean;
}): {
  checker: PermissionChecker;
  planManager: PlanModeManager;
  planFilePath: string | null;
  workspace: string;
} {
  const config = { ...defaultConfig() };
  if (opts.planMode) {
    config.permissionMode = "plan";
    config.print = true; // 触发非交互模式
  }
  // 执行阶段的 permissionMode 已恢复（非 plan），但仍要能复现无头模式
  if (opts.nonInteractive) config.print = true;

  const planManager = new PlanModeManager();
  if (opts.planActive) {
    planManager.enter("default");
  }
  // P1-1：执行阶段 = enter → submitForApproval → approve。
  // 此后 state 回 inactive、权限模式已恢复成进入前的值（故 planMode 不设为 plan），
  // 但 isExecuting() 为真——批准消息要求的「失败先更新计划文件」全发生在这个阶段。
  if (opts.executing) {
    planManager.enter("default");
    planManager.submitForApproval();
    planManager.approve();
  }

  // 真实临时目录作 workspace：相对路径会拼到 cwd 上，cwd 含 `.claude/`
  // （例如 `.claude/worktrees/`）时 safetyCheck 先于 plan mode 命中。
  // 不用 `/tmp/...` 字面量——macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，
  // PathValidator 会报「symlink 逃逸」。
  const workspace = mkdtempSync(join(tmpdir(), "sid-plan-mode-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  const checker = new PermissionChecker(config, undefined, workspace);
  checker.setPlanManager(planManager);

  return {
    checker,
    planManager,
    planFilePath: planManager.getPlanFilePath(),
    workspace,
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
    const { checker, workspace } = buildChecker({ planMode: true, planActive: true });

    // 工作区内的绝对路径：相对路径会拼到 cwd 上，cwd 含 `.claude/` 时
    // safetyCheck 会先于 plan mode 命中。绝对路径把这条测回「plan mode 限制」。
    const result = await checker.check({
      toolName: "write",
      input: {
        file_path: join(workspace, "src", "test-not-a-plan.ts"),
        content: "data",
      },
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

// ============================================================
// P1-1：执行阶段「先更新计划再继续」必须走得通
//
// 批准消息（plan/prompt.ts）是执行阶段唯一保留的锚点，它明确要求失败时
// 「必须先用 edit 工具更新计划文件再继续执行」。而 approve() 同时把 state 回到
// inactive、权限模式恢复成进入前的值，于是这一步要重新走完整条权限链——
// 从前那条链上没有任何一个分支认「执行阶段」：
//   - Step 3.5 的提前放行要求 permissionMode === "plan"，此时不成立；
//   - 计划文件在 ~/.sid-code/plans/（工作区外），Step 4 判「需确认」；
//   - 无头模式（print / maxTurns>0）把所有「需确认」直接转成拒绝。
// 结果是 recovery hint 指向一条走不通的路。
// ============================================================
describe("PermissionChecker — 执行阶段写计划文件 (P1-1)", () => {
  test("执行阶段 + write 计划文件 → ALLOW（无头模式下也不被转成拒绝）", async () => {
    const { checker, planManager, planFilePath } = buildChecker({
      executing: true,
      nonInteractive: true,
    });
    // 执行阶段的身份：权限模式已不是 plan，但 isExecuting() 为真
    expect(planManager.isExecuting()).toBe(true);
    expect(planManager.isActive()).toBe(false);
    expect(planFilePath).not.toBeNull();

    const result = await checker.check({
      toolName: "write",
      input: { file_path: planManager.getPlanFilePath(), content: "# 更新后的计划" },
    });

    expect(result.allowed).toBe(true);
    expect(result.decisionReason).toMatchObject({ type: "mode", mode: "plan+plan-file" });
  });

  test("执行阶段 + edit 计划文件 → ALLOW（recovery hint 要求的正是 edit）", async () => {
    const { checker, planManager } = buildChecker({ executing: true, nonInteractive: true });

    const result = await checker.check({
      toolName: "edit",
      input: { file_path: planManager.getPlanFilePath(), old_string: "a", new_string: "b" },
    });

    expect(result.allowed).toBe(true);
    expect(result.decisionReason).toMatchObject({ type: "mode", mode: "plan+plan-file" });
  });

  test("执行阶段的放行是精确路径匹配：同目录下的别的文件不放行", async () => {
    const { checker, planManager } = buildChecker({ executing: true, nonInteractive: true });
    const planPath = planManager.getPlanFilePath()!;
    // 同一个 plans/<项目>/ 目录里的另一个文件——若放行放宽成目录前缀就会误放
    const sibling = join(planPath, "..", "not-the-current-plan.md");

    const result = await checker.check({
      toolName: "write",
      input: { file_path: sibling, content: "x" },
    });

    expect(result.allowed).toBe(false);
  });

  test("执行阶段不放宽对工作区内普通文件的写（只多了计划文件这一条）", async () => {
    const { checker, workspace } = buildChecker({ executing: true });

    const result = await checker.check({
      toolName: "write",
      input: { file_path: join(workspace, "src", "app.ts"), content: "x" },
    });

    // 执行阶段权限模式已恢复成 default，这条不该拿到 plan+plan-file 放行。
    // 断言落在 mode 这个具体取值上：普通工作区文件本来就可能被允许（默认模式），
    // 要拦的是「被 Step 3.5 当成计划文件放行」这一种形态。
    const mode = (result.decisionReason as { mode?: string } | undefined)?.mode;
    expect(mode).not.toBe("plan+plan-file");
  });

  test("执行阶段收尾（endExecution）后 → 不再放行", async () => {
    const { checker, planManager } = buildChecker({ executing: true, nonInteractive: true });
    const planPath = planManager.getPlanFilePath()!;

    // 新用户回合开始时 app.ts 会调 endExecution()
    planManager.endExecution();
    expect(planManager.isExecuting()).toBe(false);

    const result = await checker.check({
      toolName: "write",
      input: { file_path: planPath, content: "x" },
    });

    expect(result.allowed).toBe(false);
  });

  test("用户取消（forceExit）后 → 不再放行", async () => {
    const { checker, planManager } = buildChecker({ executing: true, nonInteractive: true });
    const planPath = planManager.getPlanFilePath()!;

    planManager.forceExit();
    expect(planManager.isExecuting()).toBe(false);

    const result = await checker.check({
      toolName: "write",
      input: { file_path: planPath, content: "x" },
    });

    expect(result.allowed).toBe(false);
  });
});
