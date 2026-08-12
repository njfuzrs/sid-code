/**
 * ci-self-heal Skill 集成测试 + 契约测试
 *
 * 验证 SKILL.md frontmatter 解析 / 加载 / 工具白名单 / scripts 目录结构.
 * 纯结构验证 + Mock, 不调 LLM.
 *
 * RFC: docs/rfcs/RFC-002-ci-self-heal-skill.md
 * 三轴螺旋 Step 3 TDD (S5-T12)
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { parseCILog } from "@sid-code/core/skill/builtin/ci-self-heal/scripts/parse-ci-log.ts";
import { classifyFailure } from "@sid-code/core/skill/builtin/ci-self-heal/scripts/classify-failure.ts";
import { generateFixSuggestions } from "@sid-code/core/skill/builtin/ci-self-heal/scripts/fix-suggestion-templates.ts";

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
  "ci-self-heal",
);
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "when-to-use"?: string;
  mode?: string;
  "allowed-tools"?: string;
  "max-turns"?: number;
  "timeout-mins"?: number;
  sla?: {
    p50_ms?: number;
    p95_ms?: number;
    token_cost_usd?: number;
    failure_policy?: string;
  };
  release_metadata?: Record<string, unknown>;
}

function parseFrontmatter(markdown: string): { fm: SkillFrontmatter; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("No frontmatter found");
  const fm = loadYaml(match[1]) as SkillFrontmatter;
  return { fm, body: match[2] };
}

describe("ci-self-heal Skill - 文件结构契约", () => {
  test("SKILL.md 存在", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
  });

  test("scripts/ references/ validations/ evals/ 四件套目录就位", () => {
    expect(statSync(join(SKILL_DIR, "scripts")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "references")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "validations")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "evals")).isDirectory()).toBe(true);
  });

  test("scripts/parse-ci-log.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "parse-ci-log.ts"))).toBe(true);
  });

  test("scripts/classify-failure.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "classify-failure.ts"))).toBe(true);
  });

  test("scripts/parse-diff.ts 复用 code-review/scripts/parse-diff.ts(symlink 或文件存在)", () => {
    const path = join(SKILL_DIR, "scripts", "parse-diff.ts");
    expect(existsSync(path)).toBe(true);
  });

  test("references/ci-failure-patterns.md 存在(分类启发式手册)", () => {
    expect(existsSync(join(SKILL_DIR, "references", "ci-failure-patterns.md"))).toBe(true);
  });
});

describe("ci-self-heal Skill - SKILL.md frontmatter 契约", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { fm } = parseFrontmatter(markdown);

  test("name = ci-self-heal", () => {
    expect(fm.name).toBe("ci-self-heal");
  });

  test("description 含 CI / 失败 / 诊断 关键字", () => {
    expect(fm.description).toBeDefined();
    expect(fm.description!).toMatch(/CI|失败|诊断|fix/i);
  });

  test("when-to-use 含触发条件描述(>= 20 字)", () => {
    expect(fm["when-to-use"]).toBeDefined();
    expect(fm["when-to-use"]!.length).toBeGreaterThan(20);
  });

  test("mode = delegate(子代理执行)", () => {
    expect(fm.mode).toBe("delegate");
  });

  test("allowed-tools 含 read / grep / glob / bash, 不含 edit / write(RL-001 守护)", () => {
    expect(fm["allowed-tools"]).toBeDefined();
    const tools = (fm["allowed-tools"] as string).split(",").map((s) => s.trim());
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  test("max-turns 在 20..35 范围(诊断类需足够步骤排查)", () => {
    expect(fm["max-turns"]).toBeGreaterThanOrEqual(20);
    expect(fm["max-turns"]).toBeLessThanOrEqual(35);
  });

  test("timeout-mins 与 SLA P95 一致", () => {
    const sla = fm.sla!;
    expect(sla.p95_ms).toBeDefined();
    expect(fm["timeout-mins"]).toBe(Math.floor(sla.p95_ms! / 60_000));
  });

  test("sla 段含 4 个字段, 比 code-review 紧 ~10×", () => {
    const sla = fm.sla!;
    expect(sla.p50_ms).toBeGreaterThan(0);
    expect(sla.p95_ms).toBeGreaterThan(sla.p50_ms!);
    expect(sla.token_cost_usd).toBeGreaterThan(0);
    expect(sla.failure_policy).toBe("degrade");
    // 诊断类 SLA 较紧: P95 < 120s
    expect(sla.p95_ms!).toBeLessThanOrEqual(120_000);
  });

  test("release_metadata 含 baseline_before / baseline_after / graduated_at(Step 8 填)", () => {
    expect(fm.release_metadata).toBeDefined();
    const rm = fm.release_metadata!;
    expect("baseline_before" in rm).toBe(true);
    expect("baseline_after" in rm).toBe(true);
    expect("graduated_at" in rm).toBe(true);
  });

  test("release_metadata.status = released (Step 8 完成)", () => {
    expect(fm.release_metadata!.status).toBe("released");
  });
});

describe("ci-self-heal Skill - 红线 / 反例守护契约(SKILL.md body)", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { body } = parseFrontmatter(markdown);

  test("body 明确禁止调用 edit / write(RL-001 不删用户代码)", () => {
    expect(body).toMatch(/RL-001/);
    expect(body).toMatch(/不删除用户代码|不调用 edit|不修改文件/);
  });

  test("body 含 RL-002 redact 守护(CI log 含 token / API key)", () => {
    expect(body).toMatch(/RL-002/);
    expect(body).toMatch(/redact|REDACTED|凭证/);
  });

  test("body 含 RL-007 不编造问题(file:line / log line 引用要求)", () => {
    expect(body).toMatch(/RL-007|file:line|log line|引用具体|具体行号/);
  });

  test("body 含 SLA / failure policy 段", () => {
    expect(body).toMatch(/SLA|失败策略|failure_policy/);
  });

  test("body 含 Known Limitations 段", () => {
    expect(body).toMatch(/Known Limitations|已知限制/);
  });

  test("body 含中文一等公民约束(zh_001~005 联动)", () => {
    expect(body).toMatch(/中文|chinese/i);
  });

  test("body 明确不阻断 PR(advisory only)", () => {
    expect(body).toMatch(/advisory|不阻断|degrade/);
  });
});

describe("ci-self-heal Skill - SkillLoader 集成(无 LLM 调用)", () => {
  test("SkillManager.discover 把 ci-self-heal 标为 builtin(ADR-025 修复后)", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const skills = manager.getAllSkills();
    const csh = skills.find((s) => s.name === "ci-self-heal");
    expect(csh).toBeDefined();
    expect(csh!.isBuiltin).toBe(true);
    expect(csh!.source).toBe("builtin");
    expect(csh!.mode).toBe("delegate");
    expect(csh!.allowedTools).toContain("read");
    expect(csh!.allowedTools).not.toContain("edit");
  });

  test("ci-self-heal 与 code-review 共存, 不冲突", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const all = manager.getAllSkills();
    const cr = all.find((s) => s.name === "code-review");
    const csh = all.find((s) => s.name === "ci-self-heal");
    expect(cr).toBeDefined();
    expect(csh).toBeDefined();
    expect(cr!.filePath).not.toBe(csh!.filePath);
  });
});

describe("ci-self-heal scripts/parse-ci-log.ts - 解析契约", () => {
  test("解析 jest 失败 log: runner=jest + 抽取 stack trace + assertion", () => {
    const log = `Error: TypeError: Cannot read properties of undefined
    at Object.<anonymous> (src/foo.ts:42:10)
PASS  src/bar.test.ts
FAIL  src/foo.test.ts
  ✗ should work
    Expected: 1
    Received: 2
Tests:       1 failed, 5 passed`;
    const result = parseCILog(log);
    expect(result.runner).toBe("jest");
    expect(result.stackTraces.length).toBeGreaterThanOrEqual(1);
    expect(result.failedAssertions.length).toBeGreaterThanOrEqual(1);
    expect(result.failedAssertions[0].expected).toBe("1");
    expect(result.failedAssertions[0].actual).toBe("2");
  });

  test("解析 tsc 失败 log: runner=tsc + 抽取 file:line", () => {
    const log = `error TS2305: Module "../foo.ts" has no exported member "Bar".
src/baz.ts:10:5
error TS2322: Type "string" is not assignable to type "number".
src/baz.ts:20:10`;
    const result = parseCILog(log);
    expect(result.runner).toBe("tsc");
    expect(result.fileRefs.length).toBeGreaterThanOrEqual(2);
    expect(result.fileRefs.some((r) => r.file === "src/baz.ts" && r.line === 10)).toBe(true);
    expect(result.fileRefs.some((r) => r.file === "src/baz.ts" && r.line === 20)).toBe(true);
  });

  test("解析 pytest 失败 log: 抽取 File line 引用", () => {
    const log = `=========== FAILURES ===========
______ test_foo ______
File "tests/test_foo.py", line 42, in test_foo
    assert result == expected
E   assert 1 == 2`;
    const result = parseCILog(log);
    expect(result.runner).toBe("pytest");
    expect(result.fileRefs.some((r) => r.file === "tests/test_foo.py" && r.line === 42)).toBe(true);
  });

  test("检测 retry markers(flaky 信号)", () => {
    const log = `✗ test_async_eventually 1.5s (retry 1)
ECONNREFUSED 127.0.0.1:8080
✓ test_async_eventually (retry 2)`;
    const result = parseCILog(log);
    expect(result.hasRetryMarkers).toBe(true);
  });

  test("空 log 不报错, 返回 unknown runner", () => {
    const result = parseCILog("");
    expect(result.runner).toBe("unknown");
    expect(result.stackTraces.length).toBe(0);
    expect(result.fileRefs.length).toBe(0);
  });
});

describe("ci-self-heal scripts/classify-failure.ts - 分类契约", () => {
  test("jest 测试失败 → test_failure 主因 + type_error 次因", () => {
    const log = `Error: TypeError: Cannot read properties of undefined
    at Object.<anonymous> (src/foo.ts:42:10)
FAIL  src/foo.test.ts
  ✗ should work
    Expected: 1
    Received: 2
Tests:       1 failed, 5 passed`;
    const parsed = parseCILog(log);
    const result = classifyFailure(parsed);
    expect(result.class).toBe("test_failure");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    // 次类应含 type_error(因为 TypeError 关键字命中)
    const altClasses = result.candidate_alternatives.map((a) => a.class);
    expect(altClasses).toContain("type_error");
  });

  test("tsc 类型错误 → type_error", () => {
    const log = `error TS2305: Module "../foo.ts" has no exported member "Bar".
src/baz.ts:10:5
error TS2322: Type "string" is not assignable to type "number".
src/baz.ts:20:10`;
    const parsed = parseCILog(log);
    const result = classifyFailure(parsed);
    expect(result.class).toBe("type_error");
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test("retry + ECONNREFUSED → flaky", () => {
    const log = `✗ test_async_eventually 1.5s (retry 1)
ECONNREFUSED 127.0.0.1:8080
✓ test_async_eventually (retry 2)`;
    const parsed = parseCILog(log);
    const result = classifyFailure(parsed);
    expect(result.class).toBe("flaky");
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.signals.some((s) => s.includes("retry"))).toBe(true);
  });

  test("Module not found → dependency_missing", () => {
    const log = `Error: Cannot find module 'lodash'
    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1234:5)
Module not found: 'react-dom/client'`;
    const parsed = parseCILog(log);
    const result = classifyFailure(parsed);
    expect(result.class).toBe("dependency_missing");
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test("空 log → unknown 兜底", () => {
    const parsed = parseCILog("");
    const result = classifyFailure(parsed);
    expect(result.class).toBe("unknown");
    expect(result.confidence).toBe(0.0);
  });

  test("confidence 上限 0.95(留 0.05 给 LLM 修正)", () => {
    // 制造多信号叠加的极端 log: jest + 多 assertion + assertion keyword
    const log = `FAIL  src/foo.test.ts
  ✗ test_a
    expect(actual).toBe(expected)
    Expected: 1
    Received: 2
  ✗ test_b
    expect(x).toEqual(y)
    Expected: "a"
    Received: "b"
  ✗ test_c
    Expected: true
    Received: false
Tests:       3 failed, 5 passed
at Object.<anonymous> (src/foo.ts:42:10)
jest.fn`;
    const parsed = parseCILog(log);
    const result = classifyFailure(parsed);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });
});

describe("ci-self-heal scripts/fix-suggestion-templates.ts - 模板契约 (S6-T10)", () => {
  test("test_failure 模板返回 ≤ 3 条建议 + 第一条含'复现'关键词", () => {
    const log = `FAIL  src/foo.test.ts
  ✗ test_a
    expect(actual).toBe(expected)
    Expected: 1
    Received: 2
Tests:       1 failed`;
    const parsed = parseCILog(log);
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed, maxSuggestions: 3 });
    expect(result.class).toBe("test_failure");
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].title).toContain("复现");
  });

  test("confidence 梯度衰减 (第 N 条比第 N-1 条低 0.08)", () => {
    const parsed = parseCILog("FAIL  src/foo.test.ts\n  ✗ a\nTests: 1 failed");
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed, maxSuggestions: 3 });
    if (result.suggestions.length >= 2) {
      const diff = result.suggestions[0].confidence - result.suggestions[1].confidence;
      expect(diff).toBeCloseTo(0.08, 2);
    }
  });

  test("references 取自 parse-ci-log fileRefs 前 5 个", () => {
    const log = `FAIL src/a.test.ts
    expect().toBe()
at fn (src/a.ts:10:5)
at fn (src/b.ts:20:3)
at fn (src/c.ts:30:1)`;
    const parsed = parseCILog(log);
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed });
    expect(Array.isArray(result.suggestions[0].references)).toBe(true);
    expect(result.suggestions[0].references.length).toBeGreaterThan(0);
    expect(result.suggestions[0].references.length).toBeLessThanOrEqual(5);
  });

  test("flaky 模板含 'retry' 或 '重跑' 关键词", () => {
    const log = `attempt 2 of 3: connection ECONNREFUSED 127.0.0.1:5432
  retry 1
  retry 2`;
    const parsed = parseCILog(log);
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed });
    expect(result.class).toBe("flaky");
    const titles = result.suggestions.map((s) => s.title).join(" ");
    expect(/retry|重跑/.test(titles)).toBe(true);
  });

  test("unknown 类返回 escalation (建议人介入)", () => {
    const parsed = parseCILog(""); // 空 log → unknown
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify });
    expect(result.class).toBe("unknown");
    // unknown 模板第一条本身就是"建议人介入"
    expect(result.suggestions[0].title).toContain("人介入");
  });

  test("所有 confidence < 0.5 时 escalation 非 null", () => {
    // 手工构造一个低 confidence 的 classify
    const result = generateFixSuggestions({
      classify: {
        class: "lint_failure",
        confidence: 0.3,
        signals: [],
        candidate_alternatives: [],
      },
    });
    // 0.3 - 0.1 (基线衰减) = 0.2 → 第一条 0.2, 后续更低 → 全部 < 0.5
    expect(result.escalation).not.toBeNull();
    expect(result.escalation).toContain("人工介入");
  });

  test("candidate_alternatives 非空且 maxSuggestions 留有余地时, 备选建议被加入", () => {
    const result = generateFixSuggestions({
      classify: {
        class: "test_failure",
        confidence: 0.7,
        signals: [],
        candidate_alternatives: [{ class: "type_error", confidence: 0.5, reason: "tsc traces" }],
      },
      maxSuggestions: 5, // 给备选留位置
    });
    // test_failure 基线 3 条 + 备选 1 条 = 4
    const altMatch = result.suggestions.find((s) => s.title.startsWith("[备选: type_error]"));
    expect(altMatch).toBeDefined();
  });

  test("RL-001 / RL-006 守护: 模板永远不出现 edit/write 工具调用建议", () => {
    const classes: Array<
      | "test_failure"
      | "lint_failure"
      | "build_failure"
      | "type_error"
      | "dependency_missing"
      | "config_error"
      | "flaky"
      | "timeout"
      | "unknown"
    > = [
      "test_failure",
      "lint_failure",
      "build_failure",
      "type_error",
      "dependency_missing",
      "config_error",
      "flaky",
      "timeout",
      "unknown",
    ];
    for (const cls of classes) {
      const result = generateFixSuggestions({
        classify: { class: cls, confidence: 0.8, signals: [], candidate_alternatives: [] },
        maxSuggestions: 3,
      });
      const allText = result.suggestions
        .map((s) => `${s.title} ${s.command_or_action} ${s.why}`)
        .join(" ");
      // 不应直接给"用 edit 工具改 src/X.ts 第 N 行"这种 imperative 建议
      expect(allText).not.toMatch(/\b调用\s*edit\b|\b调用\s*write\b/);
    }
  });

  test("maxSuggestions=1 时只返回 1 条", () => {
    const parsed = parseCILog("FAIL src/a.test.ts\n  ✗ a");
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed, maxSuggestions: 1 });
    expect(result.suggestions.length).toBe(1);
  });

  test("maxSuggestions ≤ 0 也至少返回 1 条 (lower bound)", () => {
    const parsed = parseCILog("FAIL src/a.test.ts");
    const classify = classifyFailure(parsed);
    const result = generateFixSuggestions({ classify, parsed, maxSuggestions: 0 });
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });
});
