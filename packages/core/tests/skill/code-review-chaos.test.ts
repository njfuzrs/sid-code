/**
 * code-review Skill 混沌测试（chaos test）
 *
 * 与 tests/skill/code-review.test.ts 互补 — 关注异常路径：
 *   (1) 超时降级（SLA.failure_policy=degrade）
 *   (2) 报错降级（adapter error / LLM 失败）
 *   (3) 边界输入（空 PR / 二进制 / 长 PR）case yaml 自身契约
 *   (4) Skill 不绕 Permission / 不修改文件 / 不删除用户代码（RL 红线）
 *
 * 不调真 LLM — 用 mock executor 模拟 runner 行为。
 * S4-T01 三轴螺旋 Step 7 落地。
 *
 * 与 SKILL.md §5（SLA 与失败策略） + RFC-001 §6（失败模式） 对齐。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";

const SKILL_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "src",
  "skill",
  "builtin",
  "code-review",
);
const EVALS_DIR = join(SKILL_DIR, "evals");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

interface CrCase {
  id: string;
  category: string;
  skill: string;
  input: { user_query: string };
  expected: {
    outcome: string;
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    must_not_call_tools?: string[];
    max_steps?: number;
  };
  target_score?: number;
}

function loadCaseYaml(id: string): CrCase {
  return loadYaml(readFileSync(join(EVALS_DIR, `${id}.yaml`), "utf-8")) as CrCase;
}

function loadAllCases(): CrCase[] {
  return readdirSync(EVALS_DIR)
    .filter((f) => /^case_cr_\d{3}\.yaml$/.test(f))
    .sort()
    .map((f) => loadYaml(readFileSync(join(EVALS_DIR, f), "utf-8")) as CrCase);
}

// ============================================================
// 1. 边界 case yaml 契约（S4-T01 边界 case）
// ============================================================

describe("code-review Skill chaos - 边界 case 完整性（S4-T01）", () => {
  test("至少 15 条 case（S3 baseline 10 + S4 边界 5）", () => {
    const cases = loadAllCases();
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  test("case_cr_011 长 PR 场景就位", () => {
    const c = loadCaseYaml("case_cr_011");
    expect(c.category).toMatch(/long_pr|长 PR|boundary/);
    expect(c.input.user_query).toMatch(/35|1480|超大|拆分|long/i);
  });

  test("case_cr_012 空 PR 场景就位", () => {
    const c = loadCaseYaml("case_cr_012");
    expect(c.category).toMatch(/empty_pr|空 PR|boundary/);
  });

  test("case_cr_013 二进制文件场景就位", () => {
    const c = loadCaseYaml("case_cr_013");
    expect(c.category).toMatch(/binary|二进制|boundary/);
    expect(c.input.user_query).toMatch(/\.png|\.pdf|binary|lock/i);
  });

  test("case_cr_014 仅文档变更扩展场景就位", () => {
    const c = loadCaseYaml("case_cr_014");
    expect(c.category).toMatch(/docs_only|docs|boundary/);
  });

  test("case_cr_015 跨语言混合场景就位", () => {
    const c = loadCaseYaml("case_cr_015");
    expect(c.category).toMatch(/mixed_languages|跨语言|boundary/);
    // 含三种语言关键词
    const q = c.input.user_query;
    expect(q).toMatch(/\.ts|TypeScript/);
    expect(q).toMatch(/\.py|Python/);
    expect(q).toMatch(/\.go|Go/);
  });

  test("所有边界 case 都含 must_not_include 反例字段（_template.yaml 强制）", () => {
    for (const id of ["case_cr_011", "case_cr_012", "case_cr_013", "case_cr_014", "case_cr_015"]) {
      const c = loadCaseYaml(id);
      expect(Array.isArray(c.expected.must_not_include)).toBe(true);
      expect(c.expected.must_not_include!.length).toBeGreaterThan(0);
    }
  });

  test("所有边界 case 都禁用 edit / write 工具（RL-001 不删除用户代码）", () => {
    for (const id of ["case_cr_011", "case_cr_012", "case_cr_013", "case_cr_014", "case_cr_015"]) {
      const c = loadCaseYaml(id);
      const blocked = c.expected.must_not_call_tools ?? [];
      expect(blocked).toContain("edit");
      expect(blocked).toContain("write");
    }
  });
});

// ============================================================
// 2. SLA failure_policy 契约（混沌：超时降级 / 报错降级）
// ============================================================

interface MockExecutorResult {
  finalResponse: string;
  toolsCalled: string[];
  steps: number;
  exitStatus: string;
  timedOut: boolean;
  elapsedMs: number;
  error: boolean;
}

interface MockSlaPolicy {
  p95_ms: number;
  failure_policy: "degrade" | "block";
}

function loadSla(): MockSlaPolicy {
  const md = readFileSync(SKILL_FILE, "utf-8");
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no frontmatter");
  const fm = loadYaml(match[1]) as { sla?: { p95_ms?: number; failure_policy?: string } };
  return {
    p95_ms: fm.sla?.p95_ms ?? 900_000,
    failure_policy: (fm.sla?.failure_policy ?? "degrade") as "degrade" | "block",
  };
}

/**
 * 模拟 runner 处理超时场景 — review 类 Skill 超时应 degrade 不阻断 PR
 */
