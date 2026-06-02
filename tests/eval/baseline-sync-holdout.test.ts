/**
 * F-H4 holdout 双重防御单测
 *
 * 验证 syncBaselineScores 在 allowHoldout=false 时:
 *   - 命中 holdout/ 路径的 result 被跳过(不写入 yaml)
 *   - 命中 yaml.holdout=true 的 result 被跳过
 *   - 显式 allowHoldout=true 时,正常写入
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBaselineScores, type BaselineResult } from "eval-framework/core/baseline-sync";
import { GRADER_VERSION } from "eval-framework/core/judge";

const tmpRoot = mkdtempSync(join(tmpdir(), "sid-baseline-holdout-"));

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function setupHoldoutCase(caseDir: string, caseId: string, holdoutFlag: boolean) {
  mkdirSync(caseDir, { recursive: true });
  const yamlContent = `id: ${caseId}
priority: P0
${holdoutFlag ? "holdout: true\n" : ""}category: test
input:
  user_query: "test query"
expected:
  must_include_any_of: [foo]
`;
  const path = join(caseDir, `${caseId}.yaml`);
  writeFileSync(path, yamlContent);
  return path;
}

function mkHoldoutResult(caseId: string): BaselineResult {
  return {
    caseId,
    provider: "sid_code_test",
    score: 4.0,
    runStatus: "success",
    testedAt: "2026-05-30T10:00:00.000Z",
    dimensions: { anchor_hit: 1.0 },
    formulaVersion: { grader: GRADER_VERSION },
    transcriptPath: null,
  };
}

describe("F-H4 holdout 双重防御", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpRoot, "run-"));
    mkdirSync(join(baseDir, "general", "p0-core"), { recursive: true });
    mkdirSync(join(baseDir, "holdout"), { recursive: true });
  });

  test("holdout 路径(/holdout/)的 result 默认被跳过", () => {
    const path = setupHoldoutCase(join(baseDir, "holdout"), "case_holdout_path", false);
    const updated = syncBaselineScores(
      [mkHoldoutResult("case_holdout_path")],
      { baseDir, testerLabel: "test" },
    );
    expect(updated).toBe(0);
    // yaml 不应被改写;读回原始内容确认
    const content = readFileSync(path, "utf-8");
    expect(content).not.toContain("baseline_scores");
  });

  test("yaml.holdout=true 的 result 默认被跳过(即使在 general/ 路径)", () => {
    setupHoldoutCase(join(baseDir, "general", "p0-core"), "case_holdout_flag", true);
    const updated = syncBaselineScores(
      [mkHoldoutResult("case_holdout_flag")],
      { baseDir, testerLabel: "test" },
    );
    expect(updated).toBe(0);
  });

  test("allowHoldout=true 时,holdout case 正常写入", () => {
    const path = setupHoldoutCase(join(baseDir, "holdout"), "case_holdout_explicit", true);
    const updated = syncBaselineScores(
      [mkHoldoutResult("case_holdout_explicit")],
      { baseDir, testerLabel: "test", allowHoldout: true },
    );
    expect(updated).toBe(1);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("baseline_scores");
    expect(content).toContain("sid_code_test");
  });

  test("非 holdout case 不受 F-H4 影响,正常写入", () => {
    setupHoldoutCase(join(baseDir, "general", "p0-core"), "case_normal", false);
    const updated = syncBaselineScores(
      [mkHoldoutResult("case_normal")],
      { baseDir, testerLabel: "test" },
    );
    expect(updated).toBe(1);
  });
});
