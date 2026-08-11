/**
 * security-audit Skill scripts 单测 (S7-T04 Step 4 实施)
 *
 * 验证启发式漏洞检测器 + CVE 离线查询的正确性 + false_positive 控制.
 * 不调 LLM, 纯单测.
 */

import { describe, test, expect } from "bun:test";
import { detectVulnerabilities } from "@sid-code/core/skill/builtin/security-audit/scripts/detect-vulnerabilities.ts";
import {
  detectEcosystem,
  lookupCves,
} from "@sid-code/core/skill/builtin/security-audit/scripts/cve-lookup.ts";

const wrapDiff = (file: string, content: string): string => {
  const lines = content.split("\n");
  const numbered = lines.map((l) => `+${l}`).join("\n");
  return `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${lines.length} @@\n${numbered}\n`;
};

describe("security-audit detect-vulnerabilities — injection", () => {
  test("识别 SQL string concat injection 为 blocker", () => {
    const diff = wrapDiff(
      "src/db.ts",
      `const result = db.query("SELECT * FROM users WHERE id=" + userId);`,
    );
    const r = detectVulnerabilities(diff);
    const inj = r.findings.filter((f) => f.vuln_class === "injection");
    expect(inj.length).toBeGreaterThan(0);
    expect(inj.some((f) => f.severity === "blocker")).toBe(true);
    expect(inj[0].cwe).toMatch(/CWE-(89|78)/);
  });

  test("识别 SQL template literal injection", () => {
    const diff = wrapDiff(
      "src/api.ts",
      `const sql = \`SELECT * FROM messages WHERE user_id=\${req.body.userId}\`;`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "injection")).toBe(true);
  });

  test("识别 command injection (execSync 含模板变量)", () => {
    const diff = wrapDiff(
      "src/cli.ts",
      `execSync(\`rm -rf \${userPath}\`);`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "injection" && f.cwe === "CWE-78")).toBe(true);
  });

  test("不误报 prepared statement (parameterized query 排除)", () => {
    const diff = wrapDiff(
      "src/db.ts",
      `const result = db.query("SELECT * FROM users WHERE id = ?", [userId]); // parameterized`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "injection").length).toBe(0);
  });
});

describe("security-audit detect-vulnerabilities — secret_leak", () => {
  test("识别硬编码 AWS key 为 blocker", () => {
    const diff = wrapDiff(
      "src/aws.ts",
      `const accessKey = "AKIAIOSFODNN7EXAMPLE";`,
    );
    const r = detectVulnerabilities(diff);
    const sec = r.findings.filter((f) => f.vuln_class === "secret_leak");
    expect(sec.length).toBeGreaterThan(0);
    expect(sec[0].severity).toBe("blocker");
  });

  test("识别 GitHub PAT 为 blocker", () => {
    const diff = wrapDiff(
      "src/gh.ts",
      `const ghToken = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "secret_leak" && f.severity === "blocker")).toBe(true);
  });

  test("识别硬编码密码", () => {
    const diff = wrapDiff(
      "src/auth.ts",
      `const password = "supersecret123";`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "secret_leak")).toBe(true);
  });

  test("不误报 process.env / 占位符", () => {
    const diff = wrapDiff(
      "src/auth.ts",
      `const password = process.env.DB_PASSWORD;\nconst apiKey = "<TODO>";`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "secret_leak").length).toBe(0);
  });

  test("不误报 example/sample/test 字面", () => {
    const diff = wrapDiff(
      "tests/fixtures/sample.ts",
      `const password = "example_password_for_test_only_xxxx";`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "secret_leak").length).toBe(0);
  });
});

describe("security-audit detect-vulnerabilities — xss", () => {
  test("识别 React dangerouslySetInnerHTML 为 high", () => {
    const diff = wrapDiff(
      "src/ui/post.tsx",
      `return <div dangerouslySetInnerHTML={{ __html: post.content }} />;`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "xss" && f.severity === "high")).toBe(true);
  });

  test("识别 .innerHTML = req.body", () => {
    const diff = wrapDiff(
      "src/ui/render.ts",
      `el.innerHTML = req.body.content;`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "xss")).toBe(true);
  });

  test("识别 document.write 为 medium", () => {
    const diff = wrapDiff(
      "src/legacy.js",
      `document.write("<script src='" + url + "'></script>");`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "xss" && f.severity === "medium")).toBe(true);
  });
});

describe("security-audit detect-vulnerabilities — crypto_weak", () => {
  test("识别 createHash('md5') 为 high", () => {
    const diff = wrapDiff(
      "src/auth.ts",
      `const h = createHash('md5').update(password).digest('hex');`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "crypto_weak" && f.cwe === "CWE-327")).toBe(true);
  });

  test("不误报 md5 用于 cache key (excludes 排除)", () => {
    const diff = wrapDiff(
      "src/cache.ts",
      `// content hash for cache key\nconst cacheKey = createHash('md5').update(payload).digest('hex');`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "crypto_weak").length).toBe(0);
  });

  test("识别 Math.random() 用于 token", () => {
    const diff = wrapDiff(
      "src/token.ts",
      `const sessionToken = String(Math.random());`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "crypto_weak")).toBe(true);
  });

  test("不误报 Math.random 用于 jitter / animation", () => {
    const diff = wrapDiff(
      "src/ui/anim.ts",
      `const jitter = Math.random() * 100; // delay jitter for animation`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "crypto_weak").length).toBe(0);
  });
});

