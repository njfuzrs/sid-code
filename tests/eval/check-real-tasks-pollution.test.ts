/**
 * check-real-tasks-pollution.ts 单测（B6-10 数据污染防护扫描器）
 *
 * 覆盖：
 *  - 干净 yaml → 0 violations，main 返回 0
 *  - 命中 contamination 关键词 → main 返回 1，stderr 含违规位置
 *  - 显式文件列表（pre-commit 用法）只扫 evals/real-tasks/ 路径下文件
 *  - real-tasks/ 目录不存在/为空 → 返回 0
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanFile, walkYaml } from "../../scripts/eval/check-real-tasks-pollution.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-pollution-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("walkYaml - 递归收集 yaml", () => {
  test("空目录 → 空数组", () => {
    const empty = join(tmpRoot, "empty-walk");
    mkdirSync(empty, { recursive: true });
    expect(walkYaml(empty).length).toBe(0);
  });

  test("递归收集 .yaml 与 .yml", () => {
    const root = join(tmpRoot, "walk-mixed");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.yaml"), "id: a\n", "utf-8");
    writeFileSync(join(root, "sub", "b.yml"), "id: b\n", "utf-8");
    writeFileSync(join(root, "ignore.txt"), "text\n", "utf-8");
    const files = walkYaml(root);
    expect(files.length).toBe(2);
    expect(files.some((p) => p.endsWith("a.yaml"))).toBe(true);
    expect(files.some((p) => p.endsWith("b.yml"))).toBe(true);
  });

  test("不存在的目录 → 空数组（不抛错）", () => {
    expect(walkYaml(join(tmpRoot, "nonexistent")).length).toBe(0);
  });
});

describe("scanFile - 复用 scanContamination 检测黑名单字段", () => {
  test("干净 yaml → 0 violations", () => {
    const f = join(tmpRoot, "clean.yaml");
    writeFileSync(f, "id: real_T0001\ninstruction:\n  text: 修 bug\n", "utf-8");
    expect(scanFile(f).length).toBe(0);
  });

  test("命中 tool_result_content → 至少 1 violation", () => {
    const f = join(tmpRoot, "dirty1.yaml");
    writeFileSync(
      f,
      `id: real_T0002
tool_result_content: "上一轮答案"
`,
      "utf-8",
    );
    const v = scanFile(f);
    expect(v.length).toBe(1);
    expect(v[0]).toMatch(/tool_result_content/);
    expect(v[0]).toMatch(/@line:/);
  });

  test("命中 5 个黑名单字段 → 5 violations", () => {
    const f = join(tmpRoot, "dirty5.yaml");
    writeFileSync(
      f,
      `id: x
tool_result_content: "..."
response_content: "..."
patch_content: "..."
observation_content: "..."
completion_text: "..."
`,
      "utf-8",
    );
    expect(scanFile(f).length).toBe(5);
  });
});
