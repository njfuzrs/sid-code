import { describe, expect, test, afterEach } from "bun:test";
import {
  registerBuiltinPlugin,
  unregisterBuiltinPlugin,
  getBuiltinPlugins,
  getBuiltinPluginDefinition,
  listBuiltinPluginNames,
} from "@sid-code/cli/plugin/builtin.ts";

describe("内置插件注册表", () => {
  afterEach(() => {
    // 清理测试中注册的插件
    for (const name of ["test-bp", "mac-only", "default-off"]) {
      unregisterBuiltinPlugin(name);
    }
  });

  // 缺陷 38：同名重复注册必须保留先注册者（与 command/registry.ts、mergePluginSources 一致），
  // 不能是 last-write-wins 静默覆盖。
  test("同名重复注册保留先注册者，不做 last-write-wins 覆盖", () => {
    const first = { name: "test-bp", description: "先注册者" };
    const second = { name: "test-bp", description: "后注册者" };
    expect(registerBuiltinPlugin(first)).toBe(true);
    expect(registerBuiltinPlugin(second)).toBe(false);
    expect(getBuiltinPluginDefinition("test-bp")?.description).toBe("先注册者");
  });

  test("重复注册同一对象幂等（不重复告警，也不改内容）", () => {
    const def = { name: "test-bp", description: "同一个" };
    expect(registerBuiltinPlugin(def)).toBe(true);
    expect(registerBuiltinPlugin(def)).toBe(false);
    expect(getBuiltinPluginDefinition("test-bp")).toBe(def);
  });

  // 缺陷 40：生产环境无注册者时，这一层必须是「正确的空结果」，而不是报错。
  // 这条测试同时是能力盘点的口径说明：内置插件层当前恒为空（架构脚手架）。
  test("无注册时 getBuiltinPlugins 返回空数组（生产环境即此状态）", () => {
    unregisterBuiltinPlugin("test-bp");
    unregisterBuiltinPlugin("mac-only");
    unregisterBuiltinPlugin("default-off");
    expect(getBuiltinPlugins()).toEqual([]);
    expect(listBuiltinPluginNames()).toEqual([]);
  });

  test("注册后可被 getBuiltinPlugins 返回", () => {
    registerBuiltinPlugin({ name: "test-bp", description: "测试内置插件", version: "2.0.0" });
    const plugins = getBuiltinPlugins();
    const found = plugins.find((p) => p.name === "test-bp");
    expect(found).toBeDefined();
    expect(found!.isBuiltin).toBe(true);
    expect(found!.source).toBe("test-bp@builtin");
    expect(found!.path).toBe("builtin");
    expect(found!.manifest.version).toBe("2.0.0");
  });

  test("isAvailable=false 的插件被过滤", () => {
    registerBuiltinPlugin({
      name: "mac-only",
      description: "仅 mac",
      isAvailable: () => false,
    });
    expect(getBuiltinPlugins().find((p) => p.name === "mac-only")).toBeUndefined();
  });

  test("enabledOverrides 覆盖默认启用状态", () => {
    registerBuiltinPlugin({ name: "test-bp", description: "x", defaultEnabled: true });
    const overridden = getBuiltinPlugins({ "test-bp": false });
    expect(overridden.find((p) => p.name === "test-bp")!.enabled).toBe(false);
  });

  test("defaultEnabled=false 时默认禁用", () => {
    registerBuiltinPlugin({ name: "default-off", description: "x", defaultEnabled: false });
    expect(getBuiltinPlugins().find((p) => p.name === "default-off")!.enabled).toBe(false);
  });

  test("getBuiltinPluginDefinition 返回原始定义", () => {
    registerBuiltinPlugin({ name: "test-bp", description: "原始" });
    expect(getBuiltinPluginDefinition("test-bp")?.description).toBe("原始");
  });

  test("unregister 后不再返回", () => {
    registerBuiltinPlugin({ name: "test-bp", description: "x" });
    unregisterBuiltinPlugin("test-bp");
    expect(getBuiltinPluginDefinition("test-bp")).toBeUndefined();
  });

  test("listBuiltinPluginNames 包含已注册插件", () => {
    registerBuiltinPlugin({ name: "test-bp", description: "x" });
    expect(listBuiltinPluginNames()).toContain("test-bp");
  });

  test("内置插件的 MCP 服务器自动加作用域前缀", () => {
    registerBuiltinPlugin({
      name: "test-bp",
      description: "x",
      mcpServers: { srv: { transport: "stdio", command: "node" } },
    });
    const found = getBuiltinPlugins().find((p) => p.name === "test-bp")!;
    expect(Object.keys(found.mcpServers!)).toEqual(["plugin:test-bp:srv"]);
  });
});
