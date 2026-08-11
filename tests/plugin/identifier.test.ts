import { describe, expect, test } from "bun:test";
import { parsePluginId, buildPluginId } from "@sid-code/cli/plugin/identifier.ts";

describe("插件标识符解析", () => {
  test("解析 name@source 格式", () => {
    expect(parsePluginId("my-plugin@local")).toEqual({ name: "my-plugin", source: "local" });
  });

  test("无 @ 时 source 为 undefined", () => {
    expect(parsePluginId("my-plugin")).toEqual({ name: "my-plugin" });
  });

  test("name@ 末尾空 source 归一为 undefined", () => {
    expect(parsePluginId("my-plugin@")).toEqual({ name: "my-plugin", source: undefined });
  });

  test("source 中含额外 @ 时只在首个 @ 切分", () => {
    expect(parsePluginId("a@b@c")).toEqual({ name: "a", source: "b@c" });
  });

  test("buildPluginId 构建带 source 标识符", () => {
    expect(buildPluginId("foo", "builtin")).toBe("foo@builtin");
  });

  test("buildPluginId 无 source 时只返回 name", () => {
    expect(buildPluginId("foo")).toBe("foo");
  });

  test("parse/build 往返一致", () => {
    const id = buildPluginId("plug", "local");
    const parsed = parsePluginId(id);
    expect(buildPluginId(parsed.name, parsed.source)).toBe(id);
  });
});
