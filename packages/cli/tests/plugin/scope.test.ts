import { describe, expect, test } from "bun:test";
import {
  addPluginScopeToServers,
  isPluginScopedServer,
  PLUGIN_MCP_PREFIX,
} from "@sid-code/cli/plugin/scope.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

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

  // 缺陷 39：作用域隔离必须做到嵌套字段，不能只拷顶层。
  test("嵌套字段（env/headers/args/includeTools/excludeTools）不与源配置共享引用", () => {
    const source: Record<string, MCPServerConfig> = {
      srv: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "a" },
        headers: { "X-A": "1" },
        includeTools: ["read"],
        excludeTools: ["write"],
      },
    };
    const scoped = addPluginScopeToServers(source, "p");
    const copy = scoped["plugin:p:srv"]!;

    expect(copy).toEqual(source.srv!);
    // 逐个容器字段断言不共享引用（改副本不影响源）
    copy.env!.TOKEN = "b";
    expect(source.srv!.env!.TOKEN).toBe("a");
    copy.headers!["X-A"] = "2";
    expect(source.srv!.headers!["X-A"]).toBe("1");
    copy.args!.push("--flag");
    expect(source.srv!.args).toEqual(["server.js"]);
    copy.includeTools!.push("grep");
    expect(source.srv!.includeTools).toEqual(["read"]);
    copy.excludeTools!.push("edit");
    expect(source.srv!.excludeTools).toEqual(["write"]);
  });

  test("oauth 对象不与源配置共享引用", () => {
    const source: Record<string, MCPServerConfig> = {
      remote: { transport: "http", url: "https://x", oauth: { clientId: "c1" } },
    };
    const scoped = addPluginScopeToServers(source, "p");
    scoped["plugin:p:remote"]!.oauth!.clientId = "c2";
    expect(source.remote!.oauth!.clientId).toBe("c1");
  });

  test("两个插件传同一份配置对象时互不影响", () => {
    const shared: Record<string, MCPServerConfig> = {
      srv: { transport: "stdio", command: "node", env: { TOKEN: "a" } },
    };
    const a = addPluginScopeToServers(shared, "a");
    const b = addPluginScopeToServers(shared, "b");
    a["plugin:a:srv"]!.env!.TOKEN = "changed-by-a";
    expect(b["plugin:b:srv"]!.env!.TOKEN).toBe("a");
    expect(shared.srv!.env!.TOKEN).toBe("a");
  });
});
