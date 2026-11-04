import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
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
import { getPluginsDir, writeInstalledPlugins } from "@sid-code/cli/plugin/installed.ts";
import type { InstalledPluginEntry } from "@sid-code/cli/plugin/types.ts";

let tmpDirs: string[] = [];
/** SID_CONFIG_DIR 指向的临时配置根（installed.json 由它派生），不碰真实 ~/.sid-code */
let configDir: string;
let prevConfigDir: string | undefined;

beforeEach(async () => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "sid-plugin-e2e-config-"));
  process.env.SID_CONFIG_DIR = configDir;
  clearAllPluginCaches();
});

/**
 * 测试里临时创建的「用户插件目录」：默认就在 getPluginsDir() 之内（缺陷 29 之后必须如此），
 * 传 escape=true 时建在插件目录的兄弟位置，用来验证目录外条目被拒。
 */
async function makePluginDirInRegistry(name: string, opts?: { escape?: boolean }): Promise<string> {
  let dir: string;
  if (opts?.escape) {
    dir = await mkdtemp(join(tmpdir(), "sid-plugin-e2e-escaped-"));
  } else {
    // plugins 目录本身在全新 SID_CONFIG_DIR 下还不存在，mkdtemp 不会递归创建父目录
    await mkdir(getPluginsDir(), { recursive: true });
    dir = await mkdtemp(join(getPluginsDir(), `${name}-`));
  }
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: "installed.json 测试插件" }),
  );
  return dir;
}

/** 写 installed.json（SID_CONFIG_DIR 已重定向到 tmpdir） */
async function writeRegistry(plugins: Record<string, InstalledPluginEntry>): Promise<void> {
  await writeInstalledPlugins({ version: 1, plugins });
  clearAllPluginCaches();
}

/** 构造注册表条目（默认值都能通过校验，各用例只覆盖要测的字段） */
function entry(overrides: Partial<InstalledPluginEntry> & { path: string }): InstalledPluginEntry {
  return {
    name: "reg-plugin",
    source: "reg-plugin@local",
    version: "1.0.0",
    installedAt: "2026-09-27T00:00:00.000Z",
    enabled: true,
    ...overrides,
  };
}

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
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  await rm(configDir, { recursive: true, force: true }).catch(() => {});
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

/**
 * 缺陷 29：installed.json 的 path 与键名都不能无条件信任
 * 隔离：beforeEach 把 SID_CONFIG_DIR 指向 tmpdir，installed.json 与插件目录都建在临时目录里。
 */
