/**
 * check-skill-holdout-regression.ts 单测（B7-7）
 *
 * 覆盖：
 *  - isSkillMd：SKILL.md 路径识别（builtin / .sid-code/skills 都识别）
 *  - surveyHoldout：扫 holdout 目录统计 grader_type 分布；缺 grader_type 默认 rubric_5d
 *  - 空 holdout 目录 → all 0
 *  - 含 execution_test case → execution_cases > 0 且 path 收集
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  surveyHoldout,
  walkYaml,
  isSkillMd,
} from "../../scripts/eval/check-skill-holdout-regression.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-skill-holdout-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("isSkillMd - SKILL.md 路径识别", () => {
  test("builtin SKILL.md 命中", () => {
    expect(isSkillMd("src/skill/builtin/code-review/SKILL.md")).toBe(true);
  });

  test(".sid-code/skills 内 .md 命中", () => {
    expect(isSkillMd("path/to/.sid-code/skills/test.md")).toBe(true);
  });

  test("普通 .md 不命中", () => {
    expect(isSkillMd("docs/README.md")).toBe(false);
  });

  test("非 .md 文件不命中", () => {
    expect(isSkillMd("src/skill/builtin/foo/SKILL.txt")).toBe(false);
  });
});

describe("walkYaml - 递归收集 yaml", () => {
  test("空目录 → 空数组", () => {
    const dir = join(tmpRoot, "empty-walk");
    mkdirSync(dir, { recursive: true });
    expect(walkYaml(dir).length).toBe(0);
  });

  test("不存在目录 → 空数组（不抛错）", () => {
    expect(walkYaml(join(tmpRoot, "nonexistent")).length).toBe(0);
  });

  test("递归收集 .yaml + .yml，跳过其他文件", () => {
    const dir = join(tmpRoot, "walk-recurse");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.yaml"), "id: a\n", "utf-8");
    writeFileSync(join(dir, "sub", "b.yml"), "id: b\n", "utf-8");
    writeFileSync(join(dir, "ignore.txt"), "skip\n", "utf-8");
    expect(walkYaml(dir).length).toBe(2);
  });
});

describe("surveyHoldout - 统计 grader_type 分布", () => {
  test("空 holdout → 全 0", () => {
    const dir = join(tmpRoot, "holdout-empty");
    mkdirSync(dir, { recursive: true });
    const s = surveyHoldout(dir);
    expect(s.total_cases).toBe(0);
    expect(s.execution_cases).toBe(0);
    expect(s.rubric_cases).toBe(0);
    expect(s.other_cases).toBe(0);
    expect(s.execution_case_paths).toEqual([]);
  });

  test("混合 grader_type 正确分类", () => {
    const dir = join(tmpRoot, "holdout-mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "case_exec.yaml"), "id: e1\ngrader_type: execution_test\n", "utf-8");
    writeFileSync(join(dir, "case_rubric.yaml"), "id: r1\ngrader_type: rubric_5d\n", "utf-8");
    writeFileSync(
      join(dir, "case_default.yaml"),
      "id: d1\n", // 缺 grader_type → fallback rubric_5d
      "utf-8",
    );
    writeFileSync(join(dir, "case_arch.yaml"), "id: a1\ngrader_type: structured_arch\n", "utf-8");

    const s = surveyHoldout(dir);
    expect(s.total_cases).toBe(4);
    expect(s.execution_cases).toBe(1);
    expect(s.rubric_cases).toBe(2); // 显式 + fallback
    expect(s.other_cases).toBe(1);
    expect(s.execution_case_paths.length).toBe(1);
    expect(s.execution_case_paths[0]).toContain("case_exec.yaml");
  });

  test("缺 id 字段的 yaml 跳过（不算 case）", () => {
    const dir = join(tmpRoot, "holdout-no-id");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "no_id.yaml"), "category: x\n", "utf-8");
    writeFileSync(join(dir, "ok.yaml"), "id: ok\n", "utf-8");
    const s = surveyHoldout(dir);
    expect(s.total_cases).toBe(1);
  });

  test("非法 yaml 跳过不抛错", () => {
    const dir = join(tmpRoot, "holdout-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.yaml"), "[: not yaml :\n  - x\n", "utf-8");
    writeFileSync(join(dir, "good.yaml"), "id: g1\ngrader_type: rubric_5d\n", "utf-8");
    const s = surveyHoldout(dir);
    expect(s.total_cases).toBe(1);
  });

  test("子目录递归扫", () => {
    const dir = join(tmpRoot, "holdout-deep");
    mkdirSync(join(dir, "architecture", "kernel"), { recursive: true });
    writeFileSync(
      join(dir, "architecture", "kernel", "deep.yaml"),
      "id: deep1\ngrader_type: execution_test\n",
      "utf-8",
    );
    const s = surveyHoldout(dir);
    expect(s.total_cases).toBe(1);
    expect(s.execution_cases).toBe(1);
  });
});
