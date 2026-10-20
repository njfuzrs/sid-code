/**
 * 回归：动态发现绕过项目扩展信任（B1）+ 禁用名单不传播到晚到 skill（B2）+
 * bundled 模型工具不读禁用态（B3）。
 *
 * B1 的真实失败形态：启动扫描被信任门拒掉的项目 skill（含 cwd 根目录那份），
 * 模型读一下仓库里任意文件，动态发现就把它重新加载进 listing——信任门形同虚设。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SkillActivationCoordinator } from "@sid-code/core/skill/activation-coordinator.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { TrustManager } from "@sid-code/core/extension/trust.ts";
import { BundledSkillTool } from "@sid-code/core/skill/bundled/tool.ts";
import { setPolicyLimits, resetPolicyLimits } from "@sid-code/core/config/policy-limits.ts";
import type { ParsedExtensionFile, ScanOptions } from "@sid-code/core/extension/types.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

let tmp: string;
let proj: string;
let prevConfigDir: string | undefined;

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n正文`,
  );
}

/** 生产同形的扫描配置：trustManager + onUntrusted（返回值 = 当场批准的文件） */
function scanOptionsWith(
  onUntrusted: (files: ParsedExtensionFile[]) => Promise<ParsedExtensionFile[]>,
): ScanOptions {
  return { trustManager: new TrustManager(), trustProjectExtensions: false, onUntrusted };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sid-dyn-trust-"));
  proj = join(tmp, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "a.ts"), "x");
  // trustBatch 会落盘信任存储：重定向到 tmp，存/恢复原值（不无条件 delete，见 CONTRIBUTING 测试约定）
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(tmp, "home");
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  resetPolicyLimits();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("B1：动态发现必须过项目扩展信任门", () => {
  test("cwd 根目录下启动被拒的 skill，读仓库文件后不得被重新加载", async () => {
    await writeSkill(join(proj, ".sid-code", "skills"), "evil");
    const opts = scanOptionsWith(async () => []);
    const mgr = new SkillManager();
    await mgr.discover(proj, opts);
    expect(mgr.getSkill("evil")).toBeNull();

    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: proj, scanOptions: opts });
    coord.init(mgr.getAllSkills());
    await coord.onToolResults([{ file_path: join(proj, "a.ts") }]);

    expect(mgr.getSkill("evil")).toBeNull();
    expect(coord.drainListingDelta()).toBeNull();
  });

  test("嵌套目录的未信任 skill：拒绝时不加载，批准后才加载", async () => {
    await writeSkill(join(proj, "sub", ".sid-code", "skills"), "nested");
    await writeFile(join(proj, "sub", "b.ts"), "x");

    let approve = false;
    const seen: string[] = [];
    const opts = scanOptionsWith(async (files) => {
      seen.push(...files.map((f) => f.name));
      return approve ? files : [];
    });
    const mgr = new SkillManager();
    await mgr.discover(proj, opts);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: proj, scanOptions: opts });
    coord.init(mgr.getAllSkills());

    await coord.onToolResults([{ file_path: join(proj, "sub", "b.ts") }]);
    expect(seen).toContain("nested");
    expect(mgr.getSkill("nested")).toBeNull();

    // 被扣下的目录不登记为已发现：批准后再碰一次即可在本会话加载
    approve = true;
    await coord.onToolResults([{ file_path: join(proj, "sub", "b.ts") }]);
    expect(mgr.getSkill("nested")).not.toBeNull();
    expect(coord.drainListingDelta()).toContain("nested");
  });

  test("企业 extensions 面被禁用时，动态发现即使 trustProjectExtensions 也不加载", async () => {
    await writeSkill(join(proj, "sub", ".sid-code", "skills"), "locked");
    await writeFile(join(proj, "sub", "b.ts"), "x");
    setPolicyLimits({ extensions: { allowed: false } });

    const opts: ScanOptions = { trustProjectExtensions: true };
    const mgr = new SkillManager();
    await mgr.discover(proj, opts);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: proj, scanOptions: opts });
    coord.init(mgr.getAllSkills());
    await coord.onToolResults([{ file_path: join(proj, "sub", "b.ts") }]);

    expect(mgr.getSkill("locked")).toBeNull();
  });

  test("已信任（trustProjectExtensions）的嵌套 skill 照常动态发现", async () => {
    await writeSkill(join(proj, "sub", ".sid-code", "skills"), "ok");
    await writeFile(join(proj, "sub", "b.ts"), "x");
    const opts: ScanOptions = { trustProjectExtensions: true };
    const mgr = new SkillManager();
    await mgr.discover(proj, opts);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: proj, scanOptions: opts });
    coord.init(mgr.getAllSkills());
    await coord.onToolResults([{ file_path: join(proj, "sub", "b.ts") }]);

    expect(mgr.getSkill("ok")).not.toBeNull();
  });
});

function makeSkill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} 描述`,
    prompt: "正文",
    source: "project",
    loadedFrom: "plugin",
    filePath: `/plugin/${name}.md`,
  };
}

describe("B2：禁用名单作用于晚到的 skill", () => {
  test("setDisabledSkills 之后追加的插件 skill 仍是 disabled，且不进 listing", () => {
    const mgr = new SkillManager();
    mgr.setDisabledSkills(["gh:comments"]);
    mgr.addPluginSkills([makeSkill("gh:comments"), makeSkill("gh:other")]);

    expect(mgr.getSkill("gh:comments")?.disabled).toBe(true);
    expect(mgr.getListableSkills().map((s) => s.name)).toEqual(["gh:other"]);
  });

  test("replacePluginSkills 刷新后禁用态保留；移除禁用项后恢复", () => {
    const mgr = new SkillManager();
    mgr.setDisabledSkills(["gh:comments"]);
    mgr.replacePluginSkills([makeSkill("gh:comments")]);
    expect(mgr.getSkill("gh:comments")?.disabled).toBe(true);

    mgr.setDisabledSkills([]);
    expect(mgr.getSkill("gh:comments")?.disabled).toBe(false);
    mgr.replacePluginSkills([makeSkill("gh:comments")]);
    expect(mgr.getSkill("gh:comments")?.disabled).toBe(false);
  });
});

describe("B3：BundledSkillTool 与 slash 路径共享禁用态", () => {
  function makeTool(mgr: SkillManager): BundledSkillTool {
    const cmd = {
      type: "prompt",
      name: "review",
      description: "审查",
      context: "fork",
      getPromptForCommand: async () => "prompt",
    } as unknown as ConstructorParameters<typeof BundledSkillTool>[0];
    const tool = new BundledSkillTool(cmd, {} as never, {} as never);
    tool.setDisabledQuery((n) => mgr.isNameDisabled(n));
    return tool;
  }

  test("禁用后工具不进 schema 且按名直调被拒；启用后恢复", async () => {
    const mgr = new SkillManager();
    const tool = makeTool(mgr);
    expect(tool.isEnabled()).toBe(true);

    // bundled skill 不在 manager 里，名单也必须生效（isNameDisabled 不依赖已加载对象）
    mgr.setDisabledSkills(["Review"]);
    expect(tool.isEnabled()).toBe(false);
    const res = await tool.execute({ input: "" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已被禁用");

    mgr.setDisabledSkills([]);
    expect(tool.isEnabled()).toBe(true);
  });
});
