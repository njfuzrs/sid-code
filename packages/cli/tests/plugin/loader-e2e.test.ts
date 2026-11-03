import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  setInlinePluginDirs,
  getInlinePluginDirs,
  loadAllPlugins,
  loadAllPluginsCacheOnly,
} from "@sid-code/cli/plugin/loader.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import { registerBuiltinPlugin, unregisterBuiltinPlugin } from "@sid-code/cli/plugin/builtin.ts";

let tmpDirs: string[] = [];

async function makePluginDir(
  manifest: object,
  opts?: { commands?: Record<string, string> },
): Promise<string> {
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

    const { loadAllPlugins } = await import("@sid-code/cli/plugin/loader.ts");
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

    const { getPluginCommands } = await import("@sid-code/cli/plugin/loadPluginCommands.ts");
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

    const { loadAllPlugins } = await import("@sid-code/cli/plugin/loader.ts");
    const result = await loadAllPlugins();

    expect(result.enabled.find((p) => p.name === "needs-dep")).toBeUndefined();
    expect(result.disabled.find((p) => p.name === "needs-dep")).toBeDefined();
    expect(result.errors.some((e) => e.type === "dependency-unsatisfied")).toBe(true);
  });

  test("无效插件目录记录 path-not-found 错误", async () => {
    setInlinePluginDirs(["/nonexistent/plugin/path"]);
    clearAllPluginCaches();

    const { loadAllPlugins } = await import("@sid-code/cli/plugin/loader.ts");
    const result = await loadAllPlugins();
    expect(result.errors.some((e) => e.type === "path-not-found")).toBe(true);
  });
});

describe("加载器只有一层（缺陷 23/25/26）", () => {
  test("loadAllPluginsCacheOnly 与 loadAllPlugins 是同一 memoize 实例", () => {
    // 缺陷 25：两个 slot 会让「预热的 Promise 对象」与「真实 Promise 对象」不一致，
    // 并在 clearAllPluginCaches 之后被旧结果写回。
    expect(loadAllPluginsCacheOnly).toBe(loadAllPlugins);
    expect(loadAllPluginsCacheOnly.cache).toBe(loadAllPlugins.cache);
  });

  test("连续两次调用（含跨别名）只执行一次底层加载", async () => {
    clearAllPluginCaches();
    const first = loadAllPlugins();
    const second = loadAllPluginsCacheOnly();
    // 同一次执行：调用方拿到同一个 Promise；两个 slot 也不该各存一份
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    // 第三次调用仍命中缓存（否则说明 memoize 未生效，每次都在扫盘）
    expect(loadAllPluginsCacheOnly()).toBe(first);
    expect(loadAllPlugins.cache.size).toBe(1);
  });

  test("clear 之后两个别名都重新加载", async () => {
    clearAllPluginCaches();
    const first = loadAllPlugins();
    expect(loadAllPlugins.cache.get(undefined)).toBe(first);
    clearAllPluginCaches();
    expect(loadAllPlugins.cache.size).toBe(0);
    const reloaded = loadAllPluginsCacheOnly();
    expect(reloaded).not.toBe(first);
  });

  test("inline 插件覆盖同名内置插件（优先级 inline > builtin）", async () => {
    const dir = await makePluginDir({
      name: "shadow-me",
      version: "1.0.0",
      description: "会话级同名插件",
    });
    registerBuiltinPlugin({ name: "shadow-me", description: "内置同名插件", version: "0.0.1" });
    try {
      setInlinePluginDirs([dir]);
      clearAllPluginCaches();

      const result = await loadAllPlugins();
      const loaded = result.enabled.find((p) => p.name === "shadow-me");
      expect(loaded).toBeDefined();
      expect(loaded!.source).toBe("shadow-me@inline");
      expect(result.errors.some((e) => e.type === "duplicate-name")).toBe(true);
    } finally {
      unregisterBuiltinPlugin("shadow-me");
    }
  });
});
