import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadManifest, loadPluginFromDirectory } from "../../src/plugin/manifest.ts";
import type { PluginError } from "../../src/plugin/types.ts";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sid-plugin-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

describe("loadManifest - 从磁盘读取 plugin.json", () => {
  test("读取合法 manifest", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "d" }),
    );
    const errors: PluginError[] = [];
    const m = await loadManifest(dir, errors);
    expect(m).not.toBeNull();
    expect(m!.name).toBe("p");
    expect(errors).toEqual([]);
  });

  test("plugin.json 不存在记录 manifest-not-found", async () => {
    const dir = await makeTmpDir();
    const errors: PluginError[] = [];
    const m = await loadManifest(dir, errors);
    expect(m).toBeNull();
    expect(errors[0].type).toBe("manifest-not-found");
  });

  test("JSON 解析失败记录 manifest-parse-error", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "plugin.json"), "{ not valid json");
    const errors: PluginError[] = [];
    const m = await loadManifest(dir, errors);
    expect(m).toBeNull();
    expect(errors[0].type).toBe("manifest-parse-error");
  });

  test("验证失败记录 manifest-validation-error", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "p" }));
    const errors: PluginError[] = [];
    const m = await loadManifest(dir, errors);
    expect(m).toBeNull();
    expect(errors[0].type).toBe("manifest-validation-error");
  });
});

describe("loadPluginFromDirectory - 组装 LoadedPlugin", () => {
  test("解析默认 commands/ 目录路径", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "d" }),
    );
    await mkdir(join(dir, "commands"));
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin).not.toBeNull();
    expect(plugin!.source).toBe("p@local");
    expect(plugin!.commandsPaths).toEqual([join(dir, "commands")]);
    // 默认 skills/agents 目录不存在 → 空数组
    expect(plugin!.skillsPaths).toEqual([]);
  });

  test("加载 hooks.json 配置", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "d", hooks: "hooks.json" }),
    );
    await writeFile(
      join(dir, "hooks.json"),
      JSON.stringify({ PreToolUse: [{ type: "command", command: "echo hi" }] }),
    );
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.hooksConfig).toBeDefined();
    expect(plugin!.hooksConfig!.PreToolUse).toHaveLength(1);
  });

  test("声明的 hooks 文件不存在时报 hook-load-failed", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "d", hooks: "missing.json" }),
    );
    const errors: PluginError[] = [];
    await loadPluginFromDirectory(dir, "local", true, errors);
    expect(errors.some((e) => e.type === "hook-load-failed")).toBe(true);
  });
});
