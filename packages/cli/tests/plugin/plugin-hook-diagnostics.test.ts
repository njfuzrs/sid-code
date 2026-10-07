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
});