describe("security-audit detect-vulnerabilities — iac_misconfig", () => {
  test("识别 Dockerfile USER root 为 high", () => {
    const diff = wrapDiff("Dockerfile", `USER root\nCMD ["node","server.js"]`);
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "iac_misconfig" && f.severity === "high")).toBe(true);
  });

  test("识别 :latest tag 为 medium", () => {
    const diff = wrapDiff("Dockerfile", `FROM node:latest`);
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "iac_misconfig" && f.severity === "medium")).toBe(true);
  });

  test("识别 K8s privileged: true", () => {
    const diff = wrapDiff(
      "k8s/deployment.yaml",
      `securityContext:\n  privileged: true`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "iac_misconfig")).toBe(true);
  });

  test("识别 K8s hostNetwork: true", () => {
    const diff = wrapDiff(
      "k8s/pod.yaml",
      `spec:\n  hostNetwork: true`,
    );
    const r = detectVulnerabilities(diff);
    expect(r.findings.some((f) => f.vuln_class === "iac_misconfig")).toBe(true);
  });
});

describe("security-audit detect-vulnerabilities — summary", () => {
  test("综合 diff 命中多类时 summary 正确聚合", () => {
    const diff = [
      wrapDiff("Dockerfile", `USER root`),
      wrapDiff("src/db.ts", `db.query("SELECT * FROM u WHERE id=" + uid);`),
      wrapDiff("src/aws.ts", `const k = "AKIAIOSFODNN7TESTING";`),
    ].join("\n");
    const r = detectVulnerabilities(diff);
    expect(r.summary.total).toBeGreaterThanOrEqual(3);
    expect(r.summary.by_class).toHaveProperty("iac_misconfig");
    expect(r.summary.by_class).toHaveProperty("injection");
    expect(r.summary.by_class).toHaveProperty("secret_leak");
    expect(r.summary.by_severity).toHaveProperty("blocker");
  });

  test("空 diff 输出 total=0", () => {
    const r = detectVulnerabilities("");
    expect(r.summary.total).toBe(0);
    expect(r.findings.length).toBe(0);
  });

  test("仅删除行的 diff 不触发 finding (只看 + 行)", () => {
    const diff = `--- a/old.ts\n+++ b/old.ts\n@@ -1,2 +1,1 @@\n-const password = "abc12345";\n+const password = process.env.PASS;`;
    const r = detectVulnerabilities(diff);
    expect(r.findings.filter((f) => f.vuln_class === "secret_leak").length).toBe(0);
  });
});