describe("installed.json 路径与键名校验（缺陷 29）", () => {
  test("path 是相对路径 → 不加载，errors 有 generic-error", async () => {
    const dir = await makePluginDirInRegistry("rel-plugin");
    const relativePath = join("some", "relative", "plugin-dir");
    const realDir = join(process.cwd(), relativePath);
    expect(existsSync(realDir)).toBe(false); // 前提：这个相对路径本来也不存在
    expect(dir.startsWith(getPluginsDir())).toBe(true);
    await writeRegistry({
      "rel-plugin": entry({ name: "rel-plugin", path: relativePath, source: "rel-plugin@local" }),
    });

    const result = await loadAllPlugins();
    expect(result.enabled.find((p) => p.name === "rel-plugin")).toBeUndefined();
    expect(result.disabled.find((p) => p.name === "rel-plugin")).toBeUndefined();
    const err = result.errors.find((e) => e.type === "generic-error");
    expect(err).toBeDefined();
    expect((err as { source: string }).source).toBe("rel-plugin");
    expect((err as { error: string }).error).toContain("path 必须是绝对路径字符串");
  });

  test("path 在插件目录之外且无 external:true → path-escape；带 external:true → 正常加载", async () => {
    const escaped = await makePluginDirInRegistry("outside-plugin", { escape: true });
    // 前提：这个目录确实在插件目录之外（否则这条用例什么都证明不了）
    expect(escaped.startsWith(getPluginsDir())).toBe(false);

    await writeRegistry({
      "outside-plugin": entry({
        name: "outside-plugin",
        path: escaped,
        source: "outside-plugin@local",
      }),
    });
    const rejected = await loadAllPlugins();
    expect(rejected.enabled.find((p) => p.name === "outside-plugin")).toBeUndefined();
    const escapeErr = rejected.errors.find((e) => e.type === "path-escape");
    expect(escapeErr).toBeDefined();
    expect((escapeErr as { path: string }).path).toBe(escaped);
    expect((escapeErr as { source: string }).source).toBe("outside-plugin@local");

    // 同一条目加上 external:true（--no-copy 原地引用）→ 放行
    await writeRegistry({
      "outside-plugin": entry({
        name: "outside-plugin",
        path: escaped,
        source: "outside-plugin@local",
        external: true,
      }),
    });
    const accepted = await loadAllPlugins();
    const loaded = accepted.enabled.find((p) => p.name === "outside-plugin");
    expect(loaded).toBeDefined();
    expect(loaded!.path).toBe(escaped);
    expect(accepted.errors.some((e) => e.type === "path-escape")).toBe(false);
  });

  test("键名与 plugin.json 的 name 不一致 → 不加载，generic-error 含两个名字", async () => {
    const dir = await makePluginDirInRegistry("manifest-name");
    await writeRegistry({
      // 键名 foo，manifest.name 是 manifest-name
      foo: entry({ name: "manifest-name", path: dir, source: "foo@local" }),
    });

    const result = await loadAllPlugins();
    expect(result.enabled.find((p) => p.name === "manifest-name")).toBeUndefined();
    expect(result.disabled.find((p) => p.name === "manifest-name")).toBeUndefined();
    const err = result.errors.find(
      (e) => e.type === "generic-error" && (e as { error: string }).error.includes("键名"),
    );
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain('"foo"');
    expect((err as { error: string }).error).toContain('"manifest-name"');
  });

  test("正常条目（目录在插件目录内、键名一致）照常加载", async () => {
    const dir = await makePluginDirInRegistry("ok-plugin");
    await writeRegistry({
      "ok-plugin": entry({ name: "ok-plugin", path: dir, source: "ok-plugin@local" }),
    });

    const result = await loadAllPlugins();
    expect(result.enabled.find((p) => p.name === "ok-plugin")).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });
});

/** 缺陷 30：path-not-found 的 component 可选，目录级失败不该归因到某个组件 */
describe("path-not-found 归因（缺陷 30）", () => {
  test("formatPluginError：无 component → 插件目录不存在；有 component → 保留原文案", async () => {
    const { formatPluginError } = await import("@sid-code/cli/plugin/types.ts");

    expect(
      formatPluginError({ type: "path-not-found", source: "foo@local", path: "/tmp/foo" }),
    ).toBe("[foo@local] 插件目录不存在: /tmp/foo");
    expect(
      formatPluginError({
        type: "path-not-found",
        source: "foo@local",
        path: "/tmp/foo/commands",
        component: "commands",
      }),
    ).toBe("[foo@local] 组件 commands 路径不存在: /tmp/foo/commands");
  });

  test("loader 两处目录级失败都不带 component", async () => {
    const missingInstalled = join(getPluginsDir(), "missing-plugin");
    await writeRegistry({
      "missing-plugin": entry({ name: "missing-plugin", path: missingInstalled }),
    });
    const missingInline = "/nonexistent/plugin/path-defect-30";
    setInlinePluginDirs([missingInline]);

    const result = await loadAllPlugins();
    const notFound = result.errors.filter((e) => e.type === "path-not-found") as Array<{
      path: string;
      component?: unknown;
    }>;
    expect(notFound).toHaveLength(2);
    for (const err of notFound) {
      expect(err.component).toBeUndefined();
    }
    // 目录本身确实不存在，避免用例变成「因为别的原因报的错」
    expect(existsSync(missingInstalled)).toBe(false);
  });
});