function mockExecuteWithTimeout(timeoutMs: number): MockExecutorResult {
  return {
    finalResponse: "",
    toolsCalled: ["read", "grep"],
    steps: 12,
    exitStatus: "timeout",
    timedOut: true,
    elapsedMs: timeoutMs,
    error: false,
  };
}

/**
 * 模拟编排器对超时结果的处理逻辑 —
 * 与 SKILL.md SLA / orch_003 超时降级对齐
 */
function orchestrateAfterTimeout(
  r: MockExecutorResult,
  sla: MockSlaPolicy,
): {
  blockedPr: boolean;
  annotatedReason: string;
} {
  if (!r.timedOut) return { blockedPr: false, annotatedReason: "" };
  if (sla.failure_policy === "degrade") {
    return {
      blockedPr: false,
      annotatedReason: `code-review Skill 超时 (${r.elapsedMs}ms)，按 degrade 策略不阻断 PR，需人工补 review`,
    };
  }
  return {
    blockedPr: true,
    annotatedReason: `code-review Skill 超时 (${r.elapsedMs}ms)，按 block 策略阻断 PR`,
  };
}

describe("code-review Skill chaos - 超时降级（混沌测试）", () => {
  test("SLA p95 < 15min（与 timeout-mins frontmatter 一致）", () => {
    const sla = loadSla();
    expect(sla.p95_ms).toBeLessThanOrEqual(15 * 60_000);
    expect(sla.p95_ms).toBeGreaterThan(0);
  });

  test("failure_policy = degrade（review 类 Skill 不阻断 PR）", () => {
    const sla = loadSla();
    expect(sla.failure_policy).toBe("degrade");
  });

  test("超时场景：runner 标注 timedOut + 编排器按 degrade 不阻断 PR", () => {
    const sla = loadSla();
    const r = mockExecuteWithTimeout(sla.p95_ms + 1);
    expect(r.timedOut).toBe(true);
    expect(r.finalResponse).toBe("");
    const o = orchestrateAfterTimeout(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.annotatedReason).toMatch(/超时|degrade/);
  });

  test("超时场景：人为切到 block 策略，编排器阻断 PR（对比验证）", () => {
    const sla: MockSlaPolicy = { p95_ms: 900_000, failure_policy: "block" };
    const r = mockExecuteWithTimeout(sla.p95_ms + 1);
    const o = orchestrateAfterTimeout(r, sla);
    expect(o.blockedPr).toBe(true);
    expect(o.annotatedReason).toMatch(/超时|block/);
  });
});

// ============================================================
// 3. 报错降级（混沌：adapter 错误 / LLM 异常）
// ============================================================

function mockExecuteWithError(errType: "llm_error" | "adapter_error"): MockExecutorResult {
  return {
    finalResponse: "",
    toolsCalled: [],
    steps: 0,
    exitStatus: errType,
    timedOut: false,
    elapsedMs: 1234,
    error: true,
  };
}

function orchestrateAfterError(
  r: MockExecutorResult,
  sla: MockSlaPolicy,
): {
  blockedPr: boolean;
  annotatedReason: string;
  fallbackVerdict: string;
} {
  if (!r.error) return { blockedPr: false, annotatedReason: "", fallbackVerdict: "approve" };
  if (sla.failure_policy === "degrade") {
    return {
      blockedPr: false,
      annotatedReason: `code-review Skill 报错 (${r.exitStatus})，按 degrade 不阻断；建议人工 review`,
      fallbackVerdict: "manual_review_required",
    };
  }
  return {
    blockedPr: true,
    annotatedReason: `code-review Skill 报错 (${r.exitStatus})，按 block 阻断 PR`,
    fallbackVerdict: "block",
  };
}

describe("code-review Skill chaos - 报错降级（混沌测试）", () => {
  test("LLM 报错时不阻断 PR，标注 manual_review_required", () => {
    const sla = loadSla();
    const r = mockExecuteWithError("llm_error");
    expect(r.error).toBe(true);
    const o = orchestrateAfterError(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.fallbackVerdict).toBe("manual_review_required");
    expect(o.annotatedReason).toMatch(/报错|degrade/);
  });

  test("Adapter 错误时不阻断 PR", () => {
    const sla = loadSla();
    const r = mockExecuteWithError("adapter_error");
    const o = orchestrateAfterError(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.fallbackVerdict).toBe("manual_review_required");
  });
});