describe("security-audit cve-lookup — ecosystem detection", () => {
  test("识别 npm package.json", () => {
    const eco = detectEcosystem(
      JSON.stringify({ dependencies: { lodash: "^4.17.20" } }),
      "package.json",
    );
    expect(eco).toBe("npm");
  });

  test("识别 pypi requirements.txt", () => {
    const eco = detectEcosystem("django==4.2.0\nflask==2.0.0", "requirements.txt");
    expect(eco).toBe("pypi");
  });

  test("识别 go go.mod", () => {
    const eco = detectEcosystem(
      `module myapp\n\nrequire (\n  github.com/gin-gonic/gin v1.9.0\n)`,
      "go.mod",
    );
    expect(eco).toBe("go");
  });
});

describe("security-audit cve-lookup — vulnerability matching", () => {
  test("命中 lodash 4.17.20 → CVE-2021-23337", () => {
    const pkgJson = JSON.stringify({ dependencies: { lodash: "4.17.20" } });
    const r = lookupCves(pkgJson, "package.json");
    expect(r.summary.total).toBeGreaterThan(0);
    const lodashHit = r.vulnerable.find((v) => v.package === "lodash");
    expect(lodashHit).toBeDefined();
    expect(lodashHit!.cve_id).toBe("CVE-2021-23337");
    expect(lodashHit!.severity).toBe("high");
  });

  test("不命中 lodash 4.17.21 (已修复版本)", () => {
    const pkgJson = JSON.stringify({ dependencies: { lodash: "4.17.21" } });
    const r = lookupCves(pkgJson, "package.json");
    expect(r.vulnerable.find((v) => v.package === "lodash")).toBeUndefined();
  });

  test("命中 minimist <1.2.6 (critical)", () => {
    const pkgJson = JSON.stringify({ dependencies: { minimist: "1.2.5" } });
    const r = lookupCves(pkgJson, "package.json");
    expect(r.vulnerable.some((v) => v.package === "minimist" && v.severity === "critical")).toBe(true);
  });

  test("命中 pypi flask 2.0.0 → CVE-2023-30861", () => {
    const r = lookupCves("flask==2.0.0\ndjango==4.2.5", "requirements.txt");
    expect(r.vulnerable.some((v) => v.package === "flask")).toBe(true);
    expect(r.vulnerable.some((v) => v.package === "django")).toBe(true);
  });

  test("命中 go gin v1.9.0 → CVE-2023-29401", () => {
    const r = lookupCves(
      `module myapp\nrequire (\n  github.com/gin-gonic/gin v1.9.0\n)`,
      "go.mod",
    );
    expect(r.vulnerable.some((v) => v.package === "github.com/gin-gonic/gin")).toBe(true);
  });

  test("空 manifest 不抛错", () => {
    const r = lookupCves("{}", "package.json");
    expect(r.summary.total).toBe(0);
    expect(r.vulnerable.length).toBe(0);
  });
});

describe("security-audit scripts/references 文件结构", () => {
  test("references/cve-snapshot.json 存在且是有效 JSON 数组", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const p = path.join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "core",
      "src",
      "skill",
      "builtin",
      "security-audit",
      "references",
      "cve-snapshot.json",
    );
    expect(fs.existsSync(p)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThanOrEqual(8);
    for (const a of raw) {
      expect(a).toHaveProperty("package");
      expect(a).toHaveProperty("cve_id");
      expect(a).toHaveProperty("severity");
      expect(["critical", "high", "medium", "low"]).toContain(a.severity);
    }
  });

  test("references/vulnerability-patterns.md 存在", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const p = path.join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "core",
      "src",
      "skill",
      "builtin",
      "security-audit",
      "references",
      "vulnerability-patterns.md",
    );
    expect(fs.existsSync(p)).toBe(true);
  });

  test("validations/output-schema.json 存在且 schema 含必需字段", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const p = path.join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "core",
      "src",
      "skill",
      "builtin",
      "security-audit",
      "validations",
      "output-schema.json",
    );
    expect(fs.existsSync(p)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(schema.required).toContain("audit_verdict");
    expect(schema.required).toContain("severity_counts");
    expect(schema.required).toContain("findings");
  });
});
