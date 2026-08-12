/**
 * code-governance Skill 集成测试
 *
 * 验证 SKILL.md frontmatter 解析 / scripts 目录结构 / references / validations /
 * 四个脚本的功能正确性.
 * 纯结构验证 + 脚本单测, 不调 LLM.
 *
 * RFC: docs/rfcs/RFC-005-code-governance-skill.md
 * S8-T04 实施
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { checkLicenses } from "@sid-code/core/skill/builtin/code-governance/scripts/license-check.ts";
import { scanPii } from "@sid-code/core/skill/builtin/code-governance/scripts/pii-scan.ts";
import { exportCompliance } from "@sid-code/core/skill/builtin/code-governance/scripts/compliance-export.ts";
import { checkAuditTrail } from "@sid-code/core/skill/builtin/code-governance/scripts/audit-trail-check.ts";

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
  "code-governance",
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

const wrapDiff = (file: string, content: string): string => {
  const lines = content.split("\n");
  const numbered = lines.map((l) => `+${l}`).join("\n");
  return `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${lines.length} @@\n${numbered}\n`;
};

// ============================================================
// 1. SKILL.md frontmatter 解析验证
// ============================================================

describe("code-governance Skill - SKILL.md frontmatter 契约", () => {
  const markdown = readFileSync(SKILL_FILE, "utf-8");
  const { fm } = parseFrontmatter(markdown);

  test("name = code-governance", () => {
    expect(fm.name).toBe("code-governance");
  });

  test("mode = delegate", () => {
    expect(fm.mode).toBe("delegate");
  });

  test("allowed-tools 含 read / grep / glob / bash, 不含 edit / write (RL-001)", () => {
    expect(fm["allowed-tools"]).toBeDefined();
    const tools = (fm["allowed-tools"] as string).split(",").map((s) => s.trim());
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("glob");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  test("sla 段存在且 failure_policy = block", () => {
    expect(fm.sla).toBeDefined();
    expect(fm.sla!.failure_policy).toBe("block");
  });

  test("sla P50 / P95 / token_cost_usd 合理", () => {
    const sla = fm.sla!;
    expect(sla.p50_ms).toBeGreaterThan(0);
    expect(sla.p95_ms).toBeGreaterThan(sla.p50_ms!);
    expect(sla.token_cost_usd).toBeGreaterThan(0);
  });
});

// ============================================================
// 2. scripts 目录结构验证
// ============================================================

describe("code-governance Skill - scripts 目录结构", () => {
  test("scripts/ 目录存在", () => {
    expect(statSync(join(SKILL_DIR, "scripts")).isDirectory()).toBe(true);
  });

  test("scripts/license-check.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "license-check.ts"))).toBe(true);
  });

  test("scripts/pii-scan.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "pii-scan.ts"))).toBe(true);
  });

  test("scripts/compliance-export.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "compliance-export.ts"))).toBe(true);
  });

  test("scripts/audit-trail-check.ts 存在", () => {
    expect(existsSync(join(SKILL_DIR, "scripts", "audit-trail-check.ts"))).toBe(true);
  });
});

// ============================================================
// 3. references/license-allowlist.json 验证
// ============================================================

describe("code-governance Skill - references/license-allowlist.json", () => {
  const filePath = join(SKILL_DIR, "references", "license-allowlist.json");

  test("文件存在", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  test("是有效 JSON 数组", () => {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
  });

  test("每项含 license / policy / reason 字段", () => {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Array<Record<string, unknown>>;
    for (const entry of raw) {
      expect(entry).toHaveProperty("license");
      expect(entry).toHaveProperty("policy");
      expect(entry).toHaveProperty("reason");
      expect(["allow", "warn", "block"]).toContain(entry.policy as string);
    }
  });
});

// ============================================================
// 4. validations/output-schema.json 验证
// ============================================================

describe("code-governance Skill - validations/output-schema.json", () => {
  const filePath = join(SKILL_DIR, "validations", "output-schema.json");

  test("文件存在", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  test("含必需字段 verdict / violations_count / warnings_count / findings / compliance_metadata", () => {
    const schema = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(schema.required).toContain("verdict");
    expect(schema.required).toContain("violations_count");
    expect(schema.required).toContain("warnings_count");
    expect(schema.required).toContain("findings");
    expect(schema.required).toContain("compliance_metadata");
  });
});

// ============================================================
// 5. license-check 功能测试
// ============================================================

describe("code-governance scripts/license-check.ts - 功能测试", () => {
  test("GPL 依赖检测为 violation", () => {
    const pkg = JSON.stringify({
      dependencies: { "license-info-gpl-pkg": "^1.0.0" },
      "__license__license-info-gpl-pkg": "GPL-3.0",
    });
    const r = checkLicenses(pkg, "package.json");
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.license === "GPL-3.0" && v.policy === "block")).toBe(true);
  });

  test("MIT 依赖不报 violation 也不报 warning", () => {
    const pkg = JSON.stringify({
      dependencies: { lodash: "^4.17.21" },
      __license__lodash: "MIT",
    });
    const r = checkLicenses(pkg, "package.json");
    expect(r.violations.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  test("LGPL 依赖为 warning", () => {
    const pkg = JSON.stringify({
      dependencies: { "lgpl-pkg": "^2.0.0" },
      "__license__lgpl-pkg": "LGPL-3.0",
    });
    const r = checkLicenses(pkg, "package.json");
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.license === "LGPL-3.0" && w.policy === "warn")).toBe(true);
    expect(r.violations.length).toBe(0);
  });
});

// ============================================================
// 6. pii-scan 功能测试
// ============================================================

describe("code-governance scripts/pii-scan.ts - 功能测试", () => {
  test("中国手机号检测为 violation", () => {
    const diff = wrapDiff("src/user.ts", `const phone = "13812345678";`);
    const r = scanPii(diff);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.pii_class === "phone_cn" && f.severity === "violation")).toBe(
      true,
    );
  });

  test("身份证号检测为 violation", () => {
    const diff = wrapDiff("src/kyc.ts", `const idCard = "110101199003071234";`);
    const r = scanPii(diff);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.pii_class === "id_card_cn" && f.severity === "violation")).toBe(
      true,
    );
  });

  test("fixture 路径 + 脱敏注释豁免", () => {
    const diff = wrapDiff(
      "tests/fixtures/sample.ts",
      `const phone = "13812345678"; // fake test data`,
    );
    const r = scanPii(diff);
    expect(r.findings.filter((f) => f.pii_class === "phone_cn").length).toBe(0);
  });

  test("占位符豁免 (xxx / example.com)", () => {
    const diff = wrapDiff("src/config.ts", `const email = "xxx@example.com"; // placeholder`);
    const r = scanPii(diff);
    expect(r.findings.filter((f) => f.pii_class === "email").length).toBe(0);
  });
});

// ============================================================
// 7. compliance-export 功能测试
// ============================================================

describe("code-governance scripts/compliance-export.ts - 功能测试", () => {
  test("face_recognition → high", () => {
    const diff = wrapDiff("src/ai/face.ts", `import { face_recognition } from "deepface";`);
    const r = exportCompliance(diff);
    expect(r.eu_ai_act.risk_class).toBe("high");
    expect(r.summary.auto_inferred_risk_class).toBe("high");
  });

  test("llm_api → limited", () => {
    const diff = wrapDiff("src/chat.ts", `const client = new LLM_API({ model: "gpt-4" });`);
    const r = exportCompliance(diff);
    expect(r.eu_ai_act.risk_class).toBe("limited");
    expect(r.summary.auto_inferred_risk_class).toBe("limited");
  });

  test("普通代码 → unknown", () => {
    const diff = wrapDiff(
      "src/utils.ts",
      `export function add(a: number, b: number) { return a + b; }`,
    );
    const r = exportCompliance(diff);
    expect(r.eu_ai_act.risk_class).toBe("unknown");
    expect(r.summary.auto_inferred_risk_class).toBe("unknown");
  });
});

// ============================================================
// 8. audit-trail-check 功能测试
// ============================================================

describe("code-governance scripts/audit-trail-check.ts - 功能测试", () => {
  test("高风险路径无 ADR → incomplete", () => {
    const diff = wrapDiff("src/auth/login.ts", `export function login() { /* ... */ }`);
    const r = checkAuditTrail(diff, "feat: add login");
    expect(r.audit_trail_status).toBe("incomplete");
    expect(r.missing_adr.length).toBeGreaterThan(0);
    expect(r.missing_adr[0].file).toBe("src/auth/login.ts");
  });

  test("高风险路径有 ADR → complete", () => {
    const diff = wrapDiff("src/auth/login.ts", `export function login() { /* ... */ }`);
    const r = checkAuditTrail(diff, "feat: add login\n\nSee ADR-029-auth-redesign.md");
    expect(r.audit_trail_status).toBe("complete");
    expect(r.missing_adr.length).toBe(0);
    expect(r.summary.matched_adr_ids).toContain("ADR-029");
  });

  test("非高风险路径 → complete (无需 ADR)", () => {
    const diff = wrapDiff(
      "src/utils/format.ts",
      `export function fmt(s: string) { return s.trim(); }`,
    );
    const r = checkAuditTrail(diff, "refactor: format util");
    expect(r.audit_trail_status).toBe("complete");
    expect(r.missing_adr.length).toBe(0);
    expect(r.summary.total_high_risk_files).toBe(0);
  });
});
