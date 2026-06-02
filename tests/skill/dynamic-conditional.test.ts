/**
 * Skill 动态发现 + 条件激活测试（Task 4）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConditionalSkillStore,
  matchGlob,
  globToRegExp,
} from "../../src/skill/conditional.ts";
import {
  extractAffectedPaths,
  discoverSkillDirsForPaths,
  DynamicSkillDiscovery,
} from "../../src/skill/dynamic-discovery.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";

function makeSkill(name: string, paths?: string[]): SkillDefinition {
  return {
    name,
    description: "d",
    prompt: "p",
    source: "user",
    filePath: `/tmp/${name}/SKILL.md`,
    paths,
  };
}

describe("matchGlob / globToRegExp", () => {
  test("* 不跨目录", () => {
    expect(matchGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/sub/a.ts", "src/*.ts")).toBe(false);
  });

  test("** 跨目录", () => {
    expect(matchGlob("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchGlob("src/sub/deep/a.ts", "src/**/*.ts")).toBe(true);
  });

  test("globToRegExp 回退实现", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.md").test("readme.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/readme.md")).toBe(false);
  });
});

describe("ConditionalSkillStore", () => {
  test("separate 分离条件 / 无条件 Skill", () => {
    const store = new ConditionalSkillStore();
    const unconditional = store.separate([
      makeSkill("plain"),
      makeSkill("ts-lint", ["src/**/*.ts"]),
    ]);
    expect(unconditional.map((s) => s.name)).toEqual(["plain"]);
    expect(store.getConditionalNames()).toEqual(["ts-lint"]);
    expect(store.getDynamicSkills().length).toBe(0);
  });

  test("文件匹配时激活条件 Skill", () => {
    const store = new ConditionalSkillStore();
    store.separate([makeSkill("ts-lint", ["src/**/*.ts"])]);

    const activated = store.activateForPaths(
      [join(process.cwd(), "src/foo/bar.ts")],
      process.cwd(),
    );
    expect(activated).toEqual(["ts-lint"]);
    expect(store.isActivated("ts-lint")).toBe(true);
    expect(store.getDynamicSkills().map((s) => s.name)).toEqual(["ts-lint"]);
    // 激活后从 conditional 移除
    expect(store.getConditionalNames()).toEqual([]);
  });

  test("不匹配的文件不激活", () => {
    const store = new ConditionalSkillStore();
    store.separate([makeSkill("ts-lint", ["src/**/*.ts"])]);
    const activated = store.activateForPaths(
      [join(process.cwd(), "docs/readme.md")],
      process.cwd(),
    );
    expect(activated).toEqual([]);
    expect(store.isActivated("ts-lint")).toBe(false);
  });

  test("重复激活只触发一次", () => {
    const store = new ConditionalSkillStore();
    store.separate([makeSkill("ts-lint", ["src/**/*.ts"])]);
    const p = join(process.cwd(), "src/a.ts");
    expect(store.activateForPaths([p], process.cwd())).toEqual(["ts-lint"]);
    expect(store.activateForPaths([p], process.cwd())).toEqual([]);
  });
});

describe("extractAffectedPaths", () => {
  test("提取 file_path / path", () => {
    expect(extractAffectedPaths({ file_path: "/a/b.ts" })).toEqual(["/a/b.ts"]);
    expect(extractAffectedPaths({ path: "/c/d" })).toEqual(["/c/d"]);
  });
  test("非对象输入返回空", () => {
    expect(extractAffectedPaths(null)).toEqual([]);
    expect(extractAffectedPaths("x")).toEqual([]);
  });
});

describe("discoverSkillDirsForPaths (真实文件系统)", () => {
  let root: string;
  let nestedSkillsDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "skill-dyn-"));
    // root/packages/app/.sid-code/skills/
    nestedSkillsDir = join(root, "packages", "app", ".sid-code", "skills");
    mkdirSync(nestedSkillsDir, { recursive: true });
    writeFileSync(join(nestedSkillsDir, "x.md"), "---\nname: x\ndescription: d\n---\nbody");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("沿目录链向上发现 .sid-code/skills/", () => {
    const filePath = join(root, "packages", "app", "src", "index.ts");
    const dirs = discoverSkillDirsForPaths([filePath], root, new Set());
    expect(dirs).toContain(nestedSkillsDir);
  });

  test("已发现的目录不重复返回", () => {
    const filePath = join(root, "packages", "app", "src", "index.ts");
    const already = new Set([nestedSkillsDir]);
    expect(discoverSkillDirsForPaths([filePath], root, already)).toEqual([]);
  });

  test("DynamicSkillDiscovery 只对触发工具响应", () => {
    const disc = new DynamicSkillDiscovery(root);
    const filePath = join(root, "packages", "app", "src", "index.ts");
    // 非触发工具
    expect(disc.onToolUse("websearch", { file_path: filePath })).toEqual([]);
    // 触发工具
    const dirs = disc.onToolUse("edit", { file_path: filePath });
    expect(dirs).toContain(nestedSkillsDir);
    // 第二次不再重复
    expect(disc.onToolUse("read", { file_path: filePath })).toEqual([]);
  });
});
