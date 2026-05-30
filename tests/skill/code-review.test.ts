/**
 * code-review Skill 集成测试 + 契约测试
 *
 * 验证 SKILL.md frontmatter 解析 / 加载 / 工具白名单 / 资源目录结构
 * 纯结构验证 + Mock，不调 LLM。
 *
 * RFC: docs/rfcs/RFC-001-code-review-skill.md
 * 三轴螺旋 Step 3 TDD
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { SkillLoader } from "../../src/skill/loader.ts";
import { ExtensionLoader } from "../../src/extension/loader.ts";

const SKILL_DIR = join(import.meta.dir, "..", "..", "src", "skill", "builtin", "code-review");
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

describe("code-review Skill - 文件结构契约", () => {
  test("SKILL.md 存在", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
  });

  test("scripts/ validations/ references/ evals/ 四件套目录就位", () => {
    expect(statSync(join(SKILL_DIR, "scripts")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "validations")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "references")).isDirectory()).toBe(true);
    expect(statSync(join(SKILL_DIR, "evals")).isDirectory()).toBe(true);
  });

  test("evals/ 含至少 10 条 baseline case", () => {
    const files = readdirSync(join(SKILL_DIR, "evals")).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(10);
  });
});

describe("code-review Skill - SKILL.md frontmatter 契约", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { fm } = parseFrontmatter(markdown);

  test("name = code-review", () => {
    expect(fm.name).toBe("code-review");
  });

  test("description 非空且包含 PR / review", () => {
    expect(fm.description).toBeDefined();
    expect(fm.description?.toLowerCase()).toMatch(/(pr|review|code)/);
  });

  test("when-to-use 描述触发条件", () => {
    expect(fm["when-to-use"]).toBeDefined();
    expect(fm["when-to-use"]!.length).toBeGreaterThan(10);
  });

  test("mode = delegate", () => {
    expect(fm.mode).toBe("delegate");
  });

  test("allowed-tools 含 read / grep / glob / bash，不含 edit / write", () => {
    expect(fm["allowed-tools"]).toBeDefined();
    const tools = (fm["allowed-tools"] as string).split(",").map((s) => s.trim());
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  test("max-turns 在 10..30 范围", () => {
    expect(fm["max-turns"]).toBeGreaterThanOrEqual(10);
    expect(fm["max-turns"]).toBeLessThanOrEqual(30);
  });

  test("timeout-mins 与 SLA P95 一致（minutes 与 ms 一致）", () => {
    const sla = fm.sla!;
    expect(sla.p95_ms).toBeDefined();
    expect(fm["timeout-mins"]).toBe(Math.floor(sla.p95_ms! / 60_000));
  });

  test("sla 段含 4 个字段", () => {
    const sla = fm.sla!;
    expect(sla.p50_ms).toBeGreaterThan(0);
    expect(sla.p95_ms).toBeGreaterThan(sla.p50_ms!);
    expect(sla.token_cost_usd).toBeGreaterThan(0);
    expect(sla.failure_policy).toBe("degrade");
  });

  test("release_metadata 含 baseline_before / baseline_after / graduated_at（Step 8 填）", () => {
    expect(fm.release_metadata).toBeDefined();
    const rm = fm.release_metadata!;
    expect("baseline_before" in rm).toBe(true);
    expect("baseline_after" in rm).toBe(true);
    expect("graduated_at" in rm).toBe(true);
  });
});

describe("code-review Skill - 红线 / 反例守护契约（SKILL.md body）", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { body } = parseFrontmatter(markdown);

  test("body 明确禁止调用 edit / write（不删用户代码 RL-001）", () => {
    expect(body).toMatch(/RL-001/);
    expect(body).toMatch(/不删除用户代码|不调用 edit|不修改/);
  });

  test("body 含 RL-007 不编造问题守护（file:line 引用要求）", () => {
    expect(body).toMatch(/RL-007|file:line|引用具体|具体行号/);
  });

  test("body 含 SLA / failure policy 段", () => {
    expect(body).toMatch(/SLA|失败策略|failure_policy/);
  });

  test("body 含 Known Limitations 段", () => {
    expect(body).toMatch(/Known Limitations|已知限制/);
  });

  test("body 含中文一等公民约束（zh_001~005 联动）", () => {
    expect(body).toMatch(/中文|chinese/i);
  });
});

describe("code-review Skill - baseline case yaml 结构契约", () => {
  const evalsDir = join(SKILL_DIR, "evals");
  const caseFiles = readdirSync(evalsDir).filter((f) => /^case_cr_\d{3}\.yaml$/.test(f));

  test("命名规则：case_cr_NNN.yaml", () => {
    expect(caseFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of caseFiles) {
    describe(file, () => {
      const yaml = loadYaml(readFileSync(join(evalsDir, file), "utf-8")) as Record<string, unknown>;

      test("含 id 字段", () => {
        expect(yaml.id).toBe(file.replace(/\.yaml$/, ""));
      });

      test("含 category 字段（code-review 系列）", () => {
        expect(typeof yaml.category).toBe("string");
        expect(yaml.category as string).toMatch(/code-review/);
      });

      test("含 input.user_query", () => {
        const input = yaml.input as Record<string, unknown>;
        expect(typeof input.user_query).toBe("string");
        expect((input.user_query as string).length).toBeGreaterThan(20);
      });

      test("含 expected 段 + must_not_include 反例字段（_template.yaml 强制）", () => {
        const expected = yaml.expected as Record<string, unknown>;
        expect(Array.isArray(expected.must_not_include)).toBe(true);
      });

      test("must_not_call_tools 含 edit / write（review 类 Skill 不修改文件）", () => {
        const expected = yaml.expected as Record<string, unknown>;
        const blocked = (expected.must_not_call_tools as string[]) || [];
        expect(blocked).toContain("edit");
        expect(blocked).toContain("write");
      });

      test("含 skill: code-review 字段", () => {
        expect(yaml.skill).toBe("code-review");
      });

      test("含 target_score 字段（baseline 阈值）", () => {
        expect(typeof yaml.target_score).toBe("number");
        expect(yaml.target_score as number).toBeGreaterThan(0);
      });
    });
  }
});

describe("code-review Skill - SkillLoader 集成（无 LLM 调用）", () => {
  // ADR-025 已修复（S5-T01）:builtinDir 选项让 ExtensionLoader 走 builtin 来源分支,
  // 直接扫 src/skill/builtin/<name>/SKILL.md,不再被当作 projectDir 处理。

  test("ADR-025: SkillManager.discover 把 code-review 标为 builtin（生产路径）", async () => {
    const { SkillManager } = await import("../../src/skill/manager.ts");
    const manager = new SkillManager();
    await manager.discover();
    const skills = manager.getAllSkills();
    const cr = skills.find((s) => s.name === "code-review");
    expect(cr).toBeDefined();
    expect(cr!.isBuiltin).toBe(true);
    expect(cr!.source).toBe("builtin");
    expect(cr!.mode).toBe("delegate");
    expect(cr!.allowedTools).toContain("read");
    expect(cr!.allowedTools).not.toContain("edit");
  });

  test("SkillLoader 子目录模式可识别 SKILL.md（保留旧测试覆盖 project 来源加载路径）", async () => {
    const { mkdirSync, rmSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    const tmpRoot = join(tmpdir(), `cr-skill-${Date.now()}`);
    const skillDir = join(tmpRoot, ".sid-code", "skills", "code-review");
    mkdirSync(skillDir, { recursive: true });
    copyFileSync(SKILL_FILE, join(skillDir, "SKILL.md"));

    try {
      const loader = new SkillLoader(new ExtensionLoader());
      const skills = await loader.loadAll(tmpRoot);
      const cr = skills.find((s) => s.name === "code-review");
      expect(cr).toBeDefined();
      expect(cr!.mode).toBe("delegate");
      expect(cr!.allowedTools).toContain("read");
      expect(cr!.allowedTools).not.toContain("edit");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("RFC-001 + SKILL.md frontmatter 含必备 sla / release_metadata 字段（基线契约）", () => {
    const markdown = readFileSync(SKILL_FILE, "utf-8");
    const { fm } = parseFrontmatter(markdown);
    expect(fm.sla).toBeDefined();
    expect(fm.release_metadata).toBeDefined();
  });
});

describe("code-review Skill - reference / scripts 文件契约", () => {
  test("references/output-template.md 存在", () => {
    expect(existsSync(join(SKILL_DIR, "references", "output-template.md"))).toBe(true);
  });

  test("references/severity-guide.md 存在", () => {
    expect(existsSync(join(SKILL_DIR, "references", "severity-guide.md"))).toBe(true);
  });

  test("references/ai-code-patterns.md 存在", () => {
    expect(existsSync(join(SKILL_DIR, "references", "ai-code-patterns.md"))).toBe(true);
  });

  test("scripts/parse-diff.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "parse-diff.ts"))).toBe(true);
  });

  test("validations/output-schema.json 存在", () => {
    expect(existsSync(join(SKILL_DIR, "validations", "output-schema.json"))).toBe(true);
  });
});
