/**
 * 缺陷 22：PluginError 三个空壳类型的真实产生点
 *
 * 覆盖：
 * 1. component-load-failed —— 组件（命令/Skill/Agent）延迟加载失败能被收集、清空，并能汇入
 *    /plugin list 与 /reload-plugins 输出
 * 2. plugin-not-found    —— enable / disable / uninstall 对不存在的插件返回结构化错误
 * 3. generic-error       —— 组件刷新时的未预期异常走同一套格式化口径
 *
 * 隔离：SID_CONFIG_DIR 指向 tmpdir（installed.json 由它派生），插件目录用 setInlinePluginDirs。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CommandContext } from "@sid-code/core/command-contract/types.ts";
import { setInlinePluginDirs } from "@sid-code/cli/plugin/loader.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import {
  clearComponentLoadErrors,
  listComponentLoadErrors,
  recordComponentLoadError,
} from "@sid-code/cli/plugin/component-errors.ts";
import { loadCommandsForPlugin } from "@sid-code/cli/plugin/loadPluginCommands.ts";
import { loadAgentsForPlugin } from "@sid-code/cli/plugin/loadPluginAgents.ts";
import { disablePlugin, enablePlugin, uninstallPlugin } from "@sid-code/cli/plugin/operations.ts";
import { refreshActivePlugins } from "@sid-code/cli/plugin/refresh.ts";
import { PluginCommand } from "@sid-code/cli/command/commands/plugin/plugin.ts";
import type { LoadedPlugin } from "@sid-code/cli/plugin/types.ts";

let configDir: string;
let prevConfigDir: string | undefined;
let pluginDirs: string[] = [];

beforeEach(async () => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "sid-plugin-component-errors-"));
  process.env.SID_CONFIG_DIR = configDir;
  setInlinePluginDirs([]);
  clearAllPluginCaches();
});

afterEach(async () => {
  setInlinePluginDirs([]);
  clearAllPluginCaches();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  for (const dir of pluginDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  pluginDirs = [];
  await rm(configDir, { recursive: true, force: true }).catch(() => {});
});

/** 造一个会话级插件目录，manifest 原样写入 */
async function makePluginDir(manifest: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sid-plugin-cerr-"));
  pluginDirs.push(dir);
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

/** 直接构造 LoadedPlugin（绕过 loader 组装，单测单个组件 loader 用） */
function fakePlugin(overrides: Partial<LoadedPlugin>): LoadedPlugin {
  return {
    name: "fp",
    manifest: { name: "fp", version: "1.0.0", description: "fixture" },
    path: "/nonexistent",
    source: "fp@inline",
    enabled: true,
    isBuiltin: false,
    commandsPaths: [],
    skillsPaths: [],
    agentsPaths: [],
    ...overrides,
  };
}

describe("组件级加载失败收集器", () => {
  test("record → list 可见 → clearComponentLoadErrors 清空", () => {
    clearComponentLoadErrors();
    recordComponentLoadError({
      type: "component-load-failed",
      source: "p@inline",
      component: "commands",
      error: "boom",
    });
    const listed = listComponentLoadErrors();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      type: "component-load-failed",
      source: "p@inline",
      component: "commands",
      error: "boom",
    });

    // list 返回副本：改它不影响内部状态
    listed.pop();
    expect(listComponentLoadErrors()).toHaveLength(1);

    clearComponentLoadErrors();
    expect(listComponentLoadErrors()).toHaveLength(0);
  });

  test("clearAllPluginCaches() 会通过注册表自动清空收集器", () => {
    recordComponentLoadError({
      type: "component-load-failed",
      source: "p@inline",
      component: "skills",
      error: "boom",
    });
    expect(listComponentLoadErrors()).toHaveLength(1);

    clearAllPluginCaches();
    expect(listComponentLoadErrors()).toHaveLength(0);
  });
});

