/**
 * W1：/skills 禁用对磁盘 skill 必须在当前会话生效。
 *
 * 旧实现的读者在 loadSkillCommands 的 `if (!manager)` 分支里，生产环境总传共享
 * SkillManager，那个分支永不进；唯一的旧测试又整个覆盖了 loadAllCommands。
 * 这里**不覆盖** loadAllCommands，用真实共享 manager 走生产路径。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";

const prevConfigDir = process.env.SID_CONFIG_DIR;
let root: string;
let cwd: string;

describe("W1 磁盘 skill 禁用热生效", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-w1-"));
    process.env.SID_CONFIG_DIR = join(root, "home");
    mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
    cwd = join(root, "proj");
    const d = join(cwd, ".sid-code", "skills", "w1-disk-skill");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: w1-disk-skill\ndescription: d\n---\n# body\n`);
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test("registry.setDisabledSkills 后命令不可用、Skill 工具报已禁用；启用后恢复", async () => {
    const manager = new SkillManager();
    await manager.discover(cwd);
    const registry = new UnifiedCommandRegistry({ skillManager: manager });
    const metaTool = new SkillMetaTool(manager, {} as any, {} as any);

    const before = await registry.loadAllCommands(cwd);
    const cmd = before.find((c) => c.name === "w1-disk-skill");
    expect(cmd).toBeDefined();
    expect(cmd!.isEnabled?.() ?? true).toBe(true);

    registry.setDisabledSkills(["w1-disk-skill"]);

    // 已投影出去的命令对象（补全列表里那一份）当场失效
    expect(cmd!.isEnabled?.()).toBe(false);
    const after = await registry.getCommands(cwd);
    expect(after.some((c) => c.name === "w1-disk-skill")).toBe(false);
    const r = await metaTool.execute({ skill: "w1-disk-skill" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("已被禁用");

    registry.setDisabledSkills([]);
    const restored = await registry.getCommands(cwd);
    expect(restored.some((c) => c.name === "w1-disk-skill")).toBe(true);
  });
});

describe("W1 /skills disable|enable 走同一热更新路径", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-w1c-"));
    process.env.SID_CONFIG_DIR = join(root, "home");
    mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function run(sub: "disable" | "enable", ctx: any) {
    const { SkillsCommand } = await import("@sid-code/cli/command/extensions.ts");
    const cmd = new SkillsCommand().subCommands().find((c) => c.name() === sub)!;
    return cmd.execute("w1-x", ctx);
  }

  test("有注册表：写盘后把生效列表推给注册表，文案说当前会话已生效", async () => {
    const pushed: string[][] = [];
    const ctx = { unifiedRegistry: { setDisabledSkills: (n: string[]) => pushed.push(n) } };
    const r: any = await run("disable", ctx);
    expect(r.message).toContain("当前会话已生效");
    expect(pushed.at(-1)).toContain("w1-x");
    await run("enable", ctx);
    expect(pushed.at(-1)).not.toContain("w1-x");
  });

  test("拿不到注册表 / manager：如实提示重启后生效", async () => {
    const r: any = await run("disable", {});
    expect(r.message).toContain("重启会话后生效");
  });
});
