import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setInlinePluginDirs, getInlinePluginDirs } from "../../src/plugin/loader.ts";
import { clearAllPluginCaches } from "../../src/plugin/caches.ts";

let tmpDirs: string[] = [];

async function makePluginDir(manifest: object, opts?: { commands?: Record<string, string> }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sid-plugin-e2e-"));
  tmpDirs.push(dir);
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
  if (opts?.commands) {
    await mkdir(join(dir, "commands"), { recursive: true });
    for (const [name, content] of Object.entries(opts.commands)) {
      await writeFile(join(dir, "commands", `${name}.md`), content);
    }
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

describe("插件加载端到端", () => {
  test("会话级插件目录被加载并启用", async () => {
    const dir = await makePluginDir({
      name: "e2e-plugin",
      version: "1.0.0",
      description: "端到端测试插件",
    });
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { loadAllPlugins } = await import("../../src/plugin/loader.ts");
    const result = await loadAllPlugins();

    const found = result.enabled.find((p) => p.name === "e2e-plugin");
    expect(found).toBeDefined();
    expect(found!.source).toBe("e2e-plugin@inline");
  });

  test("setInlinePluginDirs 解析为绝对路径", () => {
    setInlinePluginDirs(["./relative/path"]);
    const dirs = getInlinePluginDirs();
    expect(dirs[0].startsWith("/")).toBe(true);
  });

  test("插件命令带命名空间前缀加载", async () => {
    const dir = await makePluginDir(
      { name: "cmd-plugin", version: "1.0.0", description: "带命令的插件" },
      { commands: { deploy: "<!-- 部署命令 -->\n执行部署" } },
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginCommands } = await import("../../src/plugin/loadPluginCommands.ts");
    const commands = await getPluginCommands();
    const deploy = commands.find((c) => c.name() === "cmd-plugin:deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.description()).toBe("部署命令");
  });

  test("依赖未满足的插件被降级到 disabled", async () => {
    const dir = await makePluginDir({
      name: "needs-dep",
      version: "1.0.0",
      description: "依赖缺失的插件",
      dependencies: ["nonexistent-dep"],
    });
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { loadAllPlugins } = await import("../../src/plugin/loader.ts");
    const result = await loadAllPlugins();

    expect(result.enabled.find((p) => p.name === "needs-dep")).toBeUndefined();
    expect(result.disabled.find((p) => p.name === "needs-dep")).toBeDefined();
    expect(result.errors.some((e) => e.type === "dependency-unsatisfied")).toBe(true);
  });

  test("无效插件目录记录 path-not-found 错误", async () => {
    setInlinePluginDirs(["/nonexistent/plugin/path"]);
    clearAllPluginCaches();

    const { loadAllPlugins } = await import("../../src/plugin/loader.ts");
    const result = await loadAllPlugins();
    expect(result.errors.some((e) => e.type === "path-not-found")).toBe(true);
  });
});
