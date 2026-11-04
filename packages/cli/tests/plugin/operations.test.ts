/**
 * 插件生命周期操作测试（缺陷 31 / 32 / 34）
 *
 * 隔离：显式把 SID_CONFIG_DIR 指到 tmpdir（bunfig preload 有兜底，但断言落盘的测试必须自己设）。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
} from "@sid-code/cli/plugin/operations.ts";
import {
  registerPluginRuntimeRefresher,
  hasPluginRuntimeRefresher,
} from "@sid-code/cli/plugin/runtime-refresh.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import type { InstalledPluginEntry } from "@sid-code/cli/plugin/types.ts";

let root: string;
let pluginsDir: string;
let originalSidConfigDir: string | undefined;
let unregister: (() => void) | undefined;

/** 造一个最小插件目录（plugin.json 只需三必填字段） */
async function makePluginDir(dir: string, name: string, deps?: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: "test",
      ...(deps ? { dependencies: deps } : {}),
    }),
  );
}

async function writeRegistry(entries: Record<string, InstalledPluginEntry>): Promise<void> {
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    join(pluginsDir, "installed.json"),
    JSON.stringify({ version: 1, plugins: entries }),
  );
}

async function readRegistry(): Promise<Record<string, InstalledPluginEntry>> {
  const raw = await readFile(join(pluginsDir, "installed.json"), "utf-8");
  return JSON.parse(raw).plugins;
}

function entry(name: string, path: string, enabled = false): InstalledPluginEntry {
  return {
    name,
    path,
    source: `${name}@local`,
    version: "1.0.0",
    installedAt: new Date(0).toISOString(),
    enabled,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sid-plugin-ops-"));
  pluginsDir = join(root, "plugins");
  originalSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = root;
  clearAllPluginCaches();
});

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  clearAllPluginCaches();
  // 必须恢复原值而不是 delete：同批测试可能依赖 preload 兜底
  if (originalSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalSidConfigDir;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("缺陷 31：uninstall --delete-files 的目录边界", () => {
  test("兄弟目录 plugins-backup 不会被 rm -rf，插件目录本身会被删", async () => {
    const inside = join(pluginsDir, "foo");
    const sibling = join(root, "plugins-backup", "foo");
    await makePluginDir(inside, "foo");
    await makePluginDir(sibling, "foo");
    await writeRegistry({ foo: entry("foo", inside), backup: entry("backup", sibling) });

    // 裸 startsWith(pluginsDir) 会放行这个兄弟目录（缺陷 31 的 P0 形态）
    const r = await uninstallPlugin("backup", { deleteFiles: true });
    expect(r.ok).toBe(true);
    expect(existsSync(sibling)).toBe(true);

    const r2 = await uninstallPlugin("foo", { deleteFiles: true });
    expect(r2.ok).toBe(true);
    expect(existsSync(inside)).toBe(false);
  });
});

describe("缺陷 32：enablePlugin 启用依赖闭包", () => {
  test("依赖已安装但被禁用时，一并启用并按顺序落盘", async () => {
    const aDir = join(pluginsDir, "a");
    const bDir = join(pluginsDir, "b");
    await makePluginDir(aDir, "a", ["b"]);
    await makePluginDir(bDir, "b");
    await writeRegistry({ a: entry("a", aDir), b: entry("b", bDir) });

    const r = await enablePlugin("a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toContain("同时启用依赖: b");

    const reg = await readRegistry();
    expect(reg.a!.enabled).toBe(true);
    // 旧实现只启用 a，b 仍禁用，下次加载 verifyAndDemote 又把 a 降级
    expect(reg.b!.enabled).toBe(true);
  });
});

describe("缺陷 34：生命周期操作刷新运行时", () => {
  test("注册刷新器后 enable / disable 会调用它，未注册时退化为只清缓存", async () => {
    const aDir = join(pluginsDir, "a");
    await makePluginDir(aDir, "a");
    await writeRegistry({ a: entry("a", aDir) });

    let calls = 0;
    unregister = registerPluginRuntimeRefresher(async () => {
      calls++;
    });
    expect(hasPluginRuntimeRefresher()).toBe(true);

    const r = await enablePlugin("a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.runtimeRefreshed).toBe(true);
    expect(calls).toBe(1);

    const r2 = await disablePlugin("a");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.runtimeRefreshed).toBe(true);
    expect(calls).toBe(2);

    unregister();
    unregister = undefined;
    const r3 = await enablePlugin("a");
    if (r3.ok) expect(r3.runtimeRefreshed).toBe(false);
    expect(calls).toBe(2);

    const reg = await readRegistry();
    expect(reg.a!.enabled).toBe(true);
  });

  test("installPlugin 成功后也会刷新运行时", async () => {
    const src = join(root, "src-plugin");
    await makePluginDir(src, "src-plugin");

    let calls = 0;
    unregister = registerPluginRuntimeRefresher(() => {
      calls++;
    });

    const r = await installPlugin(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.runtimeRefreshed).toBe(true);
    expect(calls).toBe(1);
    expect(existsSync(join(pluginsDir, "src-plugin", "plugin.json"))).toBe(true);
  });
});
