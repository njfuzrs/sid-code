/**
 * D4：MCP 全限定工具名必须匹配 API `^[a-zA-Z0-9_-]{1,64}$`。
 *
 * 旧实现只在每一段上截 64，拼完最长 135。短名字碰不到；企业自建 MCP
 * 把 npm 包名当 server 名就会超——工具在列表里看得见、调用时失败。
 *
 * 判据一律落在最终全名长度 + parse 仍能拆出两段。只 `slice(0, 64)` 会切掉
 * 第二个 `__`，parse 拆不出 tool 段——那条路径必须红。
 */

import { describe, test, expect } from "bun:test";
import {
  buildMcpToolName,
  parseMcpToolName,
  normalizeMcpName,
  isMcpTool,
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_NAME_PATTERN,
} from "@sid-code/core/mcp/normalization.ts";

describe("buildMcpToolName 最终全名 ≤ 64 且可反解", () => {
  test("短名字保持 mcp__server__tool，且匹配 API 形态", () => {
    const name = buildMcpToolName("tavily", "tavily_search");
    expect(name).toBe("mcp__tavily__tavily_search");
    expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
    expect(parseMcpToolName(name)).toEqual({
      serverName: "tavily",
      toolName: "tavily_search",
    });
  });

  test("两段各 80 字符 → 全名 ≤ 64、仍能 parse 出两段（守 D4）", () => {
    const name = buildMcpToolName("a".repeat(80), "b".repeat(80));
    expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
    const parsed = parseMcpToolName(name);
    expect(parsed).not.toBeNull();
    expect(parsed!.serverName.length).toBeGreaterThan(0);
    expect(parsed!.toolName).toBeDefined();
    expect(parsed!.toolName!.length).toBeGreaterThan(0);
    expect(name.startsWith("mcp__")).toBe(true);
    expect(name).toContain("__");
  });

  test("短 server + 超长 tool：server 段完整保留", () => {
    const name = buildMcpToolName("gh", "x".repeat(80));
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
    const parsed = parseMcpToolName(name);
    expect(parsed!.serverName).toBe("gh");
    expect(parsed!.toolName!.startsWith("x")).toBe(true);
  });

  test("超长 server + 短 tool：tool 段完整保留", () => {
    const name = buildMcpToolName("y".repeat(80), "search");
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
    const parsed = parseMcpToolName(name);
    expect(parsed!.toolName).toBe("search");
    expect(parsed!.serverName.startsWith("y")).toBe(true);
  });

  test("非法字符清洗后仍 ≤ 64", () => {
    const name = buildMcpToolName("my.server/v2", "do something!");
    expect(name).toBe("mcp__my_server_v2__do_something");
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
  });

  test("空名字回退 unnamed，全名仍合法", () => {
    const name = buildMcpToolName("@@@", "***");
    expect(name).toBe("mcp__unnamed__unnamed");
    expect(MCP_TOOL_NAME_PATTERN.test(name)).toBe(true);
  });
});

describe("normalizeMcpName / parseMcpToolName / isMcpTool", () => {
  test("normalize 合并连续下划线、去掉首尾下划线", () => {
    expect(normalizeMcpName("__foo--bar__")).toBe("foo--bar");
  });

  test("parse 非 mcp 前缀返回 null", () => {
    expect(parseMcpToolName("bash")).toBeNull();
    expect(parseMcpToolName("mcp")).toBeNull();
  });

  test("isMcpTool 只认 mcp__ 前缀", () => {
    expect(isMcpTool("mcp__a__b")).toBe(true);
    expect(isMcpTool("bash")).toBe(false);
  });
});