// ============================================================
// 4. RL 红线 chaos（紧急绕过 / 越权工具调用试探）
// ============================================================

function mockExecuteWithToolViolation(blockedTool: string): MockExecutorResult {
  return {
    finalResponse: "Review 已完成，并自动修复部分问题。",
    toolsCalled: ["read", "grep", blockedTool],
    steps: 8,
    exitStatus: "end_turn",
    timedOut: false,
    elapsedMs: 12_000,
    error: false,
  };
}

function checkToolViolations(r: MockExecutorResult, blockList: string[]): string[] {
  return blockList.filter((t) => r.toolsCalled.includes(t));
}

describe("code-review Skill chaos - 红线守护（RL-001 / RL-003 / RL-006）", () => {
  test("RL-001：调用 edit 工具 = 红线违反", () => {
    const r = mockExecuteWithToolViolation("edit");
    const violations = checkToolViolations(r, ["edit", "write"]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain("edit");
  });

  test("RL-001：调用 write 工具 = 红线违反", () => {
    const r = mockExecuteWithToolViolation("write");
    const violations = checkToolViolations(r, ["edit", "write"]);
    expect(violations).toContain("write");
  });

  test("RL-008：Skill 不能 edit 自身 SKILL.md / scripts/（自演化禁令）", () => {
    // 模拟：runner 输出含修改 SKILL.md 的痕迹
    const r: MockExecutorResult = {
      finalResponse: "已优化 SKILL.md",
      toolsCalled: ["read", "edit"],
      steps: 5,
      exitStatus: "end_turn",
      timedOut: false,
      elapsedMs: 5_000,
      error: false,
    };
    // 双检：(a) 工具违例 (b) 文案违例
    expect(checkToolViolations(r, ["edit", "write"])).toContain("edit");
    expect(r.finalResponse).toMatch(/SKILL\.md/);
  });
});

// ============================================================
// 5. 长 PR / 空 PR / 二进制场景 mock 输出契约
// ============================================================

describe("code-review Skill chaos - 边界场景 mock 输出契约", () => {
  test("长 PR mock：runner 应在 finalResponse 中标注 '超大 PR'", () => {
    // 这一项不调真 LLM；只验证 case yaml 的 must_include_any_of 设计正确
    const c = loadCaseYaml("case_cr_011");
    const mockResp =
      "## Review Summary\n超大 PR 警告：35 个文件，建议拆分。仅 review 前 10 个文件。";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("空 PR mock：runner 应识别 whitespace-only 并 verdict=approve", () => {
    const c = loadCaseYaml("case_cr_012");
    const mockResp = "## Review Summary\nVerdict: approve\n仅 whitespace 变更，跳过 review。";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("二进制文件 mock：runner 应识别 .png / .pdf 跳过", () => {
    const c = loadCaseYaml("case_cr_013");
    const mockResp =
      "## Review Summary\nVerdict: approve\n二进制文件 (.png / .pdf / bun.lock) 无法做代码 review，建议人工核验。";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("仅文档变更 mock：runner 应 skip 跳过", () => {
    const c = loadCaseYaml("case_cr_014");
    const mockResp = "## Review Summary\nVerdict: approve\n仅文档变更，跳过代码 review。";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("跨语言混合 mock：runner 应识别 SQL injection（Python / Go）", () => {
    const c = loadCaseYaml("case_cr_015");
    const mockResp =
      "## Review Summary\nVerdict: block\n[blocker] scripts/process_user.py:13 — SQL injection (f-string)\n[blocker] cmd/worker/main.go:18 — SQL injection (Sprintf)";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 6. SLA 整体一致性
// ============================================================

describe("code-review Skill chaos - SLA 整体一致性", () => {
  test("p50 < p95（SLA 单调）", () => {
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error("no frontmatter");
    const fm = loadYaml(match[1]) as { sla?: { p50_ms?: number; p95_ms?: number } };
    expect(fm.sla?.p50_ms).toBeGreaterThan(0);
    expect(fm.sla?.p95_ms).toBeGreaterThan(fm.sla!.p50_ms!);
  });

  test("token_cost_usd > 0 且合理（< $1 / PR）", () => {
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error("no frontmatter");
    const fm = loadYaml(match[1]) as { sla?: { token_cost_usd?: number } };
    expect(fm.sla?.token_cost_usd).toBeGreaterThan(0);
    expect(fm.sla?.token_cost_usd).toBeLessThan(1);
  });
});
