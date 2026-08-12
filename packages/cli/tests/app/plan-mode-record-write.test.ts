/**
 * W12.D2 集成测试 — handlePlanModeTransitions 内的 plan 文件 write/edit 检测逻辑
 *
 * 见 docs/specs/active/W12-plan-recovery-mechanism.md §3
 *
 * 因 handlePlanModeTransitions 是 App 内 private 方法且依赖大量 deps，
 * 本测试复现其内部检测逻辑（block.name + result.is_error + isPlanFile）
 * 直接断言 PlanModeManager 的 recordPlanFileWrite 触发条件。
 *
 * 覆盖：
 * - write 成功 + file_path === planFilePath → recordPlanFileWrite 被调
 * - write 失败（is_error: true）→ 不调
 * - write 成功但 file_path !== planFilePath → 不调
 * - edit 工具与 write 同等处理
 * - write 但 file_path 未提供 → 不调
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

interface MockToolBlock {
  name: string;
  input: { file_path?: string; content?: string } | undefined;
}

interface MockToolResult {
  type: "tool_result" | "text";
  is_error?: boolean;
}

/**
 * 复现 src/app.ts:handlePlanModeTransitions 内的 plan 文件 write/edit 检测分支
 * 单元测试用，不依赖完整 App 实例
 */
function maybeRecordPlanFileWrite(
  planManager: PlanModeManager,
  block: MockToolBlock,
  result: MockToolResult | undefined,
): void {
  if (
    (block.name === "write" || block.name === "edit") &&
    result &&
    result.type === "tool_result" &&
    !result.is_error
  ) {
    const fp = block.input?.file_path;
    if (fp && planManager.isPlanFile(fp)) {
      planManager.recordPlanFileWrite(Date.now());
    }
  }
}

describe("handlePlanModeTransitions — plan 文件 write/edit 检测（W12.D2）", () => {
  test("write 成功 + file_path === planFilePath → recordPlanFileWrite 被调", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();
    expect(planPath).not.toBeNull();

    maybeRecordPlanFileWrite(
      m,
      { name: "write", input: { file_path: planPath!, content: "# plan" } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(1);
  });

  test("write 失败（is_error: true）→ 不调", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();

    maybeRecordPlanFileWrite(
      m,
      { name: "write", input: { file_path: planPath!, content: "# plan" } },
      { type: "tool_result", is_error: true },
    );

    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("write 成功但 file_path !== planFilePath → 不调", () => {
    const m = new PlanModeManager();
    m.enter("default");

    maybeRecordPlanFileWrite(
      m,
      { name: "write", input: { file_path: "./src/foo.ts", content: "x" } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("edit 工具与 write 同等处理 → recordPlanFileWrite 被调", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();

    maybeRecordPlanFileWrite(
      m,
      { name: "edit", input: { file_path: planPath!, content: "patched" } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(1);
  });

  test("file_path 未提供 → 不调（防御性）", () => {
    const m = new PlanModeManager();
    m.enter("default");

    maybeRecordPlanFileWrite(
      m,
      { name: "write", input: { content: "x" } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("result 是 text 类型（不应该出现，但防御）→ 不调", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();

    maybeRecordPlanFileWrite(m, { name: "write", input: { file_path: planPath!, content: "x" } }, {
      type: "text",
    } as MockToolResult);

    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("非 write/edit 工具（如 bash） → 不调", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();

    maybeRecordPlanFileWrite(
      m,
      { name: "bash", input: { file_path: planPath! } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(0);
  });

  test("连续两次 write plan 文件 → count 累加到 2", () => {
    const m = new PlanModeManager();
    m.enter("default");
    const planPath = m.getPlanFilePath();

    maybeRecordPlanFileWrite(
      m,
      { name: "write", input: { file_path: planPath!, content: "v1" } },
      { type: "tool_result", is_error: false },
    );
    maybeRecordPlanFileWrite(
      m,
      { name: "edit", input: { file_path: planPath!, content: "v2" } },
      { type: "tool_result", is_error: false },
    );

    expect(m.getPlanFileUpdateCount()).toBe(2);
  });
});
