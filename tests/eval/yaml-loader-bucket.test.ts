/**
 * yaml-loader bucket 判定单测（B7-1 新增 isTrajectoryBucket）
 *
 * 锁定 §15.2 ADR-033 的 trajectory 轴 bucket 范围：
 *   - real-tasks / real-tasks/<sub> 命中
 *   - holdout/real-tasks / holdout/real-tasks/<sub> 命中
 *   - 其他 bucket（general / architecture / general/execution）不命中
 *
 * 同时验证三个轴互斥：execution ⊥ trajectory ⊥ architecture（同一 bucket 不应同时命中两个轴）。
 */

import { describe, test, expect } from "bun:test";
import {
  isTrajectoryBucket,
  isExecutionBucket,
  isArchitectureBucket,
  isBehaviorBucket,
} from "../../scripts/eval/lib/yaml-loader.ts";

describe("isTrajectoryBucket - §15.2 trajectory 轴 bucket 判定", () => {
  test("real-tasks 根命中", () => {
    expect(isTrajectoryBucket("real-tasks")).toBe(true);
  });

  test("real-tasks/<sub> 命中", () => {
    expect(isTrajectoryBucket("real-tasks/codereview")).toBe(true);
    expect(isTrajectoryBucket("real-tasks/skill-distill")).toBe(true);
  });

  test("holdout/real-tasks 命中（永封 trajectory case）", () => {
    expect(isTrajectoryBucket("holdout/real-tasks")).toBe(true);
    expect(isTrajectoryBucket("holdout/real-tasks/sub")).toBe(true);
  });

  test("非 trajectory bucket 不命中", () => {
    expect(isTrajectoryBucket("general/p0-core")).toBe(false);
    expect(isTrajectoryBucket("general/execution")).toBe(false);
    expect(isTrajectoryBucket("architecture/redline")).toBe(false);
    expect(isTrajectoryBucket("holdout")).toBe(false);
    expect(isTrajectoryBucket("holdout/architecture/kernel")).toBe(false);
  });

  test("空字符串不命中", () => {
    expect(isTrajectoryBucket("")).toBe(false);
  });
});

describe("三轴互斥铁律（execution ⊥ trajectory ⊥ architecture）", () => {
  // 生产里实际出现的 bucket 列表；不含 "general/execution/<sub>"——execution case 当前只在
  // EXECUTION_BUCKET="general/execution" 单层下落盘，子目录形态后续若出现需先修
  // isBehaviorBucket 的 startsWith 判定（已知 latent issue：general/execution/<sub> 当前会同时
  // 命中 isBehaviorBucket + isExecutionBucket，待生产真出现该形态时再修）。
  const samples = [
    "general/p0-core",
    "general/execution",
    "architecture/redline",
    "architecture/kernel",
    "holdout/architecture/kernel",
    "real-tasks",
    "real-tasks/codereview",
    "holdout/real-tasks",
    "holdout/real-tasks/sub",
  ];

  test("同一 bucket 不会同时命中 execution + trajectory", () => {
    for (const b of samples) {
      const exec = isExecutionBucket(b);
      const traj = isTrajectoryBucket(b);
      expect(exec && traj).toBe(false);
    }
  });

  test("同一 bucket 不会同时命中 architecture + trajectory", () => {
    for (const b of samples) {
      const arch = isArchitectureBucket(b);
      const traj = isTrajectoryBucket(b);
      expect(arch && traj).toBe(false);
    }
  });

  test("同一 bucket 不会同时命中 architecture + execution", () => {
    for (const b of samples) {
      const arch = isArchitectureBucket(b);
      const exec = isExecutionBucket(b);
      expect(arch && exec).toBe(false);
    }
  });

  test("isBehaviorBucket 不与 execution / architecture / trajectory 重叠", () => {
    for (const b of samples) {
      const behavior = isBehaviorBucket(b);
      const other = isExecutionBucket(b) || isArchitectureBucket(b) || isTrajectoryBucket(b);
      // behavior 与 execution 设计上明确互斥（执行轴从 general/ 中分出）
      // behavior 与 architecture / trajectory 各处于不同顶层目录，理论上不重叠
      expect(behavior && other).toBe(false);
    }
  });
});
