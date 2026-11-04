/**
 * 插件 hook 归一化诊断必须返回给调用方（§三.9）：app.init 拿它送进启动横幅 / -p stderr。
 * 原先 loadPluginHooks 返回 void、诊断只进 logger.warn，TUI 接管终端后用户看不到。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setInlinePluginDirs } from "@sid-code/cli/plugin/loader.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";

let dir = "";
afterEach(async () => {
  setInlinePluginDirs([]);
  clearAllPluginCaches();
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("loadPluginHooks 诊断", () => {
  test("非法 hook 类型的诊断被返回，path 指明是哪个插件", async () => {
    dir = await mkdtemp(join(tmpdir(), "sid-plugin-hookdiag-"));
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "diag-plugin", version: "1.0.0", description: "诊断测试" }),
    );
    await writeFile(
      join(dir, "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "bogus", command: "x" }] }] } }),
    );
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { loadPluginHooks } = await import("@sid-code/cli/plugin/loadPluginHooks.ts");
    const diags = await loadPluginHooks(new HookSystem());
    const mine = diags.filter((d) => d.path.includes("plugin:diag-plugin"));
    expect(mine.length).toBe(1);
    expect(mine[0]!.message).toContain("无效的 hook 类型");
  });

  // 缺陷 36：缓存必须按 HookSystem 实例分槽。
  // 旧实现是单 slot memoize —— 第二次调用直接返回第一次的 Promise，参数被丢掉，
  // 于是第二个 HookSystem 一个插件 hook 都注册不上，而调用返回成功。
  test("两个 HookSystem 各自注册自己的插件 hook（不是一个实例吃掉缓存）", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "sid-hook-a-"));
    await writeFile(
      join(dirA, "plugin.json"),
      JSON.stringify({ name: "plugin-a", version: "1.0.0", description: "A" }),
    );
    await writeFile(
      join(dirA, "hooks.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo a" }] }] },
      }),
    );

    const { loadPluginHooks } = await import("@sid-code/cli/plugin/loadPluginHooks.ts");
    const sysA = new HookSystem();
    setInlinePluginDirs([dirA]);
    clearAllPluginCaches();
    await loadPluginHooks(sysA);

    const dirB = await mkdtemp(join(tmpdir(), "sid-hook-b-"));
    await writeFile(
      join(dirB, "plugin.json"),
      JSON.stringify({ name: "plugin-b", version: "1.0.0", description: "B" }),
    );
    await writeFile(
      join(dirB, "hooks.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo b" }] }] },
      }),
    );
    const sysB = new HookSystem();
    setInlinePluginDirs([dirB]);
    clearAllPluginCaches();
    await loadPluginHooks(sysB);

    const pluginHooksOf = (sys: HookSystem) =>
      sys.getAllHooks().filter((h) => h.source === "plugin");
    // HookConfig 是 command / url / prompt 等形态的联合类型，只有 command 形态有 command 字段
    const commandOf = (sys: HookSystem) =>
      pluginHooksOf(sys).map((h) => (h.config as { command?: string }).command);

    expect(pluginHooksOf(sysA).length).toBeGreaterThan(0);
    expect(commandOf(sysA)).toEqual(["echo a"]);
    // 旧实现在这里是 0：sysB 拿到的仍是 sysA 的缓存 Promise
    expect(pluginHooksOf(sysB).length).toBeGreaterThan(0);
    expect(commandOf(sysB)).toEqual(["echo b"]);

    await rm(dirA, { recursive: true, force: true }).catch(() => {});
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  });
});
