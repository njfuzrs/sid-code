/**
 * eval-runner 端到端测试
 *
 * 不调真实 LLM，用合成的 TestResult mock 数据，验证 _runs / _scores / baseline_scores 三处产物的 schema 正确性。
 *
 * 关键回归保护：
 *  - tested_at 必须是单 case 实际完成时间（不是整批 runId）
 *  - _runs/{provider}.jsonl 追加式写入，不能覆盖
 *  - run_status 正确分类 success / timeout / error
 *  - 多 case 写入 _scores/wNN/ 时按 case 切分文件
 *  - syncBaselineScores 找不到 case yaml 时跳过（不报错）
 *  - syncBaselineScores 写入的 dimensions 完整
 *  - aggregate 公式行为符合权重设计（rubric_score 主导 + cost 兜底）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  appendRunHistory,
  writeWeekScores,
  syncBaselineScores,
  isRetryableError,
  type TestResult,
} from "../../evals/eval-runner.ts";
import { aggregate } from "../../evals/eval-judge.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `eval-runner-e2e-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  // 准备 mock case yaml（让 syncBaselineScores 能找到回写目标）
  mkdirSync(join(tmpRoot, "p0-core"), { recursive: true });
  writeFileSync(
    join(tmpRoot, "p0-core", "case_001.yaml"),
    `id: case_001
category: 代码理解
priority: P0
input:
  user_query: "test query"
expected:
  must_include_any_of: ["foo"]
`,
  );
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function mkResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    caseId: "case_001",
    provider: "sid_code_test",
    score: 4.0,
    namedScores: { anchor_hit: 1.0, rubric_score: 0.8, tool_compliance: 1.0, efficiency: 1.0, cost: 1.0 },
    dims: {},
    response: { output: "test output" },
    latencyMs: 1234,
    success: true,
    runStatus: "success",
    testedAt: "2026-05-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("appendRunHistory", () => {
  test("追加式写入 _runs/{provider}.jsonl，不覆盖", () => {
    const results1: TestResult[] = [
      mkResult({ caseId: "case_001", testedAt: "2026-05-24T10:00:00.000Z" }),
    ];
    const results2: TestResult[] = [
      mkResult({ caseId: "case_002", testedAt: "2026-05-24T10:05:00.000Z" }),
    ];
    appendRunHistory(results1, "run-1", 21, tmpRoot);
    appendRunHistory(results2, "run-2", 21, tmpRoot);

    const filePath = join(tmpRoot, "_runs", "sid_code_test.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    const line1 = JSON.parse(lines[0]);
    const line2 = JSON.parse(lines[1]);
    expect(line1.case_id).toBe("case_001");
    expect(line2.case_id).toBe("case_002");
    expect(line1.run_id).toBe("run-1");
    expect(line2.run_id).toBe("run-2");
  });

  test("tested_at 用 case 实际完成时间，不是 runId", () => {
    const runId = "run-batch-timestamp";
    const caseCompletedAt = "2026-05-24T11:11:11.111Z";
    const results: TestResult[] = [mkResult({ testedAt: caseCompletedAt, caseId: "case_003" })];

    appendRunHistory(results, runId, 21, tmpRoot);

    const content = readFileSync(join(tmpRoot, "_runs", "sid_code_test.jsonl"), "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.tested_at).toBe(caseCompletedAt);
    expect(last.tested_at).not.toBe(runId);
    expect(last.run_id).toBe(runId);
  });

  test("run_status 分类正确：timeout / error / success", () => {
    const runId = "run-status-test";
    // 新行为（审查 #1 + #2）：runStatus 由 caller 显式传，appendRunHistory 不再 sniff output
    const results: TestResult[] = [
      mkResult({ caseId: "case_t1", response: { output: "[ERROR] TIMEOUT after 30s" }, success: false, runStatus: "timeout", score: null }),
      mkResult({ caseId: "case_t2", response: { output: "[ERROR] something else" }, success: false, runStatus: "error", score: null }),
      mkResult({ caseId: "case_t3", response: { output: "good output" }, success: true, runStatus: "success" }),
    ];
    appendRunHistory(results, runId, 21, tmpRoot);

    const content = readFileSync(join(tmpRoot, "_runs", "sid_code_test.jsonl"), "utf-8");
    const all = content.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const t1 = all.find((r) => r.case_id === "case_t1");
    const t2 = all.find((r) => r.case_id === "case_t2");
    const t3 = all.find((r) => r.case_id === "case_t3");
    expect(t1.run_status).toBe("timeout");
    expect(t2.run_status).toBe("error");
    expect(t3.run_status).toBe("success");
    // 修复审查 #1 + #10：error/timeout case 的 score 必须写 null（与 baseline 一致）
    expect(t1.score).toBeNull();
    expect(t2.score).toBeNull();
    expect(t3.score).toBe(4.0);
  });

  test("按 provider 切分文件", () => {
    const results: TestResult[] = [
      mkResult({ caseId: "case_p1", provider: "sid_code_test" }),
      mkResult({ caseId: "case_p1", provider: "claude_code_test" }),
    ];
    appendRunHistory(results, "run-multi-provider", 21, tmpRoot);
    expect(existsSync(join(tmpRoot, "_runs", "sid_code_test.jsonl"))).toBe(true);
    expect(existsSync(join(tmpRoot, "_runs", "claude_code_test.jsonl"))).toBe(true);
  });
});

describe("writeWeekScores", () => {
  test("按 case 切分文件到 _scores/wNN/", () => {
    const subRoot = join(tmpRoot, "wkscores");
    mkdirSync(subRoot, { recursive: true });
    const results: TestResult[] = [
      mkResult({ caseId: "case_w1" }),
      mkResult({ caseId: "case_w2" }),
    ];
    writeWeekScores(results, 21, subRoot);
    expect(existsSync(join(subRoot, "_scores", "w21", "case_w1.yaml"))).toBe(true);
    expect(existsSync(join(subRoot, "_scores", "w21", "case_w2.yaml"))).toBe(true);
  });

  test("yaml 内嵌 anchor/llm 嵌套结构供 yaml-loader 消费", () => {
    const subRoot = join(tmpRoot, "wknest");
    mkdirSync(subRoot, { recursive: true });
    const results: TestResult[] = [
      mkResult({
        caseId: "case_nest",
        namedScores: { anchor_hit: 0.85, rubric_score: 0.9, tool_compliance: 1, efficiency: 0.7, cost: 0.4 },
      }),
    ];
    writeWeekScores(results, 21, subRoot);
    const doc = parseYaml(readFileSync(join(subRoot, "_scores", "w21", "case_nest.yaml"), "utf-8"));
    expect(doc.tested_at).toBeDefined();
    expect(doc.sid_code_test.anchor.score).toBe(0.85);
    expect(doc.sid_code_test.llm.score).toBe(0.9);
    expect(doc.sid_code_test.llm.dimensions.cost).toBe(0.4);
  });

  test("多 provider 同 case：tested_at 取最晚", () => {
    const subRoot = join(tmpRoot, "wklatest");
    mkdirSync(subRoot, { recursive: true });
    const results: TestResult[] = [
      mkResult({ provider: "a", testedAt: "2026-05-24T08:00:00.000Z" }),
      mkResult({ provider: "b", testedAt: "2026-05-24T12:00:00.000Z" }),
    ];
    writeWeekScores(results, 21, subRoot);
    const doc = parseYaml(readFileSync(join(subRoot, "_scores", "w21", "case_001.yaml"), "utf-8"));
    expect(doc.tested_at).toBe("2026-05-24T12:00:00.000Z");
  });
});

describe("syncBaselineScores", () => {
  test("找到 case yaml 时写入 baseline_scores.{provider}", () => {
    const results: TestResult[] = [
      mkResult({
        caseId: "case_001",
        provider: "sid_code_v2",
        score: 4.5,
        testedAt: "2026-05-24T13:00:00.000Z",
      }),
    ];
    syncBaselineScores(results, tmpRoot);
    const doc = parseYaml(readFileSync(join(tmpRoot, "p0-core", "case_001.yaml"), "utf-8"));
    expect(doc.baseline_scores.sid_code_v2.score).toBe(4.5);
    expect(doc.baseline_scores.sid_code_v2.tested_at).toBe("2026-05-24T13:00:00.000Z");
    expect(doc.baseline_scores.sid_code_v2.tested_by).toBe("eval-runner");
    expect(doc.baseline_scores.sid_code_v2.dimensions.anchor_hit).toBe(1.0);
  });

  test("找不到 case yaml 时静默跳过（不抛异常）", () => {
    const results: TestResult[] = [mkResult({ caseId: "case_nonexistent_xyz", provider: "p" })];
    expect(() => syncBaselineScores(results, tmpRoot)).not.toThrow();
  });

  test("run_status: timeout 时 notes 含 '超时'", () => {
    const results: TestResult[] = [
      mkResult({
        caseId: "case_001",
        provider: "p_timeout",
        response: { output: "[ERROR] sid-code TIMEOUT after 360000ms" },
        success: false,
        runStatus: "timeout",
        score: null,
      }),
    ];
    syncBaselineScores(results, tmpRoot);
    const doc = parseYaml(readFileSync(join(tmpRoot, "p0-core", "case_001.yaml"), "utf-8"));
    expect(doc.baseline_scores.p_timeout.run_status).toBe("timeout");
    expect(doc.baseline_scores.p_timeout.notes).toContain("超时");
  });
});

describe("isRetryableError", () => {
  test("识别 stderr 里的常见网络瞬时错误", () => {
    expect(isRetryableError("", "ECONNRESET while reading")).toBe(true);
    expect(isRetryableError("", "HTTP 429 Too Many Requests")).toBe(true);
    expect(isRetryableError("", "upstream 502 Bad Gateway")).toBe(true);
    expect(isRetryableError("", "fetch failed")).toBe(true);
    expect(isRetryableError("", "socket hang up")).toBe(true);
  });

  test("识别 output [ERROR]/[TIMEOUT] 前缀块里的网络错误", () => {
    expect(isRetryableError("[ERROR] HTTP 429 Too Many Requests", "")).toBe(true);
    expect(isRetryableError("[TIMEOUT] socket hang up after 30s", "")).toBe(true);
    expect(isRetryableError("[ERROR] upstream 502 Bad Gateway", "")).toBe(true);
  });

  test("regression 审查 #9: agent 长答案里的 429/502 关键字不应触发重试", () => {
    // 旧实现扫整段 stdout → 任何讨论 HTTP 状态码的回答都会触发误判
    const agentAnswer = "如果遇到 HTTP 429 Too Many Requests 应该退避重试。502 Bad Gateway 是 nginx 常见错误。";
    expect(isRetryableError(agentAnswer, "")).toBe(false);
  });

  test("业务错误不重试", () => {
    expect(isRetryableError("[ERROR] empty output", "")).toBe(false);
    expect(isRetryableError("[ERROR] parse_error stdout=abc", "")).toBe(false);
    expect(isRetryableError("Model refused to respond", "")).toBe(false);
    expect(isRetryableError("", "")).toBe(false);
  });
});

describe("aggregate 权重公式回归", () => {
  test("rubric_score 主导（权重 4.0/7.8）：rubric=0 时即使其它满分也 < 3 分", () => {
    const { score } = aggregate({
      anchor_hit: { pass: true, score: 1, reason: "" },
      rubric_score: { pass: false, score: 0, reason: "" },
      tool_compliance: { pass: true, score: 1, reason: "" },
      efficiency: { pass: true, score: 1, reason: "" },
      cost: { pass: true, score: 1, reason: "" },
    });
    // 新权重（审查 #7：efficiency 1.0→0.3）：
    // weighted: (1*1.5 + 0*4.0 + 1*1.5 + 1*0.3 + 1*0.5) / 7.8 * 5 = 3.8/7.8*5 ≈ 2.44
    // rubric=0 仍然主导（< 3 分），但权重调整后总分略低于旧 2.65
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(3);
    expect(score!).toBeGreaterThan(2.0);
  });

  test("全部满分 = 5", () => {
    const { score } = aggregate({
      anchor_hit: { pass: true, score: 1, reason: "" },
      rubric_score: { pass: true, score: 1, reason: "" },
      tool_compliance: { pass: true, score: 1, reason: "" },
      efficiency: { pass: true, score: 1, reason: "" },
      cost: { pass: true, score: 1, reason: "" },
    });
    expect(score).toBe(5);
  });

  test("namedScores 镜像各维度分数", () => {
    const { namedScores } = aggregate({
      anchor_hit: { pass: true, score: 0.5, reason: "" },
      rubric_score: { pass: false, score: 0.3, reason: "" },
    });
    expect(namedScores.anchor_hit).toBe(0.5);
    expect(namedScores.rubric_score).toBe(0.3);
  });
});
