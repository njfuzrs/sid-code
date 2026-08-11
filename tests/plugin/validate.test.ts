import { describe, expect, test } from "bun:test";
import { validateManifest } from "@sid-code/cli/plugin/validate.ts";

describe("插件 Manifest 验证", () => {
  const valid = {
    name: "my-plugin",
    version: "1.0.0",
    description: "测试插件",
  };

  test("合法 manifest 通过验证", () => {
    const r = validateManifest(valid);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("非对象直接失败", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest("foo").valid).toBe(false);
    expect(validateManifest([]).valid).toBe(false);
  });

  test("缺少 name 失败", () => {
    const r = validateManifest({ version: "1.0.0", description: "x" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("缺少 version 失败", () => {
    const r = validateManifest({ name: "p", description: "x" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("缺少 description 失败", () => {
    const r = validateManifest({ name: "p", version: "1.0.0" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("name 非 slug 格式失败", () => {
    expect(validateManifest({ ...valid, name: "My Plugin" }).valid).toBe(false);
    expect(validateManifest({ ...valid, name: "-bad" }).valid).toBe(false);
    expect(validateManifest({ ...valid, name: "UPPER" }).valid).toBe(false);
  });

  test("name 合法 slug 通过", () => {
    expect(validateManifest({ ...valid, name: "a" }).valid).toBe(true);
    expect(validateManifest({ ...valid, name: "a-b_c2" }).valid).toBe(true);
    expect(validateManifest({ ...valid, name: "9lives" }).valid).toBe(true);
  });

  test("name 超长失败", () => {
    const r = validateManifest({ ...valid, name: "a".repeat(65) });
    expect(r.valid).toBe(false);
  });

  test("dependencies 非数组失败", () => {
    const r = validateManifest({ ...valid, dependencies: "dep" });
    expect(r.valid).toBe(false);
  });

  test("dependencies 数组含非字符串失败", () => {
    const r = validateManifest({ ...valid, dependencies: ["ok", 42] });
    expect(r.valid).toBe(false);
  });

  test("dependencies 合法数组通过", () => {
    expect(validateManifest({ ...valid, dependencies: ["a", "b"] }).valid).toBe(true);
  });

  test("commands 接受字符串或数组", () => {
    expect(validateManifest({ ...valid, commands: "cmds/" }).valid).toBe(true);
    expect(validateManifest({ ...valid, commands: ["a", "b"] }).valid).toBe(true);
    expect(validateManifest({ ...valid, commands: 1 as any }).valid).toBe(false);
  });

  test("mcpServers 接受字符串或对象", () => {
    expect(validateManifest({ ...valid, mcpServers: "mcp.json" }).valid).toBe(true);
    expect(validateManifest({ ...valid, mcpServers: {} }).valid).toBe(true);
    expect(validateManifest({ ...valid, mcpServers: 42 as any }).valid).toBe(false);
  });

  test("hooks 必须是字符串", () => {
    expect(validateManifest({ ...valid, hooks: "hooks.json" }).valid).toBe(true);
    expect(validateManifest({ ...valid, hooks: {} as any }).valid).toBe(false);
  });
});
