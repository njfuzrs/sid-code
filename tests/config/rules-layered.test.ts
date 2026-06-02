/**
 * CLAUDE.md 多层级增强测试（Task 6）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseRulesFrontmatter,
  rulesPathsMatch,
  parseClaudeMd,
  loadAllCLAUDEmd,
} from "../../src/config/rules.ts";

describe("parseRulesFrontmatter", () => {
  test("inline 数组写法", () => {
    const { paths, body } = parseRulesFrontmatter(`---
paths: ["src/**", "lib/**"]
---
正文`);
    expect(paths).toEqual(["src/**", "lib/**"]);
    expect(body.trim()).toBe("正文");
  });

  test("多行列表写法", () => {
    const { paths } = parseRulesFrontmatter(`---
paths:
  - src/**
  - tests/**
---
body`);
    expect(paths).toEqual(["src/**", "tests/**"]);
  });

  test("单值写法", () => {
    const { paths } = parseRulesFrontmatter(`---
paths: src/**
---
body`);
    expect(paths).toEqual(["src/**"]);
  });

  test("无 frontmatter 返回原内容", () => {
    const { paths, body } = parseRulesFrontmatter("# 标题\n内容");
    expect(paths).toBeUndefined();
    expect(body).toBe("# 标题\n内容");
  });
});

describe("rulesPathsMatch", () => {
  test("无 paths 条件始终匹配", () => {
    expect(rulesPathsMatch(undefined, [])).toBe(true);
    expect(rulesPathsMatch([], ["src/a.ts"])).toBe(true);
  });

  test("有 paths 条件但无活动文件不匹配", () => {
    expect(rulesPathsMatch(["src/**"], [])).toBe(false);
  });

  test("glob 匹配活动文件", () => {
    expect(rulesPathsMatch(["src/**"], ["src/foo/bar.ts"])).toBe(true);
    expect(rulesPathsMatch(["src/**"], ["lib/baz.ts"])).toBe(false);
  });

  test("任一 glob 匹配任一文件即生效", () => {
    expect(rulesPathsMatch(["src/**", "*.md"], ["README.md"])).toBe(true);
  });
});

describe("parseClaudeMd 带 frontmatter", () => {
  test("提取 paths 并正常解析段落", () => {
    const content = `---
paths: ["src/**"]
---
# Instructions
使用 TypeScript`;
    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.paths).toEqual(["src/**"]);
    expect(rules.instructions).toContain("使用 TypeScript");
  });
});

describe("loadAllCLAUDEmd 多层级", () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "sid-rules-"));
  });
  afterEach(() => {
    try { rmSync(proj, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("加载 .claude/rules/ 目录规则", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n项目根规则");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    writeFileSync(join(proj, ".claude", "rules", "style.md"), "# Custom Rules\n- 缩进用 2 空格");

    const merged = await loadAllCLAUDEmd(proj);
    expect(merged).not.toBeNull();
    expect(merged!.rawContent).toContain("项目根规则");
    expect(merged!.rawContent).toContain("缩进用 2 空格");
  });

  test("CLAUDE.local.md 优先级最高（覆盖 model）", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Model\nclaude-sonnet");
    writeFileSync(join(proj, "CLAUDE.local.md"), "# Model\nclaude-opus");

    const merged = await loadAllCLAUDEmd(proj);
    expect(merged!.model).toBe("claude-opus");
  });

  test("frontmatter paths 不匹配的规则被跳过", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n通用规则");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    // 只在编辑 python 文件时生效的规则
    writeFileSync(
      join(proj, ".claude", "rules", "py.md"),
      `---\npaths: ["**/*.py"]\n---\n# Custom Rules\n- Python 专用规则`,
    );

    // 活动文件是 .ts，不应包含 Python 规则
    const merged = await loadAllCLAUDEmd(proj, { activeFiles: ["src/foo.ts"] });
    expect(merged!.rawContent).not.toContain("Python 专用规则");

    // 活动文件是 .py，应包含
    const merged2 = await loadAllCLAUDEmd(proj, { activeFiles: ["src/foo.py"] });
    expect(merged2!.rawContent).toContain("Python 专用规则");
  });

  test("项目内无规则文件时不泄露项目内容", async () => {
    // 注意：开发机可能存在全局 ~/.claude/CLAUDE.md，会被正常加载（User 层）。
    // 这里只验证：项目目录内没有规则文件时，合并结果不包含任何项目级内容。
    const merged = await loadAllCLAUDEmd(proj);
    if (merged) {
      expect(merged.layer).toBe("user");
      expect(merged.sourcePath).not.toContain(proj);
    } else {
      expect(merged).toBeNull();
    }
  });
});
