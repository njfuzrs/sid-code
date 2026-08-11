/**
 * 插件 Skills 加载测试（P0-4）
 *
 * 覆盖：加载、命名空间前缀不被 sanitize 破坏、卸载后消失、frontmatter 字段保真。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setInlinePluginDirs } from "@sid-code/cli/plugin/loader.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";

let tmpDirs: string[] = [];

/** 造一个带 skills/<name>/SKILL.md 的插件目录 */
async function makePluginWithSkills(
  manifest: object,
  skills: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sid-plugin-skills-"));
  tmpDirs.push(dir);
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(skills)) {
    await mkdir(join(dir, "skills", name), { recursive: true });
    await writeFile(join(dir, "skills", name, "SKILL.md"), content);
  }
  return dir;
}

afterEach(async () => {
  setInlinePluginDirs([]);
  clearAllPluginCaches();
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

describe("插件 Skills 加载（P0-4）", () => {
  test("插件 skill 带 pluginName: 命名空间前缀加载", async () => {
    const dir = await makePluginWithSkills(
      { name: "skill-plugin", version: "1.0.0", description: "带 skill 的插件" },
      {
        "code-review": `---
name: code-review
description: 审查代码质量
---
审查以下代码`,
      },
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginSkills } = await import("@sid-code/cli/plugin/loadPluginSkills.ts");
    const skills = await getPluginSkills();

    const found = skills.find((s) => s.name === "skill-plugin:code-review");
    expect(found).toBeDefined();
    // 关键：命名空间前缀的 `:` 未被 sanitizeName 破坏成 `-`
    expect(found!.name).toContain(":");
    expect(found!.name).not.toBe("skill-plugin-code-review");
    expect(found!.loadedFrom).toBe("plugin");
    expect(found!.description).toBe("审查代码质量");
  });

  test("多个 skill 目录全部加载", async () => {
    const dir = await makePluginWithSkills(
      { name: "multi", version: "1.0.0", description: "多 skill" },
      {
        alpha: `---\nname: alpha\ndescription: A skill\n---\nA`,
        beta: `---\nname: beta\ndescription: B skill\n---\nB`,
      },
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginSkills } = await import("@sid-code/cli/plugin/loadPluginSkills.ts");
    const names = (await getPluginSkills()).map((s) => s.name).sort();
    expect(names).toContain("multi:alpha");
    expect(names).toContain("multi:beta");
  });

  test("卸载插件后其 skills 消失", async () => {
    const dir = await makePluginWithSkills(
      { name: "temp-plugin", version: "1.0.0", description: "临时插件" },
      { "my-skill": `---\nname: my-skill\ndescription: 临时\n---\n内容` },
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginSkills } = await import("@sid-code/cli/plugin/loadPluginSkills.ts");
    expect((await getPluginSkills()).length).toBeGreaterThan(0);

    // 卸载：清空 inline 目录 + 清缓存
    setInlinePluginDirs([]);
    clearAllPluginCaches();
    expect((await getPluginSkills()).length).toBe(0);
  });

  test("frontmatter 敏感字段(effort/allowedTools)保真", async () => {
    const dir = await makePluginWithSkills(
      { name: "rich", version: "1.0.0", description: "字段丰富" },
      {
        deep: `---
name: deep
description: 深度分析
effort: high
allowed-tools: read, grep
---
分析`,
      },
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginSkills } = await import("@sid-code/cli/plugin/loadPluginSkills.ts");
    const found = (await getPluginSkills()).find((s) => s.name === "rich:deep");
    expect(found).toBeDefined();
    expect(found!.effort).toBe("high");
    expect(found!.allowedTools).toEqual(["read", "grep"]);
  });
});
