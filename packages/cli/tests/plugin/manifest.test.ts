import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadManifest, loadPluginFromDirectory } from "@sid-code/cli/plugin/manifest.ts";
import { loadPluginMcpServers } from "@sid-code/cli/plugin/loadPluginMcp.ts";
import type { LoadedPlugin, PluginError } from "@sid-code/cli/plugin/types.ts";

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

// ============================================================
// 缺陷 21：组件路径必须限制在插件目录内
// ============================================================

/** 建一个带 manifest 的插件目录，返回目录路径 */
async function makePluginDir(manifest: Record<string, unknown>): Promise<string> {
  const dir = await makeTmpDir();
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ name: "p", version: "1.0.0", description: "d", ...manifest }),
  );
  return dir;
}

/** 取出某组件的全部 path-escape 错误 */
function pathEscapes(errors: PluginError[], component?: string): PluginError[] {
  return errors.filter(
    (e) => e.type === "path-escape" && (component === undefined || e.component === component),
  );
}

describe("缺陷 21 - commands/skills/agents 路径逃逸", () => {
  test("相对路径 ../.. 逃逸被拒并记录 path-escape", async () => {
    const dir = await makePluginDir({ commands: "../../etc" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([]);
    const esc = pathEscapes(errors, "commands");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ type: "path-escape", path: "../../etc", component: "commands" });
  });

  test("绝对路径被拒并记录 path-escape", async () => {
    const dir = await makePluginDir({ commands: "/etc/ssh" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([]);
    const esc = pathEscapes(errors, "commands");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ path: "/etc/ssh", component: "commands" });
  });

  test("数组里只过滤越界项，合法的兄弟项保留", async () => {
    const dir = await makePluginDir({ commands: ["cmds", "../../../.ssh"] });
    await mkdir(join(dir, "cmds"));
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([join(dir, "cmds")]);
    const esc = pathEscapes(errors, "commands");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ path: "../../../.ssh", component: "commands" });
  });

  test("正常相对路径保留", async () => {
    const dir = await makePluginDir({ commands: "cmds" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([join(dir, "cmds")]);
    expect(pathEscapes(errors)).toEqual([]);
  });

  test("'.' 解析为插件根目录本身，属于允许的边界", async () => {
    const dir = await makePluginDir({ commands: "." });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([dir]);
    expect(pathEscapes(errors)).toEqual([]);
  });

  test("skills / agents 同样受校验", async () => {
    const dir = await makePluginDir({ skills: "/tmp", agents: "../outside" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.skillsPaths).toEqual([]);
    expect(plugin!.agentsPaths).toEqual([]);
    expect(pathEscapes(errors, "skills")).toHaveLength(1);
    expect(pathEscapes(errors, "agents")).toHaveLength(1);
  });

  test("插件目录内指向外部的符号链接被拒（realpath 复核）", async () => {
    const outside = await makeTmpDir();
    const dir = await makePluginDir({ commands: "linked" });
    await symlink(outside, join(dir, "linked"), "dir");
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([]);
    expect(pathEscapes(errors, "commands")).toHaveLength(1);
  });

  test("默认目录是指向外部的符号链接时被拒（未声明 commands）", async () => {
    // 声明缺省时走 join(pluginPath, "commands")，若该目录本身是指向外部的符号链接，
    // 只校验显式声明就漏掉了这条同等危险的逃逸路径。
    const outside = await makeTmpDir();
    const dir = await makePluginDir({});
    await symlink(outside, join(dir, "commands"), "dir");
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([]);
    expect(pathEscapes(errors, "commands")).toHaveLength(1);
  });

  test("同名前缀的兄弟目录不被误判为目录内（foo vs foo-evil）", async () => {
    const parent = await makeTmpDir();
    const dir = join(parent, "foo");
    await mkdir(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "d", commands: "../foo-evil" }),
    );
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.commandsPaths).toEqual([]);
    expect(pathEscapes(errors, "commands")).toHaveLength(1);
  });
});

describe("缺陷 21 - hooks 路径逃逸", () => {
  test("相对路径逃逸被拒，hooksConfig 为 undefined", async () => {
    const dir = await makePluginDir({ hooks: "../../evil.json" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.hooksConfig).toBeUndefined();
    const esc = pathEscapes(errors, "hooks");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ path: "../../evil.json", component: "hooks" });
  });

  test("绝对路径被拒，hooksConfig 为 undefined", async () => {
    const dir = await makePluginDir({ hooks: "/etc/evil.json" });
    const errors: PluginError[] = [];
    const plugin = await loadPluginFromDirectory(dir, "local", true, errors);
    expect(plugin!.hooksConfig).toBeUndefined();
    expect(pathEscapes(errors, "hooks")).toHaveLength(1);
  });
});

describe("缺陷 21 - mcpServers 文件路径逃逸", () => {
  /** 构造一个最小 LoadedPlugin（只填 loadPluginMcpServers 用到的字段） */
  function makePlugin(dir: string, mcpServers: unknown): LoadedPlugin {
    return {
      name: "p",
      manifest: {
        name: "p",
        version: "1.0.0",
        description: "d",
        mcpServers: mcpServers as any,
      },
      path: dir,
      source: "p@local",
      enabled: true,
      isBuiltin: false,
      commandsPaths: [],
      skillsPaths: [],
      agentsPaths: [],
    };
  }

  test("相对路径逃逸返回 undefined 并记录 path-escape", async () => {
    const dir = await makeTmpDir();
    const errors: PluginError[] = [];
    const servers = await loadPluginMcpServers(makePlugin(dir, "../../mcp.json"), errors);
    expect(servers).toBeUndefined();
    const esc = pathEscapes(errors, "mcp-servers");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ path: "../../mcp.json", component: "mcp-servers" });
  });

  test("绝对路径返回 undefined 并记录 path-escape", async () => {
    const dir = await makeTmpDir();
    const errors: PluginError[] = [];
    const servers = await loadPluginMcpServers(makePlugin(dir, "/etc/mcp.json"), errors);
    expect(servers).toBeUndefined();
    expect(pathEscapes(errors, "mcp-servers")).toHaveLength(1);
  });

  test("插件目录内的相对文件路径仍可正常加载", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { srv: { transport: "stdio", command: "node" } } }),
    );
    const errors: PluginError[] = [];
    const servers = await loadPluginMcpServers(makePlugin(dir, "mcp.json"), errors);
    expect(servers).toBeDefined();
    expect(Object.keys(servers!)).toEqual(["plugin:p:srv"]);
    expect(pathEscapes(errors)).toEqual([]);
  });
});
