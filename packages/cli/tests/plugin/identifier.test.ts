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

  // 分隔符取最后一个 @：name 侧可能来自文件路径（可含 @）。source 侧含 @ 时会被切到 name 一侧，
  // 这是本函数的取舍（见 identifier.ts 注释），此处把边界钉住。
  test("多个 @ 时按最后一个 @ 切分", () => {
    expect(parsePluginId("a@b@c")).toEqual({ name: "a@b", source: "c" });
  });

  test("路径含 @ 时 name 取完整路径，source 取最后一段", () => {
    expect(parsePluginId("/Users/me/proj@v2/plugins/foo@inline")).toEqual({
      name: "/Users/me/proj@v2/plugins/foo",
      source: "inline",
    });
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

  // buildPluginId 与 parsePluginId 必须互逆：name 自身带 @（磁盘路径）时也要还原一致，
  // 否则 parsePluginId 取首个 @ 的错误会在这里暴露
  test.each([
    ["plug", "local"],
    ["/Users/me/proj@v2/plugins/foo", "inline"],
    ["/opt/a@b@c/d", "builtin"],
    ["a@b", "c"],
  ])("parse(build(name, source)) 往返一致：%s @ %s", (name, source) => {
    const parsed = parsePluginId(buildPluginId(name, source));
    expect(parsed.name).toBe(name);
    expect(parsed.source).toBe(source);
    expect(buildPluginId(parsed.name, parsed.source)).toBe(buildPluginId(name, source));
  });
});
