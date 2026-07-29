/**
 * Skill 运行时激活协调器测试（P1-2 条件激活 + P2-2 动态发现 + P3-2 增量 listing）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SkillActivationCoordinator } from "../../src/skill/activation-coordinator.ts";
import { SkillManager } from "../../src/skill/manager.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: "demo",
    description: "演示",
    prompt: "内容",
    source: "project",
    filePath: "/test/demo.md",
    ...overrides,
  };
}

function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 注入内部 skills
  m.skills = skills;
  return m;
}

describe("SkillActivationCoordinator - 条件激活门控（P1-2）", () => {
  test("init 把带 paths 的 skill gate（从 listing 隐藏）", () => {
    const mgr = managerWith([
      makeSkill({ name: "always" }),
      makeSkill({ name: "onts", paths: ["**/*.ts"] }),
    ]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj" });
    const gated = coord.init(mgr.getSkills());
    expect(gated).toEqual(["onts"]);
    // listable 不含被 gate 的
    expect(mgr.getListableSkills().map((s) => s.name)).toEqual(["always"]);
  });

  test("文件路径匹配触发激活 → 解除 gate + 进 pending", async () => {
    const mgr = managerWith([
      makeSkill({ name: "onts", paths: ["**/*.ts"] }),
    ]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj", enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());
    expect(mgr.isGated("onts")).toBe(true);

    await coord.onToolResults([{ file_path: "/proj/src/foo.ts" }]);
    expect(mgr.isGated("onts")).toBe(false);
    expect(mgr.getListableSkills().map((s) => s.name)).toContain("onts");
  });

  test("路径不匹配则不激活", async () => {
    const mgr = managerWith([makeSkill({ name: "onts", paths: ["**/*.ts"] })]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj", enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());
    await coord.onToolResults([{ file_path: "/proj/README.md" }]);
    expect(mgr.isGated("onts")).toBe(true);
  });
});

describe("SkillActivationCoordinator - 增量 listing（P3-2）", () => {
  test("init 后 drainListingDelta 首轮不再返回全量（审计第 10 条：避免与 system prompt 重复）", () => {
    const mgr = managerWith([makeSkill({ name: "a" }), makeSkill({ name: "b" })]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj" });
    coord.init(mgr.getSkills());
    // init 设了 sentSkillNames 基线（对齐 reinit），drainListingDelta 首轮不再全量注入——
    // 这些 skill 已由 collectSkillListingEntries 经 system prompt 静态附件注入过一轮。
    const delta = coord.drainListingDelta();
    expect(delta).toBeNull();
    // 基线已记录两个 skill，后续不再重复
    expect(coord.getSentNames().sort()).toEqual(["a", "b"]);
  });

  test("drainListingDelta 首轮全量能力仍保留（不调 init 的场景，如 MCP 迟到 skill）", () => {
    const mgr = managerWith([makeSkill({ name: "a" }), makeSkill({ name: "b" })]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj" });
    // 不调 init → sentSkillNames 为空 → drainListingDelta 首轮返回全量。
    // 这覆盖"启动后才出现的 skill"经 enqueueListingForNewSkills / drain 增量注入的真实路径。
    const delta = coord.drainListingDelta();
    expect(delta).toContain("a");
    expect(delta).toContain("b");
  });

  test("首轮即返回 null，后续无新增也返回 null", () => {
    const mgr = managerWith([makeSkill({ name: "a" })]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj" });
    coord.init(mgr.getSkills());
    expect(coord.drainListingDelta()).toBeNull(); // 首轮：基线已设，不重复
    expect(coord.drainListingDelta()).toBeNull(); // 后续无新增
  });

  test("激活新 skill 后增量注入只含新 skill", async () => {
    const mgr = managerWith([
      makeSkill({ name: "always" }),
      makeSkill({ name: "onts", paths: ["**/*.ts"] }),
    ]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: "/proj", enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());

    // 首轮：基线已设（always 已在 system prompt），drainListingDelta 返回 null
    const first = coord.drainListingDelta();
    expect(first).toBeNull();

    // 激活 onts（条件 skill 从 gate 解除 → 进 pending）
    await coord.onToolResults([{ file_path: "/proj/x.ts" }]);
    const delta = coord.drainListingDelta();
    expect(delta).toContain("onts");
    expect(delta).not.toContain("always"); // 已发过，不重复
  });
});

describe("SkillActivationCoordinator - 动态发现（P2-2）", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sid-dyn-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  test("文件操作沿目录链发现 .sid-code/skills/ 并加载", async () => {
    // 造 tmp/sub/.sid-code/skills/found/SKILL.md
    const skillDir = join(tmp, "sub", ".sid-code", "skills", "found");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: found\ndescription: 动态发现的 skill\n---\n内容`,
    );

    const mgr = managerWith([]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: tmp });
    coord.init(mgr.getSkills());

    // 对 tmp/sub/ 下的文件做操作 → 沿链发现 tmp/sub/.sid-code/skills/
    await coord.onToolResults([{ file_path: join(tmp, "sub", "app.ts") }]);

    expect(mgr.getSkill("found")).not.toBeNull();
    // 新发现的 skill 进增量 listing
    const delta = coord.drainListingDelta();
    expect(delta).toContain("found");
  });

  test("enableDynamicDiscovery=false 时不发现", async () => {
    const skillDir = join(tmp, "sub", ".sid-code", "skills", "nope");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: nope\ndescription: x\n---\nx`);

    const mgr = managerWith([]);
    const coord = new SkillActivationCoordinator({ manager: mgr, cwd: tmp, enableDynamicDiscovery: false });
    coord.init(mgr.getSkills());
    await coord.onToolResults([{ file_path: join(tmp, "sub", "app.ts") }]);
    expect(mgr.getSkill("nope")).toBeNull();
  });
});
