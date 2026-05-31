/**
 * incident-rca Skill 集成测试 + 契约测试 (S7-T16 Step 3 TDD)
 *
 * 验证 SKILL.md frontmatter 解析 / 加载 / 工具白名单 / case yaml 契约.
 * 纯结构验证 + Mock, 不调 LLM.
 *
 * RFC: docs/rfcs/RFC-004-incident-rca-skill.md
 * 三轴螺旋 Step 3 TDD (S7-T16)
 *
 * 关键差异 (vs security-audit.test.ts):
 *   - failure_policy = degrade (RCA 不阻断业务) 而非 block
 *   - 红线守护加 RL-007 (不编造) 为最重要不变量
 *   - 输出契约段名 Top Hypotheses / Suggested Actions / Monitoring Gaps
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { SkillManager } from "../../src/skill/manager.ts";

const SKILL_DIR = join(import.meta.dir, "..", "..", "src", "skill", "builtin", "incident-rca");
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

describe("incident-rca Skill - 文件结构契约", () => {
  test("SKILL.md 存在", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
  });

  test("evals/ 目录就位", () => {
    expect(statSync(join(SKILL_DIR, "evals")).isDirectory()).toBe(true);
  });

  test("references/ 目录就位 (output-template + evidence-collection-guide)", () => {
    expect(statSync(join(SKILL_DIR, "references")).isDirectory()).toBe(true);
    expect(existsSync(join(SKILL_DIR, "references", "output-template.md"))).toBe(true);
    expect(existsSync(join(SKILL_DIR, "references", "evidence-collection-guide.md"))).toBe(true);
  });

  test("evals/ 含 ≥ 10 条 case_inc_*.yaml", () => {
    const cases = readdirSync(join(SKILL_DIR, "evals")).filter(
      (f) => f.startsWith("case_inc_") && f.endsWith(".yaml"),
    );
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  test("RFC-004 落盘", () => {
    const rfcPath = join(import.meta.dir, "..", "..", "docs", "rfcs", "RFC-004-incident-rca-skill.md");
    expect(existsSync(rfcPath)).toBe(true);
  });

  test("runner scripts/eval/run-incident-rca-skill.ts 落盘", () => {
    const runner = join(import.meta.dir, "..", "..", "scripts", "eval", "run-incident-rca-skill.ts");
    expect(existsSync(runner)).toBe(true);
  });
});

describe("incident-rca Skill - SKILL.md frontmatter 契约", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { fm } = parseFrontmatter(markdown);

  test("name = incident-rca", () => {
    expect(fm.name).toBe("incident-rca");
  });

  test("description 含 incident / RCA / 根因 / 故障 关键字", () => {
    expect(fm.description).toBeDefined();
    expect(fm.description!).toMatch(/incident|RCA|根因|故障/i);
  });

  test("when-to-use 含触发条件描述 (>= 20 字)", () => {
    expect(fm["when-to-use"]).toBeDefined();
    expect(fm["when-to-use"]!.length).toBeGreaterThan(20);
  });

  test("mode = delegate (子代理执行 / 推理链长 / 输入维度多)", () => {
    expect(fm.mode).toBe("delegate");
  });

  test("allowed-tools 含 read / grep / glob / bash, 不含 edit / write (RL-001 守护)", () => {
    expect(fm["allowed-tools"]).toBeDefined();
    const tools = fm["allowed-tools"]!.split(/[,\s]+/).filter(Boolean);
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  test("max-turns 在 20..30 范围 (RCA 推理链长)", () => {
    expect(fm["max-turns"]).toBeGreaterThanOrEqual(20);
    expect(fm["max-turns"]).toBeLessThanOrEqual(30);
  });

  test("timeout-mins 与 SLA P95 一致 (3 分钟 = 180s)", () => {
    expect(fm["timeout-mins"]).toBe(3);
    expect(fm.sla?.p95_ms).toBe(180000);
  });

  test("sla 段含 4 个字段 + failure_policy=degrade (RCA 不阻断业务)", () => {
    expect(fm.sla).toBeDefined();
    expect(fm.sla!.p50_ms).toBe(60000);
    expect(fm.sla!.p95_ms).toBe(180000);
    expect(fm.sla!.token_cost_usd).toBeDefined();
    // 关键: RCA 是辅助诊断,不阻断业务,degrade
    expect(fm.sla!.failure_policy).toBe("degrade");
  });

  test("release_metadata 含 baseline_before / baseline_after / graduated_at (Step 8 填)", () => {
    expect(fm.release_metadata).toBeDefined();
    expect("baseline_before" in fm.release_metadata!).toBe(true);
    expect("baseline_after" in fm.release_metadata!).toBe(true);
    expect("graduated_at" in fm.release_metadata!).toBe(true);
  });

  test("release_metadata.status = released (Step 8 完成)", () => {
    expect((fm.release_metadata as Record<string, string>).status).toBe("released");
  });

  test("release_metadata.spiral_step = 8 (Step 8 发布完成)", () => {
    expect((fm.release_metadata as Record<string, number>).spiral_step).toBe(8);
  });

  test("release_metadata.redline_protection 含 RL-007 (RCA 最重要不变量) + RL-001/002", () => {
    const rl = (fm.release_metadata as Record<string, unknown>).redline_protection as string[];
    expect(rl).toContain("RL-001");
    expect(rl).toContain("RL-002");
    expect(rl).toContain("RL-007");
  });

  test("release_metadata.rfc 指向 RFC-004", () => {
    const rfc = (fm.release_metadata as Record<string, string>).rfc;
    expect(rfc).toContain("RFC-004");
  });
});

describe("incident-rca Skill - 红线 / 反例守护契约 (SKILL.md body)", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { body } = parseFrontmatter(markdown);
  const bodyLower = body.toLowerCase();

  test("body 明确禁止调用 edit / write (RL-001 不删用户代码)", () => {
    expect(/不删除|不删|RL-001/i.test(body)).toBe(true);
  });

  test("body 含 RL-002 redact 守护 (引用日志含 token / API key)", () => {
    expect(/RL-002|redact|脱敏/i.test(body)).toBe(true);
  });

  test("body 含 RL-007 不编造问题 (Evidence / 证据引用要求)", () => {
    expect(/RL-007|不编造/i.test(body)).toBe(true);
    expect(/evidence|证据/i.test(body)).toBe(true);
  });

  test("body 含 RL-008 Skill 不自演化", () => {
    expect(/RL-008|不自演化|不修改自己/i.test(body)).toBe(true);
  });

  test("body 含 SLA / failure_policy=degrade 段", () => {
    expect(bodyLower).toContain("failure_policy");
    expect(/degrade/i.test(body)).toBe(true);
  });

  test("body 含 Known Limitations 段", () => {
    expect(bodyLower).toContain("known limitations");
  });

  test("body 含中文一等公民约束 (中文输入用中文输出)", () => {
    expect(/中文/i.test(body)).toBe(true);
  });

  test("body 含 Top Hypotheses 输出契约段 + ≤ 3 条假设硬约束", () => {
    expect(/top hypothes/i.test(body)).toBe(true);
    expect(/≤\s*3|≤ 3|不超过.*3|最多.*3/i.test(body)).toBe(true);
  });

  test("body 含 5 维度证据收集顺序 (log_pattern / metric_anomaly / trace_correlation / rca_hypothesis / fix_priority)", () => {
    const dimensions = ["log_pattern", "metric_anomaly", "trace_correlation", "rca_hypothesis", "fix_priority"];
    for (const dim of dimensions) {
      expect(bodyLower).toContain(dim);
    }
  });

  test("body 含三档行动 Suggested Actions (hotfix / mitigation / long-term)", () => {
    expect(/hotfix/i.test(body)).toBe(true);
    expect(/mitigation/i.test(body)).toBe(true);
    expect(/long-?term/i.test(body)).toBe(true);
  });

  test("body 含 §7.2 完全无法构造假设的回退模板", () => {
    expect(/skipped checks/i.test(body)).toBe(true);
    expect(/severity.*unknown|unknown.*confidence/i.test(body)).toBe(true);
  });

  test("body 含与其他 Skill 协同表 (输入域区分)", () => {
    // 与 ci-self-heal 输入域区分:CI log vs production observability
    expect(/ci-self-heal/i.test(body)).toBe(true);
    expect(/code-review/i.test(body)).toBe(true);
  });
});

describe("incident-rca Skill - SkillLoader 集成 (无 LLM 调用)", () => {
  test("SkillManager.discover 把 incident-rca 标为 builtin (ADR-025 修复后)", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const skills = manager.getAllSkills();
    const found = skills.find((s) => s.name === "incident-rca");
    expect(found).toBeDefined();
    expect(found!.isBuiltin).toBe(true);
    expect(found!.source).toBe("builtin");
    expect(found!.mode).toBe("delegate");
    expect(found!.allowedTools).toContain("read");
    expect(found!.allowedTools).not.toContain("edit");
    expect(found!.allowedTools).not.toContain("write");
  });

  test("incident-rca 与 4 个其他 builtin Skill 共存,不冲突", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const all = manager.getAllSkills();
    const inc = all.find((s) => s.name === "incident-rca");
    const sec = all.find((s) => s.name === "security-audit");
    const cr = all.find((s) => s.name === "code-review");
    const csh = all.find((s) => s.name === "ci-self-heal");
    const sk = all.find((s) => s.name === "skill-creator");
    expect(inc).toBeDefined();
    expect(sec).toBeDefined();
    expect(cr).toBeDefined();
    expect(csh).toBeDefined();
    expect(sk).toBeDefined();
    // 5 个 Skill 各自独立 SKILL.md
    const paths = [inc!.filePath, sec!.filePath, cr!.filePath, csh!.filePath, sk!.filePath];
    expect(new Set(paths).size).toBe(5);
  });
});

describe("incident-rca Skill - case yaml 契约校验 (S7-T15 落盘)", () => {
  const evalDir = join(SKILL_DIR, "evals");
  const cases = readdirSync(evalDir)
    .filter((f) => f.startsWith("case_inc_") && f.endsWith(".yaml"))
    .map((f) => ({
      file: f,
      content: loadYaml(readFileSync(join(evalDir, f), "utf-8")) as Record<string, unknown>,
    }));

  test("每条 case 含 id / category / priority / target_score / expected", () => {
    for (const { file, content } of cases) {
      expect(content.id, file).toBeDefined();
      expect(content.category, file).toBeDefined();
      expect(content.priority, file).toBeDefined();
      expect(content.target_score, file).toBeDefined();
      expect(content.expected, file).toBeDefined();
    }
  });

  test("每条 case must_not_call_tools 含 edit + write (RL-001 守护)", () => {
    for (const { file, content } of cases) {
      const expected = content.expected as Record<string, unknown>;
      const blockedTools = (expected.must_not_call_tools ?? []) as string[];
      expect(blockedTools, file).toContain("edit");
      expect(blockedTools, file).toContain("write");
    }
  });

  test("每条 case max_steps ≤ 25 (max-turns 守护)", () => {
    for (const { file, content } of cases) {
      const expected = content.expected as Record<string, unknown>;
      expect(expected.max_steps, file).toBeDefined();
      expect((expected.max_steps as number) <= 25, file).toBe(true);
    }
  });

  test("每条 case 含 must_include_any_of 与 must_not_include (双向断言)", () => {
    for (const { file, content } of cases) {
      const expected = content.expected as Record<string, unknown>;
      const mustInclude = expected.must_include_any_of as string[];
      const mustNot = expected.must_not_include as string[];
      expect(mustInclude, `${file} must_include_any_of`).toBeDefined();
      expect(mustInclude.length, `${file} must_include_any_of 长度`).toBeGreaterThan(0);
      expect(mustNot, `${file} must_not_include`).toBeDefined();
      expect(mustNot.length, `${file} must_not_include 长度`).toBeGreaterThan(0);
    }
  });

  test("覆盖 5 主维度 (log_pattern / metric_anomaly / trace_correlation / rca_hypothesis / fix_priority)", () => {
    const categories = cases.map(({ content }) => (content.category as string).toLowerCase());
    expect(categories.some((c) => c.includes("log_pattern"))).toBe(true);
    expect(categories.some((c) => c.includes("metric_anomaly"))).toBe(true);
    expect(categories.some((c) => c.includes("trace_correlation"))).toBe(true);
    expect(categories.some((c) => c.includes("rca_hypothesis") || c.includes("multi_hypothesis"))).toBe(true);
    expect(categories.some((c) => c.includes("fix_priority"))).toBe(true);
  });

  test("≥ 1 条 evidence_no_fabrication / RL-007 守护 case (最重要不变量)", () => {
    const fab = cases.filter(({ content }) => {
      const cat = (content.category as string).toLowerCase();
      return cat.includes("evidence_no_fabrication") || cat.includes("trigger_no_input");
    });
    expect(fab.length).toBeGreaterThanOrEqual(1);
  });

  test("case_inc_010 (evidence_no_fabrication) must_not_include 含具体编造结论守护", () => {
    const inc010 = cases.find((c) => c.file === "case_inc_010.yaml");
    expect(inc010, "case_inc_010.yaml 应存在").toBeDefined();
    const expected = inc010!.content.expected as Record<string, unknown>;
    const mustNot = (expected.must_not_include ?? []) as string[];
    // 必须显式禁止编造常见 RCA 结论
    expect(mustNot.some((kw) => /慢查询|GC|网络抖动|代码 bug|确定是|明显是/.test(kw))).toBe(true);
  });

  test("≥ 4 条 P0 case (核心场景覆盖)", () => {
    const p0 = cases.filter(({ content }) => (content.priority as string).toLowerCase() === "p0");
    expect(p0.length).toBeGreaterThanOrEqual(4);
  });

  test("每条 case skill 字段为 incident-rca", () => {
    for (const { file, content } of cases) {
      expect(content.skill, file).toBe("incident-rca");
    }
  });
});

describe("incident-rca Skill - references 内容契约", () => {
  test("output-template.md 含模板字段 (Severity / Top Hypotheses / Suggested Actions)", () => {
    const tmpl = readFileSync(join(SKILL_DIR, "references", "output-template.md"), "utf-8");
    expect(tmpl).toContain("Severity");
    expect(tmpl).toContain("Top Hypotheses");
    expect(tmpl).toContain("Suggested Actions");
    expect(tmpl).toContain("Monitoring Gaps");
    expect(tmpl).toContain("Skipped Checks");
  });

  test("evidence-collection-guide.md 含 5 维度顺序 + ci-self-heal 差异表", () => {
    const guide = readFileSync(join(SKILL_DIR, "references", "evidence-collection-guide.md"), "utf-8");
    expect(guide).toContain("log_pattern");
    expect(guide).toContain("metric_anomaly");
    expect(guide).toContain("trace_correlation");
    expect(guide).toContain("rca_hypothesis");
    expect(guide).toContain("fix_priority");
    expect(guide).toContain("ci-self-heal");
  });
});
