/**
 * inferGraderType 单测（B7-1 配套）
 *
 * 锁定 HTML dashboard 与 markdown dashboard 同口径：
 *   - architecture/redline / architecture/* → binary_redline / structured_arch
 *   - general/execution → execution_test（与 yaml-loader.isExecutionBucket 同源）
 *   - real-tasks / holdout/real-tasks → trajectory_match（与 isTrajectoryBucket 同源）
 *   - 显式 grader_type 优先
 *   - 默认 general → rubric_5d
 */

import { describe, test, expect } from "bun:test";
import { inferGraderType } from "../../scripts/eval/build-dashboard-html.ts";

function fakeCase(bucket: string, extras: Record<string, unknown> = {}): any {
  return { id: "x", bucket, ...extras };
}

describe("inferGraderType - B7-1 三轴 grader_type 推断", () => {
  test("显式 grader_type 优先", () => {
    expect(inferGraderType(fakeCase("anything", { grader_type: "custom" }))).toBe("custom");
  });

  test("architecture/redline → binary_redline", () => {
    expect(inferGraderType(fakeCase("architecture/redline"))).toBe("binary_redline");
    expect(inferGraderType(fakeCase("holdout/architecture/redline"))).toBe("binary_redline");
  });

  test("architecture/<其他> → structured_arch", () => {
    expect(inferGraderType(fakeCase("architecture/kernel"))).toBe("structured_arch");
    expect(inferGraderType(fakeCase("holdout/architecture/kernel"))).toBe("structured_arch");
  });

  test("general/execution → execution_test", () => {
    expect(inferGraderType(fakeCase("general/execution"))).toBe("execution_test");
    expect(inferGraderType(fakeCase("general/execution/bug-001"))).toBe("execution_test");
  });

  test("real-tasks / holdout/real-tasks → trajectory_match", () => {
    expect(inferGraderType(fakeCase("real-tasks"))).toBe("trajectory_match");
    expect(inferGraderType(fakeCase("real-tasks/codereview"))).toBe("trajectory_match");
    expect(inferGraderType(fakeCase("holdout/real-tasks"))).toBe("trajectory_match");
    expect(inferGraderType(fakeCase("holdout/real-tasks/sub"))).toBe("trajectory_match");
  });

  test("default general → rubric_5d", () => {
    expect(inferGraderType(fakeCase("general/p0-core"))).toBe("rubric_5d");
    expect(inferGraderType(fakeCase("anything"))).toBe("rubric_5d");
  });
});
