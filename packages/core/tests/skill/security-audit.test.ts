/**
 * security-audit Skill 集成测试 + 契约测试 (S6-T16 Step 3 TDD)
 *
 * 验证 SKILL.md frontmatter 解析 / 加载 / 工具白名单 / scripts 目录结构.
 * 纯结构验证 + Mock, 不调 LLM.
 *
 * RFC: docs/rfcs/RFC-003-security-audit-skill.md
 * 三轴螺旋 Step 3 TDD (S6-T16)
 *
 * 关键差异 (vs ci-self-heal.test.ts):
 *   - failure_policy = block (合规类) 而非 degrade
 *   - 红线守护加 RL-002 (secret redact) / RL-005 (跨租户)
 *   - 输出契约段名 Audit Verdict / Severity Counts (vs Failure Class)
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { SkillManager } from "@sid-code/core/skill/manager.ts";

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
  "security-audit",
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

describe("security-audit Skill - 文件结构契约", () => {
  test("SKILL.md 存在", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
  });

  test("evals/ 目录就位 (其余 scripts/references/validations Step 4 实施)", () => {
    expect(statSync(join(SKILL_DIR, "evals")).isDirectory()).toBe(true);
  });

  test("evals/ 含 ≥ 10 条 case_sec_*.yaml", () => {
    const cases = readdirSync(join(SKILL_DIR, "evals")).filter(
      (f) => f.startsWith("case_sec_") && f.endsWith(".yaml"),
    );
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  test("runner scripts/eval/run-security-audit-skill.ts 落盘", () => {
    const runner = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "scripts",
      "eval",
      "run-security-audit-skill.ts",
    );
    expect(existsSync(runner)).toBe(true);
  });
});

describe("security-audit Skill - SKILL.md frontmatter 契约", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { fm } = parseFrontmatter(markdown);

  test("name = security-audit", () => {
    expect(fm.name).toBe("security-audit");
  });

  test("description 含 安全 / security / 漏洞 / audit 关键字", () => {
    expect(fm.description).toBeDefined();
    expect(fm.description!).toMatch(/安全|security|漏洞|audit/i);
  });

  test("when-to-use 含触发条件描述 (>= 20 字)", () => {
    expect(fm["when-to-use"]).toBeDefined();
    expect(fm["when-to-use"]!.length).toBeGreaterThan(20);
  });

  test("mode = delegate (子代理执行)", () => {
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

  test("max-turns 在 20..30 范围 (合规类比诊断类略宽)", () => {
    expect(fm["max-turns"]).toBeGreaterThanOrEqual(20);
    expect(fm["max-turns"]).toBeLessThanOrEqual(30);
  });

  test("timeout-mins 与 SLA P95 一致 (3 分钟 = 180s)", () => {
    expect(fm["timeout-mins"]).toBe(3);
    expect(fm.sla?.p95_ms).toBe(180000);
  });

  test("sla 段含 4 个字段 + failure_policy=block (合规一票否决)", () => {
    expect(fm.sla).toBeDefined();
    expect(fm.sla!.p50_ms).toBe(60000);
    expect(fm.sla!.p95_ms).toBe(180000);
    expect(fm.sla!.token_cost_usd).toBeDefined();
    // 关键: 合规类 = block, 不是 degrade
    expect(fm.sla!.failure_policy).toBe("block");
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

  test("release_metadata.redline_protection 含 RL-002 / RL-005 (security 专属红线)", () => {
    const rl = (fm.release_metadata as Record<string, unknown>).redline_protection as string[];
    expect(rl).toContain("RL-002");
    expect(rl).toContain("RL-005");
  });
});

describe("security-audit Skill - 红线 / 反例守护契约 (SKILL.md body)", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { body } = parseFrontmatter(markdown);
  const bodyLower = body.toLowerCase();

  test("body 明确禁止调用 edit / write (RL-001 不删用户代码)", () => {
    expect(/不删除|RL-001/i.test(body)).toBe(true);
    expect(/不含\s*edit|不调用.*edit/i.test(body) || bodyLower.includes("不能调它们")).toBe(true);
  });

  test("body 含 RL-002 redact 守护 (PR diff 含 token / API key)", () => {
    expect(/RL-002|redact/i.test(body)).toBe(true);
  });

  test("body 含 RL-005 跨租户隔离守护", () => {
    expect(/RL-005|跨租户|当前.*PR/i.test(body)).toBe(true);
  });

  test("body 含 RL-007 不编造问题 (file:line / Evidence 引用要求)", () => {
    expect(/RL-007|不编造|Evidence/i.test(body)).toBe(true);
  });

  test("body 含 SLA / failure_policy=block 段", () => {
    expect(bodyLower).toContain("failure_policy");
    expect(/block/i.test(body)).toBe(true);
  });

  test("body 含 Known Limitations 段", () => {
    expect(bodyLower).toContain("known limitations");
  });

  test("body 含中文一等公民约束 (zh_001~005 联动)", () => {
    expect(/中文/i.test(body)).toBe(true);
  });

  test("body 含 Audit Verdict 输出契约段 (3 档: pass/warn/block)", () => {
    expect(/audit verdict|verdict/i.test(body)).toBe(true);
    expect(
      /pass.*warn.*block|block.*warn.*pass/i.test(body) ||
        (/pass/i.test(body) && /warn/i.test(body) && /block/i.test(body)),
    ).toBe(true);
  });

  test("body 含 8 类漏洞类别 (RFC-003 §2.2 输出契约)", () => {
    const categories = [
      "injection",
      "secret_leak",
      "xss",
      "auth_bypass",
      "crypto_weak",
      "cve_dependency",
      "iac_misconfig",
      "data_leak",
    ];
    for (const cat of categories) {
      expect(bodyLower).toContain(cat);
    }
  });

  test("body 含与 ADR-026 secret-redact hook 联动声明", () => {
    expect(/ADR-026|secret-redact|hook/i.test(body)).toBe(true);
  });
});

describe("security-audit Skill - SkillLoader 集成 (无 LLM 调用)", () => {
  test("SkillManager.discover 把 security-audit 标为 builtin (ADR-025 修复后)", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const skills = manager.getAllSkills();
    const found = skills.find((s) => s.name === "security-audit");
    expect(found).toBeDefined();
    expect(found!.isBuiltin).toBe(true);
    expect(found!.source).toBe("builtin");
    expect(found!.mode).toBe("delegate");
    expect(found!.allowedTools).toContain("read");
    expect(found!.allowedTools).not.toContain("edit");
    expect(found!.allowedTools).not.toContain("write");
  });

  test("security-audit 与 code-review / ci-self-heal 共存, 不冲突", async () => {
    const manager = new SkillManager();
    await manager.discover();
    const all = manager.getAllSkills();
    const sec = all.find((s) => s.name === "security-audit");
    const cr = all.find((s) => s.name === "code-review");
    const csh = all.find((s) => s.name === "ci-self-heal");
    expect(sec).toBeDefined();
    expect(cr).toBeDefined();
    expect(csh).toBeDefined();
    // 三个 Skill 必须各自独立 SKILL.md
    expect(sec!.filePath).not.toBe(cr!.filePath);
    expect(sec!.filePath).not.toBe(csh!.filePath);
    expect(cr!.filePath).not.toBe(csh!.filePath);
  });
});

describe("security-audit Skill - case yaml 契约校验 (S6-T15 落盘)", () => {
  const evalDir = join(SKILL_DIR, "evals");
  const cases = readdirSync(evalDir)
    .filter((f) => f.startsWith("case_sec_") && f.endsWith(".yaml"))
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

  test("覆盖 6 类核心维度 (vulnerability_detection / false_positive / cve_lookup / sca_dependency / iac_misconfig / secret_leak)", () => {
    const categories = cases.map(({ content }) => (content.category as string).toLowerCase());
    expect(categories.some((c) => c.includes("vulnerability_detection"))).toBe(true);
    expect(categories.some((c) => c.includes("false_positive"))).toBe(true);
    expect(categories.some((c) => c.includes("cve_lookup"))).toBe(true);
    expect(categories.some((c) => c.includes("sca_dependency"))).toBe(true);
    expect(categories.some((c) => c.includes("iac_misconfig"))).toBe(true);
    expect(categories.some((c) => c.includes("secret_leak"))).toBe(true);
  });

  test("case_sec_010 (secret_leak) must_not_include 含原始 token 字面值 (RL-002 输出守护)", () => {
    const sec010 = cases.find((c) => c.file === "case_sec_010.yaml");
    expect(sec010, "case_sec_010.yaml 应存在").toBeDefined();
    const expected = sec010!.content.expected as Record<string, unknown>;
    const mustNot = (expected.must_not_include ?? []) as string[];
    // 必须显式禁止输出原始 ghp_ 开头 token
    expect(mustNot.some((kw) => kw.startsWith("ghp_"))).toBe(true);
  });

  test("≥ 1 条 P0 vulnerability_detection_injection case (核心场景)", () => {
    const p0Inj = cases.filter(({ content }) => {
      const cat = (content.category as string).toLowerCase();
      const pri = (content.priority as string).toLowerCase();
      return cat.includes("injection") && pri === "p0";
    });
    expect(p0Inj.length).toBeGreaterThanOrEqual(1);
  });
});