describe("component-load-failed 产生点", () => {
  test("commands 路径指向文件（readdir ENOTDIR）→ 收集到 component: commands", async () => {
    const dir = await makePluginDir({
      name: "bad-cmd-plugin",
      version: "1.0.0",
      description: "命令路径是文件",
      commands: "./commands.md",
    });
    const notADir = join(dir, "commands.md");
    await writeFile(notADir, "不是目录");
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { loadAllPlugins } = await import("@sid-code/cli/plugin/loader.ts");
    const { enabled } = await loadAllPlugins();
    const plugin = enabled.find((p) => p.name === "bad-cmd-plugin");
    expect(plugin).toBeDefined();
    // manifest 里 commands 显式指向一个文件（存在 → resolveComponentPaths 保留，readdir 报 ENOTDIR）
    expect(plugin!.commandsPaths).toEqual([notADir]);

    const cmds = await loadCommandsForPlugin(plugin!);
    expect(cmds).toHaveLength(0);

    const errs = listComponentLoadErrors();
    const hit = errs.find((e) => e.type === "component-load-failed" && e.component === "commands");
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("bad-cmd-plugin@inline");
    expect((hit as { error: string }).error).toContain(notADir);
  });

  test("agents 路径指向文件 → 收集到 component: agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sid-plugin-cerr-"));
    pluginDirs.push(dir);
    const notADir = join(dir, "agents.md");
    await writeFile(notADir, "不是目录");

    const agents = await loadAgentsForPlugin(
      fakePlugin({
        name: "bad-agent-plugin",
        source: "bad-agent-plugin@inline",
        agentsPaths: [notADir],
      }),
    );
    expect(agents).toHaveLength(0);
    const hit = listComponentLoadErrors().find(
      (e) => e.type === "component-load-failed" && e.component === "agents",
    );
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("bad-agent-plugin@inline");
  });

  test("命令 frontmatter 格式错误（fail-closed 跳过）也被记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sid-plugin-cerr-"));
    pluginDirs.push(dir);
    const cmdsDir = join(dir, "commands");
    await mkdir(cmdsDir, { recursive: true });
    // 缺结尾 --- 的畸形 frontmatter
    await writeFile(join(cmdsDir, "broken.md"), "---\ndescription: 坏掉的\n正文");

    const cmds = await loadCommandsForPlugin(
      fakePlugin({ name: "fm-plugin", source: "fm-plugin@inline", commandsPaths: [cmdsDir] }),
    );
    expect(cmds).toHaveLength(0);
    const hit = listComponentLoadErrors().find(
      (e) => e.type === "component-load-failed" && e.component === "commands",
    );
    expect(hit).toBeDefined();
    expect((hit as { error: string }).error).toContain("frontmatter");
  });
});

describe("plugin-not-found 产生点", () => {
  test("enable / disable / uninstall 对不存在的插件返回结构化错误", async () => {
    const cases = [
      ["enable", await enablePlugin("不存在的插件")],
      ["disable", await disablePlugin("不存在的插件")],
      ["uninstall", await uninstallPlugin("不存在的插件")],
    ] as const;
    for (const [op, r] of cases) {
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      // formatPluginError({ type: "plugin-not-found" }) → `[name] 未找到插件: name`
      expect(r.error).toContain("未找到插件");
      expect(r.error).toContain("不存在的插件");
      expect(r.error, `${op} 的错误应带来源标注`).toBe(`[不存在的插件] 未找到插件: 不存在的插件`);
    }
  });
});

describe("generic-error 产生点（refreshActivePlugins）", () => {
  test("reloadPlugins 抛错 → componentErrors 出现结构化 generic-error 格式", async () => {
    clearAllPluginCaches();
    const result = await refreshActivePlugins({
      unifiedRegistry: {
        reloadPlugins: async () => {
          throw new Error("registry 炸了");
        },
        loadPlugins: async () => 0,
        invalidateSkillCommands: () => {},
        setDisabledSkills: () => {},
      },
    });

    const hit = result.componentErrors.find((e) => e.includes("registry 炸了"));
    expect(hit).toBeDefined();
    // formatPluginError({ type: "generic-error", source: "命令", ... }) → `[命令] registry 炸了`
    expect(hit).toBe("[命令] registry 炸了");
  });

  test("组件级失败并入 componentErrors（顺序：清缓存后重新加载再读取）", async () => {
    const dir = await makePluginDir({
      name: "component-refresh-plugin",
      version: "1.0.0",
      description: "命令路径是文件",
      commands: "./commands.md",
    });
    const notADir = join(dir, "commands.md");
    await writeFile(notADir, "不是目录");
    setInlinePluginDirs([dir]);
    clearAllPluginCaches();

    const { getPluginCommands } = await import("@sid-code/cli/plugin/loadPluginCommands.ts");
    // 先让 refresh 真实地重新加载一次插件命令：用 unifiedRegistry stub 触发
    const result = await refreshActivePlugins({
      unifiedRegistry: {
        reloadPlugins: async () => {
          await getPluginCommands();
          return 0;
        },
        loadPlugins: async () => 0,
        invalidateSkillCommands: () => {},
        setDisabledSkills: () => {},
      },
    });

    const hit = result.componentErrors.find((e) => e.includes(notADir));
    expect(hit).toBeDefined();
    expect(hit).toContain("[component-refresh-plugin@inline]");
    expect(hit).toContain("组件 commands 加载失败");
  });
});

describe("/plugin list 展示组件加载失败", () => {
  test("收集器有内容时 list 输出「组件加载失败:」段", async () => {
    clearComponentLoadErrors();
    recordComponentLoadError({
      type: "component-load-failed",
      source: "visible@inline",
      component: "skills",
      error: "目录读不了",
    });

    const r = await new PluginCommand().call("list", {} as CommandContext);
    expect(r.type).toBe("text");
    const value = (r as { type: "text"; value: string }).value;
    expect(value).toContain("组件加载失败:");
    expect(value).toContain("[visible@inline] 组件 skills 加载失败: 目录读不了");
  });
});
