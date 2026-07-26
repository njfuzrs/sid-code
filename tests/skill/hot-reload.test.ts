/**
 * Skill 热重载测试（P2-3：change-detector 接线）
 *
 * 覆盖：
 *  - SkillManager.reload() 重扫磁盘拾取 新增/修改/删除 的 SKILL.md
 *  - reload 保留插件/动态追加的 skill（appendedSkills 重放）
 *  - reload 保留禁用态（disabled 跨重载不丢）
 *  - SkillActivationCoordinator.reinit 保留「重载前已激活」的条件 skill（只进不退）
 *  - SkillChangeDetector 防抖后触发 onChange，stop() 后不再触发
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SkillManager } from "../../src/skill/manager.ts";
import { SkillLoader } from "../../src/skill/loader.ts";
import { ExtensionLoader } from "../../src/extension/loader.ts";
import { SkillActivationCoordinator } from "../../src/skill/activation-coordinator.ts";
import { SkillChangeDetector } from "../../src/skill/change-detector.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";

/** 在 projectDir/.sid-code/skills/<name>/SKILL.md 写一个 skill */
async function writeSkill(
  projectDir: string,
  name: string,
  frontmatter: Record<string, string>,
  body = "内容",
): Promise<void> {
  const dir = join(projectDir, ".sid-code", "skills", name);
  await mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n${fm}\n---\n${body}`);
}

/** 用独立 ExtensionLoader 构造 manager，避免跨用例共享缓存 */
function freshManager(): SkillManager {
  return new SkillManager(new SkillLoader(new ExtensionLoader()));
}

describe("SkillManager.reload — 磁盘重扫（P2-3）", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "skill-reload-"));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("新增 SKILL.md 经 reload 被拾取", async () => {
    const mgr = freshManager();
    await mgr.discover(projectDir, { builtinDir: undefined });
    expect(mgr.getSkill("added")).toBeNull();

    await writeSkill(projectDir, "added", { description: "新增的" });
    await mgr.reload();
    expect(mgr.getSkill("added")?.description).toBe("新增的");
  });

  test("修改 SKILL.md 经 reload 生效（清缓存，不命中旧 TTL）", async () => {
    const mgr = freshManager();
    await writeSkill(projectDir, "edit-me", { description: "旧描述" });
    await mgr.discover(projectDir, { builtinDir: undefined });
    expect(mgr.getSkill("edit-me")?.description).toBe("旧描述");

    await writeSkill(projectDir, "edit-me", { description: "新描述" });
    await mgr.reload();
    expect(mgr.getSkill("edit-me")?.description).toBe("新描述");
  });

  test("删除 SKILL.md 经 reload 消失", async () => {
    const mgr = freshManager();
    await writeSkill(projectDir, "gone", { description: "待删" });
    await mgr.discover(projectDir, { builtinDir: undefined });
    expect(mgr.getSkill("gone")).not.toBeNull();

    await rm(join(projectDir, ".sid-code", "skills", "gone"), { recursive: true, force: true });
    await mgr.reload();
    expect(mgr.getSkill("gone")).toBeNull();
  });

  test("reload 保留插件/动态追加的 skill", async () => {
    const mgr = freshManager();
    await mgr.discover(projectDir, { builtinDir: undefined });
    const pluginSkill: SkillDefinition = {
      name: "my-plugin:helper",
      description: "插件带的",
      prompt: "x",
      source: "project",
      filePath: "/plugins/my-plugin/skills/helper/SKILL.md",
    };
    mgr.addPluginSkills([pluginSkill]);
    expect(mgr.getSkill("my-plugin:helper")).not.toBeNull();

    // 磁盘新增一个 skill，reload 后两者都在
    await writeSkill(projectDir, "disk-one", { description: "磁盘的" });
    await mgr.reload();
    expect(mgr.getSkill("my-plugin:helper")).not.toBeNull();
    expect(mgr.getSkill("disk-one")).not.toBeNull();
  });

  test("reload 保留禁用态", async () => {
    const mgr = freshManager();
    await writeSkill(projectDir, "keep", { description: "启用" });
    await writeSkill(projectDir, "off", { description: "禁用" });
    await mgr.discover(projectDir, { builtinDir: undefined });
    mgr.setDisabledSkills(["off"]);
    expect(mgr.getSkill("off")?.disabled).toBe(true);

    await mgr.reload();
    expect(mgr.getSkill("off")?.disabled).toBe(true);
    expect(mgr.getSkill("keep")?.disabled).toBeFalsy();
  });
});

describe("SkillActivationCoordinator.reinit — 保留已激活（P2-3）", () => {
  function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
    return {
      name: "demo",
      description: "演示",
      prompt: "内容",
      source: "project",
      filePath: `/test/${overrides.name ?? "demo"}.md`,
      ...overrides,
    };
  }
  function managerWith(skills: SkillDefinition[]): SkillManager {
    const m = new SkillManager();
    // @ts-expect-error 注入内部 skills
    m.skills = skills;
    return m;
  }

  test("reinit 后：重载前已激活的条件 skill 保持激活，未激活的仍 gate", async () => {
    const mgr = managerWith([
      makeSkill({ name: "always" }),
      makeSkill({ name: "onts", paths: ["**/*.ts"] }),
      makeSkill({ name: "oncss", paths: ["**/*.css"] }),
    ]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj", enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());

    // 激活 onts（操作 .ts 文件）
    await coord.onToolResults([{ file_path: "/proj/a.ts" }]);
    expect(mgr.isGated("onts")).toBe(false);
    expect(mgr.isGated("oncss")).toBe(true);

    // 快照已激活 + reinit（模拟热重载）
    const prevActivated = coord.getActivatedNames(); // 含 always + onts
    coord.reinit(mgr.getAllSkills(), prevActivated);

    // onts 保持激活（只进不退），oncss 仍 gate
    expect(mgr.isGated("onts")).toBe(false);
    expect(mgr.isGated("oncss")).toBe(true);
    expect(mgr.getListableSkills().map((s) => s.name).sort()).toEqual(["always", "onts"]);
  });

  test("reinit 重置 listing 基线：当前可见 skill 视为已发送，drain 返回 null", () => {
    const mgr = managerWith([makeSkill({ name: "always" })]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj", enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());
    coord.reinit(mgr.getAllSkills(), coord.getActivatedNames());
    // 基线已含 always，无新增 → drain 无内容
    expect(coord.drainListingDelta()).toBeNull();
  });
});

describe("SkillChangeDetector — 防抖与停止（P2-3）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-watch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("SKILL.md 变更防抖后触发 onChange", async () => {
    let fired = 0;
    const detector = new SkillChangeDetector({
      debounceMs: 50,
      onChange: () => {
        fired++;
      },
    });
    detector.watchDirs([dir]);
    // 递归 fs.watch 在某些平台不支持则跳过（降级路径，不算失败）
    if (!detector.isWatching()) {
      detector.stop();
      return;
    }

    await writeFile(join(dir, "SKILL.md"), "---\nname: x\n---\nbody");
    // 等防抖 + 触发
    await new Promise((r) => setTimeout(r, 250));
    detector.stop();
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  test("stop() 后不再触发", async () => {
    let fired = 0;
    const detector = new SkillChangeDetector({
      debounceMs: 50,
      onChange: () => {
        fired++;
      },
    });
    detector.watchDirs([dir]);
    if (!detector.isWatching()) {
      detector.stop();
      return;
    }
    detector.stop();
    await writeFile(join(dir, "SKILL.md"), "---\nname: y\n---\nbody");
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(0);
  });
});
