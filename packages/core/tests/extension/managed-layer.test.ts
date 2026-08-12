/**
 * 企业 managed 扩展层测试（P2-1）
 *
 * 覆盖：managed 覆盖同名 user/project、SID_CODE_DISABLE_POLICY_SKILLS 开关、
 * managed source 标记、五层优先级（builtin < user < project < managed）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";

let testDir: string;
let loader: ExtensionLoader;
let prevSidHome: string | undefined;
let prevClaudeHome: string | undefined;
let prevDisable: string | undefined;

function writeSkill(dir: string, name: string, desc: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n内容`);
}

beforeEach(() => {
  testDir = join(tmpdir(), `managed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  prevSidHome = process.env.SID_CONFIG_DIR;
  prevClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  prevDisable = process.env.SID_CODE_DISABLE_POLICY_SKILLS;
  process.env.SID_CONFIG_DIR = join(testDir, "__user_home__", ".sid-code");
  process.env.CLAUDE_CONFIG_DIR = join(testDir, "__user_home__", ".claude");
  delete process.env.SID_CODE_DISABLE_POLICY_SKILLS;
  loader = new ExtensionLoader();
});

afterEach(() => {
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeHome;
  if (prevDisable === undefined) delete process.env.SID_CODE_DISABLE_POLICY_SKILLS;
  else process.env.SID_CODE_DISABLE_POLICY_SKILLS = prevDisable;
  rmSync(testDir, { recursive: true, force: true });
});

describe("企业 managed 扩展层（P2-1）", () => {
  test("managed skill 被加载且标记 source=managed", async () => {
    const managedDir = join(testDir, "managed-skills");
    writeSkill(managedDir, "policy-skill", "企业策略 skill");

    const result = await loader.scanWithResult("skills", testDir, {
      managedDirs: [managedDir],
    });
    const found = result.files.find((f) => f.name === "policy-skill");
    expect(found).toBeDefined();
    expect(found!.source).toBe("managed");
  });

  test("managed 覆盖同名 project skill", async () => {
    // project 级同名 skill
    const projDir = join(testDir, ".sid-code", "skills");
    writeSkill(projDir, "shared", "项目版");
    // managed 级同名
    const managedDir = join(testDir, "managed-skills");
    writeSkill(managedDir, "shared", "企业版");

    const result = await loader.scanWithResult("skills", testDir, {
      managedDirs: [managedDir],
      trustProjectExtensions: true, // 跳过信任检查
    });
    const found = result.files.find((f) => f.name === "shared");
    expect(found).toBeDefined();
    // managed 最后扫描 → 覆盖 project
    expect(found!.source).toBe("managed");
  });

  test("SID_CODE_DISABLE_POLICY_SKILLS=1 时不加载 managed 层", async () => {
    const managedDir = join(testDir, "managed-skills");
    writeSkill(managedDir, "policy-skill", "企业策略 skill");

    process.env.SID_CODE_DISABLE_POLICY_SKILLS = "1";
    const disabledLoader = new ExtensionLoader();
    const result = await disabledLoader.scanWithResult("skills", testDir, {
      managedDirs: [managedDir],
    });
    expect(result.files.find((f) => f.name === "policy-skill")).toBeUndefined();
  });

  test("未提供 managedDirs 时无 managed 层（向后兼容）", async () => {
    const projDir = join(testDir, ".sid-code", "skills");
    writeSkill(projDir, "only-proj", "只有项目版");
    const result = await loader.scanWithResult("skills", testDir, {
      trustProjectExtensions: true,
    });
    const found = result.files.find((f) => f.name === "only-proj");
    expect(found).toBeDefined();
    expect(found!.source).toBe("project");
  });
});
