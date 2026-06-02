import { describe, expect, test } from "bun:test";
import {
  addPluginScopeToServers,
  isPluginScopedServer,
  PLUGIN_MCP_PREFIX,
} from "../../src/plugin/scope.ts";
import type { MCPServerConfig } from "../../src/config/config.ts";

describe("插件 MCP 作用域前缀", () => {
  const servers: Record<string, MCPServerConfig> = {
    "my-server": { transport: "stdio", command: "node", args: ["server.js"] },
    other: { transport: "http", url: "http://localhost:8080" },
  };

  test("为每个服务器添加 plugin:name: 前缀", () => {
    const scoped = addPluginScopeToServers(servers, "my-plugin");
    expect(Object.keys(scoped).sort()).toEqual([
      "plugin:my-plugin:my-server",
      "plugin:my-plugin:other",
    ]);
  });

  test("保留原始配置内容", () => {
    const scoped = addPluginScopeToServers(servers, "p");
    expect(scoped["plugin:p:my-server"]).toMatchObject({
      transport: "stdio",
      command: "node",
    });
  });

  test("isPluginScopedServer 识别前缀", () => {
    expect(isPluginScopedServer("plugin:foo:bar")).toBe(true);
    expect(isPluginScopedServer("regular-server")).toBe(false);
  });

  test("前缀常量正确", () => {
    expect(PLUGIN_MCP_PREFIX).toBe("plugin:");
  });

  test("空服务器集返回空对象", () => {
    expect(addPluginScopeToServers({}, "p")).toEqual({});
  });
});
