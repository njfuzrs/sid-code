/**
 * sid-code review 子命令契约测试 (S5-T13)
 *
 * 仅验证参数解析 + Skill body 加载 + system prompt 结构,不真调 LLM.
 * 真集成测试通过 dogfood (S5-T14) 在真 PR 上跑.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join(
  __dirname,
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
  "SKILL.md",
);
const REVIEW_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "cli",
  "src",
  "command",
  "review.ts",
);
const BOOTSTRAP_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "cli",
  "src",
  "entrypoints",
  "bootstrap.ts",
);

describe("sid-code review 子命令 - 文件契约", () => {
  test("src/command/review.ts 存在", () => {
    expect(existsSync(REVIEW_TS)).toBe(true);
  });

  test("review.ts 导出 handleReviewCommand", async () => {
    const mod = await import("@sid-code/cli/command/review.ts");
    expect(typeof mod.handleReviewCommand).toBe("function");
  });

  test("bootstrap.ts 含 review 子命令快速路径", () => {
    const content = readFileSync(BOOTSTRAP_TS, "utf-8");
    expect(content).toMatch(/args\[0\]\s*===\s*"review"/);
    expect(content).toMatch(/handleReviewCommand/);
    expect(content).toMatch(/command\/review\.ts/);
  });
});

describe("sid-code review 子命令 - 参数与 Skill 加载契约", () => {
  test("loadCodeReviewSkillPrompt 返回嵌入的 code-review 正文（与源码树 SKILL.md 一致）", async () => {
    // B24：真跑加载函数，而不是 grep 源码里有没有路径字面量——后者在路径算错时照样绿。
    const { loadCodeReviewSkillPrompt } = await import("@sid-code/cli/command/review.ts");
    const body = await loadCodeReviewSkillPrompt();
    expect(body).toContain("# Code Review");
    expect(body.startsWith("---")).toBe(false);
    const md = readFileSync(SKILL_FILE, "utf-8");
    const diskBody = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)![1].trim();
    expect(body).toBe(diskBody);
  });

  test("review.ts 不从磁盘相对路径读 Skill（编译产物里模块在 /$bunfs/，B24）", () => {
    // 去掉块注释与行注释再断言：注释里解释「为什么不用 import.meta.url」不该让门禁红
    const code = readFileSync(REVIEW_TS, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/import\.meta\.(url|dir)/);
    expect(code).toMatch(/EMBEDDED_BUILTIN_SKILLS/);
  });

  test("review.ts 系统提示注入了 RL-001 / RL-007 守护语义", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    // RL-001 不删用户代码
    expect(content).toMatch(/RL-001|不删用户代码|不调用 edit/);
    // RL-007 不编造问题
    expect(content).toMatch(/RL-007|不编造问题|file:line/);
  });

  test("review.ts 不直接调 edit / write 工具(子进程模式 + RL-001 守护)", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    expect(content).not.toMatch(/EditTool|WriteTool|fs\.writeFileSync.*\.ts'/);
  });

  test("review.ts 默认 timeout 180s,与 Skill SLA p95 对齐", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    expect(content).toMatch(/timeoutMs:\s*180000|180_000|180000/);
  });

  test("review.ts 含 --help / -h 帮助处理", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    expect(content).toMatch(/printHelp|--help|short:\s*"h"/);
  });

  test("SKILL.md body 可以被 review.ts 解析(frontmatter --- 分隔正常)", () => {
    expect(existsSync(SKILL_FILE)).toBe(true);
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeGreaterThan(100);
  });
});

describe("sid-code review 子命令 - 帮助文本契约", () => {
  test("help 文本含核心用法示例", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    expect(content).toMatch(/git diff/);
    expect(content).toMatch(/--diff/);
    expect(content).toMatch(/stdin/);
  });

  test("help 文本声明输出 markdown + file:line 引用", () => {
    const content = readFileSync(REVIEW_TS, "utf-8");
    expect(content).toMatch(/Markdown|markdown/);
    expect(content).toMatch(/file:line/);
  });
});
