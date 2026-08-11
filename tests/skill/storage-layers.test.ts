/**
 * Skill 存储层测试：additional（--add-dir）层 + 企业锁定（strictPluginOnlyCustomization）
 *
 * 优先级：builtin < user < project < additional < managed
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import {
  setPluginOnlyPolicy,
  isRestrictedToPluginOnly,
  isSourceAllowedUnderLock,
  __resetPluginOnlyPolicy,
} from "@sid-code/core/config/plugin-only-policy.ts";

/** 在 <base>/<sub>/skills/<name>/SKILL.md 写一个最小 skill */
function writeSkill(base: string, sub: string, name: string, description: string): void {
  const dir = join(base, sub, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n做点事`,
  );
}

let roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sid-skill-layer-"));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  __resetPluginOnlyPolicy();
});

afterEach(() => {
  __resetPluginOnlyPolicy();
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
  roots = [];
});

describe("additional 层（--add-dir 授权目录）", () => {
  test("授权目录下的 .sid-code/skills 与 .claude/skills 都被加载", async () => {
    const addDir = tempRoot();
    writeSkill(addDir, ".sid-code", "from-sid", "sid 目录的 skill");
    writeSkill(addDir, ".claude", "from-claude", "claude 目录的 skill");

    const files = await new ExtensionLoader().scan("skills", undefined, {
      trustProjectExtensions: true,
      additionalDirs: [addDir],
    });

    const names = files.map((f) => f.name);
    expect(names).toContain("from-sid");
    expect(names).toContain("from-claude");
  });

  test("additional 覆盖同名项目级 skill（优先级更高）", async () => {
    const projectDir = tempRoot();
    const addDir = tempRoot();
    writeSkill(projectDir, ".sid-code", "dup", "项目级版本");
    writeSkill(addDir, ".sid-code", "dup", "授权目录版本");

    const files = await new ExtensionLoader().scan("skills", projectDir, {
      trustProjectExtensions: true,
      additionalDirs: [addDir],
    });

    const dup = files.filter((f) => f.name === "dup");
    expect(dup.length).toBe(1);
    expect(dup[0].frontmatter.description).toBe("授权目录版本");
  });

  test("managed 仍覆盖 additional（企业层最高）", async () => {
    const addDir = tempRoot();
    const managedDir = tempRoot();
    writeSkill(addDir, ".sid-code", "dup2", "授权目录版本");
    // managedDirs 直接指向 skills 容器目录
    mkdirSync(join(managedDir, "dup2"), { recursive: true });
    writeFileSync(
      join(managedDir, "dup2", "SKILL.md"),
      "---\nname: dup2\ndescription: 企业版本\n---\n\n做点事",
    );

    const files = await new ExtensionLoader().scan("skills", undefined, {
      trustProjectExtensions: true,
      additionalDirs: [addDir],
      managedDirs: [managedDir],
    });

    const dup = files.filter((f) => f.name === "dup2");
    expect(dup.length).toBe(1);
    expect(dup[0].frontmatter.description).toBe("企业版本");
    expect(dup[0].source).toBe("managed");
  });

  test("未传 additionalDirs 时行为不变（不误加载）", async () => {
    const addDir = tempRoot();
    writeSkill(addDir, ".sid-code", "unlisted", "不该被加载");

    const files = await new ExtensionLoader().scan("skills", undefined, {
      trustProjectExtensions: true,
    });
    expect(files.map((f) => f.name)).not.toContain("unlisted");
  });
});

describe("strictPluginOnlyCustomization（企业锁定定制化来源）", () => {
  test("true 锁定全部面；数组只锁列出的面", () => {
    setPluginOnlyPolicy(true);
    expect(isRestrictedToPluginOnly("skills")).toBe(true);
    expect(isRestrictedToPluginOnly("hooks")).toBe(true);

    setPluginOnlyPolicy(["skills"]);
    expect(isRestrictedToPluginOnly("skills")).toBe(true);
    expect(isRestrictedToPluginOnly("hooks")).toBe(false);

    setPluginOnlyPolicy(undefined);
    expect(isRestrictedToPluginOnly("skills")).toBe(false);
  });

  test("锁定 skills 后 user/project/additional 层被跳过，managed 仍加载", async () => {
    const projectDir = tempRoot();
    const addDir = tempRoot();
    const managedDir = tempRoot();
    writeSkill(projectDir, ".sid-code", "proj-skill", "项目级");
    writeSkill(addDir, ".sid-code", "add-skill", "授权目录");
    mkdirSync(join(managedDir, "managed-skill"), { recursive: true });
    writeFileSync(
      join(managedDir, "managed-skill", "SKILL.md"),
      "---\nname: managed-skill\ndescription: 企业下发\n---\n\n做点事",
    );

    setPluginOnlyPolicy(["skills"]);
    const files = await new ExtensionLoader().scan("skills", projectDir, {
      trustProjectExtensions: true,
      additionalDirs: [addDir],
      managedDirs: [managedDir],
    });

    const names = files.map((f) => f.name);
    expect(names).not.toContain("proj-skill");
    expect(names).not.toContain("add-skill");
    expect(names).toContain("managed-skill");
  });

  test("锁定 skills 不影响其他面（commands 照常加载项目级）", async () => {
    const projectDir = tempRoot();
    const dir = join(projectDir, ".sid-code", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mycmd.md"), "---\ndescription: 项目命令\n---\n\n内容");

    setPluginOnlyPolicy(["skills"]);
    const files = await new ExtensionLoader().scan("commands", projectDir, {
      trustProjectExtensions: true,
    });
    expect(files.map((f) => f.name)).toContain("mycmd");
  });

  test("admin-trusted 来源在锁定下仍放行；用户来源被拦", () => {
    setPluginOnlyPolicy(["skills"]);
    for (const src of ["managed", "plugin", "builtin", "bundled"]) {
      expect(isSourceAllowedUnderLock("skills", src)).toBe(true);
    }
    for (const src of ["user", "project", "mcp", undefined]) {
      expect(isSourceAllowedUnderLock("skills", src)).toBe(false);
    }
    // 未锁定的面一律放行
    expect(isSourceAllowedUnderLock("hooks", "project")).toBe(true);
  });

  test("未知面名被忽略且不影响已知面", () => {
    setPluginOnlyPolicy(["skills", "nope" as any]);
    expect(isRestrictedToPluginOnly("skills")).toBe(true);
    expect(isRestrictedToPluginOnly("agents")).toBe(false);
  });
});
